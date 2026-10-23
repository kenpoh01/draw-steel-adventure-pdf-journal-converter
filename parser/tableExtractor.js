/**
 * Finds tables in a page's PDF.js text items and turns each into a small
 * data structure ({ title, header, rows }).
 *
 * How a table is recognised (this matches the Draw Steel adventure layout):
 *
 *   ®  Table Title  ®        <- a title bar: ornament glyphs on both sides
 *   Header  Header           <- first line below the title
 *   cell    cell             <- body rows
 *             £              <- an ornament that closes the table
 *
 * Everything between the title bar and the closing ornament, in the same
 * column of the page, belongs to the table. Columns are taken from the
 * header line, and rows from the vertical spacing of the body text (a cell
 * that wraps onto several lines stays inside its row).
 *
 * The table's items are replaced by one placeholder item. Its text is a
 * marker ("⟦t<hex>⟧") that carries the whole table, so the table
 * travels through reading order, paragraph building and header linking as an
 * ordinary line of text and is turned into HTML at the very end.
 */

const TITLE_GLYPH = "®";
const END_GLYPH = "£";

export const TABLE_MARKER = /^⟦t([0-9a-f]+)⟧$/;

// Vertical distance (points) within which two items share a line.
const SAME_LINE = 1.2;

// A table narrower than this many columns is not treated as a table.
const MIN_COLUMNS = 2;

// A table whose centre is this close to the page centre spans both columns.
const FULL_WIDTH_CENTER = 0.1;

/**
 * Encode a table as a single-token marker.
 */
export function encodeTable(table) {
  const bytes = new TextEncoder().encode(JSON.stringify(table));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `⟦t${hex}⟧`;
}

/**
 * Decode a marker produced by encodeTable(); null if it is not one.
 */
