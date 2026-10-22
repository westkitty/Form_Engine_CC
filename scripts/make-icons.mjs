// Renders the app icon to PNGs (Android/Chrome install requires 192 and 512 PNG; maskable needs the art
// inside the central 80% safe zone). Run: node scripts/make-icons.mjs
import { chromium } from 'playwright';
const art = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><radialGradient id="c" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#fff3e4"/><stop offset=".4" stop-color="#d3c0a8"/><stop offset=".85" stop-color="#7a6553"/><stop offset="1" stop-color="#3b3028"/></radialGradient></defs>
  <rect width="512" height="512" fill="#121418"/>
  <g transform="translate(256 262) scale(${(1 - pad * 2).toFixed(3)})">
    <ellipse cx="0" cy="190" rx="150" ry="22" fill="#000" opacity=".45"/>
    <circle r="180" fill="url(#c)"/>
    <path d="M-120 -70 C -60 -150, 60 -150, 120 -70" stroke="#e0a35a" stroke-width="22" fill="none" stroke-linecap="round"/>
  </g></svg>`;
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 0.06], ['icon-512.png', 512, 0.06], ['icon-maskable-512.png', 512, 0.16], ['apple-touch-icon.png', 180, 0.08]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${art(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `public/${name}`, omitBackground: false });
  console.log('wrote public/' + name);
}
await browser.close();
