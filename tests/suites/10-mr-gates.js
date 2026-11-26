'use strict';
// Map-reduce: the gate (v6 server, date, jobs flag), busy answers, today's capacity, limits, retry limits, the tutor next to a big run.
const { suite, assert } = require('../lib/harness');
const { MODES_V6, MODES_V7 } = require('../lib/fake-n8n');
const { AFTER, BEFORE, mask } = require('../lib/common');
const M = require('../lib/mr');
const { fx } = M;

const t = suite('10-mr-gates');
const hello = (app) => app.ev('jobs.hello()');

t.test('the gate flips to a v6 server in the middle of a run: it pauses, sends nothing, and carries on when v7 is back', async (h) => {
  const app = await M.bigApp(h);
  M.holdPart(app.n8n, 1);
  M.holdPart(app.n8n, 2);
  await M.toConsent(app);
  await M.start(app);
  await app.waitNode(() => app.n8n.creates().length === 2);
  await app.until(`[...jobs.recs.values()].filter(r => r.state === 'submitted' || r.state === 'running').length === 2`);
  app.n8n.v = 0; app.n8n.modes = MODES_V6;
  await hello(app);
  await app.until(`!studioMrOn()`);
  app.n8n.release(); // the two parts in flight finish
  await app.advanceUntil(`(() => { const g = [...jobs.groups.values()].find(g => g.kind === 'mr'); return g && g.members[0].state === 'done' && g.members[1].state === 'done'; })()`, { step: 2000, what: 'the two running parts finished' });
  await app.advance(60000);
  assert.equal(app.n8n.creates().length, 2, 'paused: nothing new is sent while the server is v6');
  const d = await M.describe(app);
  assert.match(d.text, /^Paused: big runs are not available from the server right now, so nothing more is sent\. It carries on by itself when they are back\.$/);
  assert.deepEqual(d.actions.map(a => a.label), ['Cancel']);
  assert.equal((await M.members(app)).filter(m => m.state === 'todo').length, 4, 'the other parts and the last step wait');
  app.n8n.v = 7; app.n8n.modes = MODES_V7;
  await hello(app);
  await M.finish(app);
  assert.equal(app.n8n.creates().length, 6);
  for (let i = 1; i <= 5; i++) assert.equal(M.partCreates(app.n8n, i).length, 1);
});

t.test('the server leaves the digest job out of its modes mid-run: the same pause', async (h) => {
  const app = await M.bigApp(h);
  M.holdPart(app.n8n, 1);
  M.holdPart(app.n8n, 2);
  await M.toConsent(app);
  await M.start(app);
  await app.waitNode(() => app.n8n.creates().length === 2);
  await app.until(`[...jobs.recs.values()].filter(r => r.state === 'submitted' || r.state === 'running').length === 2`);
  app.n8n.modes = MODES_V7.filter(m => m !== 'studio_digest');
  await hello(app);
  app.n8n.release();
  await app.advance(60000);
  assert.equal(app.n8n.creates().length, 2);
  app.n8n.modes = MODES_V7;
  await hello(app);
  await M.finish(app);
});

