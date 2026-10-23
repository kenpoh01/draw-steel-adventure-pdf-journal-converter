import { PdfLoader } from "../parser/pdfLoader.js";
import { HeaderDetector } from "../parser/headerDetector.js";
import { StoryExtractor } from "../parser/storyExtractor.js";
import { JournalBuilder } from "../journal/journalBuilder.js";
import { linkHeaders } from "../parser/headerLinker.js";
import { textToHtml } from "../journal/htmlFormatter.js";

const MODULE_ID = "draw-steel-adventure-pdf-journal-converter";

/**
 * Registers the import button in the Foundry Journal directory.
 */
export function registerImportButton() {
  Hooks.on("renderJournalDirectory", (_app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];

    if (!root) return;

    const header = root.querySelector(".directory-header");

    if (!header) {
      console.warn(
        `${MODULE_ID} | Journal directory header not found.`
      );
      return;
    }

    // Prevent duplicate buttons when the directory is rendered again.
    if (header.querySelector(".drawsteel-importer")) return;

    const button = document.createElement("button");

    button.type = "button";
    button.className = "drawsteel-importer";
    button.textContent = "Import Draw Steel Adventure";

    button.addEventListener("click", openImportDialog);

    header.appendChild(button);
  });
}

/**
 * Opens the import dialog.
 */
function openImportDialog() {
  const content = `
    <form class="drawsteel-import-form">
      <div class="form-group">
        <label for="drawsteel-pdf">PDF File:</label>
        <input
          type="file"
          id="drawsteel-pdf"
          accept=".pdf,application/pdf"
          required
        >
      </div>

      <div class="form-group">
        <label for="drawsteel-folder">Target Journal Folder:</label>
        <input
          type="text"
          id="drawsteel-folder"
          placeholder="Adventure Name"
          required
        >
      </div>
    </form>
  `;

  new Dialog({
    title: "Import Draw Steel Adventure",
    content,

    buttons: {
      import: {
        icon: '<i class="fas fa-file-import"></i>',
        label: "Import",

        callback: async html => {
          await handleImport(html);
        }
      },

      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel"
      }
    },

    default: "import"
  }).render(true);
}

/**
 * Runs the PDF-to-journal import pipeline.
 */
