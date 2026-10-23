import * as pdfjs from "../libs/pdfjs/pdf.mjs";
import { BookmarkExtractor } from "./bookmarkExtractor.js";
import { orderPageItems, findRunningFurniture, dropDuplicateItems } from "./textLayoutAnalyzer.js";
import { chooseLineConnectors } from "./paragraphBuilder.js";
import { extractTables } from "./tableExtractor.js";
import { normalizeLineBullet, joinStrayBullets } from "./bulletNormalizer.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "../libs/pdfjs/pdf.worker.mjs",
  import.meta.url
).href;

const MODULE_ID = "draw-steel-adventure-pdf-journal-converter";

// Keep detailed diagnostics for the pages we've been investigating.
const DIAGNOSTIC_PAGES = new Set([7, 15, 66]);

export class PdfLoader {
  constructor() {
    this.bookmarkExtractor = new BookmarkExtractor();
  }

  /**
   * Loads a PDF and extracts its text, text-item positions,
   * and bookmark hierarchy.
   *
   * @param {File} file
   * @returns {Promise<Object>}
   */
  async load(file) {
    if (!file) {
      throw new Error(`${MODULE_ID} | No PDF file was provided.`);
    }

    if (typeof file.arrayBuffer !== "function") {
      throw new Error(
        `${MODULE_ID} | The supplied file does not support arrayBuffer().`
      );
    }

    let pdf = null;

    try {
      console.log(
        `${MODULE_ID} | Loading PDF: ${file.name ?? "Unknown file"}`
      );

      const arrayBuffer = await file.arrayBuffer();

      pdf = await pdfjs.getDocument({
        data: new Uint8Array(arrayBuffer)
      }).promise;

      console.log(
        `${MODULE_ID} | PDF loaded. Pages: ${pdf.numPages}`
      );

      // Extract text and positional metadata from every page.
      const pages = await this.extractPages(pdf);

      // Preserve the PDF's actual bookmark hierarchy.
      const bookmarks = await this.extractBookmarks(pdf);

      // Diagnose bookmark destinations without altering the bookmarks.
      this.diagnoseBookmarks(bookmarks, pages);

      const result = {
        fileName: file.name ?? "Unknown file",
        pageCount: pdf.numPages,
        pages,
        bookmarks
      };

      console.log(
        `${MODULE_ID} | PDF extraction complete. ` +
        `Pages: ${result.pageCount}; ` +
        `Bookmarks: ${this.countBookmarks(bookmarks)}.`
      );

      return result;

    } catch (error) {
      console.error(
        `${MODULE_ID} | Failed to load or extract PDF.`,
        error
      );

      throw error;

    } finally {
      if (pdf && typeof pdf.destroy === "function") {
        try {
          await pdf.destroy();
        } catch (error) {
          console.warn(
            `${MODULE_ID} | PDF cleanup failed.`,
            error
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Page extraction
  // -------------------------------------------------------------------------

  /**
   * Extracts text and positional information from every PDF page.
   *
   * The page.text property remains the combined string used by existing
   * heading detection. page.textItems preserves the original text fragments
   * and their coordinates for future layout-aware extraction.
   *
   * Each text item's startOffset and endOffset refer to character positions
   * in page.text. endOffset is exclusive.
   *
   * @param {Object} pdf
   * @returns {Promise<Array<Object>>}
   */
  async extractPages(pdf) {
    const pages = [];
    const collected = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      try {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();

        // Collect the raw items. Their order is the PDF content-stream
        // order, which is NOT reliable for multi-column layouts.
        const rawItems = [];

        for (let index = 0; index < content.items.length; index++) {
          const item = content.items[index];

          // Ignore non-text items, such as marked-content records.
          if (typeof item.str !== "string") {
            continue;
          }

          const transform = Array.isArray(item.transform)
            ? item.transform
            : [];

          rawItems.push({
            index,
            text: item.str,
            str: item.str,

            // Coordinates from the PDF.js text transform.
            x: transform[4] ?? null,
            y: transform[5] ?? null,

            // Preserve the transform for orientation and scale analysis.
            transform: [...transform],

            width: item.width ?? null,
            height: item.height ?? null,
            hasEOL: Boolean(item.hasEOL),
            fontName: item.fontName ?? null,
            dir: item.dir ?? null
          });
        }

        const pageWidth = page.view?.[2] - page.view?.[0];
        const pageHeight = page.view?.[3] - page.view?.[1];

        collected.push({
          pageNumber,
          page,
          content,
          rawItems,
          pageWidth,
          pageHeight
        });

      } catch (error) {
        console.error(
          `${MODULE_ID} | Failed to extract page ${pageNumber}.`,
          error
        );

        throw error;
      }
    }

    // Running headers, footers and page numbers repeat across pages, so
    // they can only be recognised once every page has been read.
    const furniture = findRunningFurniture(
      collected.map(entry => ({
        width: entry.pageWidth,
        height: entry.pageHeight,
        items: entry.rawItems
      }))
    );

    let removedCount = 0;

    for (const entry of collected) {
      const { pageNumber, page, content, pageWidth, pageHeight } = entry;

      try {
        const rawItems = dropDuplicateItems(
          entry.rawItems.filter(item => {
            if (furniture.has(item)) {
              removedCount++;
              return false;
            }

            return true;
          })
        );

        // Rebuild visual reading order (left column before right column,
        // full-width banners separating bands) from the coordinates.
        // Tables are lifted out first; each leaves one marker line behind.
        const { items: layoutItems } = extractTables(rawItems, {
          width: pageWidth,
          height: pageHeight
        });

        const { lines, lineMetrics } = orderPageItems(layoutItems, {
          width: pageWidth,
          height: pageHeight
        });

        // Build page.text from the ordered lines and record, for every item,
        // where it sits in that text. endOffset is exclusive.
        //
        // Lines that are only a column wrapping mid-sentence are joined into
        // one paragraph; real paragraph ends become a blank line.
        // Bullets are drawn with a symbol font; write them as real bullets.
        joinStrayBullets(lines, lineMetrics);
        lines.forEach(normalizeLineBullet);

        const lineTexts = lines.map(line =>
          line.map(({ item, separator }) => separator + item.text.trim()).join("")
        );

        const connectors = chooseLineConnectors(lineTexts, lineMetrics);

        const textItems = [];
        let rawText = "";

        lines.forEach((line, lineIndex) => {
          let lineText = "";

          for (const { item, separator } of line) {
            const piece = item.text.trim();

            lineText += separator;

            item.lineIndex = lineIndex;
            item.startOffset = rawText.length + lineText.length;
            item.endOffset = item.startOffset + piece.length;

            lineText += piece;
            textItems.push(item);
          }

          rawText += lineText + connectors[lineIndex];
        });

        const pageData = {
          pageNumber,
          text: rawText,
          textItems,

          // page.text and page.textItems are in visual reading order, so
          // text offsets can be used directly to slice out sections.
          readingOrder: true,

          // Page geometry helps interpret the text-item coordinates.
          width: page.view?.[2] - page.view?.[0],
          height: page.view?.[3] - page.view?.[1],
          rotation: page.rotate,
          view: Array.isArray(page.view) ? [...page.view] : null
        };

        pages.push(pageData);

        console.log(
          `${MODULE_ID} | Extracted page ${pageNumber}/${pdf.numPages}. ` +
          `Text items: ${textItems.length}.`
        );

        if (DIAGNOSTIC_PAGES.has(pageNumber)) {
          this.diagnosePage(
            pageNumber,
            pageData,
            content,
            rawText
          );
        }

      } catch (error) {
        console.error(
          `${MODULE_ID} | Failed to extract page ${pageNumber}.`,
          error
        );

        throw error;
      }
    }

    console.log(
      `${MODULE_ID} | Removed ${removedCount} running header/footer/page-number items.`
    );

    return pages;
  }

  // -------------------------------------------------------------------------
  // Page diagnostics
  // -------------------------------------------------------------------------

  /**
   * Logs extracted text and coordinates for a diagnostic page.
   *
   * @param {number} pageNumber
   * @param {Object} pageData
   * @param {Object} content
   * @param {string} rawText
   */
  diagnosePage(pageNumber, pageData, content, rawText) {
    console.group(
      `${MODULE_ID} | DIAGNOSTIC: PDF page ${pageNumber}`
    );

    console.log("Page dimensions:", {
      width: pageData.width,
      height: pageData.height,
      rotation: pageData.rotation,
      view: pageData.view
    });

    console.log("Total PDF.js items:", content.items.length);
    console.log("Text items:", pageData.textItems.length);
    console.log("Extracted text length:", rawText.length);

    console.log(
      "FULL EXTRACTED PAGE TEXT:\n",
      rawText
    );

    // Show the coordinates and offsets for each text fragment.
    console.table(
      pageData.textItems.map(item => ({
        index: item.index,
        text: item.text,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        startOffset: item.startOffset,
        endOffset: item.endOffset,
        hasEOL: item.hasEOL,
        fontName: item.fontName
      }))
    );

    const searchTerms = [
      "CHAPTER 1: FIREFALL",
      "Every Good Adventure",
      "Chapter 3: Escape at All Costs",
      "Leaving Safety",
      "Dogs Sniffing About"
    ];

    for (const term of searchTerms) {
      const index = this.findTitleInText(rawText, term);

      console.log(
        `Search "${term}":`,
        index >= 0
          ? {
              found: true,
              start: index,
              end: index + term.length,
              surroundingText: rawText.slice(
                Math.max(0, index - 100),
                Math.min(rawText.length, index + term.length + 200)
              )
            }
          : {
              found: false
            }
      );
    }

    console.groupEnd();
  }

  // -------------------------------------------------------------------------
  // Bookmark diagnostics
  // -------------------------------------------------------------------------

  /**
   * Reports whether bookmark titles occur in their destination-page text.
   * This diagnostic never filters or modifies the bookmark hierarchy.
   *
   * @param {Array<Object>} bookmarks
   * @param {Array<Object>} pages
   */
  diagnoseBookmarks(bookmarks, pages) {
    if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
      console.warn(
        `${MODULE_ID} | Bookmark diagnostics: no bookmarks were extracted.`
      );
      return;
    }

    const pageMap = new Map(
      pages.map(page => [page.pageNumber, page.text])
    );

    const results = [];

    const visit = bookmark => {
      if (!bookmark || typeof bookmark !== "object") {
        return;
      }

      const title = String(
        bookmark.title ?? bookmark.name ?? ""
      ).trim();

      const pageNumber = this.getBookmarkPageNumber(bookmark);

      if (
        title &&
        pageNumber !== null &&
        DIAGNOSTIC_PAGES.has(pageNumber)
      ) {
        const pageText = pageMap.get(pageNumber);

        const position = pageText !== undefined
          ? this.findTitleInText(pageText, title)
          : -1;

        results.push({
          title,
          pageNumber,
          depth: bookmark.depth ?? null,
          foundInExtractedText: position >= 0,
          textPosition: position >= 0 ? position : null,
          pageTextLength: pageText?.length ?? null
        });
      }

      if (Array.isArray(bookmark.children)) {
        for (const child of bookmark.children) {
          visit(child);
        }
      }
    };

    for (const bookmark of bookmarks) {
      visit(bookmark);
    }

    console.group(
      `${MODULE_ID} | Bookmark diagnostics for pages 7, 15, and 66`
    );

    if (results.length > 0) {
      console.table(results);
    } else {
      console.log(
        "No bookmarks were mapped to the diagnostic pages. " +
        "Check the page-number format returned by BookmarkExtractor."
      );
    }

    console.groupEnd();
  }

  /**
   * Finds a bookmark title in extracted text.
   *
   * @param {string} text
   * @param {string} title
   * @returns {number}
   */
  findTitleInText(text, title) {
    if (
      typeof text !== "string" ||
      typeof title !== "string" ||
      !title.trim()
    ) {
      return -1;
    }

    const exactIndex = text.toLocaleLowerCase().indexOf(
      title.toLocaleLowerCase()
    );

    if (exactIndex >= 0) {
      return exactIndex;
    }

    // Allow PDF.js to insert line breaks between words.
    const escaped = title
      .trim()
      .split(/\s+/)
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");

    try {
      const match = new RegExp(escaped, "iu").exec(text);
      return match ? match.index : -1;
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Could not search for title "${title}".`,
        error
      );

      return -1;
    }
  }

  // -------------------------------------------------------------------------
  // Bookmark extraction
  // -------------------------------------------------------------------------

  /**
   * Obtains a bookmark's destination page number.
   *
   * @param {Object} bookmark
   * @returns {number|null}
   */
  getBookmarkPageNumber(bookmark) {
    const candidates = [
      bookmark.pageNumber,
      bookmark.page,
      bookmark.destinationPage
    ];

    for (const candidate of candidates) {
      const value = Number(candidate);

      if (Number.isInteger(value) && value >= 1) {
        return value;
      }
    }

    return null;
  }

  /**
   * Extracts the PDF bookmark hierarchy.
   *
   * @param {Object} pdf
   * @returns {Promise<Array<Object>>}
   */
  async extractBookmarks(pdf) {
    try {
      return await this.bookmarkExtractor.extract(pdf);

    } catch (error) {
      console.warn(
        `${MODULE_ID} | Bookmark extraction failed.`,
        error
      );

      return [];
    }
  }

  /**
   * Counts bookmarks, including nested bookmarks.
   *
   * @param {Array<Object>} bookmarks
   * @returns {number}
   */
  countBookmarks(bookmarks) {
    if (!Array.isArray(bookmarks)) {
      return 0;
    }

    return bookmarks.reduce((total, bookmark) => {
      return total + 1 + this.countBookmarks(bookmark.children);
    }, 0);
  }
}