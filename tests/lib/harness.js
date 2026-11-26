'use strict';
// Shared test plumbing: static server, browser, a page with every external request mocked, a tiny runner.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert').strict;
const { chromium } = require('playwright');
const vendor = require('./vendor');
const { build, cleanup, DEFAULT_PAGE } = require('./build');
const { FakeN8n, sleep } = require('./fake-n8n');
const { GIS, PICKER, FakeDrive } = require('./fake-google');
const fx = require('./fixtures');

const RESULTS = path.join(__dirname, '..', '.results');
const TMP = path.join(__dirname, '..', '.tmp');

// ── static server for a built page folder ──
function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(dir, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

class App {
  constructor(o) { Object.assign(this, o); this.pageErrors = []; this.blocked = []; this.consoleErrors = []; }
  // run code inside the page's main closure (direct eval); async code: wrap in (async () => {...})()
  ev(code) { return this.page.evaluate((c) => window.__t.ev(c), code); }
  // wait until code (an expression evaluated inside the closure) is truthy; the polling is in real time
  async until(code, { timeout = 15000, interval = 40, what = code } = {}) {
    const t0 = Date.now();
    let last;
    for (;;) {
      try { last = await this.ev(code); } catch (e) { last = undefined; }
      if (last) return last;
      if (Date.now() - t0 > timeout) throw new Error(`Timed out after ${timeout} ms waiting for: ${what} (last value ${JSON.stringify(last)})`);
      await sleep(interval);
    }
  }
  // with a fake clock: move the page's time on in steps until the condition holds
  async advanceUntil(code, { step = 1000, max = 400, what = code, pause = 25 } = {}) {
    for (let i = 0; i < max; i++) {
      let v; try { v = await this.ev(code); } catch { v = undefined; }
      if (v) return v;
      await this.page.clock.runFor(step);
      await sleep(pause);
    }
    throw new Error(`Page time advanced ${max * step} ms without: ${what}`);
  }
  async advance(ms, { step = 1000, pause = 25 } = {}) {
    for (let left = ms; left > 0; left -= step) { await this.page.clock.runFor(Math.min(step, left)); await sleep(pause); }
  }
  // answer the page's own confirm box (ok = true presses the main button)
  async confirm(ok = true) {
    await this.page.waitForSelector('#confirmOverlay.open', { timeout: 10000 });
    await this.page.click(ok ? '#confirmOk' : '#confirmCancel');
    await this.page.waitForSelector('#confirmOverlay:not(.open)', { state: 'attached', timeout: 5000 });
  }
  async goto(hash) { await this.page.evaluate((h) => { location.hash = h; }, hash); await sleep(30); }
  // open a tutor chat (by id) and wait until it is on screen
  async openChat(id) {
    await this.goto(`#tutor/${id}`);
    await this.until(`state.currentRoute === 'tutor' && tutor.currentId === ${JSON.stringify(id)} && tutorDraft.chatId === ${JSON.stringify(id)}`, { what: `chat ${id} open` });
  }
  // a new chat made the way the page does it (opened too); returns its id
  async newChat(title) {
    const id = await this.ev(`(async () => { const c = await tutor.newChatFor(${title ? `{ title: ${JSON.stringify(title)} }` : ''}); return c.id; })()`);
    await this.openChat(id);
    return id;
  }
  async type(text) { await this.page.fill('#tutorInput', text); }
  async send(text) { await this.page.fill('#tutorInput', text); await this.page.press('#tutorInput', 'Enter'); }
  drafts() { return this.ev(`JSON.parse(storageGet('sth_tutor_drafts') || '{}')`); }
  async reload() { await this.page.reload(); await this.ready(); }
  async ready() {
    await this.page.waitForFunction(() => window.__t && window.__t.authInitDone === true, null, { timeout: 20000 });
    await this.until('!kb.loading && !tutor.loading && studio.ready && (jobs.initP !== null || !jobs.enabled())', { what: 'app stores ready' });
    await this.ev('jobs.initP');
    // the server's hello answer (v and caps) is part of "started": wait for it when jobs work
    await this.until('!jobs.available || jobs.serverOffUntil > Date.now() || jobs.modes !== null', { what: 'hello answered' });
  }
  // wait in node until fn() is truthy (for things only the fake server knows)
  async waitNode(fn, { timeout = 15000, what = 'condition' } = {}) {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error(`Timed out waiting for ${what}`); await sleep(40); }
  }
  // put Knowledge Bay items on the page: items from fixtures.kbItem
  async seedKb(items) {
    await this.page.evaluate(async (list) => { const t = window.__t; for (const it of list) if (!t.kb.cache.some(k => k.id === it.id)) t.kb.cache.push(it); await t.kb.persist(); t.studio.renderSources(); }, items);
  }
  async seedItems(list) { // Study Studio items (ready or not) without a request
    await this.page.evaluate(async (items) => { const t = window.__t; for (const it of items) { t.studio.items.unshift(it); await t.studio.persist(it); } t.studio.refreshViews(); }, list);
  }
  async close() { try { await this.context.close(); } catch { /* closed */ } }
}

