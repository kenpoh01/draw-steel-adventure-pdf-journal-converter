import { normalizeText } from "./textNormalizer.js";
import { detectHeaders } from "./headerDetector.js";
import { extractStory } from "./storyExtractor.js";
import { linkHeaders } from "./headerLinker.js";

/**
 * PdfParser orchestrates the full parsing pipeline:
 * 1. Normalize raw text
 * 2. Detect headers
 * 3. Extract story sections
 * 4. Link headers into a structured adventure object
 */
export class PdfParser {

  /**
   * Parse the raw PDF pages returned by PdfLoader.
   * @param {Array<{pageNumber: number, text: string}>} pages
   * @returns {Object} structured adventure object
   */
  parse(pages) {

    // STEP 1 — Normalize text for each page
    const normalizedPages = pages.map(p => ({
      pageNumber: p.pageNumber,
      text: normalizeText(p.text)
    }));

    // STEP 2 — Detect headers across all pages
    const headers = detectHeaders(normalizedPages);

    // STEP 3 — Extract story sections based on headers
    const sections = extractStory(
	{pages: normalizedPages}, 
	headers
	);

    // STEP 4 — Link headers + sections into a structured adventure
    const adventure = linkHeaders(sections, headers);

    return {
      pages: normalizedPages,
      headers,
      sections
    };
  }
}
