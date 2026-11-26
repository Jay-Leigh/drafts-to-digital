'use strict';
// Map-reduce journeys with the fake server: consent first, a 5-part run, resume, retry, skip, cancel, replaced runs, delete.
const { suite, assert } = require('../lib/harness');
const M = require('../lib/mr');

const t = suite('09-mr-journeys');

t.test('consent first: the question is shown and NOTHING is sent until Start', async (h) => {
  const app = await M.bigApp(h);
  await M.toConsent(app);
  const c = await M.readConsent(app);
  assert.equal(c.title, 'This is a big request');
  assert.match(c.lead, /About 1,167 pages from 2 sources \(about 700k tokens\) is more than one AI call takes \(about 400k\), so it runs in 5 parts and a last step that joins them/);
  assert.ok(c.facts.some(f => /^Time: about \d+–\d+ minutes/.test(f)), c.facts.join(' | '));
  assert.ok(c.facts.some(f => /^Cost: about R[\d.]+–R[\d.]+\./.test(f)));
  assert.ok(c.facts.some(f => /finished parts stay on this device for 7 days/.test(f)));
  assert.ok(c.facts.some(f => /Each part can be tried again twice by hand/.test(f)));
  assert.equal(c.startText, 'Start 5-part run');
  assert.equal(c.startHidden, false);
  await app.advance(20000); // the question can sit there: still nothing goes out
  assert.equal(app.n8n.creates().length, 0, 'no job created');
  assert.equal(app.n8n.direct().length, 0, 'no direct request');
  assert.equal(app.n8n.ops('budget').length, 1, 'only the budget question was asked');
  assert.equal(await app.ev('studio.items.length'), 0, 'no study aid yet');
  assert.equal(await app.ev('jobs.groups.size'), 0, 'no run yet');
  assert.equal(await app.ev(`[...jobs.recs.values()].length`), 0);
});

t.test('consent: Cancel keeps what was typed (it asks first, as when closing the form)', async (h) => {
  const app = await M.bigApp(h);
  await app.goto('#studio');
  await app.ev(`studio.openDialog('mindmap', { sourceIds: ['k_a', 'k_b'] })`);
  await app.page.fill('#studioTopic', 'Only chapter two, please');
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  await app.page.click('#studioGenerateBtn');
  await app.until(`studio.dialog.view === 'mr'`);
  await app.page.click('#studioMrCancel');
  await app.page.waitForSelector('#confirmOverlay.open');
  await app.confirm(false); // "Discard what you typed?" -> No
  assert.equal(await app.ev(`studio.dialog.tool`), 'mindmap', 'the form is still open');
  assert.equal(await app.page.inputValue('#studioTopic'), 'Only chapter two, please');
  assert.equal(await app.ev(`document.getElementById('studioFormBody').hidden`), false, 'the form, not the question');
  // "Choose fewer sources" goes back too, with the text
  await app.page.click('#studioGenerateBtn');
  await app.until(`studio.dialog.view === 'mr'`);
  await app.page.click('#studioMrBack');
  assert.equal(await app.page.inputValue('#studioTopic'), 'Only chapter two, please');
  // Escape on the question goes back to the form as well
  await app.page.click('#studioGenerateBtn');
  await app.until(`studio.dialog.view === 'mr'`);
  await app.page.keyboard.press('Escape');
  await app.until(`studio.dialog.view === null && studio.dialog.tool === 'mindmap'`);
  assert.equal(await app.page.inputValue('#studioTopic'), 'Only chapter two, please');
  assert.equal(app.n8n.creates().length, 0);
});

