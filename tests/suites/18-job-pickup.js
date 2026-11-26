'use strict';
// Pickup of a background result on another device (client side of the v8 claim / collected contract), with TWO simulated devices on one fake Drive and one fake v8 server:
// the origin lists a one-job request in the hidden Drive file `sth-jobs-v1.json`, the other device finds it, claims the answer, applies it once, acks it and marks the entry done;
// the origin sees `collected` and never sends the request again. Also: the claim race, a dead winner (lease), stale / deleted / mismatched entries, hostile files,
// kinds that are never listed, a rollback to v7, entry lifetime, no sync = no file, and the key never leaving the file / the job calls / the job store.
const { suite, assert } = require('../lib/harness');
const { connectDrive, studioItem } = require('../lib/common');

const t = suite('18-job-pickup');
const FILE = 'sth-jobs-v1.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── helpers ──
const POKE = `(async () => { for (const r of jobs.recs.values()) if (JOBS_ACTIVE.has(r.state)) r.nextPollAt = 0; await pickup.step(true); await jobs.tick(); })()`;
async function untilPoking(apps, cond, what, timeout = 25000) {
  const list = Array.isArray(apps) ? apps : [apps];
  const t0 = Date.now();
  for (;;) {
    let ok = true;
    for (const [i, a] of list.entries()) { const c = Array.isArray(cond) ? cond[i] : cond; if (c && !(await a.ev(c))) ok = false; }
    if (ok) return;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out waiting for: ${what}`);
    await Promise.all(list.map((a) => a.ev(POKE).catch(() => {})));
    await sleep(120);
  }
}
const stop = (app) => app.ev('jobs.leader = false');
const go = (app) => app.ev('jobs.leader = true');
const countApplies = (app) => app.ev(`(() => { window.__ap = 0; const o = studio.hooks.applyResult; studio.hooks.applyResult = (i, d) => { window.__ap++; return o(i, d); }; })()`);
const applies = (app) => app.ev('window.__ap || 0');
const listed = (drive) => { const f = drive.byName(FILE)[0]; return f ? JSON.parse(String(f.body)) : null; };

// two devices of one person: the same Google account (one fake Drive), the same server (one fake n8n), both with sync connected
async function pair(h, o = {}) {
  const A = await h.newApp({ v: 8, ...o });
  const B = await h.newApp({ v: 8, n8n: A.n8n, drive: A.drive, ...o });
  await connectDrive(A); await connectDrive(B);
  return { A, B };
}
async function startAid(h, app, tool = 'mindmap') {
  await app.seedKb([h.fx.kbItem('a.txt', { tokens: 100, id: 'k_a' })]);
  await app.ev(`studio.openDialog('${tool}', { sourceIds: ['k_a'] })`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  await app.page.click('#studioGenerateBtn');
  await app.until(`[...jobs.recs.values()].some(r => r.state === 'submitted' || r.state === 'running')`);
  return app.ev(`(() => { const r = [...jobs.recs.values()][0]; return { jobId: r.id, itemId: r.ref.itemId, key: r.key }; })()`);
}
const itemOf = (app, itemId) => app.ev(`(() => { const i = studio.items.find(x => x.id === ${JSON.stringify(itemId)}); return i ? { status: i.status, tool: i.tool, jobId: i.jobId || null, pickedUp: !!i.pickedUp, title: i.title } : null; })()`);
const recOf = (app, id) => app.ev(`(() => { const r = jobs.recs.get(${JSON.stringify(id)}); return r ? { state: r.state, foreign: !!r.foreign, pub: !!r.pub, doneElsewhere: !!r.doneElsewhere, dismissed: !!r.dismissed, nonce: r.nonce || null, mode: r.mode } : null; })()`);
const rid = (c) => `j_${c.repeat(22)}`;
const rkey = (c) => c.repeat(43);
// a job on the fake server as if another device's app had started it
function seedJob(n8n, id, key, mode = 'studio_mindmap', state = 'succeeded') {
  n8n.jobs.set(id, { id, key, attempt: 1, mode, bulk: false, payload: { mode, sources: [] }, files: [], state, plan: null, polls: 0, createdSeq: 1, createdAt: Date.now(), cancelled: false, acked: false, forceDone: false });
}
function entry(o = {}) {
  const now = Date.now();
  return { id: rid('B'), key: rkey('k'), mode: 'studio_mindmap', kind: 'studio', label: 'Mind map: seeded', createdAt: now - 60000, expiresAt: now + 3 * 3600e3, state: 'open', doneAt: 0,
    ctx: { itemId: 'item_seeded1', tool: 'mindmap', title: 'Mind map: seeded', language: 'en', topic: '', options: {}, sourceIds: ['k_a'], sourceNames: ['a.txt'], createdAt: now - 60000 }, ...o };
}
const putFile = (drive, body) => drive.add(FILE, typeof body === 'string' ? body : JSON.stringify(body));

// ───────────────────────────────────────────────────────────────────────────

t.test('start on A, B picks it up and applies it once, A sees `collected`, nothing is sent twice; the entry ends with no key', async (h) => {
  const { A, B } = await pair(h);
  await countApplies(A); await countApplies(B);
  const toasts = await B.ev(`(() => { window.__toasts = []; const o = showToast; showToast = (...a) => { window.__toasts.push(String(a[0])); return o(...a); }; })()`);
  A.n8n.plan(null, { type: 'hold' });
  const { jobId, itemId, key } = await startAid(h, A);
  await A.until(`[...jobs.recs.values()].some(r => r.pub)`, { what: 'listed' });
  let f = listed(A.drive);
  assert.equal(f.v, 1);
  assert.equal(f.jobs.length, 1);
  assert.deepEqual([f.jobs[0].id, f.jobs[0].key, f.jobs[0].mode, f.jobs[0].kind, f.jobs[0].state], [jobId, key, 'studio_mindmap', 'studio', 'open']);
  assert.equal(f.jobs[0].ctx.itemId, itemId);
  assert.equal(f.jobs[0].ctx.tool, 'mindmap');
  assert.deepEqual(f.jobs[0].ctx.sourceNames, ['a.txt']);
  assert.equal(Math.round((f.jobs[0].expiresAt - f.jobs[0].createdAt) / 3600e3), 72);
  assert.equal(Object.keys(f.jobs[0]).sort().join(), 'createdAt,ctx,doneAt,expiresAt,id,key,kind,label,mode,state');
  await stop(A); // A is "away": only B works on it
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${jobId}')`, { what: 'B took the entry' });
  assert.deepEqual((await recOf(B, jobId)).foreign, true);
  assert.equal(await itemOf(B, itemId), null, 'nothing is created on B before there is a result');
  // the tray row says where it comes from
  await B.ev('jobs.openTray(true)');
  assert.match(await B.ev(`document.getElementById('jobsTrayList').textContent`), /Picked up from your other device/);
  A.n8n.release();
  await untilPoking(B, `jobs.recs.get('${jobId}').state === 'done'`, 'B collected');
  const it = await itemOf(B, itemId);
  assert.deepEqual([it.status, it.tool, it.jobId], ['ready', 'mindmap', jobId]);
  assert.equal(await applies(B), 1);
  assert.equal(A.n8n.job(jobId).state, 'collected');
  assert.equal(A.n8n.ops('claim').length, 1, 'one claim in all');
  assert.equal(A.n8n.ops('result').length, 0);
  assert.equal(A.n8n.creates().length, 1);
  assert.deepEqual(await B.ev('window.__toasts'), [], 'no popup on the collecting device');
  await untilPoking(B, `[...jobs.recs.values()].every(r => !r.pickupMark)`, 'B marked the entry');
  f = listed(A.drive);
  assert.equal(f.jobs[0].state, 'done');
  assert.equal(f.jobs[0].key, '', 'a finished entry has no key');
  // A comes back: it never resends, it is told the answer was collected, and the aid arrives by sync
  await go(A);
  await untilPoking(A, `jobs.recs.get('${jobId}').state === 'done'`, 'A saw collected');
  const ra = await recOf(A, jobId);
  assert.equal(ra.doneElsewhere, true);
  assert.equal(await applies(A), 0, 'A did not apply anything itself');
  assert.equal(A.n8n.creates().length, 1, 'never sent again');
  assert.deepEqual(await itemOf(A, itemId), { status: 'generating', tool: 'mindmap', jobId, pickedUp: true, title: (await itemOf(A, itemId)).title });
  await B.ev('pushToDrive()');
  await A.until(`(() => { const i = studio.items.find(x => x.id === '${itemId}'); return !!i && i.status === 'ready'; })()`, { what: 'the finished aid reached A by sync', timeout: 20000 }).catch(async () => { await A.ev(`syncEnqueue('pull')`); });
  await A.until(`studio.items.find(x => x.id === '${itemId}').status === 'ready'`, { what: 'aid ready on A', timeout: 20000 });
  const done = await itemOf(A, itemId);
  assert.deepEqual([done.status, done.pickedUp], ['ready', false]);
  assert.equal(await A.ev(`studio.items.filter(x => x.id === '${itemId}').length`), 1);
  assert.equal(A.n8n.creates().length, 1);
  assert.deepEqual(A.pageErrors, []); assert.deepEqual(B.pageErrors, []);
  void toasts;
}, { timeout: 90000 });

