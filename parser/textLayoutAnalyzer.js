/**
 * TextLayoutAnalyzer: reading-order reconstruction for PDF.js text items.
 *
 * PDF.js returns text items in the order they appear in the PDF content
 * stream, which for multi-column layouts is often *not* the visual reading
 * order (the right column may be written first, or lines from both columns
 * may be interleaved). This module rebuilds the order from geometry alone.
 *
 * Algorithm (a recursive XY-cut):
 *
 *  1. Look for a vertical gutter: a strip of x positions that almost no text
 *     covers (measured by the fraction of the region's height the text
 *     occupies, so a few lines crossing the strip do not hide it).
 *  2. Items that cross the gutter (banners, centered titles, full-width
 *     boxes) act as separators. They split the region into horizontal bands.
 *  3. Inside each band, read the left side completely, then the right side,
 *     recursing so that three columns or nested layouts also work.
 *  4. A region without a gutter is a single column and is read line by line.
 *
 * Everything here is pure geometry: no PDF.js and no Foundry APIs.
 */

const MAX_DEPTH = 6;

// A strip counts as a gutter when text covers at most this fraction of the
// busiest x position's coverage.
const GUTTER_COVERAGE = 0.15;

// Each side of a gutter must reach at least this fraction of the busiest
// x position's coverage, otherwise it is a ragged edge, not a column.
const MIN_SIDE_COVERAGE = 0.2;

// Items at least this wide (relative to the region) are always separators.
const WIDE_ITEM_RATIO = 0.6;

// An item that crosses the gutter's midline is a separator only if it
// extends at least this far (relative to the region width) on both sides.
const CROSSING_MARGIN_RATIO = 0.06;

/**
 * Convert raw item data into geometry used for ordering.
 */
function toGeometry(item, pageHeight) {
  const transform = Array.isArray(item.transform) ? item.transform : [];
  const a = Number(transform[0]) || 0;
  const b = Number(transform[1]) || 0;
  const d = Number(transform[3]) || 0;

  const fontSize = Math.hypot(a, b) || Math.abs(d) || 10;
  const height = Number(item.height) > 0 ? Number(item.height) : fontSize;

  const x0 = Number(item.x);
  const y = Number(item.y);

  let width = Number(item.width);
  if (!Number.isFinite(width) || width <= 0) {
    width = item.text.length * fontSize * 0.5;
  }

  const base = pageHeight - y;

  return {
    item,
    x0,
    x1: x0 + width,
    width,
    h: height,
    base,
    top: base - height,
    cy: base - height * 0.3,
    rotated: Math.abs(b) > Math.abs(a) * 2 && Math.abs(b) > 0.01
  };
}

/**
 * Group geometry entries into visual lines (top to bottom, left to right).
 */
function sortByLines(entries, ctx) {
  // Every call lays out one run of lines that read straight on from one to
  // the next (a column, or a block of full-width lines). Remember which, so
  // later steps know which lines can belong to the same paragraph.
  const region = ctx.nextRegion++;
  for (const entry of entries) entry.region = region;

  const sorted = [...entries].sort((p, q) => p.base - q.base || p.x0 - q.x0);
  const lines = [];

  for (const entry of sorted) {
    const line = lines[lines.length - 1];

    if (line) {
      const tolerance = Math.max(1.5, 0.35 * Math.max(entry.h, line.h));

      if (Math.abs(entry.base - line.base) <= tolerance) {
        line.entries.push(entry);
        line.h = Math.max(line.h, entry.h);
        continue;
      }
    }

    lines.push({ entries: [entry], base: entry.base, h: entry.h });
  }

  for (const line of lines) {
    line.entries.sort((p, q) => p.x0 - q.x0);
  }

  return lines.map(line => line.entries);
}

/**
 * Find the vertical gutter of a region, if it has one.
 *
 * @returns {{start:number,end:number,mid:number}|null}
 */
