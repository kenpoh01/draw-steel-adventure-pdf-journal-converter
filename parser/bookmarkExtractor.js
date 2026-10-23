const MODULE_ID = "draw-steel-adventure-pdf-journal-converter";

export class BookmarkExtractor {
  /**
   * Extract and normalize a PDF's bookmark hierarchy.
   *
   * @param {Object} pdf - PDF.js PDFDocumentProxy.
   * @returns {Promise<Array<Object>>}
   */
  async extract(pdf) {
    if (!pdf || typeof pdf.getOutline !== "function") {
      throw new Error(
        `${MODULE_ID} | Invalid PDF document supplied to BookmarkExtractor.`
      );
    }

    let outline;

    try {
      outline = await pdf.getOutline();
    } catch (error) {
      console.error(
        `${MODULE_ID} | Failed to retrieve the PDF bookmark outline.`,
        error
      );

      throw error;
    }

    if (!Array.isArray(outline) || outline.length === 0) {
      console.warn(
        `${MODULE_ID} | This PDF does not contain a usable bookmark outline.`
      );

      return [];
    }

    const bookmarks = await this.processItems(pdf, outline);

    console.log(
      `${MODULE_ID} | Extracted ${this.countBookmarks(bookmarks)} bookmarks.`
    );

    return bookmarks;
  }

  /**
   * Recursively process PDF.js outline items.
   *
   * The original hierarchy is preserved through the children property.
   *
   * @param {Object} pdf
   * @param {Array<Object>} items
   * @param {number} depth
   * @param {string|null} parentTitle
   * @returns {Promise<Array<Object>>}
   */
  async processItems(
    pdf,
    items,
    depth = 0,
    parentTitle = null
  ) {
    const results = [];

    for (const item of items) {
const title = this.normalizeTitle(item.title);

const pageNumber = await this.resolvePageNumber(
  pdf,
  item
);

// Temporary diagnostic for the problematic bookmark.
if (
  !title ||
  title.toLocaleLowerCase() === "untitled" ||
  title.toLocaleLowerCase().includes("iron orb")
) {
  console.log(
    `${MODULE_ID} | Bookmark inspection:`,
    {
      originalTitle: item.title,
      normalizedTitle: title,
      pageNumber,
      depth,
      parentTitle,
      hasChildren: Array.isArray(item.items) &&
        item.items.length > 0,
      childCount: Array.isArray(item.items)
        ? item.items.length
        : 0,
      destinationType: typeof item.dest,
      hasDestination: Boolean(item.dest),
      action: item.action ?? null,
      url: item.url ?? null
    }
  );
}

      const children = Array.isArray(item.items)
        ? await this.processItems(
            pdf,
            item.items,
            depth + 1,
            title || parentTitle
          )
        : [];

      results.push({
        title,
        normalizedTitle: this.normalizeForComparison(title),
        pageNumber,
        depth,
        parentTitle,
        isBold: Boolean(item.bold),
        isItalic: Boolean(item.italic),
        children
      });
    }

    return results;
  }

  /**
   * Resolve a bookmark to its one-based PDF page number.
   *
   * PDF.js uses zero-based page indexes internally.
   *
   * @param {Object} pdf
   * @param {Object} item
   * @returns {Promise<number|null>}
   */
  async resolvePageNumber(pdf, item) {
    try {
      let destination = item.dest ?? null;

      /*
       * Some PDF outlines use named destinations.
       * Resolve those names before looking up the page.
       */
      if (typeof destination === "string") {
        destination = await pdf.getDestination(destination);
      }

      /*
       * Some bookmarks use URL actions instead of internal
       * page destinations. Those cannot be resolved here.
       */
      if (!Array.isArray(destination) || !destination[0]) {
        return null;
      }

      const pageIndex = await pdf.getPageIndex(destination[0]);

      return pageIndex + 1;
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Could not resolve bookmark destination: "${item.title}".`,
        error
      );

      return null;
    }
  }

  /**
   * Normalize a bookmark title.
   *
   * This cleans whitespace and common typographic differences
   * without changing the displayed title.
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
   * Create a normalized title for matching against extracted PDF text.
   *
   * The original title remains unchanged in the bookmark record.
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
   * Count all bookmarks, including nested children.
   *
   * @param {Array<Object>} bookmarks
   * @returns {number}
   */
  countBookmarks(bookmarks) {
    let count = 0;

    for (const bookmark of bookmarks) {
      count += 1;

      if (Array.isArray(bookmark.children)) {
        count += this.countBookmarks(bookmark.children);
      }
    }

    return count;
  }
}