t.test('both devices race for the answer: exactly one applies, the other ends `done elsewhere`, no resend', async (h) => {
  const { A, B } = await pair(h);
  await countApplies(A); await countApplies(B);
  A.n8n.plan(null, { type: 'hold' });
  const { jobId, itemId } = await startAid(h, A);
  await A.until(`[...jobs.recs.values()].some(r => r.pub)`, { what: 'listed' });
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${jobId}')`);
  A.n8n.release();
  await untilPoking([A, B], [`jobs.recs.get('${jobId}').state === 'done'`, `jobs.recs.get('${jobId}').state === 'done'`], 'both finished', 40000);
  assert.equal((await applies(A)) + (await applies(B)), 1, 'exactly one device applied it');
  const ra = await recOf(A, jobId), rb = await recOf(B, jobId);
  assert.equal([ra, rb].filter((r) => r.doneElsewhere).length, 1, 'the other one is done elsewhere');
  assert.equal(A.n8n.job(jobId).state, 'collected');
  assert.equal(A.n8n.ops('ack').filter((o) => (o.payload.jobs || []).length).length >= 1, true);
  assert.equal(A.n8n.creates().length, 1);
  // the aid exists on the winner; the loser gets it by sync
  const winner = ra.doneElsewhere ? B : A, loser = ra.doneElsewhere ? A : B;
  assert.equal((await itemOf(winner, itemId)).status, 'ready');
  await winner.ev('pushToDrive()');
  await loser.ev(`syncEnqueue('pull')`);
  await loser.until(`studio.items.find(x => x.id === '${itemId}') && studio.items.find(x => x.id === '${itemId}').status === 'ready'`, { what: 'loser has the aid by sync', timeout: 20000 });
}, { timeout: 90000 });