async function createHarness(opts = {}) {
  vendor.ensure();
  const pages = {};
  const servers = [];
  const getPage = async (kind = 'new') => {
    if (pages[kind]) return pages[kind];
    const src = kind === 'base' ? process.env.BASE : (process.env.PAGE || DEFAULT_PAGE);
    if (!src || !fs.existsSync(src)) return null;
    const b = build(path.resolve(src), kind);
    const s = await serve(b.dir);
    servers.push(s.server);
    return (pages[kind] = { ...b, url: s.url, kind });
  };
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const apps = [];

  // opts: page ('new'|'base'), v, fake (FakeN8n options), width, height, now (ms, fake clock), signedIn, consent, seed {key: value}, hash, jobs (false: flag off),
  //       storageBlocked, wait (false: do not wait for the app to start), locale
  async function newApp(o = {}) {
    const pg = await getPage(o.page || 'new');
    if (!pg) throw new Error(`page "${o.page || 'new'}" is not available`);
    const context = await browser.newContext({ viewport: { width: o.width || 1280, height: o.height || 800 }, serviceWorkers: 'block', ...(o.contextOptions || {}) });
    const n8n = o.n8n || new FakeN8n({ v: o.v === undefined ? 7 : o.v, ...(o.fake || {}) });
    const drive = o.drive || new FakeDrive();
    const app = new App({ context, n8n, drive, pg, harness: null });
    const clockStart = o.now === undefined ? Date.now() : o.now;
    if (o.now !== undefined || o.clock) await context.clock.install({ time: clockStart }); // a fake clock that also runs by itself; app.advance() moves it on
    // every external request is mocked; anything unknown is refused and listed in app.blocked
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(pg.url)) return route.continue();
      const lib = vendor.lookup(url);
      if (lib && /^https:\/\/(cdn\.|cdnjs\.)/.test(url)) return route.fulfill({ status: 200, contentType: lib.type, body: lib.body, headers: { 'access-control-allow-origin': '*' } });
      if (/^https:\/\/accounts\.google\.com\/gsi\/client/.test(url)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: GIS });
      if (/^https:\/\/apis\.google\.com\/js\/api\.js/.test(url)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: PICKER });
      if (/^https:\/\/fonts\.googleapis\.com/.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      app.blocked.push(url);
      return route.abort('blockedbyclient');
    });
    await n8n.attach(context);
    await drive.attach(context);
    const seed = { ...(o.seed || {}) };
    if (o.signedIn !== false) { const t = n8n.issueToken(clockStart); seed.sth_token = JSON.stringify({ t: t.token, exp: t.exp }); }
    if (o.consent !== false) seed.sth_consent = JSON.stringify({ acceptedAt: new Date(clockStart).toISOString(), termsVersion: pg.termsVersion });
    if (o.jobs === false) seed.sth_flag_jobs = '0';
    await context.addInitScript((s) => {
      try { if (sessionStorage.getItem('__seeded')) return; sessionStorage.setItem('__seeded', '1'); for (const [k, v] of Object.entries(s)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch (e) { /* storage blocked */ }
    }, seed);
    if (o.storageBlocked) await context.addInitScript(() => {
      const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
      Storage.prototype.getItem = boom; Storage.prototype.setItem = boom; Storage.prototype.removeItem = boom;
    });
    if (o.recordStorage) await context.addInitScript(() => {
      window.__sk = new Set(); window.__sess = new Set();
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { (this === window.localStorage ? window.__sk : window.__sess).add(String(k)); return set.call(this, k, v); };
    });
    const page = await context.newPage();
    app.page = page;
    page.on('pageerror', (e) => app.pageErrors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') app.consoleErrors.push(m.text()); });
    await page.goto(`${pg.url}/index.html${o.hash || ''}`);
    if (o.wait !== false && o.signedIn !== false && o.consent !== false) await app.ready();
    apps.push(app);
    return app;
  }

  async function close() {
    for (const a of apps) await a.close();
    await browser.close();
    for (const s of servers) s.close();
    for (const p of Object.values(pages)) cleanup(p.dir);
  }
  const warnings = [];
  // a finding that is reported but does not fail the suite
  const warn = (msg) => { warnings.push(msg); };
  return { newApp, getPage, close, browser, fx, sleep, assert, apps, warnings, warn };
}

// ── runner ──
function suite(name) {
  const tests = [];
  const api = {
    name,
    test(title, fn, o = {}) { tests.push({ title, fn, ...o }); },
    skip(title) { tests.push({ title, skip: true }); },
    // a bug found in the page and not fixed (reported, not failed): a failure is listed as KNOWN, a pass says the bug may be gone
    known(title, fn, o = {}) { tests.push({ title, fn, known: true, ...o }); },
    async run() {
      const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
      let h;
      const results = [];
      const t0 = Date.now();
      try { h = await createHarness(); } catch (e) { console.log(`  FAIL setup: ${e.message}`); results.push({ title: 'setup', ok: false, error: e.message }); return finish(results, t0); }
      for (const t of tests) {
        if (only && !only.test(t.title)) continue;
        if (t.skip) { console.log(`  SKIP ${t.title}`); results.push({ title: t.title, skipped: true, ok: true }); continue; }
        const s = Date.now();
        const before = h.apps.length;
        try {
          if (t.needsBase && !(await h.getPage('base'))) { console.log(`  SKIP ${t.title} (no BASE page)`); results.push({ title: t.title, skipped: true, ok: true }); continue; }
          await Promise.race([t.fn(h), new Promise((_, rej) => setTimeout(() => rej(new Error(`test timed out after ${t.timeout || 45000} ms`)), t.timeout || 45000))]);
          console.log(`  ${t.known ? 'PASS (known issue seems fixed)' : 'PASS'} ${t.title} (${Date.now() - s} ms)`);
          results.push({ title: t.title, ok: true, ms: Date.now() - s, ...(t.known ? { knownFixed: true } : {}) });
        } catch (e) {
          const msg = String(e && e.stack ? e.message : e).split('\n').slice(0, 6).join('\n       ');
          if (t.known) { console.log(`  KNOWN ISSUE ${t.title}\n       ${msg}`); results.push({ title: t.title, ok: true, known: true, error: msg }); }
          else {
          console.log(`  FAIL ${t.title}\n       ${msg}`);
          results.push({ title: t.title, ok: false, error: msg });
          try { fs.mkdirSync(TMP, { recursive: true }); const a = h.apps[h.apps.length - 1]; if (a && a.page && h.apps.length > before) await a.page.screenshot({ path: path.join(TMP, `fail-${name}-${results.length}.png`) }); } catch { /* no screenshot */ }
          }
        }
        while (h.apps.length > before) { const a = h.apps.pop(); await a.close(); }
      }
      const warnings = h.warnings.slice();
      await h.close();
      return finish(results, t0, warnings);
    },
  };
  function finish(results, t0, warnings = []) {
    const real = results.filter(r => !r.skipped && !r.known);
    const total = real.length, pass = real.filter(r => r.ok).length, skipped = results.filter(r => r.skipped).length, known = results.filter(r => r.known).length;
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify({ suite: name, pass, total, skipped, known, warnings, ms: Date.now() - t0, results }, null, 1));
    for (const w of warnings) console.log(`  WARN ${w}`);
    console.log(`RESULT ${name} ${pass}/${total}${skipped ? ` (${skipped} skipped)` : ''}${known ? ` (${known} known issue${known > 1 ? 's' : ''})` : ''}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`);
    process.exitCode = pass === total ? 0 : 1;
    setTimeout(() => process.exit(process.exitCode), 100); // open keep-alive sockets must not hold the process
    return { pass, total };
  }
  return api;
}

module.exports = { suite, createHarness, assert, fx, sleep, FakeN8n, FakeDrive };