async function handleImport(html) {
  try {
    const root = html instanceof HTMLElement ? html : html?.[0];

    if (!root) {
      throw new Error("Could not access the import dialog.");
    }

    const fileInput = root.querySelector("#drawsteel-pdf");
    const folderInput = root.querySelector("#drawsteel-folder");

    const file = fileInput?.files?.[0];
    const folderName = folderInput?.value?.trim();

    // ---------------------------------------------------------
    // Validate input
    // ---------------------------------------------------------

    if (!file) {
      ui.notifications.warn("Please select a PDF file.");
      return;
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      ui.notifications.error("Please select a PDF file.");
      return;
    }

    if (!folderName) {
      ui.notifications.warn("Please enter a folder name.");
      return;
    }

    ui.notifications.info(`Loading PDF: ${file.name}`);

    // ---------------------------------------------------------
    // Step 1: Load the PDF and extract its text and bookmarks.
    // ---------------------------------------------------------

    const loader = new PdfLoader();
    const parsed = await loader.load(file);

    if (!parsed || !Array.isArray(parsed.pages)) {
      throw new Error(
        "The PDF loader did not return valid page data."
      );
    }

    console.log(`${MODULE_ID} | Parsed PDF:`, parsed);

    console.log(
      `${MODULE_ID} | PDF pages: ${parsed.pageCount ?? parsed.pages.length}`
    );

    console.log(
      `${MODULE_ID} | Top-level bookmarks: ${
        Array.isArray(parsed.bookmarks)
          ? parsed.bookmarks.length
          : 0
      }`
    );

    // ---------------------------------------------------------
    // Step 2: Find or create the destination Journal folder.
    // ---------------------------------------------------------

    ui.notifications.info("Preparing journal folder...");

    let folder = game.folders.find(
      f =>
        f.type === "JournalEntry" &&
        f.name.toLowerCase() === folderName.toLowerCase() &&
        !f.folder
    );

    if (!folder) {
      folder = await Folder.create({
        name: folderName,
        type: "JournalEntry",
        folder: null
      });
    }

    if (!folder) {
      throw new Error(
        `Could not create journal folder "${folderName}".`
      );
    }

    // ---------------------------------------------------------
    // Step 3: Detect headings.
    // ---------------------------------------------------------

    ui.notifications.info("Detecting adventure headings...");

    const headerDetector = new HeaderDetector();

    // Pass the complete PDF data so the detector can use bookmarks.
    const headers = await headerDetector.detect(parsed);

    if (!Array.isArray(headers) || headers.length === 0) {
      throw new Error(
        "No adventure headings were detected. " +
        "Check the PDF extraction and header detector."
      );
    }

    console.log(
      `${MODULE_ID} | Detected ${headers.length} headings:`,
      headers
    );

    // ---------------------------------------------------------
    // Step 4: Extract story sections.
    // ---------------------------------------------------------

    ui.notifications.info("Extracting adventure sections...");

    const storyExtractor = new StoryExtractor({
      includePageMetadata: true
    });

    const sections = storyExtractor.extract(parsed, headers);

    if (!Array.isArray(sections) || sections.length === 0) {
      throw new Error(
        "No story sections were extracted from the PDF."
      );
    }

    console.log(
      `${MODULE_ID} | Extracted ${sections.length} story sections:`,
      sections
    );

    // ---------------------------------------------------------
    // Step 5: Create journal entries.
    // ---------------------------------------------------------

    ui.notifications.info(
      `Creating ${sections.length} journal entries...`
    );

    const builder = new JournalBuilder();

    const journalMap = await builder.createJournals(
      sections,
      folder.id
    );

    if (!(journalMap instanceof Map) || journalMap.size === 0) {
      throw new Error(
        "The journal builder did not return a populated Map."
      );
    }

    console.log(
      `${MODULE_ID} | Created journal entries:`,
      journalMap
    );

    // ---------------------------------------------------------
    // Step 6: Resolve references between sections.
    // ---------------------------------------------------------

    const linkedSections = linkHeaders(sections, journalMap);

    if (!Array.isArray(linkedSections)) {
      throw new Error(
        "The header linker did not return an array of sections."
      );
    }

    console.log(
      `${MODULE_ID} | Linked sections:`,
      linkedSections
    );

    // ---------------------------------------------------------
    // Step 7: Update journal entry page content.
    // ---------------------------------------------------------

    let updatedCount = 0;
    let skippedCount = 0;

    for (const section of linkedSections) {
      const entry = journalMap.get(section.headerId);

      if (!entry) {
        console.warn(
          `${MODULE_ID} | No journal entry found for header:`,
          section.headerId,
          section.headerTitle
        );

        skippedCount++;
        continue;
      }

      const cleanedText = String(section.cleanedText ?? "").trim();

      if (!cleanedText) {
        console.warn(
          `${MODULE_ID} | Empty section text:`,
          section.headerTitle
        );

        skippedCount++;
        continue;
      }

      // Preserve the original page structure created by JournalBuilder.
      const page = entry.pages?.contents?.[0];

      if (!page) {
        console.warn(
          `${MODULE_ID} | No page found for journal entry:`,
          entry.name
        );

        skippedCount++;
        continue;
      }

      // Escapes the extracted text and turns bullets into list items.
      const paragraphs = textToHtml(cleanedText);

      // Update only the existing page's content.
      await page.update({
        "text.content": paragraphs
      });

      updatedCount++;
    }

    // ---------------------------------------------------------
    // Step 8: Report results.
    // ---------------------------------------------------------

    console.log(
      `${MODULE_ID} | Import summary:`,
      {
        fileName: file.name,
        pageCount: parsed.pageCount ?? parsed.pages.length,
        headingCount: headers.length,
        sectionCount: sections.length,
        journalEntryCount: journalMap.size,
        updatedCount,
        skippedCount
      }
    );

    ui.notifications.info(
      `Import complete. Updated ${updatedCount} journal entries.` +
      (skippedCount > 0
        ? ` Skipped ${skippedCount} sections. Check the console for details.`
        : "")
    );

  } catch (error) {
    console.error(
      `${MODULE_ID} | Import failed:`,
      error
    );

    ui.notifications.error(
      `Import failed: ${
        error.message || "An unexpected error occurred."
      } Check the browser console for details.`
    );
  }
}