export function decodeTable(marker) {
  const match = TABLE_MARKER.exec(String(marker).trim());
  if (!match) return null;

  try {
    const hex = match[1];
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function box(item) {
  const x0 = Number(item.x);
  const width = Number(item.width) || 0;
  return {
    item,
    text: String(item.text ?? "").trim(),
    x0,
    x1: x0 + width,
    y: Number(item.y),
    h: Number(item.height) || 0
  };
}

/**
 * Group boxes into lines by y (top to bottom); each line is sorted by x.
 */
function toLines(boxes) {
  const sorted = [...boxes].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const lines = [];

  for (const entry of sorted) {
    const line = lines[lines.length - 1];

    if (line && Math.abs(line.y - entry.y) <= SAME_LINE) {
      line.boxes.push(entry);
    } else {
      lines.push({ y: entry.y, boxes: [entry] });
    }
  }

  for (const line of lines) line.boxes.sort((a, b) => a.x0 - b.x0);
  return lines;
}

/**
 * Join the text of boxes that sit on one line, inserting a space wherever
 * there is a visible gap.
 */
function joinBoxes(boxes) {
  let text = "";
  let previous = null;

  for (const entry of boxes) {
    if (previous) {
      const gap = entry.x0 - previous.x1;
      const size = Math.max(entry.h, previous.h, 1);
      if (gap > size * 0.12) text += " ";
    }
    text += entry.text;
    previous = entry;
  }

  return text.replace(/\s+/g, " ").trim();
}

/**
 * Header cells: neighbouring words of the first line merge into one cell
 * when they are close together ("Success" "Limit").
 */
function headerCells(line) {
  const cells = [];

  for (const entry of line.boxes) {
    const last = cells[cells.length - 1];
    const size = Math.max(entry.h, 1);

    if (last && entry.x0 - last.x1 <= size * 1.0) {
      last.text = joinBoxes([...last.boxes, entry]);
      last.boxes.push(entry);
      last.x1 = Math.max(last.x1, entry.x1);
    } else {
      cells.push({ boxes: [entry], text: entry.text, x0: entry.x0, x1: entry.x1 });
    }
  }

  return cells;
}

/**
 * Start a new row wherever the vertical gap between body lines is clearly
 * larger than the gap inside a wrapped cell. When all gaps are alike, every
 * line is a row.
 */
function groupRows(lines) {
  if (lines.length === 0) return [];

  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(lines[i - 1].y - lines[i].y);
  }

  const rows = [[lines[0]]];
  if (gaps.length === 0) return rows;

  const small = Math.min(...gaps);
  const large = Math.max(...gaps);
  const varied = large > small * 1.3;
  const cut = (small + large) / 2;

  gaps.forEach((gap, index) => {
    if (!varied || gap > cut) {
      rows.push([lines[index + 1]]);
    } else {
      rows[rows.length - 1].push(lines[index + 1]);
    }
  });

  return rows;
}

/**
 * Locate the ® … ® title bars on a page.
 */
function findTitleBars(boxes) {
  const glyphs = boxes
    .filter(entry => entry.text === TITLE_GLYPH)
    .sort((a, b) => b.y - a.y || a.x0 - b.x0);

  const used = new Set();
  const bars = [];

  for (const left of glyphs) {
    if (used.has(left)) continue;

    const right = glyphs.find(
      other =>
        other !== left &&
        !used.has(other) &&
        other.x0 > left.x1 &&
        Math.abs(other.y - left.y) <= 3
    );

    if (!right) continue;

    const words = boxes.filter(
      entry =>
        entry.text &&
        entry.text !== TITLE_GLYPH &&
        entry.x0 >= left.x1 - 1 &&
        entry.x1 <= right.x0 + 1 &&
        Math.abs(entry.y - left.y) <= 3
    );

    if (words.length === 0) continue;

    words.sort((a, b) => a.x0 - b.x0);

    used.add(left);
    used.add(right);

    bars.push({
      left,
      right,
      words,
      title: joinBoxes(words),
      y: Math.max(...words.map(entry => entry.y)),
      center: (left.x0 + right.x1) / 2
    });
  }

  return bars.sort((a, b) => b.y - a.y);
}

/**
 * Turn the items of one table (header line first) into columns and rows.
 */
function buildTable(title, bodyBoxes) {
  const lines = toLines(bodyBoxes);
  if (lines.length < 2) return null;

  const [headLine, ...bodyLines] = lines;
  const heads = headerCells(headLine);
  if (heads.length < MIN_COLUMNS) return null;

  // Column boundaries sit midway between neighbouring header cells.
  const bounds = [];
  for (let i = 1; i < heads.length; i++) {
    bounds.push((heads[i - 1].x1 + heads[i].x0) / 2);
  }

  const columnOf = entry => {
    let column = 0;
    while (column < bounds.length && entry.x0 >= bounds[column]) column++;
    return column;
  };

  const rows = groupRows(bodyLines).map(rowLines => {
    const cells = heads.map(() => []);

    for (const line of rowLines) {
      const perColumn = heads.map(() => []);
      for (const entry of line.boxes) perColumn[columnOf(entry)].push(entry);

      perColumn.forEach((boxes, column) => {
        if (boxes.length) {
          cells[column].push({
            text: joinBoxes(boxes),
            x0: boxes[0].x0,
            x1: boxes[boxes.length - 1].x1
          });
        }
      });
    }

    return cells;
  });

  // Widest line per column: a line much shorter than that was ended on
  // purpose (a new entry), a full-width one is wrapped text.
  const widest = heads.map((_, column) =>
    Math.max(
      0,
      ...rows.flatMap(row => row[column].map(line => line.x1 - line.x0))
    )
  );

  // Lines of one cell are separate entries ("One torlas (captain)" /
  // "Four frenzieds (minion squad)") unless the first one is plainly
  // wrapped text: the next line starts in lower case, or the first fills
  // the column and does not end a phrase.
  const cellText = (lines, column) => {
    let text = "";

    lines.forEach((line, index) => {
      if (index > 0) {
        const previous = lines[index - 1];
        const full = previous.x1 - previous.x0 >= widest[column] * 0.9;
        const endsPhrase = /[.)!?:;]$/.test(previous.text);

        if (/-$/.test(previous.text) && /^\p{Ll}/u.test(line.text)) {
          text = text.slice(0, -1);
        } else if (/^\p{Ll}/u.test(line.text) || (full && !endsPhrase)) {
          text += " ";
        } else {
          text += "\n";
        }
      }
      text += line.text;
    });

    return text;
  };

  return {
    title,
    header: heads.map(cell => cell.text),
    rows: rows.map(row => row.map((lines, column) => cellText(lines, column)))
  };
}

/**
 * @param {Array<Object>} items Raw text items (text, x, y, width, height…).
 * @param {{width:number,height:number}} page
 * @returns {{ items: Array<Object>, tables: Array<Object> }} The items with
 *   every table replaced by one marker item, and the tables found.
 */
/**
 * Some adventures draw the title bar and the closing ornament as artwork, so
 * the text has no ® or £ to anchor on. The text layout still gives the table
 * away:
 *
 *   Title                 <- one item, larger than the header
 *   Header   Header       <- two or more cells, all one size
 *   cell     cell         <- body lines, set smaller than the header
 *
 * The body ends at the first line that is larger than that or sits far below.
 */
