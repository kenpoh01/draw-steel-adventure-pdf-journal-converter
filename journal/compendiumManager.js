export async function getOrCreatePack() {
  const pack = game.packs.get("drawsteel-adventure-pdf-journal-converter.drawsteel-adventures");
  if (!pack) throw new Error("Compendium not found.");
  return pack;
}