t.test('the winner dies mid-claim: the loser keeps watching, takes the answer after the lease, applies it once', async (h) => {
  const { A, B } = await pair(h);
  await countApplies(A);
  A.n8n.plan(null, { type: 'hold' });
  const { jobId, itemId } = await startAid(h, A);
  await A.until(`[...jobs.recs.values()].some(r => r.pub)`, { what: 'listed' });
  await stop(A);
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${jobId}')`);
  A.n8n.release();
  // B wins the claim and hangs in the apply (its tab dies)
  await B.ev(`pickup.applyStudio = () => new Promise(() => {})`);
  for (let i = 0; i < 100 && !A.n8n.job(jobId).claimed; i++) { await B.ev(POKE).catch(() => {}); await sleep(120); }
  await sleep(300);
  assert.equal(A.n8n.job(jobId).claimed, 1);
  await B.close();
  // A comes back while the lease runs: 409, it keeps the record and does not give up
  await go(A);
  await untilPoking(A, `(jobs.recs.get('${jobId}').claimTries || 0) >= 1`, 'A met the lease');
  assert.equal(await A.ev(`jobs.recs.get('${jobId}').state`), 'succeeded');
  assert.equal(await applies(A), 0);
  assert.equal(A.n8n.ops('claim').length >= 2, true);
  // the lease ends on the server's clock
  const t0 = Date.now(); A.n8n.clock = () => t0 + 601000;
  await untilPoking(A, `jobs.recs.get('${jobId}').state === 'done'`, 'A took over', 30000);
  assert.equal(await applies(A), 1);
  assert.equal((await itemOf(A, itemId)).status, 'ready');
  assert.equal(A.n8n.job(jobId).state, 'collected');
  assert.equal(A.n8n.creates().length, 1);
}, { timeout: 90000 });

t.test('origin: `unknown` for a listed job is never a resend (calm "collected elsewhere"); an unlisted job still resends as before', async (h) => {
  // listed
  const { A } = await pair(h);
  A.n8n.plan(null, { type: 'hold' });
  const s = await startAid(h, A);
  await A.until(`[...jobs.recs.values()].some(r => r.pub)`);
  await A.ev(`jobs.recs.get('${s.jobId}').lastCreateAt = Date.now() - 600000`);
  A.n8n.jobs.delete(s.jobId); // collected elsewhere and the note is gone (or Redis lost it)
  await untilPoking(A, `jobs.recs.get('${s.jobId}').state === 'done'`, 'no resend');
  assert.equal((await recOf(A, s.jobId)).doneElsewhere, true);
  assert.equal(A.n8n.creates().length, 1, 'never sent again');
  assert.equal(await A.ev(`document.getElementById('jobsAlert').textContent`), '');
  assert.equal((await itemOf(A, s.itemId)).pickedUp, true);
  // not listed (sync not connected): the old rule
  const C = await h.newApp({ v: 8 });
  C.n8n.plan(null, { type: 'hold' });
  const c = await startAid(h, C);
  await C.ev(`(() => { const r = jobs.recs.get('${c.jobId}'); r.sawServer = true; r.lastCreateAt = Date.now() - 600000; })()`);
  assert.equal((await recOf(C, c.jobId)).pub, false);
  C.n8n.jobs.delete(c.jobId);
  await untilPoking(C, `jobs.recs.get('${c.jobId}').attempt === 2`, 'resent as attempt 2');
  for (let i = 0; i < 100 && C.n8n.creates().length < 2; i++) { await C.ev(POKE).catch(() => {}); await sleep(100); }
  assert.equal(C.n8n.creates().length, 2);
}, { timeout: 60000 });