// ── gate off: the old behaviour, unchanged ──
const SIZES = [300000, 500000, 950000];
async function refusal(h, kind, cfg, tokens) {
  const app = await h.newApp({ page: kind, ...cfg });
  await app.seedKb([fx.kbItem('big.txt', { tokens, id: 'k_big' })]);
  await app.goto('#studio');
  await app.ev(`studio.openDialog('mindmap', { sourceIds: ['k_big'] })`);
  await h.sleep(150);
  const out = await app.page.evaluate(() => ({
    plan: JSON.stringify(window.__t.studio.plan(['k_big'])), reason: document.getElementById('studioDialogReason').textContent, meter: document.getElementById('studioDialogMeterText').textContent,
    cost: document.getElementById('studioDialogCost').textContent, disabled: document.getElementById('studioGenerateBtn').getAttribute('aria-disabled'), view: window.__t.studio.dialog.view || null,
  }));
  if (out.disabled === 'true') { // only a refused form is clicked: it must send nothing (a valid one would start a run, at a timing of its own)
    await app.page.click('#studioGenerateBtn', { force: true }).catch(() => {});
    await h.sleep(250);
  }
  out.sent = app.n8n.creates().length + app.n8n.direct().length + app.n8n.ops('budget').length;
  out.after = (await app.ev('studio.dialog.view')) || null; // (null in the new page, absent in the old one)
  out.toast = await app.page.evaluate(() => document.getElementById('toast').textContent);
  return out;
}
const CONFIGS = [['v6 server after 8 Dec', { v: 0, now: AFTER }], ['v7 server before 8 Dec', { v: 7, now: BEFORE }], ['jobs flag off after 8 Dec', { v: 7, now: AFTER, jobs: false }]];
for (const [label, cfg] of CONFIGS) {
  t.test(`gate off (${label}): the too-big refusal and the meter are the same in BASE and NEW`, async (h) => {
    for (const tokens of SIZES) {
      const nu = await refusal(h, 'new', cfg, tokens);
      const base = await refusal(h, 'base', cfg, tokens);
      const diff = Object.keys(nu).filter(k => JSON.stringify(nu[k]) !== JSON.stringify(base[k])).map(k => `${k}: NEW ${JSON.stringify(nu[k])} / BASE ${JSON.stringify(base[k])}`);
      assert.deepEqual(diff, [], `${tokens} tokens`);
      assert.notEqual(nu.view, 'mr', 'no big-run question when the gate is off');
    }
    const big = await refusal(h, 'new', cfg, 950000);
    assert.equal(big.disabled, 'true');
    assert.equal(big.reason, 'Choose fewer sources.');
    assert.equal(big.sent, 0, 'a disabled Generate sends nothing (no job, no direct request, no budget question)');
  }, { needsBase: true, timeout: 80000 });
}

t.test('gate on, same 500k-token source: no refusal, the big-run question instead (the contrast)', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedKb([fx.kbItem('big.txt', { tokens: 500000, id: 'k_big' })]);
  await app.goto('#studio');
  await app.ev(`studio.openDialog('mindmap', { sourceIds: ['k_big'] })`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  await app.page.click('#studioGenerateBtn');
  await app.until(`studio.dialog.view === 'mr'`, { timeout: 20000 });
  const c = await require('../lib/mr').readConsent(app);
  assert.match(c.lead, /so it runs in 4 parts/);
  assert.equal(app.n8n.creates().length, 0);
});

t.test('single call just under the cap: the request is the same in BASE and NEW with the gate on', async (h) => {
  const grab = async (kind) => {
    const app = await h.newApp({ page: kind, now: AFTER });
    await app.seedKb([fx.kbItem('mid.txt', { tokens: 380000, id: 'k_mid' })]);
    await app.goto('#studio');
    await app.ev(`studio.openDialog('flashcards', { sourceIds: ['k_mid'], language: 'af', topic: 'ch 2' })`);
    await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
    await app.page.click('#studioGenerateBtn');
    await app.waitNode(() => app.n8n.creates().length === 1, { what: 'the single request' });
    return { payload: app.n8n.creates()[0].payload, mr: app.n8n.ops('budget').length };
  };
  const nu = await grab('new'), base = await grab('base');
  assert.equal(mask(nu.payload), mask(base.payload));
  assert.equal(nu.mr, 0, 'no big-run question and no budget call for a run one call can take');
  assert.ok(!('part' in nu.payload) && !('strategy' in nu.payload));
}, { needsBase: true });

