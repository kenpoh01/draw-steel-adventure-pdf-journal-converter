import { extractTextBetween } from "./textSlicer.js";

const MODULE_ID = "draw-steel-adventure-pdf-journal-converter";

export class StoryExtractor {
  constructor(options = {}) {
    this.options = {
      includePageMetadata: true,

      ...options
    };
  }

  /**
   * Extract bookmark-based headings into chapter groups.
   * Each chapter becomes one journal entry with multiple pages.
   */
  extract(pdfData, headers = []) {
    if (!pdfData || !Array.isArray(pdfData.pages)) {
      throw new Error(
        `${MODULE_ID} | StoryExtractor requires PDF page data.`
      );
    }

    if (!Array.isArray(headers)) {
      throw new Error(
        `${MODULE_ID} | StoryExtractor requires an array of headings.`
      );
    }

    const pages = this.normalizePages(pdfData.pages);

    if (!pages.length) {
      console.warn(`${MODULE_ID} | No PDF pages were supplied.`);
      return [];
    }

    const normalizedHeaders = this.normalizeHeaders(headers, pages);

    if (!normalizedHeaders.length) {
      console.warn(`${MODULE_ID} | No usable bookmark headings were supplied.`);
      return [];
    }

    // Every bookmark becomes a heading; nothing is filtered out.
    const selectedHeaders = normalizedHeaders;

    const chapterGroups = this.groupHeadersIntoChapters(selectedHeaders);

    if (!chapterGroups.length) {
      console.warn(
        `${MODULE_ID} | No numbered chapter headings were found.`
      );
      return [];
    }

    const groups = chapterGroups;

    const chapters = [];

    groups.forEach((group, chapterIndex) => {
      const nextChapter = groups[chapterIndex + 1] ?? null;

      const chapterEndPage = nextChapter
        ? nextChapter.heading.pageNumber - 1
        : pages[pages.length - 1].pageNumber;

      // Everything from the chapter heading to its first section (or to the
      // next chapter when it has no sections), across page breaks.
      const overviewEnd = group.headers[0] ?? nextChapter?.heading ?? null;

      const overviewText = this.extractSectionContent(
        group.heading,
        overviewEnd,
        pages
      );

      const chapterPages = [{
        headerId: `${group.id}-overview`,
        headerTitle: "Chapter Overview",
        title: "Chapter Overview",
        cleanedText: overviewText,
        content: overviewText,
        depth: 0,
        parentTitle: null,
        source: "chapter-overview",
        heading: group.heading,
        startPage: group.heading.pageNumber,
        endPage: group.heading.pageNumber
      }];

      for (let index = 0; index < group.headers.length; index++) {
        const header = group.headers[index];

        const nextHeader =
          group.headers[index + 1] ??
          nextChapter?.heading ??
          null;

        const content = this.extractSectionContent(
          header,
          nextHeader,
          pages
        );

        const section = {
          headerId: this.createHeaderId(header, chapterIndex, index),
          headerTitle: header.title,
          title: header.title,
          cleanedText: content,
          content,
          depth: header.depth,
          parentTitle: header.parentTitle ?? null,
          source: header.source ?? "bookmark",
          heading: header
        };

        if (this.options.includePageMetadata) {
          section.startPage = header.pageNumber;
          section.endPage = nextHeader
            ? nextHeader.pageNumber
            : chapterEndPage;

          section.pageMetadata = {
            startPage: section.startPage,
            endPage: section.endPage,
            startPageLabel: `PDF page ${section.startPage}`,
            endPageLabel: `PDF page ${section.endPage}`
          };
        }

        chapterPages.push(section);
      }

      chapters.push({
        chapterId: group.id,
        chapterTitle: group.heading.title,
        title: group.heading.title,
        heading: group.heading,
        startPage: group.heading.pageNumber,
        endPage: chapterEndPage,
        pages: chapterPages
      });
    });

    const totalPages = chapters.reduce(
      (total, chapter) => total + chapter.pages.length,
      0
    );

    console.log(
      `${MODULE_ID} | Extracted ${chapters.length} chapters containing ` +
      `${totalPages} journal pages from ${pages.length} PDF pages.`
    );

    return chapters;
  }

  // ---------------------------------------------------------------------------
  // Page normalization
  // ---------------------------------------------------------------------------

  normalizePages(pages) {
    return pages
      .filter(page => page && Number.isInteger(Number(page.pageNumber)))
      .map(page => ({
        ...page,
        pageNumber: Number(page.pageNumber),
        text: typeof page.text === "string" ? page.text : "",
        textItems: Array.isArray(page.textItems) ? page.textItems : [],
        width: Number(page.width) || 0,
        height: Number(page.height) || 0
      }))
      .sort((a, b) => a.pageNumber - b.pageNumber);
  }

  // ---------------------------------------------------------------------------
  // Bookmark normalization
  // ---------------------------------------------------------------------------