t.test('5-part mind map: five digests (two at a time), one last step over all five, ready', async (h) => {
  const app = await M.bigApp(h);
  await M.toConsent(app);
  await M.start(app);
  await M.finish(app);
  const digests = app.n8n.creates('studio_digest');
  assert.deepEqual(digests.map(r => r.part.i).sort(), [1, 2, 3, 4, 5]);
  assert.ok(digests.every(r => r.part.n === 5 && r.bulk === true && r.payload.tool === 'digest' && r.payload.mode === 'studio_digest'), 'every part is a bulk digest job');
  assert.ok(digests.every(r => r.payload.sources.length >= 1 && r.payload.clientEstimate <= 150000));
  const red = M.reduceCreates(app.n8n);
  assert.equal(red.length, 1);
  assert.equal(red[0].mode, 'studio_mindmap');
  assert.equal(red[0].payload.strategy, 'reduce');
  assert.equal(red[0].payload.digests.length, 5);
  assert.equal(red[0].bulk, true);
  assert.ok(red[0].seq > Math.max(...digests.map(r => r.seq)), 'the last step goes out after every part');
  assert.ok(M.maxBulk(app.n8n) <= 2, `at most 2 bulk jobs at once (saw ${M.maxBulk(app.n8n)})`);
  assert.equal(app.n8n.overCap || 0, 0, 'the server never had to refuse for the cap');
  const art = await app.ev(`studio.items[0].artifact`);
  assert.equal(art.tool, 'mindmap');
  assert.equal(art.strategy, 'reduce');
  assert.ok(art.usage.calls >= 6, 'usage adds up the parts and the last step');
  assert.deepEqual(art.data.notices, []);
  assert.equal(await app.ev(`studio.items[0].error`), null);
  // the run cleans up after itself once everything is acknowledged
  await app.advanceUntil(`jobs.groups.size === 0`, { step: 1000, what: 'run reaped' });
  // the group leaves memory first and its stored keys go a moment later
  let keys = [];
  for (let i = 0; i < 30; i++) { keys = (await app.ev(`jobs.store.keys()`)).filter(k => /^(mrc|out|gin|group):/.test(k)); if (!keys.length) break; await h.sleep(100); }
  assert.deepEqual(keys, [], 'no parts, answers or inputs are left on the device');
  assert.ok(app.n8n.list().every(j => j.acked), 'every job acknowledged');
});

t.test('flashcards over the cap: parts go one at a time, the browser joins them (no last step)', async (h) => {
  const app = await M.bigApp(h);
  await M.toConsent(app, 'flashcards');
  const c = await M.readConsent(app);
  assert.match(c.lead, /so it runs in 5 parts that are joined here/);
  await M.start(app);
  await M.finish(app);
  const creates = app.n8n.creates();
  assert.equal(creates.length, 5, 'five parts and no reduce');
  assert.ok(creates.every(r => r.mode === 'studio_flashcards' && r.bulk));
  assert.equal(creates.map(r => r.part.count).reduce((a, b) => a + b, 0), 39, '1.3 x 30 cards asked in all');
  assert.ok(creates.every(r => r.part.count >= 2));
  assert.equal(M.maxBulk(app.n8n), 1, 'flashcards parts are sent one at a time');
  const art = await app.ev(`studio.items[0].artifact`);
  assert.equal(art.strategy, 'mapreduce');
  assert.equal(art.data.cards.length, 30, 'cut back to the 30 asked for');
  assert.deepEqual(art.data.cards.map(c => c.id).slice(0, 3), ['c1', 'c2', 'c3']);
  assert.ok(new Set(art.data.cards.map(c => c.front)).size === 30);
  assert.ok(art.repairs.some(r => /joined 5 parts/.test(r)));
});

t.test('quiz over the cap: five parts, joined to 20 questions', async (h) => {
  const app = await M.bigApp(h);
  await M.toConsent(app, 'quiz');
  await M.start(app);
  await M.finish(app);
  assert.equal(app.n8n.creates().length, 5);
  assert.equal(await app.ev(`studio.items[0].artifact.data.questions.length`), 20);
});

