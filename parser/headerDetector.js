const MODULE_ID = "draw-steel-adventure-pdf-journal-converter";

export class HeaderDetector {
  /**
   * Detect headings exclusively from the PDF bookmark outline.
   *
   * Bookmark titles determine which headings exist.
   * Page text is used only to locate those headings.
   *
   * @param {Object} pdfData
   * @param {Array<Object>} pdfData.pages
   * @param {Array<Object>} pdfData.bookmarks
   * @returns {Promise<Array<Object>>}
   */
  async detect(pdfData) {
    if (!pdfData || !Array.isArray(pdfData.pages)) {
      throw new Error(
        `${MODULE_ID} | HeaderDetector requires an array of PDF pages.`
      );
    }

    const bookmarks = Array.isArray(pdfData.bookmarks)
      ? pdfData.bookmarks
      : [];

    if (bookmarks.length === 0) {
      console.error(
        `${MODULE_ID} | The PDF contains no usable bookmarks. ` +
        "Text-based heading detection is disabled."
      );

      return [];
    }

    const headers = this.detectFromBookmarks(
      bookmarks,
      pdfData.pages
    );

    const sortedHeaders = this.sortHeaders(headers);

    const locatedCount = sortedHeaders.filter(
      header => header.textPosition !== null
    ).length;

    const missingCount = sortedHeaders.length - locatedCount;

    console.log(
      `${MODULE_ID} | Detected ${sortedHeaders.length} headings ` +
      "from PDF bookmarks."
    );

    console.log(
      `${MODULE_ID} | Located ${locatedCount} heading positions; ` +
      `${missingCount} could not be located in the extracted text.`
    );

    if (missingCount > 0) {
      console.warn(
        `${MODULE_ID} | Some bookmark headings could not be located. ` +
        "Review the heading-position warnings before importing."
      );
    }

    return sortedHeaders;
  }

  // -------------------------------------------------------------------------
  // Bookmark processing
  // -------------------------------------------------------------------------

  /**
   * Flattens the bookmark hierarchy while preserving parent information.
   *
   * No headings are created from page text.
   *
   * @param {Array<Object>} bookmarks
   * @param {Array<Object>} pages
   * @returns {Array<Object>}
   */
  detectFromBookmarks(bookmarks, pages) {
    const headers = [];

    const pageMap = new Map(
      pages.map(page => [
        Number(page.pageNumber),
        page
      ])
    );

    let bookmarkOrder = 0;

    const visit = (items, inheritedParent = null) => {
      for (const bookmark of items) {
        if (!bookmark || typeof bookmark !== "object") {
          continue;
        }

        const currentOrder = bookmarkOrder++;

        const title = this.normalizeTitle(bookmark.title);

        const pageNumber = this.normalizePageNumber(
          bookmark.pageNumber,
          pages.length
        );

        const parentTitle =
          bookmark.parentTitle || inheritedParent;

        if (title && pageNumber !== null) {
          const page = pageMap.get(pageNumber);

          const position = page
            ? this.findHeadingPosition(page.text ?? "", title)
            : null;

          headers.push({
            title,

            normalizedTitle:
              this.normalizeForComparison(title),

            pageNumber,

            depth: Number.isInteger(bookmark.depth)
              ? bookmark.depth
              : 0,

            parentTitle,

            source: "bookmark",

            confidence: 1,

            // Actual offsets in the original, unmodified page text.
            textPosition: position?.start ?? null,
            textEndPosition: position?.end ?? null,

            // Retain bookmark ordering for cases where positions
            // cannot be determined.
            bookmarkOrder: currentOrder,

            isBold: Boolean(bookmark.isBold),
            isItalic: Boolean(bookmark.isItalic)
          });

          if (!position) {
            console.warn(
              `${MODULE_ID} | Could not locate bookmark heading ` +
              `"${title}" on PDF page ${pageNumber}.`
            );
          }
        }

        if (Array.isArray(bookmark.children)) {
          visit(
            bookmark.children,
            title || parentTitle
          );
        }
      }
    };

    visit(bookmarks);

    return headers;
  }

  // -------------------------------------------------------------------------
  // Heading position detection
  // -------------------------------------------------------------------------

