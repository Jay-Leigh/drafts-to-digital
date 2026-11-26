'use strict';
// CDN libraries the page loads. The few that matter for behaviour are fetched once (through the sandbox proxy, with curl) into tests/.cache
// (gitignored, about 1.1 MB); the others are replaced by tiny stubs. Nothing here touches a live app system.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CACHE = path.join(__dirname, '..', '.cache');

// pattern -> { file, url } fetched, or { stub } served as it is
const LIBS = [
  { re: /^https:\/\/cdn\.tailwindcss\.com\/?$/, file: 'tailwind.js', url: 'https://cdn.tailwindcss.com', stub: 'window.tailwind = window.tailwind || {};' },
  { re: /dompurify|purify(\.min)?\.js/, file: 'purify.min.js', url: 'https://cdn.jsdelivr.net/npm/dompurify@3.5.0/dist/purify.min.js', required: true },
  { re: /localforage/, file: 'localforage.min.js', url: 'https://cdn.jsdelivr.net/npm/localforage@1.10.0/dist/localforage.min.js', required: true },
  { re: /\/marked(\.min)?\.js|npm\/marked\//, file: 'marked.min.js', url: 'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js', stub: 'window.marked = { parse: (t) => String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;"), setOptions(){} };' },
  { re: /jszip/, file: 'jszip.min.js', url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', stub: 'window.JSZip = undefined;' },
  { re: /pdf-lib/, file: 'pdf-lib.min.js', url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js', stub: 'window.PDFLib = undefined;' },
  { re: /browser-image-compression/, stub: 'window.imageCompression = async (f) => f;' },
  { re: /mammoth|xlsx|pdf\.min\.js|pdf\.worker|pptxgen/, stub: '/* stubbed in tests */' },
];

function ensure() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const lib of LIBS) {
    if (!lib.file) continue;
    const dest = path.join(CACHE, lib.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) continue;
    try {
      execFileSync('curl', ['-sSL', '--fail', '-m', '60', '-o', dest, lib.url], { stdio: 'pipe' });
    } catch (e) {
      try { fs.unlinkSync(dest); } catch { /* nothing there */ }
      if (lib.required) throw new Error(`Could not fetch ${lib.url} (needed by the tests). Put the file at ${dest} by hand.`);
    }
  }
}

// -> { body, type } or null when the URL is not a known CDN library
function lookup(url) {
  for (const lib of LIBS) {
    if (!lib.re.test(url)) continue;
    if (lib.file) {
      const f = path.join(CACHE, lib.file);
      if (fs.existsSync(f)) return { body: fs.readFileSync(f), type: 'application/javascript' };
    }
    return { body: lib.stub || '', type: 'application/javascript' };
  }
  return null;
}

module.exports = { ensure, lookup, CACHE };