t.test('close and reopen: finished parts are not sent again, the held one carries on', async (h) => {
  const app = await M.bigApp(h);
  M.holdPart(app.n8n, 3);
  await M.toConsent(app);
  await M.start(app);
  // parts 1, 2 and 4 are done, 5 waits for a free slot, 3 is held
  await app.advanceUntil(`(() => { const g = [...jobs.groups.values()].find(g => g.kind === 'mr'); return g && [0, 1, 3].every(i => g.members[i].state === 'done'); })()`, { step: 2000, what: 'parts 1, 2, 4 done' });
  await app.advanceUntil(`(() => { const g = [...jobs.groups.values()].find(g => g.kind === 'mr'); return g && g.members[4].state === 'done'; })()`, { step: 2000, what: 'part 5 done' });
  const before = M.parts(app.n8n).slice().sort();
  assert.deepEqual(before, [1, 2, 3, 4, 5]);
  await app.reload(); // the person closes the tab and opens the app again
  await app.until(`[...jobs.groups.values()].some(g => g.kind === 'mr' && g.state === 'running')`, { what: 'the run is still there' });
  await app.advance(20000);
  assert.equal(app.n8n.creates().length, 5, 'nothing was sent again after the reload');
  assert.equal(M.reduceCreates(app.n8n).length, 0, 'the last step waits for part 3');
  app.n8n.release();
  await M.finish(app);
  assert.equal(app.n8n.creates().length, 6, 'five parts once each, plus the last step');
  for (let i = 1; i <= 5; i++) assert.equal(M.partCreates(app.n8n, i).length, 1, `part ${i} was paid once`);
  assert.equal(M.reduceCreates(app.n8n)[0].payload.digests.length, 5);
});

t.test('Cancel, then start again: the finished parts are found by hash and not paid for twice; the new run is not failed by the old one', async (h) => {
  const app = await M.bigApp(h);
  app.n8n.plan((j) => j.payload.part && j.payload.part.i >= 3, { type: 'hold' }, 100);
  await M.toConsent(app);
  await M.start(app);
  await app.advanceUntil(`(() => { const g = [...jobs.groups.values()].find(g => g.kind === 'mr'); return g && g.members[0].state === 'done' && g.members[1].state === 'done'; })()`, { step: 2000, what: 'parts 1 and 2 done' });
  await app.waitNode(() => app.n8n.creates().length === 4, { what: 'parts 3 and 4 in flight' });
  await app.until(`[...jobs.recs.values()].filter(r => r.state === 'submitted' || r.state === 'running').length === 2`);
  // Cancel in the tray: the run stops, the two finished parts are kept
  await M.tray(app, 'cancel');
  await app.confirm(true);
  await app.until(`[...jobs.groups.values()].some(g => g.state === 'cancelled')`);
  await app.waitNode(() => app.n8n.ops('cancel').flatMap(r => r.ids).length >= 2, { what: 'server cancel' });
  await app.until(`studio.items[0].status === 'failed'`);
  assert.equal((await M.itemState(app)).code, 'STH-JOB-410');
  const kept = await app.ev(`jobs.store.keys().then(k => k.filter(x => x.startsWith('mrc:')).length)`);
  assert.equal(kept, 2, 'two finished parts stay on this device');
  app.n8n.clearRules();
  // Retry on the study aid: the question comes first, and says what is done already
  const id = await app.ev('studio.items[0].id');
  await app.ev(`studio.retry('${id}')`);
  await app.until(`studio.dialog.view === 'mr'`);
  const c = await M.readConsent(app);
  assert.ok(c.facts.some(f => /2 of the 5 parts are done already on this device and are not charged again/.test(f)), c.facts.join(' | '));
  const sentBefore = app.n8n.creates().length;
  await app.advance(5000);
  assert.equal(app.n8n.creates().length, sentBefore, 'still nothing sent before Start');
  await M.start(app);
  await M.finish(app);
  assert.equal(await app.ev(`studio.items[0].error`), null, 'the new run was not failed by the old group');
  assert.equal(M.partCreates(app.n8n, 1).length, 1);
  assert.equal(M.partCreates(app.n8n, 2).length, 1);
  assert.equal(M.partCreates(app.n8n, 3).length, 2, 'the held one, then again after the restart');
  assert.equal(M.partCreates(app.n8n, 4).length, 2);
  assert.equal(M.partCreates(app.n8n, 5).length, 1);
  assert.equal(M.reduceCreates(app.n8n).length, 1);
  assert.equal(await app.ev(`studio.items.length`), 1, 'the same study aid, no copy');
  await app.advanceUntil(`jobs.groups.size === 0`, { step: 1000, what: 'old and new runs gone' });
});