function findGutter(entries, pageWidth) {
  if (entries.length < 8) return null;

  const left = Math.min(...entries.map(e => e.x0));
  const right = Math.max(...entries.map(e => e.x1));
  const regionWidth = right - left;

  if (!(regionWidth > 0)) return null;

  const body = entries.filter(e => e.width < regionWidth * WIDE_ITEM_RATIO);
  if (body.length < 6) return null;

  const bodyLeft = Math.floor(Math.min(...body.map(e => e.x0)));
  const bodyRight = Math.ceil(Math.max(...body.map(e => e.x1)));
  const top = Math.min(...body.map(e => e.top));
  const bottom = Math.max(...body.map(e => e.base));

  if (!(bodyRight - bodyLeft > 40) || !(bottom - top > 0)) return null;

  // Per-x list of the vertical intervals covered by text.
  const bins = Array.from({ length: bodyRight - bodyLeft + 1 }, () => null);

  for (const e of body) {
    const from = Math.max(bodyLeft, Math.floor(e.x0));
    const to = Math.min(bodyRight, Math.ceil(e.x1));

    for (let x = from; x <= to; x++) {
      (bins[x - bodyLeft] ??= []).push([e.top, e.base]);
    }
  }

  const coverage = bins.map(intervals => {
    if (!intervals) return 0;

    intervals.sort((p, q) => p[0] - q[0]);

    let total = 0;
    let [start, end] = intervals[0];

    for (let i = 1; i < intervals.length; i++) {
      const [s, e] = intervals[i];

      if (s <= end) {
        end = Math.max(end, e);
      } else {
        total += end - start;
        start = s;
        end = e;
      }
    }

    return total + (end - start);
  });

  const peak = Math.max(...coverage);
  if (!(peak > 0)) return null;

  const minGutter = Math.max(5, (pageWidth || regionWidth) * 0.01);
  const threshold = peak * GUTTER_COVERAGE;

  // Find runs of low coverage that do not touch either edge of the text.
  let best = null;
  let runStart = -1;

  for (let i = 0; i <= coverage.length; i++) {
    const low = i < coverage.length && coverage[i] <= threshold;

    if (low && runStart < 0) runStart = i;

    if (!low && runStart >= 0) {
      const runEnd = i - 1;
      const touchesEdge = runStart === 0 || runEnd === coverage.length - 1;
      const width = runEnd - runStart + 1;

      if (!touchesEdge && width >= minGutter) {
        if (!best || width > best.width) {
          best = { from: runStart, to: runEnd, width };
        }
      }

      runStart = -1;
    }
  }

  if (!best) return null;

  const start = bodyLeft + best.from;
  const end = bodyLeft + best.to;

  // Center the split on the emptiest part of the run.
  const quiet = threshold * 0.15;
  let quietFrom = -1;
  let quietTo = -1;

  for (let i = best.from; i <= best.to; i++) {
    if (coverage[i] <= quiet) {
      if (quietFrom < 0) quietFrom = i;
      quietTo = i;
    }
  }

  const mid = quietFrom >= 0
    ? bodyLeft + (quietFrom + quietTo) / 2
    : (start + end) / 2;

  // Both sides must be dense columns. A ragged right edge that only a few
  // long lines poke past is not a column: its coverage stays low.
  const sidePeak = (from, to) => {
    let max = 0;
    for (let i = from; i <= to; i++) max = Math.max(max, coverage[i]);
    return max;
  };

  if (
    sidePeak(0, best.from - 1) < peak * MIN_SIDE_COVERAGE ||
    sidePeak(best.to + 1, coverage.length - 1) < peak * MIN_SIDE_COVERAGE
  ) {
    return null;
  }

  // Both sides must contain real content.
  const leftCount = body.filter(e => e.x0 + e.width / 2 < mid).length;
  const rightCount = body.length - leftCount;

  if (leftCount < 3 || rightCount < 3) return null;

  return { start, end, mid, regionWidth };
}

/**
 * Recursively order the entries of one region.
 * Returns an array of lines; each line is an array of geometry entries.
 */
