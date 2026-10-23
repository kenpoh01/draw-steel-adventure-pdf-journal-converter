export function normalizeText(raw) {
  return raw.replace(/\r\n/g, "\n").trim();
}