t.test('a failed part stops the run; "Retry part" sends only that part again and the run finishes', async (h) => {
  const app = await M.bigApp(h);
  M.failPart(app.n8n, 3);
  await M.toConsent(app);
  await M.start(app);
  await app.advanceUntil(`[...jobs.groups.values()].some(g => g.kind === 'mr' && g.state === 'failed')`, { step: 2000, what: 'run stopped' });
  const d = await M.describe(app);
  assert.equal(d.failed, true);
  assert.match(d.text, /^Part 3 of 5 \(Book A\.pdf, pages 29–35; Book B\.pdf, pages 1–7\)/);
  assert.deepEqual(d.actions.map(a => a.label), ['Retry part', 'Skip part', 'Cancel', 'Dismiss']);
  await app.advance(30000);
  assert.equal(M.reduceCreates(app.n8n).length, 0, 'no last step while a part is missing');
  const first = M.partCreates(app.n8n, 3)[0].payload;
  await M.tray(app, 'retry');
  await M.finish(app);
  assert.equal(M.partCreates(app.n8n, 3).length, 2, 'only part 3 was sent again');
  for (const i of [1, 2, 4, 5]) assert.equal(M.partCreates(app.n8n, i).length, 1);
  const again = M.partCreates(app.n8n, 3)[1].payload;
  assert.equal(JSON.stringify(again.sources), JSON.stringify(first.sources), 'the same text is sent');
  assert.equal(M.reduceCreates(app.n8n)[0].payload.digests.length, 5);
  assert.deepEqual(await app.ev(`studio.items[0].artifact.data.notices`), []);
});

t.test('"Skip part": the last step runs over the rest, and the study aid says a part was left out', async (h) => {
  const app = await M.bigApp(h);
  M.failPart(app.n8n, 3);
  await M.toConsent(app);
  await M.start(app);
  await app.advanceUntil(`[...jobs.groups.values()].some(g => g.kind === 'mr' && g.state === 'failed')`, { step: 2000 });
  await M.tray(app, 'skip');
  await app.confirm(true); // "Skip this part? The study aid is made without it, and says so."
  await M.finish(app);
  assert.equal(M.partCreates(app.n8n, 3).length, 1, 'the skipped part is not sent again');
  const red = M.reduceCreates(app.n8n);
  assert.equal(red.length, 1);
  assert.equal(red[0].payload.digests.length, 4, 'the last step takes four digests');
  const notices = await app.ev(`studio.items[0].artifact.data.notices`);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^Part 3 of 5 \(Book A\.pdf, pages 29–35; Book B\.pdf, pages 1–7\) was left out\.$/);
});

t.test('"Skip part" in a flashcards run joins the other parts and says so', async (h) => {
  const app = await M.bigApp(h);
  M.failPart(app.n8n, 2);
  await M.toConsent(app, 'flashcards');
  await M.start(app);
  await app.advanceUntil(`[...jobs.groups.values()].some(g => g.kind === 'mr' && g.state === 'failed')`, { step: 2000 });
  await M.tray(app, 'skip');
  await app.confirm(true);
  await M.finish(app);
  assert.equal(app.n8n.creates().length, 5, 'parts 1 to 5 once each');
  const art = await app.ev(`studio.items[0].artifact`);
  assert.match(art.data.notices[0], /^Part 2 of 5 .* was left out\.$/);
  assert.ok(art.repairs.some(r => /joined 4 parts/.test(r)));
});