function layoutRegion(entries, pageWidth, ctx, depth = 0) {
  if (entries.length <= 1) {
    return entries.length ? [[entries[0]]] : [];
  }

  const gutter = depth < MAX_DEPTH ? findGutter(entries, pageWidth) : null;

  if (!gutter) {
    return sortByLines(entries, ctx);
  }

  const margin = gutter.regionWidth * CROSSING_MARGIN_RATIO;

  const isSeparator = e =>
    e.width >= gutter.regionWidth * WIDE_ITEM_RATIO ||
    (e.x0 < gutter.mid - margin && e.x1 > gutter.mid + margin);

  const separators = entries
    .filter(isSeparator)
    .sort((p, q) => p.cy - q.cy);

  const others = entries.filter(e => !isSeparator(e));

  // Assign every non-separator to the band following the separators above it.
  const bands = separators.map(() => ({ left: [], right: [] }));
  bands.push({ left: [], right: [] });

  for (const e of others) {
    let bandIndex = 0;

    while (bandIndex < separators.length && separators[bandIndex].cy < e.cy) {
      bandIndex++;
    }

    const side = e.x0 + e.width / 2 < gutter.mid ? "left" : "right";
    bands[bandIndex][side].push(e);
  }

  const lines = [];
  let pendingSeparators = [];

  const flushSeparators = () => {
    if (pendingSeparators.length) {
      lines.push(...sortByLines(pendingSeparators, ctx));
      pendingSeparators = [];
    }
  };

  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];

    if (band.left.length || band.right.length) {
      flushSeparators();
      lines.push(...layoutRegion(band.left, pageWidth, ctx, depth + 1));
      lines.push(...layoutRegion(band.right, pageWidth, ctx, depth + 1));
    }

    if (i < separators.length) {
      pendingSeparators.push(separators[i]);
    }
  }

  flushSeparators();

  return lines;
}

/**
 * Decide the text placed between two neighbouring items on a line.
 */
function joiner(prev, next) {
  const prevText = prev.item.text;
  const nextText = next.item.text;

  if (/\s$/.test(prevText) || /^\s/.test(nextText)) return " ";

  const gap = next.x0 - prev.x1;
  return gap > Math.max(0.5, 0.15 * Math.min(prev.h, next.h)) ? " " : "";
}

/**
 * Put a page's text items into reading order.
 *
 * @param {Array<Object>} items Items with text, x, y, width, height, transform.
 * @param {{width:number,height:number}} page
 * @returns {{lines: Array<Array<Object>>, dropped: Array<Object>}}
 *   lines: items grouped into visual lines in reading order, each item
 *   annotated with `geometry`-independent data only (original objects).
 *   dropped: whitespace-only or unplaceable items (not part of the text).
 */
/**
 * Some PDFs draw a line of text twice at the same spot (a link layer, a fake
 * bold). Keep one of each, so it is not read twice.
 */
export function dropDuplicateItems(items, tolerance = 0.5) {
  const seen = new Map();
  const kept = [];

  for (const item of items) {
    const text = typeof item.text === "string" ? item.text.trim() : "";

    if (text) {
      const key = text + "|" + Math.round(Number(item.y) / 2);
      const same = seen.get(key) ?? [];

      if (
        same.some(
          other =>
            Math.abs(other.x - item.x) <= tolerance &&
            Math.abs(other.y - item.y) <= tolerance
        )
      ) {
        continue;
      }

      same.push(item);
      seen.set(key, same);
    }

    kept.push(item);
  }

  return kept;
}

export function orderPageItems(items, page) {
  const pageHeight = Number(page?.height) || 0;
  const pageWidth = Number(page?.width) || 0;

  const usable = [];
  const rotated = [];
  const dropped = [];

  for (const item of items) {
    if (
      typeof item.text !== "string" ||
      !item.text.trim() ||
      !Number.isFinite(Number(item.x)) ||
      !Number.isFinite(Number(item.y))
    ) {
      dropped.push(item);
      continue;
    }

    const entry = toGeometry(item, pageHeight);

    (entry.rotated ? rotated : usable).push(entry);
  }

  const ctx = { nextRegion: 0 };
  const lines = layoutRegion(usable, pageWidth, ctx);

  // Rotated text (spine labels, margin notes) goes last, in stream order.
  for (const entry of rotated) {
    entry.region = ctx.nextRegion++;
    lines.push([entry]);
  }

  return {
    lines: lines.map(line =>
      line.map((entry, index) => ({
        item: entry.item,
        separator: index === 0 ? "" : joiner(line[index - 1], entry)
      }))
    ),

    // Geometry of each line, parallel to `lines`, used to rebuild paragraphs.
    lineMetrics: lines.map(line => {
      // Bullets, tier symbols and ornaments are separate one-character
      // items in a larger font; they must not change a line's size or
      // left edge.
      const words = line.filter(entry => {
        const text = entry.item.text.trim();
        return text.length > 2 || /[\p{L}\p{N}]/u.test(text);
      });

      const body = words.length ? words : line;

      // A page number closing the line, set well apart from the text before
      // it ("Setup ........ 3"): the mark of a contents or index line.
      const last = line[line.length - 1];
      const before = line[line.length - 2];
      const endsWithPageNumber =
        line.length >= 2 &&
        /^\d{1,4}$/.test(last.item.text.trim()) &&
        /\p{L}/u.test(line.slice(0, -1).map(entry => entry.item.text).join("")) &&
        last.x0 - before.x1 >= 12;

      return {
        pageNumberX: endsWithPageNumber ? last.x1 : null,
        region: line[0].region,
        minX: Math.min(...body.map(entry => entry.x0)),
        maxX: Math.max(...line.map(entry => entry.x1)),
        base: line[0].base,
        height: Math.max(...body.map(entry => entry.h))
      };
    }),
    dropped
  };
}


