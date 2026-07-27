// Extract all text items with positions from every cemetery map PDF.
// Output: map-texts/<name>.json  { pages: [{ w, h, items: [{ s, x, y, fh }] }] }
const fs = require('fs');
const path = require('path');

(async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const files = fs.readdirSync('maps').filter(f => f.endsWith('.pdf'));
  fs.mkdirSync('map-texts', { recursive: true });
  for (const f of files) {
    const data = new Uint8Array(fs.readFileSync(path.join('maps', f)));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({
          s: it.str.trim(),
          // transform: [a,b,c,d,e,f]; e,f = position in PDF user space (y up)
          x: Math.round(it.transform[4] * 100) / 100,
          y: Math.round(it.transform[5] * 100) / 100,
          fh: Math.round(Math.hypot(it.transform[2], it.transform[3]) * 10) / 10, // font height
          w: Math.round((it.width || 0) * 100) / 100,
        }));
      pages.push({ w: Math.round(vp.width), h: Math.round(vp.height), items });
    }
    fs.writeFileSync(path.join('map-texts', f.replace('.pdf', '.json')), JSON.stringify({ file: f, pages }));
    console.log(f, '->', pages.map(p => p.items.length).join('+'), 'items');
    await doc.destroy();
  }
})();
