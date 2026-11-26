'use strict';
// Helpers for the map-reduce journeys: a big pair of sources, the consent step, the run, the tray.
const fx = require('./fixtures');
const { AFTER } = require('./common');

// 700,000 tokens in 70 pages of 10,000: a mind map is 5 parts (15 pages each, the last 10) and a last step
const bigItems = () => [
  fx.kbItem('Book A.pdf', { tokens: 350000, pages: 35, id: 'k_a', timestamp: 1700000000002 }),
  fx.kbItem('Book B.pdf', { tokens: 350000, pages: 35, id: 'k_b', timestamp: 1700000000001 }),
];

async function bigApp(h, o = {}) {
  const app = await h.newApp({ now: AFTER, fake: { enforceCaps: true, ...(o.fake || {}) }, ...o.app });
  await app.seedKb(o.items || bigItems());
  return app;
}

// from the studio form to the consent step (nothing is sent yet)
async function toConsent(app, tool = 'mindmap', o = {}) {
  await app.goto('#studio');
  await app.until('studio.active()');
  await app.ev(`studio.openDialog('${tool}', ${JSON.stringify({ sourceIds: o.sourceIds || ['k_a', 'k_b'], language: o.language || 'en', topic: o.topic || '', options: o.options })})`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`, { what: 'generate enabled' });
  await app.page.click('#studioGenerateBtn');
  await app.until(`studio.dialog.view === 'mr'`, { what: 'consent step shown', timeout: 20000 });
}
const readConsent = (app) => app.page.evaluate(() => ({
  title: document.getElementById('studioDialogTitle').textContent, lead: document.getElementById('studioMrLead').textContent,
  facts: [...document.querySelectorAll('#studioMrFacts li')].map(l => l.textContent), note: document.getElementById('studioMrNote').textContent,
  startHidden: document.getElementById('studioMrStart').hidden, startText: document.getElementById('studioMrStart').textContent,
}));
async function start(app) {
  await app.page.click('#studioMrStart');
  await app.until(`studio.items.length > 0 && !studio.dialog.tool`, { what: 'run started' });
}
// the run of one study aid, as the tray describes it
const describe = (app) => app.ev(`(() => { const g = [...jobs.groups.values()].filter(g => g.kind === 'mr').sort((a, b) => b.createdAt - a.createdAt)[0]; return g ? JSON.parse(JSON.stringify({ state: g.state, ...studioMrDescribe(g) })) : null; })()`);
const members = (app) => app.ev(`(() => { const g = [...jobs.groups.values()].filter(g => g.kind === 'mr').sort((a, b) => b.createdAt - a.createdAt)[0]; return g ? g.members.map(m => ({ i: m.i, state: m.state, retries: m.retries || 0, skipped: !!m.skipped })) : null; })()`);
const gid = (app) => app.ev(`[...jobs.groups.values()].filter(g => g.kind === 'mr').sort((a, b) => b.createdAt - a.createdAt)[0].id`);
// a button of the run's tray row
async function tray(app, act) {
  if (await app.ev(`jobs.el('jobsTray').hidden`)) await app.page.click('#jobsTrayBtn');
  await app.page.click(`[data-jobs-gact="${act}"]`);
}
const itemState = (app) => app.ev(`studio.items.length ? { status: studio.items[0].status, code: studio.items[0].error && studio.items[0].error.code, tool: studio.items[0].tool } : null`);
const finish = (app, o = {}) => app.advanceUntil(`studio.items.length > 0 && studio.items[0].status === 'ready'`, { step: o.step || 2000, max: o.max || 400, what: 'study aid ready' });

const parts = (n8n) => n8n.creates().filter(r => r.mode !== 'studio_mindmap' || !r.payload.strategy).map(r => r.part && r.part.i);
const partCreates = (n8n, i) => n8n.creates().filter(r => r.part && r.part.i === i);
const reduceCreates = (n8n) => n8n.creates().filter(r => r.payload && r.payload.strategy === 'reduce');
// the largest number of bulk jobs the server held at once
function maxBulk(n8n) {
  const live = new Set();
  let max = 0;
  for (const r of n8n.log) {
    if (r.kind === 'jobStart' && r.jobId && r.bulk) { live.add(r.jobId); max = Math.max(max, live.size); }
    if (r.kind === 'job' && (r.op === 'result' || r.op === 'cancel')) for (const id of r.ids || []) live.delete(id);
  }
  return max;
}
const holdPart = (n8n, i, times = 1) => n8n.plan((j) => j.payload.part && j.payload.part.i === i, { type: 'hold' }, times);
const failPart = (n8n, i, times = 1, code = 'STH-AI-500') => n8n.plan((j) => j.payload.part && j.payload.part.i === i, { type: 'fail', code, retryable: false }, times);

module.exports = { bigItems, bigApp, toConsent, readConsent, start, describe, members, gid, tray, itemState, finish, parts, partCreates, reduceCreates, maxBulk, holdPart, failPart, fx };
