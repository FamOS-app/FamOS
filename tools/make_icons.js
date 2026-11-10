// Erzeugt die App-Icons (PNG) aus app/icons/logo.svg. Nur lokal nötig, wenn sich das Logo ändert;
// die PNGs werden eingecheckt, CI braucht keinen Browser.
// Aufruf: node tools/make_icons.js   (braucht Playwright mit Chromium)
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const DIR = path.join(__dirname, '..', 'app', 'icons');
const svg = fs.readFileSync(path.join(DIR, 'logo.svg'), 'utf8');
// Hintergrundfarbe = erstes <rect> im Logo (für maskierbare Icons mit Sicherheitsrand)
const bg = (svg.match(/<rect[^>]*fill="(#[0-9A-Fa-f]{6})"/) || [])[1] || '#225D65';
const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

const OUT = [
  // name, Größe, Anteil des Logos (1 = randlos; maskable: Inhalt in der sicheren Zone von 80 %)
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['maskable-512.png', 512, 0.8],
  ['apple-touch-icon.png', 180, 1],
  ['favicon-32.png', 32, 1],
];

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ deviceScaleFactor: 1 });
  for (const [name, size, scale] of OUT) {
    await p.setViewportSize({ width: size, height: size });
    const s = Math.round(size * scale);
    await p.setContent(`<html><body style="margin:0;background:${bg};width:${size}px;height:${size}px;display:grid;place-items:center">
      <img src="${uri}" style="width:${s}px;height:${s}px;display:block"></body></html>`);
    await p.waitForTimeout(150);
    await p.screenshot({ path: path.join(DIR, name), omitBackground: false });
    console.log('✓', name);
  }
  await b.close();
})();