// ── busy ──
t.test('busy (STH-JOB-429) on a part: re-sent after 60, 120, then 180 s (x 1 to 1.3), six full sends at most, then the run stops', async (h) => {
  const app = await M.bigApp(h, { app: { clock: true } });
  app.n8n.plan((j) => j.payload.part && j.payload.part.i === 2, { type: 'busy' }, 100);
  await M.toConsent(app);
  await M.start(app);
  const rec = () => app.ev(`(() => { const r = [...jobs.recs.values()].find(r => r.group && r.group.i === 1); return r ? { id: r.id, state: r.state, kind: r.waitKind, tries: r.busyTries || 0, due: r.nextPollAt - Date.now() } : null; })()`);
  const expectS = [60, 120, 180, 180, 180];
  const seen = [];
  for (let k = 0; k < 5; k++) {
    await app.advanceUntil(`(() => { const r = [...jobs.recs.values()].find(r => r.group && r.group.i === 1); return r && r.state === 'waiting' && r.waitKind === 'busy' && r.busyTries === ${k + 1}; })()`, { step: 1000, what: `busy wait ${k + 1}` });
    const r = await rec();
    seen.push(r.due);
    const lo = expectS[k] * 1000, hi = lo * 1.3;
    assert.ok(r.due > lo - 3000 && r.due <= hi + 100, `wait ${k + 1} is ${Math.round(r.due / 1000)} s, expected ${expectS[k]}–${Math.round(expectS[k] * 1.3)} s`);
    assert.equal(M.partCreates(app.n8n, 2).length, k + 1, `${k + 1} full sends so far`);
    await app.advance(r.due + 2000, { step: 10000, pause: 15 });
  }
  await app.advanceUntil(`(() => { const r = [...jobs.recs.values()].find(r => r.group && r.group.i === 1); return r && r.state === 'failed'; })()`, { step: 2000, what: 'the sixth refusal ends it' });
  assert.equal(M.partCreates(app.n8n, 2).length, 6, 'six full sends and no more');
  assert.equal(new Set(M.partCreates(app.n8n, 2).map(r => r.jobId)).size, 1, 'the same job each time');
  const same = M.partCreates(app.n8n, 2).map(r => JSON.stringify(r.payload.sources));
  assert.equal(new Set(same).size, 1, 'the whole body is sent again each time');
  await app.advanceUntil(`[...jobs.groups.values()].some(g => g.kind === 'mr' && g.state === 'failed')`, { step: 1000 });
  const d = await M.describe(app);
  assert.match(d.text, /^Part 2 of 5 .*: The service is busy right now\. Try again in a few minutes\. Retry it when it is quieter; finished parts are kept\. \(Code STH-JOB-429\)$/);
  assert.deepEqual(d.actions.map(a => a.label), ['Retry part', 'Skip part', 'Cancel', 'Dismiss']);
  assert.equal(app.n8n.overCap || 0, 0);
});

// ── what the consent says ──
const withBudget = (b) => ({ fake: { enforceCaps: true, budget: b } });
t.test('capacity left today is low: QUOTA-431 on the question, and "Start anyway" when it can still fit one day', async (h) => {
  const app = await M.bigApp(h, withBudget({ bulkRemaining: 300000, bulkCeiling: 20000000 }));
  await M.toConsent(app);
  const c = await M.readConsent(app);
  const q = await app.ev(`ERRORS['QUOTA-431'].message`);
  assert.ok(c.note.includes(q), c.note);
  assert.ok(c.note.includes('You can start anyway: it pauses when today’s capacity runs out, and you can continue it after it resets.'));
  assert.equal(c.startHidden, false);
  assert.equal(c.startText, 'Start anyway');
  assert.ok(!c.facts.some(f => /% of the shared AI capacity/.test(f)), 'the share line is only for a run that fits what is left');
  await M.start(app);
  await app.waitNode(() => app.n8n.creates().length >= 1, { what: 'Start anyway starts it' });
});

t.test('capacity: a run that can never fit today is not offered (QUOTA-431, no Start)', async (h) => {
  const app = await M.bigApp(h, withBudget({ bulkRemaining: 300000, bulkCeiling: 1000000 }));
  await M.toConsent(app);
  const c = await M.readConsent(app);
  assert.ok(c.note.includes(await app.ev(`ERRORS['QUOTA-431'].message`)));
  assert.ok(!/start anyway/.test(c.note));
  assert.equal(c.startHidden, true);
  assert.equal(await app.ev(`document.activeElement.id`), 'studioMrBack');
});

t.test('capacity: when the budget question fails the run is still offered, with a note (fail open)', async (h) => {
  // (with no answer the cap stays at the hard 900k, so the run has to be bigger than that to need parts)
  const items = [fx.kbItem('Big A.pdf', { tokens: 600000, pages: 60, id: 'k_a', timestamp: 1700000000002 }), fx.kbItem('Big B.pdf', { tokens: 600000, pages: 60, id: 'k_b', timestamp: 1700000000001 })];
  const app = await M.bigApp(h, { items });
  app.n8n.budgetStatus = 500;
  await M.toConsent(app, 'flashcards');
  const c = await M.readConsent(app);
  assert.match(c.note, /Could not check how much shared AI capacity is left today, so that is not shown\./);
  assert.ok(!/QUOTA|capacity runs out/.test(c.note.replace('how much shared AI capacity is left today', '')));
  assert.equal(c.startHidden, false);
  assert.ok(!c.facts.some(f => /% of the shared AI capacity/.test(f)), 'no share line without a budget');
  await M.start(app);
  await app.waitNode(() => app.n8n.creates().length >= 1);
});

