'use strict';
// Legal-vs-code smoke: privacy.html and terms.html load and carry the effective date of TERMS_VERSION, and the browser-storage keys the app writes are
// named in privacy.html. Keys written but not named are WARNINGS (the release PR adds some), not failures.
const fs = require('fs');
const path = require('path');
const { suite, assert } = require('../lib/harness');
const { studioItem, connectDrive, AFTER, fx } = require('../lib/common');

const t = suite('07-legal');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '.').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

t.test('privacy.html and terms.html load and carry the effective date of TERMS_VERSION', async (h) => {
  const app = await h.newApp({ wait: false, signedIn: false });
  const tv = app.pg.termsVersion;
  assert.match(tv, /^\d{4}-\d{2}-\d{2}$/);
  for (const f of ['privacy.html', 'terms.html']) {
    const res = await app.page.goto(`${app.pg.url}/${f}`);
    assert.equal(res.status(), 200, `${f} loads`);
    const body = await app.page.evaluate(() => document.body.innerText);
    assert.ok(body.length > 2000, `${f} has text`);
    assert.ok(body.includes(`Effective ${longDate(tv)}`), `${f} says "Effective ${longDate(tv)}" (TERMS_VERSION ${tv})`);
    assert.ok(/Student Tools Hub/.test(body));
    assert.ok(/jayleigh\.dev@gmail\.com/.test(body), `${f} names the contact address`);
  }
  assert.deepEqual(app.pageErrors, []);
});

t.test('the app links to both pages', async (h) => {
  const app = await h.newApp({});
  const links = await app.ev(`[...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => /privacy\\.html|terms\\.html/.test(h))`);
  assert.ok(links.some(l => /privacy\.html/.test(l)) && links.some(l => /terms\.html/.test(l)), 'privacy and terms are linked from the app');
});

t.test('storage keys the app writes versus the keys privacy.html names', async (h) => {
  const app = await h.newApp({ now: AFTER, recordStorage: true });
  // drive the app through the features that write
  await app.seedKb([fx.kbItem('notes.txt', { tokens: 200, id: 'k_n' })]);
  for (const hash of ['#tutor', '#knowledge', '#studio', '#transcribe', '#references', '#home']) { await app.goto(hash); await h.sleep(200); }
  const chat = await app.newChat('Legal chat');
  await app.send('hello');
  await app.advanceUntil(`tutor.chats.find(c => c.id === '${chat}').messages.some(m => m.role === 'model')`, { step: 2000 });
  await app.type('a draft');
  await h.sleep(600);
  await app.goto('#studio');
  await app.ev(`studio.openDialog('mindmap', { sourceIds: ['k_n'] })`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  await app.page.click('#studioGenerateBtn');
  await app.advanceUntil(`studio.items.length > 0 && studio.items[0].status === 'ready'`, { step: 2000 });
  await app.ev(`studioNoteServerCap(300000)`);
  await app.ev(`setSidebarCollapsed(true)`);
  await app.goto('#jobs?flag=0'); await h.sleep(300); await app.goto('#jobs?flag=1'); await h.sleep(300);
  await connectDrive(app);
  await app.ev('pushToDrive()');
  const notice = await app.ev(`document.getElementById('noticeBanner').hidden`);
  const written = await app.page.evaluate(() => ({ local: [...window.__sk], session: [...window.__sess] }));
  const dbs = await app.page.evaluate(async () => (await indexedDB.databases()).map(d => d.name));

  // keys in the source (string literals and key constants), so features this run did not reach are covered too
  const src = fs.readFileSync(app.pg.file, 'utf8');
  const fromSource = new Set();
  for (const m of src.matchAll(/(?:storageSet|localStorage\.setItem)\(\s*'([A-Za-z_.]+)'/g)) fromSource.add(m[1]);
  for (const m of src.matchAll(/const [A-Z_]+_KEY = '([A-Za-z_.0-9]+)'/g)) if (/^sth[_.]/.test(m[1])) fromSource.add(m[1]);
  if (/CHAT_LOCK_PREFIX = '([^']+)'/.test(src)) fromSource.add(/CHAT_LOCK_PREFIX = '([^']+)'/.exec(src)[1] + '*');
  const keys = new Set([...written.local, ...fromSource].filter(k => /^sth/.test(k) && !/^sth_chat_lock_/.test(k)));
  if (written.local.some(k => /^sth_chat_lock_/.test(k)) || fromSource.has('sth_chat_lock_*')) keys.add('sth_chat_lock_*');

  const priv = text(fs.readFileSync(path.join(app.pg.dir, 'privacy.html'), 'utf8'));
  const named = (k) => priv.includes(k.replace(/\*$/, ''));
  const unnamed = [...keys].filter(k => !named(k)).sort();
  for (const k of unnamed) h.warn(`localStorage key written by the app but not named in privacy.html: ${k}`);
  const dbUnnamed = dbs.filter(d => d && /^sth/.test(d) && !priv.includes(d));
  for (const d of dbUnnamed) h.warn(`IndexedDB database used by the app but not named in privacy.html: ${d}`);
  // legal text naming a key the page no longer has
  const legalKeys = new Set([...fs.readFileSync(path.join(app.pg.dir, 'privacy.html'), 'utf8').matchAll(/\bsth[_.][A-Za-z_.0-9]*[A-Za-z0-9]/g)].map(m => m[0]));
  for (const k of legalKeys) if (!src.includes(k)) h.warn(`privacy.html names "${k}", which the page does not contain (stale text?)`);
  console.log(`       keys seen: ${[...keys].sort().join(', ')}\n       databases: ${dbs.join(', ')}; notice banner hidden after release: ${notice}`);
  assert.ok(keys.size >= 10, 'the scan found the app\'s keys');
  assert.ok(dbs.length >= 3, 'the app\'s IndexedDB databases were created');
});

t.run();
