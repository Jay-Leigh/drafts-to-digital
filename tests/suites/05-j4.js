'use strict';
// J4: transcribe, template and reviewer. Gate off (v6 server or before 8 Dec): the direct path is unchanged (BASE = NEW). Gate on: a job group.
const { suite, assert } = require('../lib/harness');
const { AFTER, BEFORE, mask } = require('../lib/common');

const t = suite('05-j4');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = (n) => ({ name: `page${n}.png`, mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from(`-${n}`)]) });
const txt = (name, text) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

async function openTool(app, mode) {
  await app.goto(`#${mode}`);
  await app.until(`state.mode === '${mode}' && document.querySelector('[data-role] input[type=file]') !== null`, { what: `${mode} view` });
}
async function fill(app, mode, pages = 11) {
  await openTool(app, mode);
  if (mode === 'transcribe') await app.page.setInputFiles('[data-role="pages"] input[type=file]', Array.from({ length: pages }, (_, i) => png(i + 1)));
  if (mode === 'template') await app.page.setInputFiles('[data-role="instructions"] input[type=file]', [txt('brief.txt', 'Write about water. 500 words.')]);
  if (mode === 'reviewer') {
    await app.page.setInputFiles('[data-role="essay"] input[type=file]', [txt('essay.txt', 'Water is wet. It flows.')]);
    await app.page.setInputFiles('[data-role="instructions"] input[type=file]', [txt('brief.txt', 'Write about water. 500 words.')]);
  }
  await app.until(`!document.getElementById('btnAction').disabled`, { what: 'action button enabled' });
}
const run = async (app) => { await app.page.click('#btnAction'); };

// the requests the page sent for one journey on the direct path
async function directJourney(h, kind, cfg, mode, pages) {
  const app = await h.newApp({ page: kind, clock: true, ...cfg });
  await fill(app, mode, pages);
  await run(app);
  await app.advanceUntil(`state.resultText !== '' && processRunning === false`, { step: 1000, max: 200, what: `${mode} result (${kind})` });
  const reqs = app.n8n.direct(mode).map(r => r.payload);
  assert.equal(app.n8n.creates().length, 0, 'gate off: no job is created');
  assert.ok(await app.ev(`state.resultText.length > 0`));
  return { reqs, text: await app.ev('state.resultText'), history: await app.ev(`getHistory().then(e => e.length)`) };
}

for (const [label, cfg] of [['v7 server before 8 Dec', { v: 7, now: BEFORE }], ['v6 server after 8 Dec', { v: 0, now: AFTER }]]) {
  for (const [mode, pages] of [['transcribe', 7], ['template', 0], ['reviewer', 0]]) {
    t.test(`gate off (${label}): ${mode} request bodies are identical in BASE and NEW`, async (h) => {
      const nu = await directJourney(h, 'new', cfg, mode, pages);
      const base = await directJourney(h, 'base', cfg, mode, pages);
      assert.equal(nu.reqs.length, mode === 'transcribe' ? 2 : 1);
      assert.equal(mask(nu.reqs), mask(base.reqs));
      assert.equal(nu.text, base.text);
      assert.equal(nu.history, 1);
    }, { needsBase: true, timeout: 70000 });
  }
}

t.test('gate on: transcribe of 11 pages is one group of 3 batches, one History entry, one KB item', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await fill(app, 'transcribe', 11);
  await run(app);
  await app.advanceUntil(`[...jobs.groups.values()].some(g => g.ref && g.ref.mode === 'transcribe' && g.state === 'done' && g.handled)`, { step: 2000, max: 300, what: 'group done' });
  assert.equal(app.n8n.direct().length, 0);
  assert.equal(app.n8n.creates('transcribe').length, 3);
  assert.deepEqual(app.n8n.creates('transcribe').map(r => [r.payload.batchIndex, r.payload.totalBatches, r.payload.documents.length]), [[1, 3, 5], [2, 3, 5], [3, 3, 1]]);
  assert.equal(await app.ev(`jobs.groups.size`), 1);
  const text = 'Transcript of batch 1\n\nTranscript of batch 2\n\nTranscript of batch 3';
  assert.equal(await app.ev('state.resultText'), text);
  const hist = await app.ev('getHistory()');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].resultText, text);
  assert.equal(await app.ev(`kb.cache.filter(k => /\\(transcribed\\)$/.test(k.name)).length`), 1);
  assert.equal(await app.ev(`document.getElementById('sectionResult').classList.contains('hidden')`), false, 'the result is on screen');
  assert.ok(app.n8n.list().every(j => j.acked));
  // a late repeat of the finish (another tab, a crash) adds nothing
  await app.ev(`toolFinish(jobs.groups.values().next().value)`);
  assert.equal((await app.ev('getHistory()')).length, 1);
  assert.equal(await app.ev(`kb.cache.filter(k => /\\(transcribed\\)$/.test(k.name)).length`), 1);
});