t.test('over the per-run limit (cfg:mr_max_units): STU-416, with the cost and the limit, and no Start', async (h) => {
  const app = await M.bigApp(h, withBudget({ mrMaxUnits: 1000000 }));
  await M.toConsent(app);
  const c = await M.readConsent(app);
  assert.equal(c.lead, await app.ev(`ERRORS['STU-416'].message`));
  assert.ok(c.facts.some(f => /^This run would cost about R[\d.]+(–R[\d.]+)?, more than the limit of about R[\d.]+ for one run\.$/.test(f)), c.facts.join(' | '));
  assert.equal(c.startHidden, true);
  await app.advance(10000);
  assert.equal(app.n8n.creates().length, 0);
});

t.test('more parts than the server allows: STU-416 and the numbers (hello caps.maxParts)', async (h) => {
  // eight 80k-token sources pack one to a part: 640k tokens is under the 5 x 150k the plan meter allows, but it needs 8 parts
  const items = Array.from({ length: 8 }, (_, i) => fx.kbItem(`src${i}.txt`, { tokens: 80000, id: `k_s${i}`, timestamp: 1700000000000 + 10 - i }));
  const app = await M.bigApp(h, { items, fake: { enforceCaps: true, caps: { maxParts: 5 } } });
  await M.toConsent(app, 'mindmap', { sourceIds: items.map(i => i.id) });
  const c = await M.readConsent(app);
  assert.equal(c.lead, await app.ev(`ERRORS['STU-416'].message`));
  assert.ok(c.facts.includes('It would take 8 parts, and a run has at most 5.'), c.facts.join(' | '));
  assert.equal(c.startHidden, true);
});

t.test('the last step could not take the notes (hello caps.reduceMaxTokens): refused before any part is paid', async (h) => {
  const app = await M.bigApp(h, { fake: { enforceCaps: true, caps: { reduceMaxTokens: 50000 } } });
  await M.toConsent(app);
  const c = await M.readConsent(app);
  assert.equal(c.lead, await app.ev(`ERRORS['STU-416'].message`));
  assert.ok(c.facts.includes('The notes from 5 parts would be too big for the last step (the limit is about 50k tokens right now). Choose fewer sources.'), c.facts.join(' | '));
  assert.equal(c.startHidden, true);
  assert.equal(app.n8n.creates().length, 0);
});

t.test('flashcards: too many parts for the number of cards asked (2 each at least)', async (h) => {
  // 15 cards -> 20 asked -> at most 10 parts; ten 100k sources of different files need 10 parts, eleven need 11
  const items = Array.from({ length: 11 }, (_, i) => fx.kbItem(`f${i}.txt`, { tokens: 100000, id: `k_f${i}`, timestamp: 1700000000000 + 20 - i }));
  const app = await M.bigApp(h, { items });
  await M.toConsent(app, 'flashcards', { sourceIds: items.map(i => i.id), options: { count: 15 } }).catch(() => {});
  // 11 x 100k = 1.1M tokens is over what 16 parts of 150k... but the question may refuse it earlier; either way nothing is sent
  assert.equal(app.n8n.creates().length, 0);
});

// ── manual retries are limited ──
t.test('Retry part works twice; the third time it is blocked, and the run must be started again with its question', async (h) => {
  const app = await M.bigApp(h);
  M.failPart(app.n8n, 3, 3);
  await M.toConsent(app);
  await M.start(app);
  const failed = () => app.advanceUntil(`[...jobs.groups.values()].some(g => g.kind === 'mr' && g.state === 'failed')`, { step: 2000, what: 'run stopped' });
  await failed();
  await M.tray(app, 'retry');
  await app.until(`[...jobs.groups.values()].some(g => g.kind === 'mr' && g.members[2].retries === 1)`);
  await failed();
  await M.tray(app, 'retry');
  await app.until(`[...jobs.groups.values()].some(g => g.kind === 'mr' && g.members[2].retries === 2)`);
  await failed();
  assert.equal(M.partCreates(app.n8n, 3).length, 3, 'the first send and two retries');
  const d = await M.describe(app);
  assert.deepEqual(d.actions.map(a => a.label), ['Skip part', 'Cancel', 'Dismiss'], 'no Retry part any more');
  assert.match(d.text, /This has been tried again twice already, and each try can cost\. Cancel the run and start it again: you will see the estimate first\.$/);
  // asking anyway (a stale button, another tab) is refused with the same words
  await app.ev(`jobs.onGroupAct('retry', '${await M.gid(app)}', 2)`);
  await app.until(`/tried again twice already/.test(document.getElementById('toast').textContent)`);
  await app.advance(10000);
  assert.equal(M.partCreates(app.n8n, 3).length, 3, 'still three sends');
  // Cancel, then Retry on the study aid: the question comes first
  await M.tray(app, 'cancel');
  await app.confirm(true);
  await app.until(`studio.items[0].status === 'failed'`);
  const id = await app.ev('studio.items[0].id');
  await app.ev(`studio.retry('${id}')`);
  await app.until(`studio.dialog.view === 'mr'`);
  const sent = app.n8n.creates().length;
  await app.advance(5000);
  assert.equal(app.n8n.creates().length, sent, 'nothing is sent before the new Start');
  await M.start(app);
  await M.finish(app);
  assert.equal(await app.ev('studio.items[0].error'), null);
});