t.test('Cancel in the middle: no new creates, the server is told, the finished parts are kept', async (h) => {
  const app = await M.bigApp(h);
  M.holdPart(app.n8n, 1, 1);
  M.holdPart(app.n8n, 2, 1);
  await M.toConsent(app);
  await M.start(app);
  await app.waitNode(() => app.n8n.creates().length === 2, { what: 'parts 1 and 2 sent' });
  await app.until(`[...jobs.recs.values()].filter(r => r.state === 'submitted' || r.state === 'running').length === 2`);
  const ids = app.n8n.creates().map(r => r.jobId);
  await M.tray(app, 'cancel');
  await app.until(`[...jobs.groups.values()].some(g => g.state === 'cancelled')`);
  await app.waitNode(() => app.n8n.ops('cancel').flatMap(r => r.ids).length >= 2, { what: 'server cancel' });
  assert.deepEqual(app.n8n.ops('cancel').flatMap(r => r.ids).sort(), ids.sort());
  app.n8n.release();
  await app.advance(60000);
  assert.equal(app.n8n.creates().length, 2, 'no create after Cancel');
  const m = await M.members(app);
  assert.ok(m.every(x => x.state === 'cancelled'));
  assert.equal((await M.itemState(app)).status, 'failed');
  assert.equal((await M.describe(app)).text.startsWith('Cancelled.'), true);
});

t.test('deleting the study aid in the middle of a run cancels every part and removes the run', async (h) => {
  const app = await M.bigApp(h);
  M.holdPart(app.n8n, 1, 1);
  M.holdPart(app.n8n, 2, 1);
  await M.toConsent(app);
  await M.start(app);
  await app.waitNode(() => app.n8n.creates().length === 2);
  await app.until(`[...jobs.recs.values()].filter(r => r.state === 'submitted' || r.state === 'running').length === 2`);
  const ids = app.n8n.creates().map(r => r.jobId);
  const id = await app.ev('studio.items[0].id');
  const del = app.ev(`studio.remove('${id}')`);
  await app.confirm(true);
  await del;
  await app.waitNode(() => app.n8n.ops('cancel').flatMap(r => r.ids).length >= 2, { what: 'server cancel' });
  assert.deepEqual(app.n8n.ops('cancel').flatMap(r => r.ids).sort(), ids.sort());
  assert.equal(await app.ev('studio.items.length'), 0);
  assert.equal(await app.ev('jobs.groups.size'), 0, 'the run is gone');
  app.n8n.release();
  await app.advance(60000);
  assert.equal(app.n8n.creates().length, 2, 'nothing more is sent');
  assert.equal(await app.ev(`jobs.store.keys().then(k => k.filter(x => /^(mrc|out|gin|group):/.test(x)).length)`), 0, 'its parts and inputs are gone');
  assert.deepEqual(app.pageErrors, []);
});

t.test('Start while another big run is going is refused with a message', async (h) => {
  const app = await M.bigApp(h);
  app.n8n.plan(null, { type: 'hold' }, 100);
  await M.toConsent(app);
  await M.start(app);
  await app.ev(`studio.openDialog('quiz', { sourceIds: ['k_a', 'k_b'] })`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  await app.page.click('#studioGenerateBtn');
  await app.until(`/A big run is already going/.test(document.getElementById('toast').textContent)`, { what: 'busy toast' });
  assert.equal(await app.ev('studio.items.length'), 1);
});

t.test('the estimate is worked out again when the question sat for more than 30 minutes; nothing starts from a stale one', async (h) => {
  const app = await M.bigApp(h, { app: { clock: true } });
  await M.toConsent(app);
  await app.advance(31 * 60 * 1000, { step: 60000, pause: 5 });
  await app.page.click('#studioMrStart');
  await app.until(`/was a while old/.test(document.getElementById('studioMrNote').textContent)`, { what: 'stale note' });
  assert.equal(app.n8n.creates().length, 0, 'the old question did not start the run');
  assert.equal(app.n8n.ops('budget').length >= 2, true, 'the budget was asked again');
  await M.start(app);
  await app.waitNode(() => app.n8n.creates().length >= 1, { what: 'the run starts after the fresh question' });
});

t.run();