t.test('stale or wrong entries are never applied: deleted aid (tombstone), an item of another job, a result of another mode', async (h) => {
  const { B } = await pair(h);
  const n8n = B.n8n;
  // 1 a deleted aid
  seedJob(n8n, rid('C'), rkey('c'));
  seedJob(n8n, rid('D'), rkey('d'));
  seedJob(n8n, rid('E'), rkey('e'), 'studio_quiz'); // the server's job is a quiz, the entry says mind map
  putFile(B.drive, { v: 1, jobs: [
    entry({ id: rid('C'), key: rkey('c'), label: 'deleted', ctx: { ...entry().ctx, itemId: 'item_gone' } }),
    entry({ id: rid('D'), key: rkey('d'), label: 'taken', ctx: { ...entry().ctx, itemId: 'item_taken' } }),
    entry({ id: rid('E'), key: rkey('e'), label: 'wrongmode', ctx: { ...entry().ctx, itemId: 'item_wrong' } }),
  ] });
  await B.ev(`studio.saveTombs(new Map([['item_gone', { at: Date.now() }]]))`);
  await B.seedItems([{ id: 'item_taken', tool: 'quiz', title: 'my quiz', language: 'en', topic: '', options: {}, sourceIds: [], sourceNames: [], status: 'ready', createdAt: Date.now(), updatedAt: Date.now(), seen: true, error: null, artifact: null }]);
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.size === 3`, { what: 'three foreign records' });
  await untilPoking(B, `[...jobs.recs.values()].every(r => r.state === 'cancelled')`, 'all three dropped', 30000);
  assert.equal(await itemOf(B, 'item_gone'), null, 'a deleted aid is not recreated');
  assert.deepEqual(await itemOf(B, 'item_taken'), { status: 'ready', tool: 'quiz', jobId: null, pickedUp: false, title: 'my quiz' }, 'another item is not written to');
  assert.equal(await itemOf(B, 'item_wrong'), null, 'a result of another mode is not applied');
  assert.equal(await B.ev(`studio.items.length`), 1);
  // nothing was acknowledged (the owner of the request may still want its answer), and the entries are marked cancelled
  assert.equal(n8n.ops('ack').filter((o) => (o.ids || []).some((i) => [rid('C'), rid('D'), rid('E')].includes(i))).length, 0);
  await untilPoking(B, `[...jobs.recs.values()].every(r => !r.pickupMark)`, 'entries marked');
  assert.deepEqual(listed(B.drive).jobs.map((e) => e.state), ['cancelled', 'cancelled', 'cancelled']);
}, { timeout: 90000 });

t.test('hostile files: oversize is ignored without a download, prototype pollution and garbage entries are skipped, a newer version is never written', async (h) => {
  const app = await h.newApp({ v: 8 });
  await connectDrive(app);
  // pure parser: whitelist, prototype safety, limits
  const out = await app.ev(`(() => {
    const now = Date.now(), ok = { id: 'j_' + 'B'.repeat(22), key: 'k'.repeat(43), mode: 'studio_mindmap', kind: 'studio', label: 'ok', createdAt: now - 1000, expiresAt: now + 3600000, state: 'open', doneAt: 0, ctx: { itemId: 'item_1', tool: 'mindmap', title: 't', language: 'en', topic: '', options: {}, sourceIds: ['k_a'], sourceNames: ['a'], createdAt: now - 1000 } };
    const raw = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"p2":1}},"v":1,"jobs":[' + JSON.stringify(ok).replace('{"id"', '{"__proto__":{"x":1},"id"') + ',null,5,"x",{"id":"j_short"},{"id":"' + ok.id + '","key":"short","mode":"studio_mindmap"},' +
      JSON.stringify({ ...ok, id: 'j_' + 'C'.repeat(22), mode: 'tutor' }) + ',' + JSON.stringify({ ...ok, id: 'j_' + 'D'.repeat(22), ctx: { ...ok.ctx, tool: 'quiz' } }) + ',' +
      JSON.stringify({ ...ok, id: 'j_' + 'E'.repeat(22), createdAt: now - 20 * 86400000 }) + ',' + JSON.stringify({ ...ok, id: 'j_' + 'F'.repeat(22), label: 'x'.repeat(500) }) + ',' + JSON.stringify({ ...ok, id: 'j_' + 'G'.repeat(22), ctx: { ...ok.ctx, sourceIds: Array.from({ length: 40 }, (_, i) => 'k_' + i), sourceNames: Array.from({ length: 40 }, () => 'n'.repeat(900)) } }) + ']}');
    const p = pickupParse(raw, now);
    const g = p.entries.get('j_' + 'G'.repeat(22)), f = p.entries.get('j_' + 'F'.repeat(22));
    return { ids: [...p.entries.keys()].map(k => k[2]), polluted: ({}).polluted, p2: ({}).p2, x: ({}).x, own: Object.getPrototypeOf(p.entries.get(ok.id).ctx) === Object.prototype, future: pickupParse({ v: 2, jobs: [] }).future, labelLen: f.label.length, sources: g.ctx.sourceIds.length, nameLen: g.ctx.sourceNames[0].length };
  })()`);
  assert.deepEqual(out.ids, ['B', 'F', 'G'], 'only the valid entries are kept (the labelled and clipped ones too)');
  assert.deepEqual([out.polluted, out.p2, out.x], [undefined, undefined, undefined]);
  assert.equal(out.own, true);
  assert.equal(out.future, true);
  assert.ok(out.labelLen <= 120);
  assert.equal(out.sources, 15);
  assert.equal(out.nameLen, 200);
  // 50 entries at most
  const cap = await app.ev(`(() => { const now = Date.now(); const m = new Map(); for (let i = 0; i < 80; i++) { const id = 'j_' + String(i).padStart(22, 'A'); m.set(id, { id, key: 'k'.repeat(43), mode: 'studio_mindmap', kind: 'studio', label: 'l', createdAt: now - i * 1000, expiresAt: now + 3600000, state: i % 10 ? 'open' : 'done', doneAt: now, ctx: {} }); } pickupPrune(m, now); return m.size; })()`);
  assert.equal(cap, 50);
  // an oversize file (300 KB) is not even downloaded; the next write replaces it by a clean one
  const big = putFile(app.drive, JSON.stringify({ v: 1, jobs: [], pad: 'x'.repeat(300 * 1024) }));
  app.n8n.plan(null, { type: 'hold' });
  const s = await startAid(h, app);
  await app.until(`[...jobs.recs.values()].some(r => r.pub)`, { what: 'listed over the oversize file' });
  assert.equal(app.drive.log.filter((l) => l.method === 'GET' && l.url.includes(big) && l.url.includes('alt=media')).length, 0, 'not downloaded');
  assert.equal(listed(app.drive).jobs.length, 1);
  assert.equal(listed(app.drive).jobs[0].id, s.jobId);
  // a newer version is left exactly as it is
  app.drive.put(app.drive.byName(FILE)[0].id, JSON.stringify({ v: 2, jobs: [{ any: 'thing' }] }));
  const before = String(app.drive.byName(FILE)[0].body);
  await app.ev(`jobs.recs.get('${s.jobId}').pub = false; jobs.recs.get('${s.jobId}').pickupDue = true; pickupIo.cache = null`);
  await app.ev('pickup.step(true)');
  await sleep(500);
  assert.equal(String(app.drive.byName(FILE)[0].body), before, 'a newer file is never written');
  assert.deepEqual(app.pageErrors, []);
}, { timeout: 90000 });

t.test('hostile text in a listed entry is only ever text (XSS), and the aid is made from clean fields', async (h) => {
  const { B } = await pair(h);
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  seedJob(B.n8n, rid('H'), rkey('h'));
  putFile(B.drive, { v: 1, jobs: [entry({ id: rid('H'), key: rkey('h'), label: evil, ctx: { ...entry().ctx, itemId: 'item_xss', title: evil, topic: evil, sourceNames: [evil] } })] });
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${rid('H')}')`);
  await B.ev('jobs.openTray(true)');
  const html = await B.ev(`document.getElementById('jobsTrayList').innerHTML`);
  assert.ok(!/<img|<script/i.test(html), 'escaped in the tray');
  await untilPoking(B, `jobs.recs.get('${rid('H')}').state === 'done'`, 'applied');
  await B.goto('#studio');
  await B.until(`!!document.querySelector('[data-studio-item="item_xss"]')`);
  assert.ok(!/<img|<script/i.test(await B.ev(`document.querySelector('[data-studio-item="item_xss"]').innerHTML`)));
  assert.equal(await B.ev('window.__xss'), undefined);
  assert.deepEqual(B.pageErrors, []);
}, { timeout: 60000 });

