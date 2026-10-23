const script = document.createElement("script");
script.type = "importmap";
script.textContent = JSON.stringify({
  imports: {
    "pdfjs": "/modules/draw-steel-adventure-pdf-journal-converter/libs/pdfjs/pdf.mjs",
    "pdfjs-worker": "/modules/draw-steel-adventure-pdf-journal-converter/libs/pdfjs/pdf.worker.mjs",
    "pdfjs-sandbox": "/modules/draw-steel-adventure-pdf-journal-converter/libs/pdfjs/pdf.sandbox.mjs"
  }
});

// ES modules cannot use document.currentScript, so we append to <head>
document.head.appendChild(script);
