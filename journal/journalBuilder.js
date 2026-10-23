
import { textToHtml } from "./htmlFormatter.js";

const MODULE_ID = "draw-steel-adventure-pdf-journal-converter";

export class JournalBuilder {
  /**
   * Convert plain text into journal HTML (paragraphs and bullet lists).
   *
   * @param {string} text
   * @returns {string}
   */
  textToHtml(text) {
    return textToHtml(text);
  }

  /**
   * Create one JournalEntry per chapter, with one JournalEntryPage
   * per item in chapter.pages.
   *
   * Returned map:
   *   chapterId -> JournalEntry
   *   page.headerId -> JournalEntry
   *
   * Multiple page header IDs in the same chapter map to the same entry.
   *
   * @param {Array<Object>} chapters
   * @param {string} folderId
   * @returns {Promise<Map<string, JournalEntry>>}
   */
  async createJournals(chapters, folderId) {
    if (!Array.isArray(chapters) || chapters.length === 0) {
      throw new Error(
        "JournalBuilder: No chapters were provided."
      );
    }

    if (!folderId || !game.folders.get(folderId)) {
      throw new Error(
        `JournalBuilder: Destination folder "${folderId}" was not found.`
      );
    }

    const map = new Map();
    const createdEntries = [];

    try {
      for (const [chapterIndex, chapter] of chapters.entries()) {
        if (!chapter || typeof chapter !== "object") {
          throw new Error(
            `Invalid chapter at position ${chapterIndex + 1}.`
          );
        }

        const chapterId = String(chapter.chapterId ?? "").trim();
        const chapterTitle = String(
          chapter.chapterTitle ?? chapter.title ?? ""
        ).trim();

        if (!chapterId) {
          throw new Error(
            `Chapter ${chapterIndex + 1} is missing its chapterId.`
          );
        }

        if (!chapterTitle) {
          throw new Error(
            `Chapter ${chapterIndex + 1} is missing its chapterTitle.`
          );
        }

        if (!Array.isArray(chapter.pages) || chapter.pages.length === 0) {
          throw new Error(
            `Chapter "${chapterTitle}" has no journal pages.`
          );
        }

        if (map.has(chapterId)) {
          throw new Error(
            `Duplicate chapterId "${chapterId}" was found.`
          );
        }

        const pageIds = new Set();
        const journalPages = [];

        for (const [pageIndex, page] of chapter.pages.entries()) {
          if (!page || typeof page !== "object") {
            throw new Error(
              `Chapter "${chapterTitle}" has an invalid page at position ${pageIndex + 1}.`
            );
          }

          const headerId = String(page.headerId ?? "").trim();
          const pageTitle = String(
            page.title ?? page.headerTitle ?? ""
          ).trim();

          const cleanedText = String(
            page.cleanedText ?? page.content ?? ""
          );

          if (!headerId) {
            throw new Error(
              `Page ${pageIndex + 1} in chapter "${chapterTitle}" is missing its headerId.`
            );
          }

          if (!pageTitle) {
            throw new Error(
              `Page ${pageIndex + 1} in chapter "${chapterTitle}" is missing its title.`
            );
          }

          if (pageIds.has(headerId) || map.has(headerId)) {
            throw new Error(
              `Duplicate page headerId "${headerId}" was found.`
            );
          }

          pageIds.add(headerId);

          // Foundry JournalEntryPage supports text pages.
          // Keep the source bookmark hierarchy in flags for future
          // navigation/linking features.
          journalPages.push({
            name: pageTitle,
            type: "text",
            text: {
              content: this.textToHtml(cleanedText),
              format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML
            },
            flags: {
              [MODULE_ID]: {
                headerId,
                depth: Number.isInteger(page.depth) ? page.depth : 0,
                parentTitle: page.parentTitle ?? null,
                source: page.source ?? "bookmark",
                startPage: page.startPage ?? null,
                endPage: page.endPage ?? null
              }
            }
          });
        }

        const sequenceNumber = String(chapterIndex + 1).padStart(2, "0");
        const journalName = `${sequenceNumber} - ${chapterTitle}`;

        const entry = await JournalEntry.create({
          name: journalName,
          folder: folderId,
          flags: {
            [MODULE_ID]: {
              chapterId,
              chapterTitle,
              startPage: chapter.startPage ?? null,
              endPage: chapter.endPage ?? null
            }
          },
          pages: journalPages
        });

        if (!entry) {
          throw new Error(
            `Foundry failed to create journal entry "${journalName}".`
          );
        }

        createdEntries.push(entry);

        // Map the chapter ID and every page's header ID to the entry.
        map.set(chapterId, entry);

        for (const page of chapter.pages) {
          map.set(String(page.headerId), entry);
        }

        console.log(
          `${MODULE_ID} | Created "${journalName}" with ${journalPages.length} pages.`
        );
      }

      console.log(
        `${MODULE_ID} | Created ${createdEntries.length} chapter journal entries ` +
        `containing ${createdEntries.reduce(
          (total, entry) => total + entry.pages.size,
          0
        )} journal pages.`
      );

      return map;
    } catch (error) {
      console.error(
        `${MODULE_ID} | Journal creation failed; attempting rollback.`,
        error
      );

      // Delete only entries created by this invocation.
      for (const entry of [...createdEntries].reverse()) {
        try {
          await entry.delete();
        } catch (rollbackError) {
          console.error(
            `${MODULE_ID} | Failed to remove partially created journal "${entry.name}".`,
            rollbackError
          );
        }
      }

      throw error;
    }
  }
}