t.test('kinds that are never listed: tutor replies, big runs, runs of several batches, the digest step; only single study aids and one-request tool runs are', async (h) => {
  const app = await h.newApp({ v: 8 });
  await connectDrive(app);
  const e = await app.ev(`(() => {
    jobs.groups.set('g_one', { id: 'g_one', kind: 'tool', mode: 'template', n: 1 }); jobs.groups.set('g_two', { id: 'g_two', kind: 'tool', mode: 'transcribe', n: 2 }); jobs.groups.set('g_mr', { id: 'g_mr', kind: 'mr', mode: 'studio_digest', n: 1 });
    const el = (r) => pickup.eligible(r);
    return { tutor: el({ kind: 'tutor', mode: 'tutor', ref: { chatId: 'c' } }), studio: el({ kind: 'studio', mode: 'studio_quiz', ref: { itemId: 'i' } }), digest: el({ kind: 'studio', mode: 'studio_digest', ref: { itemId: 'i' } }),
      one: el({ kind: 'group', mode: 'template', group: { id: 'g_one', i: 0, n: 1 } }), two: el({ kind: 'group', mode: 'transcribe', group: { id: 'g_two', i: 0, n: 2 } }), mr: el({ kind: 'group', mode: 'studio_digest', group: { id: 'g_mr', i: 0, n: 1 } }), mrFlash: el({ kind: 'group', mode: 'studio_flashcards', group: { id: 'g_mr', i: 0, n: 1 } }), foreign: el({ foreign: true, kind: 'pickup', mode: 'studio_quiz' }) };
  })()`);
  assert.deepEqual(e, { tutor: false, studio: true, digest: false, one: true, two: false, mr: false, mrFlash: false, foreign: false });
  // a real tutor reply through the job path: done, and the file never holds it
  const chat = await app.newChat();
  await app.send('Explain osmosis');
  await untilPoking(app, `tutor.chats.find(c => c.id === '${chat}').messages.some(m => m.role === 'model')`, 'tutor reply');
  await sleep(600);
  assert.equal(app.n8n.creates('tutor').length, 1);
  assert.equal(await app.ev(`[...jobs.recs.values()].some(r => r.pub || r.pickupDue)`), false);
  const f = listed(app.drive);
  assert.ok(!f || f.jobs.length === 0, 'the tutor reply is not in the file');
}, { timeout: 60000 });