t.test('a run more than 24 hours old cannot be retried by a button: it must be started again with its question', async (h) => {
  const app = await M.bigApp(h);
  M.failPart(app.n8n, 3, 1);
  await M.toConsent(app);
  await M.start(app);
  await app.advanceUntil(`[...jobs.groups.values()].some(g => g.kind === 'mr' && g.state === 'failed')`, { step: 2000 });
  const g = await M.gid(app);
  await app.ev(`jobs.groupUpdate('${g}', x => { x.createdAt -= 25 * 3600e3; })`);
  const d = await M.describe(app);
  assert.deepEqual(d.actions.map(a => a.label), ['Skip part', 'Cancel', 'Dismiss']);
  assert.match(d.text, /This run is more than a day old\. Cancel it and start it again: you will see the estimate first\.$/);
  const n = M.partCreates(app.n8n, 3).length;
  await app.ev(`jobs.onGroupAct('retry', '${g}', 2)`);
  await app.until(`/more than a day old/.test(document.getElementById('toast').textContent)`);
  assert.equal(M.partCreates(app.n8n, 3).length, n);
});

// ── the tutor next to a big run ──
t.test('tutor jobs still get a slot while a big run holds both bulk slots', async (h) => {
  const app = await M.bigApp(h);
  M.holdPart(app.n8n, 1);
  M.holdPart(app.n8n, 2);
  await M.toConsent(app);
  await M.start(app);
  await app.waitNode(() => app.n8n.creates().length === 2);
  await app.until(`[...jobs.recs.values()].filter(r => r.state === 'submitted' || r.state === 'running').length === 2`);
  const chat = await app.newChat();
  await app.send('A question while the big run is going');
  await app.advanceUntil(`tutor.chats.find(c => c.id === '${chat}').messages.some(m => m.role === 'model')`, { step: 2000, what: 'tutor reply' });
  assert.equal(app.n8n.creates('tutor').length, 1, 'one tutor job, not turned away');
  assert.equal(app.n8n.creates('studio_digest').length, 2, 'the big run is still waiting on its two held parts');
  assert.equal(app.n8n.overCap || 0, 0, 'the server never refused for the cap');
  assert.ok(M.maxBulk(app.n8n) <= 2);
  assert.equal(M.partCreates(app.n8n, 3).length, 0, 'the run did not take a third slot');
  app.n8n.release();
  await M.finish(app);
  assert.equal(app.n8n.overCap || 0, 0);
});

