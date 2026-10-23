/**
 * Recognises list bullets in extracted PDF text.
 *
 * Adventure PDFs draw bullets with a symbol font, so the text layer holds an
 * unrelated character instead of a bullet: "¥" in the Draw Steel PDFs.
 * Other symbols from the same font are NOT bullets (tier-result icons such
 * as "á", ornaments such as "®" and "£"), so bullets are recognised by an
 * explicit list of glyphs rather than by "any symbol at the start of a line".
 *
 * To support another PDF's bullet, add its character here.
 */

export const BULLET = "•";

export const BULLET_GLYPHS = new Set([
  "¥",  // Draw Steel adventure PDFs (symbol font)
  "•",  // ordinary bullet
  "●",
  "▪",
  "◦",
  "‣",
  "∙",
  "·"
]);

/**
 * Turn a leading bullet glyph into a regular bullet followed by a space.
 * Works on a laid-out line: an array of { item, separator } as produced by
 * orderPageItems(), where the glyph is usually its own one-character item.
 *
 * @returns {boolean} true when the line starts with a bullet.
 */
export function normalizeLineBullet(line) {
  const first = line?.[0];
  if (!first) return false;

  const text = first.item.text.trim();

  // A lone glyph item ("¥") followed by the text of the bullet.
  if (BULLET_GLYPHS.has(text) && line.length > 1) {
    first.item.text = BULLET;
    line[1].separator = " ";
    return true;
  }

  // Glyph and text in one item ("¥An item").
  if (text.length > 1 && BULLET_GLYPHS.has(text[0]) && /[\p{L}\p{N}“"‘'(]/u.test(text[1])) {
    first.item.text = `${BULLET} ${text.slice(1)}`;
    return true;
  }

  return false;
}

/**
 * A bullet glyph is sometimes laid out as a line of its own, either in a
 * different layout region from its text or on a slightly different baseline.
 * Fold such a lone bullet into the line right beside it (same baseline, text
 * starting just to its right). A glyph with no text beside it is decoration
 * and is dropped.
 *
 * Mutates `lines` and `metrics` (parallel arrays from orderPageItems()).
 */
export function joinStrayBullets(lines, metrics) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];

    if (line.length !== 1 || !BULLET_GLYPHS.has(line[0].item.text.trim())) {
      continue;
    }

    const here = metrics[index];
    const target = lines.findIndex((other, i) => {
      if (i === index || other.length === 0) return false;
      const m = metrics[i];
      return (
        Math.abs(m.base - here.base) <= 3 &&
        m.minX >= here.minX &&
        m.minX - here.maxX <= 20
      );
    });

    if (target !== -1) {
      const next = lines[target];
      next[0].separator = " ";
      next.unshift({ ...line[0], separator: "" });
    }

    lines.splice(index, 1);
    metrics.splice(index, 1);
  }
}
