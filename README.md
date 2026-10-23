# Draw Steel Adventure PDF → Journal Converter

This FoundryVTT v14 module converts Draw Steel adventure PDFs into structured Journal Entries with:

- Automatic header detection
- Automatic hyperlinking between sections
- Automatic tiered test formatting (`<dl class="power-roll-display">`)
- Story-only extraction (no stat blocks)

## Installation

Zip the folder and import it into FoundryVTT v14.

## Development

Run:
npm install
npm run build

Source files are in `/src`, compiled JS is in `/dist`.