t.test('tutor: the "study studio" pointer is a separate note, shown beside the reply and never sent back as history', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedKb([fx.kbItem('Whole book.txt', { tokens: 450000, id: 'k_whole' })]);
  const chat = await app.ev(`(async () => { const c = await tutor.newChatFor({ attachedKnowledgeIds: ['k_whole'] }); return c.id; })()`);
  await app.openChat(chat);
  await app.send('Please give me a summary of the whole book');
  await app.advanceUntil(`tutor.chats.find(c => c.id === '${chat}').messages.some(m => m.role === 'model')`, { step: 2000, what: 'first reply' });
  const reply = await app.ev(`tutor.chats.find(c => c.id === '${chat}').messages.find(m => m.role === 'model')`);
  const note = await app.ev('STUDIO_TUTOR_WHOLE_NOTE');
  assert.equal(reply.note, note, 'the pointer is in its own field');
  assert.ok(!reply.text.includes(note) && !/study studio/i.test(reply.text), 'and not in the text of the reply');
  await app.reload();
  await app.openChat(chat);
  assert.ok(await app.ev(`/Study Studio can make it/.test(document.getElementById('tutorMessages').textContent)`), 'it is shown beside the reply when the chat is drawn again');
  await app.send('And what about chapter two?');
  await app.advanceUntil(`tutor.chats.find(c => c.id === '${chat}').messages.filter(m => m.role === 'model').length === 2`, { step: 2000, what: 'second reply' });
  const second = app.n8n.creates('tutor')[1].payload;
  const history = JSON.stringify(second.messages);
  assert.ok(!/Study Studio/i.test(history), 'the model never sees the pointer');
  assert.ok(second.messages.every(m => Object.keys(m).sort().join() === 'role,text'), 'history carries role and text only');
  assert.equal(second.messages.length, 3);
  const noNote = await app.ev(`tutor.chats.find(c => c.id === '${chat}').messages.filter(m => m.role === 'model')[1].note`);
  assert.equal(noNote, undefined, 'no pointer on an ordinary question');
});

t.test('tutor: no pointer before the release (gate off) and none when the reply already names Study Studio', async (h) => {
  const before = await h.newApp({ now: BEFORE });
  await before.seedKb([fx.kbItem('Whole book.txt', { tokens: 450000, id: 'k_whole' })]);
  const c1 = await before.ev(`(async () => (await tutor.newChatFor({ attachedKnowledgeIds: ['k_whole'] })).id)()`);
  await before.openChat(c1);
  await before.send('Summarise the whole book');
  await before.advanceUntil(`tutor.chats.find(c => c.id === '${c1}').messages.some(m => m.role === 'model')`, { step: 2000 }).catch(async () => { await before.until(`tutor.chats.find(c => c.id === '${c1}').messages.some(m => m.role === 'model')`, { timeout: 30000 }); });
  assert.equal(await before.ev(`tutor.chats.find(c => c.id === '${c1}').messages.find(m => m.role === 'model').note`), undefined);
  const after = await h.newApp({ now: AFTER });
  await after.seedKb([fx.kbItem('Whole book.txt', { tokens: 450000, id: 'k_whole' })]);
  after.n8n.handlers.tutor = () => ({ text: 'For a whole-book summary, Study Studio is the right tool.' });
  const c2 = await after.ev(`(async () => (await tutor.newChatFor({ attachedKnowledgeIds: ['k_whole'] })).id)()`);
  await after.openChat(c2);
  await after.send('Give me an overview of the entire book');
  await after.until(`tutor.chats.find(c => c.id === '${c2}').messages.some(m => m.role === 'model')`, { timeout: 40000 }).catch(async () => { await after.advanceUntil(`tutor.chats.find(c => c.id === '${c2}').messages.some(m => m.role === 'model')`, { step: 2000 }); });
  assert.equal(await after.ev(`tutor.chats.find(c => c.id === '${c2}').messages.find(m => m.role === 'model').note`), undefined);
});

// page.js ~10597 + ~10701: buildMessage appends the pointer after renderMarkdown(bubble, text), but a live reply is typed out by startReveal/finishReveal, which
// call renderMarkdown(bubble, ...) again (el.innerHTML = ...) and wipe it. The pointer shows only after the chat is drawn again (a reload or another chat).
t.known('tutor: the pointer note is visible beside a live reply (not only after a reload)', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedKb([fx.kbItem('Whole book.txt', { tokens: 450000, id: 'k_whole' })]);
  app.n8n.handlers.tutor = () => ({ text: 'Here is a long enough reply with many words so that the typing effect runs, and it summarises the book from a few excerpts only.' });
  const chat = await app.ev(`(async () => (await tutor.newChatFor({ attachedKnowledgeIds: ['k_whole'] })).id)()`);
  await app.openChat(chat);
  await app.send('Please give me a summary of the whole book');
  await app.advanceUntil(`tutor.chats.find(c => c.id === '${chat}').messages.some(m => m.role === 'model')`, { step: 2000 });
  await h.sleep(1500);
  assert.ok(await app.ev(`/Study Studio can make it/.test(document.getElementById('tutorMessages').textContent)`), 'the pointer is on screen next to the reply');
});

t.run();