function isRotated(item) {
  const t = Array.isArray(item.transform) ? item.transform : [];
  return Math.abs(Number(t[1]) || 0) > Math.abs(Number(t[0]) || 0) * 2;
}

/**
 * Find running headers, footers, page numbers and margin labels.
 *
 * An item counts as page furniture when it sits in the outer margin of its
 * page and the same text (digits ignored, so "4" and "17" match) appears at
 * the same height on several pages. Body text is never repeated like that.
 *
 * @param {Array<{width:number,height:number,items:Array<Object>}>} pages
 * @returns {Set<Object>} The items to drop.
 */
export function findRunningFurniture(pages, {
  marginRatio = 0.05,
  minPages = 3,
  minPageFraction = 0,
  maxLength = 60
} = {}) {
  const groups = new Map();

  pages.forEach((page, pageIndex) => {
    const width = Number(page.width) || 0;
    const height = Number(page.height) || 0;

    if (!width || !height) return;

    for (const item of page.items) {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      const x = Number(item.x);
      const y = Number(item.y);

      if (!text || text.length > maxLength) continue;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const itemWidth = Number(item.width) || 0;

      const inMargin =
        y < height * marginRatio ||
        y > height * (1 - marginRatio) ||
        x < width * marginRatio ||
        x + itemWidth > width * (1 - marginRatio);

      if (!inMargin) continue;

      // Same text, same height (4pt buckets), same side of the page.
      const key = [
        text.toLowerCase().replace(/\d+/g, "#"),
        Math.round(y / 4),
        x < width / 2 ? "L" : "R"
      ].join("|");

      let group = groups.get(key);

      if (!group) {
        group = { pages: new Set(), items: [], rotated: isRotated(item) };
        groups.set(key, group);
      }

      group.pages.add(pageIndex);
      group.items.push(item);
    }
  });

  const needed = Math.max(minPages, Math.ceil(pages.length * minPageFraction));
  const furniture = new Set();

  for (const group of groups.values()) {
    // Vertical text in a margin is a running label (often only on odd or
    // even pages), so two pages are enough.
    const required = group.rotated ? Math.min(2, needed) : needed;

    if (group.pages.size >= Math.min(required, pages.length)) {
      for (const item of group.items) furniture.add(item);
    }
  }

  // Page numbers alternate sides on facing pages, so also match digits-only
  // items regardless of side.
  const numbers = new Map();

  pages.forEach((page, pageIndex) => {
    const height = Number(page.height) || 0;

    for (const item of page.items) {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      const y = Number(item.y);

      if (!/^\d{1,4}$/.test(text) || !Number.isFinite(y) || !height) continue;
      if (y >= height * marginRatio && y <= height * (1 - marginRatio)) continue;

      const key = Math.round(y / 4);
      const group = numbers.get(key) ?? { pages: new Set(), items: [] };

      group.pages.add(pageIndex);
      group.items.push(item);
      numbers.set(key, group);
    }
  });

  for (const group of numbers.values()) {
    if (group.pages.size >= Math.min(needed, pages.length)) {
      for (const item of group.items) furniture.add(item);
    }
  }

  return furniture;
}