function findPlainTables(boxes, taken, pageWidth) {
  const middle = pageWidth / 2;
  const columns = [
    entry => (entry.x0 + entry.x1) / 2 <= middle,
    entry => (entry.x0 + entry.x1) / 2 > middle,
    () => true
  ];

  const found = [];

  for (const inColumn of columns) {
    const pool = boxes.filter(
      entry => entry.text && !taken.has(entry.item) && inColumn(entry)
    );
    const lines = toLines(pool);

    for (let index = 0; index + 2 < lines.length; index++) {
      const titleLine = lines[index];
      const headLine = lines[index + 1];

      if (titleLine.boxes.length !== 1) continue;

      const title = titleLine.boxes[0];
      if (title.text.length < 3) continue;

      const heads = headerCells(headLine);
      if (heads.length < MIN_COLUMNS) continue;

      const headHeight = Math.max(...headLine.boxes.map(entry => entry.h));
      if (headLine.boxes.some(entry => Math.abs(entry.h - headHeight) > 0.5)) continue;
      // A table title is only a little larger than its header row; a page
      // title above a list of entries (a table of contents) is far larger.
      if (title.h < headHeight + 1 || title.h > headHeight * 2) continue;
      if (titleLine.y - headLine.y > Math.max(title.h * 2.5, 20)) continue;

      const bodyLines = [];
      let previousY = headLine.y;

      for (let next = index + 2; next < lines.length; next++) {
        const line = lines[next];
        const height = Math.max(...line.boxes.map(entry => entry.h));

        if (height > headHeight - 0.4 || previousY - line.y > 22) break;

        bodyLines.push(line);
        previousY = line.y;
      }

      if (bodyLines.length === 0) continue;

      // The first body cell sits under the first header cell.
      const first = bodyLines[0].boxes[0];
      const firstHead = heads[0];
      const underFirst =
        Math.abs(first.x0 - firstHead.x0) <= 12 ||
        ((first.x0 + first.x1) / 2 >= firstHead.x0 - 6 &&
          (first.x0 + first.x1) / 2 <= firstHead.x1 + 6);
      if (!underFirst) continue;

      const bodyBoxes = bodyLines.flatMap(line => line.boxes);
      const left = Math.min(...bodyBoxes.map(entry => entry.x0), ...headLine.boxes.map(entry => entry.x0));
      const right = Math.max(...bodyBoxes.map(entry => entry.x1), ...headLine.boxes.map(entry => entry.x1));

      // The title is centred over the table.
      const center = (title.x0 + title.x1) / 2;
      if (Math.abs(center - (left + right) / 2) > (right - left) * 0.25 + 6) continue;

      const table = buildTable(title.text, [...headLine.boxes, ...bodyBoxes]);
      if (!table || table.rows.length === 0) continue;

      const members = [title, ...headLine.boxes, ...bodyBoxes];
      for (const member of members) taken.add(member.item);

      found.push({ table, members, title, left, right });
      index += bodyLines.length + 1;
    }
  }

  return found;
}

/**
 * @param {Array<Object>} items Raw text items (text, x, y, width, height…).
 * @param {{width:number,height:number}} page
 * @returns {{ items: Array<Object>, tables: Array<Object> }} The items with
 *   every table replaced by one marker item, and the tables found.
 */
export function extractTables(items, page) {
  const pageWidth = Number(page?.width) || 0;
  const boxes = items
    .filter(item => Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)))
    .map(box);

  const removed = new Set();
  const placeholders = [];
  const tables = [];

  const addTable = (table, titleBox, left, right) => {
    const sample = titleBox.item;

    placeholders.push({
      ...sample,
      text: encodeTable(table),
      str: undefined,
      x: left,
      y: titleBox.y,
      width: right - left,
      height: titleBox.h || sample.height
    });

    tables.push(table);
  };

  // Tables with ® … ® title bars and a £ at the bottom.
  const bars = findTitleBars(boxes);

  for (const bar of bars) {
    const middle = pageWidth / 2;
    const fullWidth =
      pageWidth > 0 && Math.abs(bar.center - middle) <= pageWidth * FULL_WIDTH_CENTER;

    const inColumn = entry => {
      if (fullWidth || pageWidth === 0) return true;
      const center = (entry.x0 + entry.x1) / 2;
      return bar.center < middle ? center <= middle : center >= middle;
    };

    // The closing ornament: the nearest one below the title, in this column.
    const end = boxes
      .filter(
        entry =>
          entry.text === END_GLYPH &&
          entry.y < bar.y &&
          inColumn(entry) &&
          Math.abs((entry.x0 + entry.x1) / 2 - bar.center) <= pageWidth * 0.15
      )
      .sort((a, b) => b.y - a.y)[0];

    if (!end) continue;

    // Another title bar below the start but above the end means this table
    // has no closing ornament of its own.
    const nextBar = bars.find(other => other.y < bar.y && other.y > end.y && inColumn(other.left));
    if (nextBar) continue;

    const body = boxes.filter(
      entry =>
        entry.text &&
        !removed.has(entry.item) &&
        entry.text !== TITLE_GLYPH &&
        entry.text !== END_GLYPH &&
        entry.y < bar.y - 3 &&
        entry.y > end.y + 2 &&
        inColumn(entry)
    );

    const table = buildTable(bar.title, body);
    if (!table || table.rows.length === 0) continue;

    const members = [bar.left, bar.right, ...bar.words, end, ...body];
    for (const member of members) removed.add(member.item);

    addTable(
      table,
      bar.words[0],
      Math.min(...body.map(entry => entry.x0)),
      Math.max(...body.map(entry => entry.x1))
    );
  }

  // Tables whose title bar and ornaments are artwork.
  for (const found of findPlainTables(boxes, removed, pageWidth)) {
    for (const member of found.members) removed.add(member.item);
    addTable(found.table, found.title, found.left, found.right);
  }

  if (tables.length === 0) return { items, tables: [] };

  return {
    items: [...items.filter(item => !removed.has(item)), ...placeholders],
    tables
  };
}
