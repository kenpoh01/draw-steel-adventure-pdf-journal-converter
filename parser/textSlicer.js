const MODULE_ID = "draw-steel-adventure-pdf-journal-converter";

/**
 * Slice the text between two headings out of reading-ordered page text.
 *
 * PdfLoader guarantees that page.text is in reading order, so a section is
 * simply the text from the end of its heading to the start of the next
 * heading, across as many pages as that takes.
 *
 * @param {Array<Object>} pages Pages with pageNumber and text.
 * @param {Object} header Heading with pageNumber, textPosition,
 *   textEndPosition and title.
 * @param {Object|null} nextHeader The heading that ends the section, or null
 *   to run to the end of the document.
 * @returns {string}
 */
export function extractTextBetween(pages, header, nextHeader) {
  const startPage = pages.find(
    page => page.pageNumber === header.pageNumber
  );

  if (!startPage) return "";

  if (header.textPosition === null) {
    console.warn(
      `${MODULE_ID} | Cannot locate heading "${header.title}" ` +
      `on PDF page ${header.pageNumber}.`
    );

    return "";
  }

  const headingEnd = header.textEndPosition;

  if (
    headingEnd === null ||
    headingEnd < header.textPosition ||
    headingEnd > startPage.text.length
  ) {
    console.warn(
      `${MODULE_ID} | Cannot determine the end of heading "${header.title}".`
    );

    return "";
  }

  const chunks = [];

  for (const page of pages) {
    if (page.pageNumber < header.pageNumber) continue;
    if (nextHeader && page.pageNumber > nextHeader.pageNumber) break;

    let start = 0;
    let end = page.text.length;

    if (page.pageNumber === header.pageNumber) {
      start = headingEnd;
    }

    if (nextHeader && page.pageNumber === nextHeader.pageNumber) {
      if (nextHeader.textPosition === null) break;
      end = nextHeader.textPosition;
    }

    if (end < start) continue;

    const chunk = page.text.slice(start, end).trim();

    if (chunk) chunks.push(chunk);
  }

  return chunks.join("\n\n").trim();
}
