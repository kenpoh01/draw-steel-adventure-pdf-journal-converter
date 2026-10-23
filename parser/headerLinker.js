/**
 * Header Linker
 *
 * Replaces header titles inside story text with Foundry UUID hyperlinks.
 *
 * Input:
 *   sections[] from StoryExtractor:
 *   {
 *     headerId: string,
 *     headerTitle: string,
 *     cleanedText: string
 *   }
 *
 *   journalMap: Map<headerId, JournalEntry>
 *
 * Output:
 *   sections[] with updated cleanedText containing UUID links.
 *
 * Notes:
 * - Journal entry names may contain automatic sequence numbers.
 * - Original section titles are used for matching and linking.
 * - Longer titles are processed before shorter titles.
 * - Existing UUID links are not replaced.
 */

const MODULE_ID = "draw-steel-adventure-pdf-journal-converter";

export function linkHeaders(sections, journalMap) {
  if (!Array.isArray(sections)) {
    throw new TypeError(
      "Header Linker: sections must be an array."
    );
  }

  if (!(journalMap instanceof Map)) {
    throw new TypeError(
      "Header Linker: journalMap must be a Map."
    );
  }

  // ---------------------------------------------------------
  // Step 1: Build original-title-to-UUID mappings.
  // ---------------------------------------------------------

  const titleEntries = [];
  const seenTitles = new Set();

  for (const section of sections) {
    if (!section || typeof section !== "object") {
      continue;
    }

    const headerId = section.headerId;
    const headerTitle = String(
      section.headerTitle ?? section.title ?? ""
    ).trim();

    if (!headerId || !headerTitle) {
      console.warn(
        `${MODULE_ID} | Skipping section with missing headerId or title.`
      );
      continue;
    }

    const entry = journalMap.get(headerId);

    if (!entry?.uuid) {
      console.warn(
        `${MODULE_ID} | No UUID found for header "${headerTitle}" ` +
        `(ID: ${headerId}).`
      );
      continue;
    }

    // Use the original heading rather than entry.name.
    // entry.name may now contain a prefix such as "01 - ".
    const title = headerTitle;
    const normalizedTitle = normalizeTitle(title);

    if (!normalizedTitle) {
      continue;
    }

    // Avoid ambiguous mappings when the same title occurs more than once.
    if (seenTitles.has(normalizedTitle)) {
      console.warn(
        `${MODULE_ID} | Duplicate heading title "${title}". ` +
        "Title-based linking may be ambiguous."
      );
      continue;
    }

    seenTitles.add(normalizedTitle);

    titleEntries.push({
      title,
      normalizedTitle,
      uuid: entry.uuid
    });
  }

  // Process longer titles first so a short title doesn't interfere
  // with a longer title containing the same words.
  titleEntries.sort(
    (a, b) => b.title.length - a.title.length
  );

  console.log(
    `${MODULE_ID} | Prepared ${titleEntries.length} heading links.`
  );

  // ---------------------------------------------------------
  // Step 2: Replace heading references with UUID links.
  // ---------------------------------------------------------

  for (const section of sections) {
    if (!section || typeof section.cleanedText !== "string") {
      console.warn(
        `${MODULE_ID} | Skipping a section with invalid cleanedText.`
      );
      continue;
    }

    let updated = section.cleanedText;

    for (const { title, uuid } of titleEntries) {
      const escapedTitle = escapeRegex(title);

      /*
       * Match either:
       * 1. An existing @UUID[...] {...} reference, which we preserve.
       * 2. The heading title as a standalone phrase.
       *
       * Unicode-aware boundaries avoid matching a heading as part
       * of a larger word.
       */
      const regex = new RegExp(
        `@UUID\\[[^\\]]+\\]\\{[^}]*\\}` +
        `|(?<![\\p{L}\\p{N}_])${escapedTitle}(?![\\p{L}\\p{N}_])`,
        "gu"
      );

      updated = updated.replace(regex, match => {
        // Preserve links already inserted by this linker.
        if (match.startsWith("@UUID[")) {
          return match;
        }

        return `@UUID[${uuid}]{${match}}`;
      });
    }

    section.cleanedText = updated;
  }

  console.log(
    `${MODULE_ID} | Finished linking headings in ${sections.length} sections.`
  );

  return sections;
}

/**
 * Normalizes a title for duplicate detection.
 *
 * @param {string} title
 * @returns {string}
 */
function normalizeTitle(title) {
  return String(title ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

/**
 * Escapes special regular-expression characters in a title.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}