  /**
   * Finds a bookmark title in the original page text.
   *
   * The returned offsets refer to the original pageText string.
   * The page text is never normalized before calculating these offsets.
   *
   * Matching supports:
   * - Case-insensitive matching.
   * - Multiple spaces and line breaks between words.
   * - Common typographic apostrophe variants.
   * - Common typographic dash variants.
   * - Optional whitespace around colons.
   *
   * @param {string} pageText
   * @param {string} title
   * @returns {{start: number, end: number}|null}
   */
  findHeadingPosition(pageText, title) {
    if (
      typeof pageText !== "string" ||
      !pageText.length ||
      !title
    ) {
      return null;
    }

    const pattern = this.buildFlexibleHeadingPattern(title);

    if (!pattern) {
      return null;
    }

    // Do not normalize pageText: match.index must refer to its
    // original character positions.
    const regex = new RegExp(pattern, "giu");

    // A heading title often also appears inside body text ("see Escape at
    // All Costs"). Prefer an occurrence that stands on its own line, then
    // one that starts a line. A match buried in the middle of a sentence is
    // body text, not the heading, so it is rejected: some bookmarks (such as
    // "Introduction") label a page whose printed title is different.
    let lineStart = null;

    for (const match of pageText.matchAll(regex)) {
      const start = match.index;
      const end = start + match[0].length;

      const startsLine = start === 0 || pageText[start - 1] === "\n";
      const endsLine = end === pageText.length || pageText[end] === "\n";

      const found = { start, end };

      if (startsLine && endsLine) return found;

      if (startsLine) lineStart ??= found;
    }

    return lineStart;
  }

  /**
   * Builds a flexible regular expression from a bookmark title.
   *
   * Whitespace in the bookmark can correspond to spaces or line breaks
   * in the PDF's extracted text.
   *
   * @param {string} title
   * @returns {string}
   */
  buildFlexibleHeadingPattern(title) {
    const normalized = String(title ?? "")
      .replace(/\u00A0/g, " ")
      .trim();

    if (!normalized) {
      return "";
    }

    let pattern = "";

    for (let index = 0; index < normalized.length; index++) {
      const character = normalized[index];

      // Match one or more whitespace characters, including line breaks.
      if (/\s/.test(character)) {
        while (
          index + 1 < normalized.length &&
          /\s/.test(normalized[index + 1])
        ) {
          index++;
        }

        pattern += "\\s+";
        continue;
      }

      // Allow optional whitespace around colons.
      if (character === ":") {
        pattern += "\\s*:\\s*";
        continue;
      }

      // Allow common apostrophe variants.
      if (/['’‘]/.test(character)) {
        pattern += "['’‘]";
        continue;
      }

      // Allow common hyphen and dash variants.
      if (/[-‐-‒–—]/.test(character)) {
        pattern += "[-‐-‒–—]";
        continue;
      }

      // Escape all other regular-expression metacharacters.
      pattern += character.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );
    }

    // Avoid matching the title as part of a larger word.
    return `(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`;
  }

  // -------------------------------------------------------------------------
  // Sorting and deduplication
  // -------------------------------------------------------------------------

  /**
   * Sorts headings into document order and removes duplicate detections.
   *
   * When two headings are on the same page and both positions are known,
   * their actual text positions determine their order.
   *
   * When positions are unknown, bookmark order is retained.
   *
   * @param {Array<Object>} headers
   * @returns {Array<Object>}
   */
  sortHeaders(headers) {
    const sorted = [...headers].sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) {
        return a.pageNumber - b.pageNumber;
      }

      if (
        a.textPosition !== null &&
        b.textPosition !== null
      ) {
        if (a.textPosition !== b.textPosition) {
          return a.textPosition - b.textPosition;
        }
      }

      return a.bookmarkOrder - b.bookmarkOrder;
    });

    const unique = [];
    const seen = new Set();

    for (const header of sorted) {
      const key = [
        header.pageNumber,
        header.normalizedTitle
      ].join("|");

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      unique.push(header);
    }

    return unique;
  }

  // -------------------------------------------------------------------------
  // Normalization utilities
  // -------------------------------------------------------------------------

  /**
   * Normalizes a title for display.
   *
   * This does not affect the offsets returned by findHeadingPosition().
   *
   * @param {string} title
   * @returns {string}
   */
  normalizeTitle(title) {
    return String(title ?? "")
      .replace(/\u00A0/g, " ")
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[‐-‒–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Creates a normalized comparison key.
   *
   * @param {string} title
   * @returns {string}
   */
  normalizeForComparison(title) {
    return this.normalizeTitle(title)
      .toLocaleLowerCase()
      .replace(/\s*:\s*/g, ": ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Validates a one-based PDF page number.
   *
   * @param {number} pageNumber
   * @param {number} pageCount
   * @returns {number|null}
   */
  normalizePageNumber(pageNumber, pageCount) {
    const number = Number(pageNumber);

    if (!Number.isInteger(number)) {
      return null;
    }

    if (number < 1 || number > pageCount) {
      return null;
    }

    return number;
  }
}