t.test('gate on: template and reviewer are a one-member group each', async (h) => {
  for (const mode of ['template', 'reviewer']) {
    const app = await h.newApp({ now: AFTER });
    await fill(app, mode);
    await run(app);
    await app.advanceUntil(`state.resultText !== ''`, { step: 2000, max: 200, what: `${mode} result` });
    assert.equal(app.n8n.creates(mode).length, 1);
    assert.equal(app.n8n.direct().length, 0);
    assert.match(await app.ev('state.resultText'), mode === 'template' ? /# Template/ : /# Review/);
    assert.equal((await app.ev('getHistory()')).length, 1);
  }
});

t.test('gate on: a failed batch stops the run; Retry batch sends only that batch and finishes', async (h) => {
  const app = await h.newApp({ now: AFTER });
  app.n8n.plan((j) => j.payload.batchIndex === 2, { type: 'fail', code: 'STH-AI-500', retryable: false });
  await fill(app, 'transcribe', 11);
  await run(app);
  await app.advanceUntil(`[...jobs.groups.values()].some(g => g.state === 'failed')`, { step: 2000, max: 200, what: 'group failed' });
  assert.match(await app.ev(`document.getElementById('toolJobNote').textContent`), /Pages 6-10 failed/);
  await app.page.click('#jobsTrayBtn');
  await app.page.click('[data-jobs-gact="retry"]');
  await app.advanceUntil(`[...jobs.groups.values()].some(g => g.state === 'done' && g.handled)`, { step: 2000, max: 300, what: 'done after retry' });
  const batches = app.n8n.creates('transcribe').map(r => r.payload.batchIndex);
  assert.deepEqual(batches.sort(), [1, 2, 2, 3], 'batch 2 twice, the rest once');
  assert.equal((await app.ev('getHistory()')).length, 1);
  assert.equal(await app.ev('state.resultText.split("\\n\\n").length'), 3);
});

t.test('gate on: Cancel stops the run, tells the server, and leaves no History entry', async (h) => {
  const app = await h.newApp({ now: AFTER });
  app.n8n.plan(null, { type: 'hold' }, 2);
  await fill(app, 'transcribe', 11);
  await run(app);
  await app.waitNode(() => app.n8n.creates().length === 2, { what: 'two batches in flight' });
  await app.until(`[...jobs.recs.values()].filter(r => r.state === 'submitted').length === 2`, { what: 'both creates answered' }); // (cancelling while a create is still on its way sends no server cancel: see README, known edge)
  const ids = app.n8n.creates().map(r => r.jobId);
  await app.page.click('#jobsTrayBtn');
  await app.page.click('[data-jobs-gact="cancel"]');
  await app.until(`[...jobs.groups.values()].every(g => g.state === 'cancelled')`);
  await app.waitNode(() => app.n8n.ops('cancel').flatMap(r => r.ids).length >= 2, { what: 'server cancel for both' });
  assert.deepEqual(app.n8n.ops('cancel').flatMap(r => r.ids).sort(), ids.sort());
  app.n8n.release();
  await app.advance(40000);
  assert.equal(app.n8n.creates().length, 2, 'the third batch is never sent');
  assert.equal((await app.ev('getHistory()')).length, 0);
  assert.equal(await app.ev(`kb.cache.filter(k => /\\(transcribed\\)$/.test(k.name)).length`), 0);
});

// page.js: cancel() sends the server cancel only when lastCreateAt is set, which create() sets after the answer; a create whose answer is still on its way is
// found cancelled by that update (it returns false) and the server never hears of it.
t.known('gate on: Cancel while a batch is still being sent also cancels it on the server', async (h) => {
  const app = await h.newApp({ now: AFTER });
  app.n8n.createDelay = 1500;
  app.n8n.plan(null, { type: 'hold' }, 2);
  await fill(app, 'transcribe', 11);
  await run(app);
  await app.waitNode(() => app.n8n.creates().length === 2, { what: 'two creates reached the server' });
  const ids = app.n8n.creates().map(r => r.jobId);
  await app.page.click('#jobsTrayBtn');
  await app.page.click('[data-jobs-gact="cancel"]');
  await h.sleep(3500);
  assert.deepEqual(app.n8n.ops('cancel').flatMap(r => r.ids).sort(), ids.sort(), 'the server was told to stop both');
});

t.run();