  normalizeHeaders(headers, pages) {
    const pageMap = new Map(
      pages.map(page => [page.pageNumber, page])
    );

    const normalized = [];

    for (let index = 0; index < headers.length; index++) {
      const header = headers[index];

      if (!header || typeof header.title !== "string") {
        continue;
      }

      const title = this.normalizeTitle(header.title);
      const pageNumber = Number(header.pageNumber);

      if (!title || !Number.isInteger(pageNumber)) {
        continue;
      }

      const page = pageMap.get(pageNumber);

      if (!page) {
        console.warn(
          `${MODULE_ID} | Skipping heading "${title}": ` +
          `PDF page ${pageNumber} was not found.`
        );
        continue;
      }

      let textPosition = this.validPosition(
        header.textPosition,
        page.text.length
      );

      let textEndPosition = this.validPosition(
        header.textEndPosition,
        page.text.length
      );

      if (textPosition !== null && textEndPosition === null) {
        textEndPosition = this.findHeadingEnd(
          page.text,
          textPosition,
          title
        );
      }

      // A bookmark whose title is not printed on its page (for example
      // "Introduction" pointing at a page titled "The Fall of Blackbottom")
      // still marks where its section starts: the top of that page.
      let locatedByPage = false;

      if (textPosition === null) {
        textPosition = 0;
        textEndPosition = 0;
        locatedByPage = true;

        console.warn(
          `${MODULE_ID} | Heading "${title}" is not printed on PDF page ` +
          `${pageNumber}; its section starts at the top of that page.`
        );
      }

      normalized.push({
        ...header,
        locatedByPage,
        title,
        normalizedTitle:
          header.normalizedTitle || this.normalizeForComparison(title),
        pageNumber,
        depth: Number.isInteger(header.depth) ? header.depth : 0,
        textPosition,
        textEndPosition,
        bookmarkOrder: Number.isInteger(header.bookmarkOrder)
          ? header.bookmarkOrder
          : index
      });
    }

    // Same-page headings: when the page text is in reading order (PdfLoader
    // guarantees this), text offsets give the true reading position.
    // Otherwise raw offsets are unreliable (the PDF may encode the right
    // column first), so fall back to bookmark order.
    normalized.sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) {
        return a.pageNumber - b.pageNumber;
      }

      const readingOrder = pageMap.get(a.pageNumber)?.readingOrder;

      if (
        readingOrder &&
        a.textPosition !== null &&
        b.textPosition !== null &&
        a.textPosition !== b.textPosition
      ) {
        return a.textPosition - b.textPosition;
      }

      return a.bookmarkOrder - b.bookmarkOrder;
    });

    const unique = [];
    const seen = new Set();

    for (const header of normalized) {
      const key = [
        header.pageNumber,
        header.normalizedTitle,
        header.bookmarkOrder
      ].join("|");

      if (seen.has(key)) continue;

      seen.add(key);
      unique.push(header);
    }

    return unique;
  }

  validPosition(value, textLength) {
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value > textLength
    ) {
      return null;
    }

    return value;
  }

  // ---------------------------------------------------------------------------
  // Heading matching
  // ---------------------------------------------------------------------------

  findHeadingEnd(pageText, startPosition, title) {
    if (
      typeof pageText !== "string" ||
      !Number.isInteger(startPosition) ||
      startPosition < 0 ||
      startPosition > pageText.length
    ) {
      return null;
    }

    const pattern = this.buildFlexibleHeadingPattern(title);
    if (!pattern) return null;

    const match = pattern.exec(pageText.slice(startPosition));

    if (!match || match.index !== 0) return null;

    return startPosition + match[0].length;
  }

  buildFlexibleHeadingPattern(title) {
    const normalized = String(title ?? "").trim();
    if (!normalized) return null;

    let pattern = "";

    for (let index = 0; index < normalized.length; index++) {
      const character = normalized[index];

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

      if (character === ":") {
        pattern += "\\s*:\\s*";
        continue;
      }

      if (/['’‘]/.test(character)) {
        pattern += "['’‘]";
        continue;
      }

      if (/["“”]/.test(character)) {
        pattern += '["“”]';
        continue;
      }

      if (/[-‐-‒–—]/.test(character)) {
        pattern += "[-‐-‒–—]";
        continue;
      }

      pattern += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    try {
      return new RegExp(pattern, "u");
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Could not build a heading pattern for "${title}".`,
        error
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Chapter grouping
  // ---------------------------------------------------------------------------

  /**
   * The bookmark outline decides the structure: each outermost bookmark
   * becomes a journal entry, and every bookmark nested beneath it becomes a
   * page of that entry. Bookmark titles are never inspected.
   */
  groupHeadersIntoChapters(headers) {
    const topDepth = headers.reduce(
      (min, header) => Math.min(min, header.depth ?? 0),
      Infinity
    );

    const chapters = [];
    let currentChapter = null;

    for (const header of headers) {
      if ((header.depth ?? 0) === topDepth) {
        currentChapter = {
          id: this.createChapterId(header, chapters.length),
          heading: header,
          headers: []
        };

        chapters.push(currentChapter);
        continue;
      }

      currentChapter.headers.push(header);
    }

    return chapters;
  }

  createChapterId(header, index) {
    const slug = String(header.title ?? "chapter")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);

    return `chapter-${slug || index}`;
  }

  createHeaderId(header, chapterIndex, sectionIndex) {
    const slug = String(header.title ?? "section")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);

    return [
      "chapter",
      chapterIndex,
      header.pageNumber,
      slug || "section",
      sectionIndex
    ].join("-");
  }

  // ---------------------------------------------------------------------------
  // Section content extraction
  // ---------------------------------------------------------------------------

  extractSectionContent(header, nextHeader, pages) {
    return extractTextBetween(pages, header, nextHeader);
  }

  // ---------------------------------------------------------------------------
  // Normalization helpers
  // ---------------------------------------------------------------------------

  normalizeTitle(title) {
    return String(title ?? "")
      .replace(/\u00A0/g, " ")
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[‐-‒–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  normalizeForComparison(title) {
    return this.normalizeTitle(title)
      .toLocaleLowerCase()
      .replace(/\s*:\s*/g, ": ")
      .replace(/\s+/g, " ")
      .trim();
  }
}