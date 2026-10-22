#!/usr/bin/env node
// Turns dist-artifact/index.html (a full single-file document) into the page body the Claude Artifact
// host expects: it supplies its own <!doctype>/<head>/<body> skeleton and pads :root by the phone's
// safe-area insets, so the app fills 100% of that frame instead of 100dvh.
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('dist-artifact/index.html', 'utf8');
const title = src.match(/<title>[\s\S]*?<\/title>/)[0];
const styles = [...src.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((m) => m[0]);
const scripts = [...src.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0]);
const fit = `<style>
html, body, #root { height: 100%; }
.app { height: 100%; padding-top: 0; padding-bottom: 0; }
</style>`;
const out = [title, '<meta name="description" content="Browser 3D sculpting workbench: sculpt, import and reconstruct meshes.">', ...styles, fit, '<div id="root"></div>', ...scripts].join('\n');
writeFileSync('dist-artifact/form-engine.html', out);
console.log(`dist-artifact/form-engine.html ${(out.length / 1e6).toFixed(2)} MB, ${scripts.length} script(s), ${styles.length} style block(s)`);
