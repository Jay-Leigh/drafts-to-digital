'use strict';
// Copies the page under test into a temp folder and injects a test hook before the end of the main inline IIFE:
//   window.__t.<name>   every top-level const / let / function / class of the IIFE, read lazily (getter), plus
//   window.__t.ev(src)  a direct eval inside the IIFE (reads and calls anything, also names that are not top level)
// The page itself is not changed in any other way. privacy.html and terms.html are copied next to it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = '  })();\n  </script>\n';
const REPO = path.join(__dirname, '..', '..');
const TMP = path.join(__dirname, '..', '.tmp');

function extractNames(src) {
  const start = src.indexOf('  (() => {\n    \'use strict\';');
  const end = src.indexOf(MARKER);
  const body = start >= 0 && end > start ? src.slice(start, end) : src;
  const names = new Set();
  const re = /^    (?:async function|function|const|let|class) ([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(body))) names.add(m[1]);
  return [...names];
}

// build(pagePath) -> { dir, file, termsVersion, names }
function build(pagePath, label = 'page') {
  const src = fs.readFileSync(pagePath, 'utf8');
  const at = src.indexOf(MARKER);
  if (at < 0 || src.indexOf(MARKER, at + 1) >= 0) throw new Error(`Hook marker not found exactly once in ${pagePath}`);
  const names = extractNames(src);
  const hook = '  /* test hook (tests/lib/build.js) */\n  window.__t = {};\n' +
    '  const __def = (n, f) => { try { Object.defineProperty(window.__t, n, { get() { try { return f(); } catch (e) { return undefined; } }, enumerable: true, configurable: true }); } catch (e) { /* skip */ } };\n' +
    names.map(n => `  __def(${JSON.stringify(n)}, () => ${n});`).join('\n') +
    '\n  window.__t.ev = (s) => eval(s);\n' +
    // a test-only group kind ("tgrp"): records what the engine hands it in localStorage (keys tgrp_*, not sth_*) so it survives a reload
    `  try {
    const __log = (k, v) => { try { const l = JSON.parse(localStorage.getItem(k) || '[]'); l.push(v); localStorage.setItem(k, JSON.stringify(l)); } catch (e) { /* ignore */ } };
    jobs.groupHandlers.tgrp = {
      applyMember: async (g, i, data) => { __log('tgrp_applied', [g.id, i, !!(data && (data.artifact || data.text))]); },
      done: async (g) => { __log('tgrp_done', g.id); },
      failed: (g, i, err) => { __log('tgrp_failed', [g.id, i, err && err.code]); },
      cancelled: async (g) => { __log('tgrp_cancelled', g.id); },
      dropped: async (g) => { __log('tgrp_dropped', g.id); },
    };
  } catch (e) { /* an older page has no groups */ }
`;
  fs.mkdirSync(TMP, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP, `${label}-`));
  fs.writeFileSync(path.join(dir, 'index.html'), src.slice(0, at) + hook + src.slice(at));
  for (const f of ['privacy.html', 'terms.html']) {
    const p = path.join(path.dirname(pagePath), f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dir, f));
  }
  const tv = /const TERMS_VERSION = '([^']+)'/.exec(src);
  return { dir, file: path.join(dir, 'index.html'), termsVersion: tv ? tv[1] : '', names, source: pagePath };
}

function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

const DEFAULT_PAGE = process.env.PAGE ? path.resolve(process.env.PAGE) : path.join(REPO, 'index.html');
module.exports = { build, cleanup, extractNames, DEFAULT_PAGE, REPO };
