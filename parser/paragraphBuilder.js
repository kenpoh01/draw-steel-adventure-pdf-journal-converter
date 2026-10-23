/**
 * Decides which line breaks in a PDF are real and which are just the
 * text wrapping at the edge of a column.
 *
 * PDFs store text one visual line at a time. Joining those lines with "\n"
 * puts a line break in the middle of every sentence, so this module looks
 * at the geometry of neighbouring lines and keeps a break only where the
 * paragraph really ends.
 *
 * Two lines are one paragraph when all of these hold:
 *  - they are in the same column (or full-width block),
 *  - the second sits directly below the first at the normal line spacing,
 *  - they are the same size,
 *  - the second starts at about the same left edge,
 *  - the first line is full: the next line's first word would not have fit
 *    in the space left at the end of it (a short line ends a paragraph), and
 *  - the second does not start with a bullet or a list number, and
 *  - the first does not end a sentence that the second begins a new one
 *    after (an ambiguous case, resolved in favour of a paragraph break).
 */

import { TABLE_MARKER } from "./tableExtractor.js";

const BULLET_START = /^(?:[^\p{L}\p{N}\s"“”‘’'(\[.…]|\d{1,2}[.)]\s)/u;

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function median(values) {
  return values.length ? percentile(values, 0.5) : 0;
}

/**
 * Lines of a table of contents (or index) each end in a page number, and
 * those numbers line up in a column. Returns the indexes of such lines: a
 * line counts when at least three lines of its region end in a page number
 * at the same x.
 */
function contentsLines(metrics) {
  const found = new Set();

  metrics.forEach((line, index) => {
    if (line.pageNumberX == null) return;

    const aligned = metrics.filter(
      other =>
        other.region === line.region &&
        other.pageNumberX != null &&
        Math.abs(other.pageNumberX - line.pageNumberX) <= 3
    );

    if (aligned.length >= 3) found.add(index);
  });

  return found;
}

const EDGE_TOLERANCE = 8;
const EDGE_MIN_LINES = 3;
const EDGE_MIN_SHARE = 0.5;

/**
 * Text set inside a box ends short of the column's right edge. The lines of
 * such a block share a left edge of their own, so look at the lines of this
 * column that start at the same x: where at least three long lines stop
 * together, that is this block's right edge.
 */
function localRightEdge(metrics, index, columnEdge, isTable) {
  const line = metrics[index];
  const same = [];

  metrics.forEach((other, k) => {
    if (
      other.region === line.region &&
      !isTable(k) &&
      Math.abs(other.minX - line.minX) <= 3
    ) {
      same.push(other.maxX);
    }
  });

  if (same.length < EDGE_MIN_LINES) return columnEdge;

  same.sort((a, b) => b - a);

  for (const edge of same) {
    if (edge >= columnEdge) continue;

    // A block narrower than most of the column is a list of short lines
    // (a stat block, credits), not wrapped text in a box.
    if (edge - line.minX < 0.6 * (columnEdge - line.minX)) break;

    // Long lines that stop within a few points of this x.
    const cluster = same.filter(
      x =>
        edge - x <= EDGE_TOLERANCE &&
        x - line.minX >= 0.6 * (edge - line.minX)
    );

    if (cluster.length >= EDGE_MIN_LINES && cluster.length / same.length >= EDGE_MIN_SHARE) {
      return edge;
    }
  }

  return columnEdge;
}

/**
 * @param {Array<string>} texts The text of each line, in reading order.
 * @param {Array<Object>} metrics Line geometry from orderPageItems().
 * @returns {Array<string>} For each line, what follows it: " " (same
 *   paragraph), "" (a hyphenated word continues), "\n\n" (new paragraph) or
 *   "" for the last line.
 */
export function chooseLineConnectors(texts, metrics) {
  const regions = new Map();

  const isTable = index => TABLE_MARKER.test(String(texts[index]).trim());

  metrics.forEach((line, index) => {
    // A table's width says nothing about where a column's text ends.
    if (isTable(index)) return;
    if (!regions.has(line.region)) regions.set(line.region, []);
    regions.get(line.region).push(index);
  });

  // Per region: right edge and normal line spacing.
  const stats = new Map();

  for (const [region, indexes] of regions) {
    const lines = indexes.map(index => metrics[index]);

    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i].base - lines[i - 1].base;
      if (gap > 0) gaps.push(gap);
    }

    stats.set(region, {
      rightEdge: lines.length >= 4
        ? percentile(lines.map(line => line.maxX), 0.9)
        : Math.max(...lines.map(line => line.maxX)),
      spacing: median(gaps)
    });
  }

  const contents = contentsLines(metrics);

  return metrics.map((line, index) => {
    const next = metrics[index + 1];

    // Consecutive lines of a table of contents stay on separate lines.
    if (next && contents.has(index) && contents.has(index + 1)) return "\n";

    if (!next) return "";
    if (next.region !== line.region) return "\n\n";

    // A table is always a block of its own.
    if (isTable(index) || isTable(index + 1)) return "\n\n";

    const { rightEdge: columnEdge, spacing } = stats.get(line.region);

    // Text set inside a box ends short of the column's right edge. When
    // several nearby lines with this line's left edge all stop at one x,
    // that x is the edge of this block.
    const rightEdge = localRightEdge(metrics, index, columnEdge, isTable);

    const gap = next.base - line.base;
    const sameSpacing = gap > 0 && (!spacing || gap <= spacing * 1.25);
    const sameSize = Math.abs(next.height - line.height) <= 0.6;
    const sameLeft = Math.abs(next.minX - line.minX) <= 14;

    // Text wraps when the next word would not fit in the room left on the
    // line. If it would have fit, the paragraph really ended here.
    const nextText = texts[index + 1].trim();
    const averageChar =
      (next.maxX - next.minX) / Math.max(1, nextText.length);
    const nextWordWidth = nextText.split(/\s+/)[0].length * averageChar;
    const fillsLine = rightEdge - line.maxX < nextWordWidth + 6 * averageChar;
    const startsItem = BULLET_START.test(texts[index + 1].trim());

    // A line that finishes a sentence and is followed by a new sentence is
    // ambiguous: the paragraph may have ended exactly at the margin, or the
    // text may simply have wrapped there. Geometry cannot tell them apart,
    // so favour the break: a split between two sentences is harmless, while
    // two merged paragraphs are not.
    const endsSentence =
      /[.!?]["”’)\]]*$/u.test(texts[index].trim()) &&
      /^[\p{Lu}\p{N}"“‘'(]/u.test(nextText);

    if (
      !(sameSpacing && sameSize && sameLeft && fillsLine) ||
      startsItem ||
      endsSentence
    ) {
      return "\n\n";
    }

    // A word hyphenated at the end of a line continues on the next one.
    if (/\p{L}-$/u.test(texts[index]) && /^\p{Ll}/u.test(texts[index + 1])) {
      return "";
    }

    return " ";
  });
}