t.test('a one-request template run: B picks it up into its History (once), A settles its run as collected elsewhere, never a failed run', async (h) => {
  const { A, B } = await pair(h);
  A.n8n.plan(null, { type: 'hold' });
  await A.goto('#template');
  await A.until(`state.mode === 'template' && document.querySelector('[data-role] input[type=file]') !== null`);
  await A.page.setInputFiles('[data-role="instructions"] input[type=file]', [{ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Write about water. 500 words.') }]);
  await A.until(`!document.getElementById('btnAction').disabled`);
  await A.page.click('#btnAction');
  await A.until(`[...jobs.recs.values()].some(r => (r.state === 'submitted' || r.state === 'running') && r.kind === 'group')`, { what: 'run sent' });
  await A.until(`[...jobs.recs.values()].some(r => r.pub)`, { what: 'listed' });
  const f = listed(A.drive);
  assert.equal(f.jobs[0].kind, 'tool');
  assert.deepEqual([f.jobs[0].mode, f.jobs[0].ctx.mode, f.jobs[0].ctx.fileNames, f.jobs[0].ctx.pages, f.jobs[0].ctx.batch], ['template', 'template', ['brief.txt'], 1, 5]);
  const gid = f.jobs[0].ctx.groupId, jobId = f.jobs[0].id;
  await stop(A);
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${jobId}')`);
  const toasts = await B.ev(`(() => { window.__toasts = []; const o = showToast; showToast = (...a) => { window.__toasts.push(String(a[0])); return o(...a); }; })()`);
  A.n8n.release();
  await untilPoking(B, `jobs.recs.get('${jobId}').state === 'done'`, 'B collected the run');
  const hist = await B.ev('getHistory()');
  assert.deepEqual(hist.map((x) => x.id), [`h_${gid}`]);
  assert.match(hist[0].resultText, /# Template/);
  assert.deepEqual(await B.ev('window.__toasts'), [], 'no popup on B');
  // a second pass changes nothing (History ids are the run's id)
  await B.ev(`pickup.applyTool(jobs.recs.get('${jobId}'), jobs.recs.get('${jobId}').pk.ctx, { text: 'x' })`);
  assert.equal((await B.ev('getHistory()')).length, 1);
  await go(A);
  await untilPoking(A, `jobs.recs.get('${jobId}').state === 'done'`, 'A saw collected');
  assert.equal(await A.ev(`[...jobs.groups.values()].map(g => g.state + ':' + !!g.pickedUp).join()`), 'done:true');
  assert.equal(await A.ev(`document.getElementById('jobsAlert').textContent`), '');
  assert.equal(A.n8n.creates('template').length, 1);
  assert.equal((await A.ev('getHistory()')).length, 0, 'not yet: it comes by History sync');
  await B.ev('pushToDrive()');
  await A.ev(`syncEnqueue('pull')`);
  await A.until(`getHistory().then(e => e.some(x => x.id === 'h_${gid}'))`, { what: 'the History entry reached A', timeout: 20000 });
  assert.equal((await A.ev('getHistory()')).length, 1);
  void toasts;
}, { timeout: 90000 });

t.test('rollback to a v7 server: a claim answers STH-INPUT-400; the origin falls back to result + ack and keeps its paid answer; the other device goes passive', async (h) => {
  const { A, B } = await pair(h);
  await countApplies(A); await countApplies(B);
  A.n8n.plan(null, { type: 'hold' });
  const { jobId, itemId } = await startAid(h, A);
  await A.until(`[...jobs.recs.values()].some(r => r.pub)`);
  await stop(A);
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${jobId}')`);
  // the owner rolls back while the job runs: the server is v7 now (no claim op, no collected note); neither device has heard of it yet
  A.n8n.v = 7;
  A.n8n.release();
  await untilPoking(B, `!serverHas(8)`, 'B learned v7 from the refused claim');
  assert.equal(await B.ev(`jobs.recs.get('${jobId}').state`), 'succeeded', 'B keeps the record, passive');
  assert.equal(await applies(B), 0);
  assert.equal(await itemOf(B, itemId), null, 'the other device never applies without the claim');
  assert.equal(A.n8n.job(jobId).resultServed || 0, 0, 'and never falls back to result for a request that is not its own');
  await go(A);
  await untilPoking(A, `jobs.recs.get('${jobId}').state === 'done'`, 'A used result + ack', 40000);
  assert.equal(await applies(A), 1);
  assert.equal((await itemOf(A, itemId)).status, 'ready');
  assert.equal(A.n8n.job(jobId).resultServed, 1);
  assert.equal(A.n8n.job(jobId).acked, true);
  assert.equal((await recOf(A, jobId)).doneElsewhere, false);
  assert.equal(A.n8n.creates().length, 1);
}, { timeout: 90000 });

t.test('lifetime: ended and old entries are pruned (done after 24 h, everything at its end time), foreign records past their end are dropped with their local data', async (h) => {
  const out = await (async () => {
    const app = await h.newApp({ v: 8 });
    return app.ev(`(() => {
      const now = Date.now(), H = 3600000;
      const mk = (c, o) => ({ id: 'j_' + c.repeat(22), key: 'k'.repeat(43), mode: 'studio_mindmap', kind: 'studio', label: 'l', createdAt: now - 2 * H, expiresAt: now + 70 * H, state: 'open', doneAt: 0, ctx: {}, ...o });
      const m = new Map([['A', mk('A', {})], ['B', mk('B', { expiresAt: now - 1 })], ['C', mk('C', { state: 'done', doneAt: now - 25 * H, key: '' })], ['D', mk('D', { state: 'done', doneAt: now - 23 * H, key: '' })], ['E', mk('E', { state: 'cancelled', doneAt: now - 2 * H, key: '' })]].map(([k, v]) => [v.id, v]));
      const changed = pickupPrune(m, now);
      return { changed, kept: [...m.values()].map(e => e.id[2]).sort().join('') };
    })()`);
  })();
  assert.deepEqual(out, { changed: true, kept: 'ADE' });
  // through the file: a listed-but-ended entry is dropped by the next round, and not taken up
  const { B } = await pair(h);
  seedJob(B.n8n, rid('J'), rkey('j'));
  const now = Date.now();
  putFile(B.drive, { v: 1, jobs: [entry({ id: rid('J'), key: rkey('j'), createdAt: now - 80 * 3600e3, expiresAt: now - 1000 }), entry({ id: rid('K'), key: rkey('k'), createdAt: now - 3000, expiresAt: now + 3 * 3600e3 })] });
  seedJob(B.n8n, rid('K'), rkey('k'), 'studio_mindmap', 'running');
  B.n8n.job(rid('K')).plan = { type: 'hold' };
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${rid('K')}')`);
  assert.equal(await B.ev(`jobs.recs.has('${rid('J')}')`), false, 'an ended entry is not taken up');
  assert.deepEqual(listed(B.drive).jobs.map((e) => e.id), [rid('K')], 'and the next write removes it');
  // a foreign record whose entry ended is dropped on the next start, quietly
  await B.ev(`jobs.update('${rid('K')}', x => { x.expiresAt = Date.now() - 1000; })`);
  await B.reload();
  assert.deepEqual(await recOf(B, rid('K')), { state: 'expired', foreign: true, pub: false, doneElsewhere: false, dismissed: true, nonce: null, mode: 'studio_mindmap' });
  assert.equal(await B.ev(`document.getElementById('jobsTrayBadge').hidden`), true);
}, { timeout: 90000 });

t.test('sync not connected: no file, no list calls, the old behaviour (claim, apply, ack on the one device)', async (h) => {
  const app = await h.newApp({ v: 8 });
  await countApplies(app);
  const s = await startAid(h, app);
  await untilPoking(app, `jobs.recs.get('${s.jobId}').state === 'done'`, 'done on the one device');
  assert.equal((await itemOf(app, s.itemId)).status, 'ready');
  assert.equal(await applies(app), 1);
  assert.equal(app.drive.byName(FILE).length, 0, 'no file');
  assert.equal(app.drive.log.length, 0, 'no Drive call at all');
  assert.equal(await app.ev(`[...jobs.recs.values()].some(r => r.pub)`), false);
  assert.equal(app.n8n.ops('claim').length, 1);
  assert.equal(app.n8n.job(s.jobId).state, 'collected');
  // a v7 server: the same, with result and ack
  const old = await h.newApp({ v: 7 });
  const o = await startAid(h, old);
  await untilPoking(old, `jobs.recs.get('${o.jobId}').state === 'done'`, 'v7 path');
  assert.equal(old.n8n.ops('claim').length, 0);
  assert.equal(old.n8n.job(o.jobId).resultServed, 1);
  assert.equal(old.drive.log.length, 0);
}, { timeout: 60000 });

t.test('the secret key appears only in the hidden file, the job calls and this device\'s job store: never in storage, the page, logs, error reports or URLs', async (h) => {
  const { A, B } = await pair(h);
  const logs = [];
  for (const a of [A, B]) a.page.on('console', (m) => logs.push(m.text()));
  A.n8n.plan(null, { type: 'hold' });
  const { jobId, itemId, key } = await startAid(h, A);
  await A.until(`[...jobs.recs.values()].some(r => r.pub)`);
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${jobId}')`);
  // while the entry is open the key is in the hidden file
  assert.equal(JSON.stringify(listed(A.drive)).includes(key), true);
  for (const f of A.drive.files.values()) if (f.name !== FILE) assert.equal(String(f.body).includes(key), false, `not in ${f.name}`);
  A.n8n.release();
  await stop(A);
  await untilPoking(B, `jobs.recs.get('${jobId}').state === 'done'`, 'done');
  await untilPoking(B, `[...jobs.recs.values()].every(r => !r.pickupMark)`, 'marked');
  await B.ev('jobs.openTray(true)');
  for (const [name, a] of [['A', A], ['B', B]]) {
    const dump = await a.ev(`(() => ({ ls: JSON.stringify({ ...localStorage }), ss: JSON.stringify({ ...sessionStorage }), html: document.documentElement.outerHTML, href: location.href }))()`);
    for (const k of ['ls', 'ss', 'html', 'href']) assert.equal(dump[k].includes(key), false, `${name}: key not in ${k}`);
    // every IndexedDB database but the job store is free of it
    const dbs = await a.ev(`(async () => {
      const out = {};
      for (const d of await indexedDB.databases()) {
        const db = await new Promise((res, rej) => { const q = indexedDB.open(d.name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
        let text = '';
        for (const n of db.objectStoreNames) { const rows = await new Promise((res) => { const q = db.transaction(n).objectStore(n).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); }); try { text += JSON.stringify(rows); } catch { /* blobs */ } }
        out[d.name] = text.includes(${JSON.stringify(key)});
        db.close();
      }
      return out;
    })()`);
    for (const [db, has] of Object.entries(dbs)) if (db !== 'sth_jobs') assert.equal(has, false, `${name}: key not in ${db}`);
  }
  assert.equal(logs.some((l) => l.includes(key)), false, 'not in the console');
  assert.equal(A.n8n.log.filter((r) => r.kind === 'direct' && r.payload && r.payload.mode === 'error_report').some((r) => JSON.stringify(r.payload).includes(key)), false);
  assert.equal(A.n8n.log.some((r) => r.path.includes(key)), false, 'not in a URL');
  assert.equal(A.drive.log.some((l) => l.url.includes(key)), false);
  assert.equal(A.blocked.concat(B.blocked).some((u) => u.includes(key)), false);
  // after it is collected the file entry has no key
  assert.equal(JSON.stringify(listed(A.drive)).includes(key), false);
  void itemId;
}, { timeout: 90000 });

t.test('claim and ack carry the nonce; a lease taken over elsewhere is `notYours` and still ends quietly; a failed apply on the other device is not acknowledged', async (h) => {
  const { A, B } = await pair(h);
  A.n8n.plan(null, { type: 'hold' });
  const { jobId, itemId } = await startAid(h, A);
  await A.until(`[...jobs.recs.values()].some(r => r.pub)`);
  await stop(A);
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${jobId}')`);
  A.n8n.release();
  // B's apply fails (storage trouble): not acknowledged, tried again later, the answer stays for the origin
  await B.ev(`pickup.applyStudio = () => { throw new AppError('STORE-507'); }`);
  await untilPoking(B, `(jobs.recs.get('${jobId}').applyTries || 0) >= 1`, 'a failed try');
  assert.equal(A.n8n.job(jobId).state, 'succeeded', 'not collected');
  assert.equal(A.n8n.ops('ack').length, 0, 'nothing acknowledged');
  assert.equal((await recOf(B, jobId)).state, 'succeeded');
  const claim = A.n8n.ops('claim')[0];
  assert.match(claim.payload.jobs[0].nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await B.ev(`jobs.recs.get('${jobId}').nonce`), claim.payload.jobs[0].nonce);
  // the origin (another nonce) takes it after the lease and its ack carries its own nonce
  await go(A);
  const t0 = Date.now(); A.n8n.clock = () => t0 + 601000;
  await untilPoking(A, `jobs.recs.get('${jobId}').state === 'done'`, 'A took the answer', 40000);
  const ack = A.n8n.ops('ack').at(-1).payload.jobs[0];
  assert.equal(ack.nonce, await A.ev(`jobs.recs.get('${jobId}').nonce`));
  assert.notEqual(ack.nonce, claim.payload.jobs[0].nonce);
  assert.equal(A.n8n.job(jobId).state, 'collected');
  assert.equal((await itemOf(A, itemId)).status, 'ready');
}, { timeout: 90000 });

t.test('cancel works from either device: B cancels a request A started; A is told, calmly; the entry ends cancelled', async (h) => {
  const { A, B } = await pair(h);
  A.n8n.plan(null, { type: 'hold' });
  const { jobId, itemId } = await startAid(h, A);
  await A.until(`[...jobs.recs.values()].some(r => r.pub)`);
  await stop(A);
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${jobId}')`);
  await B.ev('jobs.openTray(true)');
  await B.page.click(`[data-jobs-act="cancel"][data-id="${jobId}"]`);
  await B.until(`jobs.recs.get('${jobId}').state === 'cancelled'`);
  assert.equal(A.n8n.job(jobId).cancelled, true);
  assert.equal(await B.ev(`document.getElementById('jobsAlert').textContent`), '', 'nothing alarming on the device that cancelled');
  await untilPoking(B, `[...jobs.recs.values()].every(r => !r.pickupMark)`, 'marked');
  assert.equal(listed(A.drive).jobs[0].state, 'cancelled');
  await go(A);
  await untilPoking(A, `jobs.recs.get('${jobId}').state === 'failed'`, 'A is told');
  assert.equal((await itemOf(A, itemId)).status, 'failed');
  assert.equal(A.n8n.creates().length, 1);
}, { timeout: 60000 });

t.test('an artifact file another device already uploaded is adopted, never doubled', async (h) => {
  const app = await h.newApp({ v: 8 });
  await connectDrive(app);
  const item = studioItem('mindmap', { id: 'item_dup1' });
  const existing = app.drive.add('sth-studio-item_dup1.json', JSON.stringify({ v: 1, id: 'item_dup1', tool: 'mindmap', artifact: item.artifact }));
  await app.seedItems([item]);
  await app.ev('pushToDrive()');
  await app.until(`studio.items.find(i => i.id === 'item_dup1').driveFileId`, { what: 'uploaded or adopted' });
  assert.equal(app.drive.byName('sth-studio-item_dup1.json').length, 1);
  assert.equal(await app.ev(`studio.items.find(i => i.id === 'item_dup1').driveFileId`), existing);
}, { timeout: 60000 });

t.test('two files with the name (two devices created it at once): merged per id, a finished state wins, the extra file is removed', async (h) => {
  const { B } = await pair(h);
  const e1 = entry({ id: rid('M'), key: rkey('m'), label: 'one' });
  const e2 = entry({ id: rid('N'), key: rkey('n'), label: 'two' });
  const e1done = { ...e1, key: '', state: 'done', doneAt: Date.now() - 1000 };
  putFile(B.drive, { v: 1, jobs: [e1, e2] });
  putFile(B.drive, { v: 1, jobs: [e1done] });
  seedJob(B.n8n, rid('N'), rkey('n'), 'studio_mindmap', 'running'); B.n8n.job(rid('N')).plan = { type: 'hold' };
  await B.ev('pickup.step(true)');
  await B.until(`jobs.recs.has('${rid('N')}')`);
  assert.equal(await B.ev(`jobs.recs.has('${rid('M')}')`), false, 'the one that is done is not taken up');
  assert.equal(B.drive.byName(FILE).length, 1);
  const f = listed(B.drive);
  assert.deepEqual(f.jobs.map((e) => [e.id[2], e.state]).sort(), [['M', 'done'], ['N', 'open']]);
}, { timeout: 60000 });

t.run();
