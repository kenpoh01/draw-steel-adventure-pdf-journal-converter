/**
 * Converts extracted plain text into journal HTML.
 *
 * Blank lines separate paragraphs. Consecutive paragraphs that start with a
 * bullet ("• ") become one <ul> list; everything else becomes <p>. A single
 * line break inside a paragraph is kept as <br>. A table marker left by the
 * table extractor becomes an HTML <table>.
 */

import { decodeTable } from "../parser/tableExtractor.js";

const BULLET_PREFIX = /^•\s*/;

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(text) {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

/**
 * A table from the extractor as an HTML table: the title as a bold line, the
 * first row as headers, and a line break wherever a cell holds several lines.
 */
export function tableToHtml(table) {
  const cell = (tag, text) => `<${tag}>${inline(text)}</${tag}>`;

  const head = `<thead><tr>${table.header.map(text => cell("th", text)).join("")}</tr></thead>`;
  const body = table.rows
    .map(row => `<tr>${row.map(text => cell("td", text)).join("")}</tr>`)
    .join("");

  const title = table.title ? `<p><strong>${escapeHtml(table.title)}</strong></p>` : "";

  return `${title}<table>${head}<tbody>${body}</tbody></table>`;
}

// The tier 1, 2 and 3 icons are drawn with a symbol font, so different
// adventures extract them as different characters. Each entry is one set,
// listed as [tier 1, tier 2, tier 3]. Add a set here to support another PDF.
export const TIER_GLYPH_SETS = [
  ["!", "@", "#"],
  ["á", "é", "í"]
];

// The output always uses the standard symbols, whatever the PDF used.
const TIER_SYMBOLS = ["!", "@", "#"];

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TIER_STARTS = TIER_GLYPH_SETS.map(set =>
  set.map(glyph => new RegExp(`^${escapeRegExp(glyph)}\\s+`))
);

const MAX_TIER_CONTINUATION = 2;

/**
 * Tests list their three outcomes with the tier symbols ! (tier 1),
 * @ (tier 2) and # (tier 3). Starting at `start`, read one complete set of
 * three and return it as a Draw Steel power-roll list:
 *
 *   <dl class="power-roll-display">
 *     <dt class="tier1"><p>!</p></dt><dd><p>…</p></dd> …
 *
 * A tier may continue in following paragraphs ("Decrement the countdown by
 * 2."), up to the next tier symbol. Anything that is not a full !, @, #
 * sequence is not a power roll and returns null.
 */
function readTierSet(paragraphs, start) {
  for (const starts of TIER_STARTS) {
    const found = readTierSetWith(starts, paragraphs, start);
    if (found) return found;
  }

  for (const set of TIER_GLYPH_SETS) {
    const inline = readInlineTierSet(set, paragraphs[start] ?? "");
    if (inline) return { html: tierListHtml(inline), next: start + 1 };
  }

  return null;
}

/**
 * All three tiers in one paragraph ("á 4 damage é 6 damage í 7 damage").
 */
function readInlineTierSet(set, paragraph) {
  const [first, second, third] = set.map(escapeRegExp);

  const match = new RegExp(
    `^${first}\\s+(.+?)\\s+${second}\\s+(.+?)\\s+${third}\\s+(.+)$`,
    "s"
  ).exec(paragraph);

  return match ? [[match[1]], [match[2]], [match[3]]] : null;
}

function tierListHtml(results) {
  const items = results
    .map(
      (texts, tier) =>
        `<dt class="tier${tier + 1}"><p>${TIER_SYMBOLS[tier]}</p></dt>` +
        `<dd>${texts.map(text => `<p>${inline(text)}</p>`).join("")}</dd>`
    )
    .join("");

  return `<dl class="power-roll-display">${items}</dl>`;
}

function readTierSetWith(TIER_START, paragraphs, start) {
  const results = [];
  let index = start;

  for (let tier = 0; tier < 3; tier++) {
    if (!TIER_START[tier].test(paragraphs[index] ?? "")) return null;

    const texts = [paragraphs[index].replace(TIER_START[tier], "")];
    index++;

    if (tier < 2) {
      let extra = 0;

      while (index < paragraphs.length && !TIER_START[tier + 1].test(paragraphs[index])) {
        // A line that starts in lower case is the same sentence, wrapped.
        if (/^\p{Ll}/u.test(paragraphs[index])) {
          texts[texts.length - 1] += " " + paragraphs[index];
        } else {
          if (++extra > MAX_TIER_CONTINUATION) return null;
          texts.push(paragraphs[index]);
        }
        index++;
      }

      if (index >= paragraphs.length) return null;
    }

    results.push(texts);
  }

  return { html: tierListHtml(results), next: index };
}

// Callout boxes (sidebars, warnings, read-aloud notes) are opened by a lone
// "®" and closed by a lone "£", both drawn with the symbol font. They become
// the Draw Steel system's "Boxed Aside" (<aside class="boxed">). Change the
// class here to use another of its formats (e.g. "callout").
const CALLOUT_OPEN = "®";
const CALLOUT_CLOSE = "£";
export const CALLOUT_CLASS = "boxed";

// A callout's first paragraph is its title when it is short and not a
// sentence.
const MAX_CALLOUT_TITLE = 80;

function calloutToHtml(inner) {
  const [first, ...rest] = inner;

  const hasTitle =
    first !== undefined &&
    rest.length > 0 &&
    first.length <= MAX_CALLOUT_TITLE &&
    !BULLET_PREFIX.test(first) &&
    !/[.,;:]$/.test(first) &&
    !decodeTable(first);

  const title = hasTitle ? `<p><strong>${inline(first)}</strong></p>` : "";

  return (
    `<aside class="${CALLOUT_CLASS}">` +
    title +
    paragraphsToHtml(hasTitle ? rest : inner) +
    "</aside>"
  );
}

function paragraphsToHtml(paragraphs) {
  const html = [];
  let listItems = [];

  const closeList = () => {
    if (listItems.length) {
      html.push(`<ul>${listItems.join("")}</ul>`);
      listItems = [];
    }
  };

  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];

    if (paragraph === CALLOUT_OPEN) {
      const close = paragraphs.indexOf(CALLOUT_CLOSE, index + 1);

      if (close !== -1) {
        closeList();
        html.push(calloutToHtml(paragraphs.slice(index + 1, close)));
        index = close;
      }

      // A lone ornament with no partner is decoration, not text.
      continue;
    }

    if (paragraph === CALLOUT_CLOSE) continue;

    const tiers = readTierSet(paragraphs, index);

    if (tiers) {
      closeList();
      html.push(tiers.html);
      index = tiers.next - 1;
      continue;
    }

    const table = decodeTable(paragraph);

    if (table) {
      closeList();
      html.push(tableToHtml(table));
      continue;
    }

    if (BULLET_PREFIX.test(paragraph)) {
      listItems.push(`<li>${inline(paragraph.replace(BULLET_PREFIX, ""))}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inline(paragraph)}</p>`);
  }

  closeList();

  return html.join("");
}

export function textToHtml(text) {
  const paragraphs = String(text ?? "")
    .trim()
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

  return paragraphsToHtml(paragraphs);
}
