'use strict';
// The jobs engine: one job's life, groups (2 in flight), reload in the middle, cancel, a failed member and retryMember, busy answers.
const { suite, assert } = require('../lib/harness');
const { AFTER } = require('../lib/common');

const t = suite('04-jobs');

const member = (i) => `{ payload: { mode: 'studio_mindmap', v: 1, tool: 'mindmap', requestId: 'r${i}', tag: 'm${i}', language: { code: 'en', name: 'English' }, options: {}, description: '', sources: [{ id: 'S1', name: 'a.txt', kind: 'txt', tokens: 10, text: 'some text' }], clientEstimate: 10, promptVersion: 'x' } }`;
async function makeGroup(app, n = 5, extra = '') {
  return app.ev(`(async () => { const g = await jobs.createGroup({ kind: 'tgrp', mode: 'studio_mindmap', ref: {}, label: 'Test group', members: [${Array.from({ length: n }, (_, i) => member(i)).join(',')}] ${extra} }); return g.id; })()`);
}
const rec = (app, key) => app.ev(`JSON.parse(localStorage.getItem('${key}') || '[]')`);
const group = (app, gid) => app.ev(`(() => { const g = jobs.groups.get('${gid}'); return g && { state: g.state, members: g.members.map(m => [m.i, m.state, m.retries || 0]) }; })()`);
// the largest number of jobs the server held at once (created, answer not yet fetched, not cancelled), from the request log in order
function maxInFlight(n8n) {
  const live = new Set();
  let max = 0;
  for (const r of n8n.log) {
    if (r.kind === 'jobStart' && r.jobId) { live.add(r.jobId); max = Math.max(max, live.size); }
    if (r.kind === 'job' && (r.op === 'result' || r.op === 'cancel')) for (const id of r.ids || []) live.delete(id);
  }
  return max;
}

t.test('one job: submitted -> running -> succeeded -> applied -> done, acknowledged', async (h) => {
  const app = await h.newApp({ clock: true });
  app.n8n.plan(null, { type: 'hold' });
  await app.seedKb([h.fx.kbItem('a.txt', { tokens: 100, id: 'k_a' })]);
  await app.ev(`studio.openDialog('mindmap', { sourceIds: ['k_a'] })`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  await app.page.click('#studioGenerateBtn');
  await app.until(`[...jobs.recs.values()].some(r => r.state === 'submitted')`, { what: 'submitted' });
  const id = await app.ev(`[...jobs.recs.values()][0].id`);
  await app.advanceUntil(`jobs.recs.get('${id}').state === 'running'`, { what: 'running', step: 1000 });
  app.n8n.release();
  await app.advanceUntil(`jobs.recs.get('${id}').state === 'done'`, { what: 'done', step: 1000 });
  const ops = app.n8n.log.filter(r => r.kind === 'job' && r.ids && r.ids.includes(id)).map(r => r.op);
  assert.equal(ops.filter(o => o === 'result').length, 1);
  assert.equal(ops.filter(o => o === 'ack').length, 1);
  assert.ok(ops.indexOf('status') < ops.indexOf('result') && ops.indexOf('result') < ops.indexOf('ack'));
  assert.equal(app.n8n.job(id).acked, true);
  assert.equal(await app.ev(`studio.items[0].status`), 'ready');
});

t.test('group of 5: members go out in order, never more than 2 in flight, handler done once', async (h) => {
  const app = await h.newApp({ clock: true });
  const gid = await makeGroup(app, 5);
  await app.advanceUntil(`(jobs.groups.get('${gid}') || {}).state === 'done' && jobs.groups.get('${gid}').handled`, { step: 2000, what: 'group done' });
  assert.equal(app.n8n.creates().length, 5);
  assert.deepEqual(app.n8n.creates().map(r => r.payload.tag), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.ok(maxInFlight(app.n8n) <= 2, `at most 2 in flight, saw ${maxInFlight(app.n8n)}`);
  assert.equal(maxInFlight(app.n8n), 2, 'and it does use both slots');
  assert.deepEqual((await rec(app, 'tgrp_applied')).map(a => a[1]).sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(await rec(app, 'tgrp_done'), [gid]);
  assert.ok(app.n8n.list().every(j => j.acked), 'every member job acknowledged');
});

t.test('group: the first two are held; nothing else is sent until a slot frees', async (h) => {
  const app = await h.newApp({ clock: true });
  app.n8n.plan(null, { type: 'hold' }, 2);
  const gid = await makeGroup(app, 5);
  await app.until(`jobs.recs.size === 2`);
  await app.advance(20000);
  assert.equal(app.n8n.creates().length, 2, 'two in flight and no third create');
  app.n8n.release();
  await app.advanceUntil(`jobs.groups.get('${gid}').state === 'done'`, { step: 2000 });
  assert.equal(app.n8n.creates().length, 5);
});

t.test('group: reload in the middle resumes without re-sending finished or held members', async (h) => {
  const app = await h.newApp({ clock: true });
  app.n8n.plan(null, { type: 'hold' }, 2);
  const gid = await makeGroup(app, 5);
  await app.until(`jobs.recs.size === 2`);
  const first = app.n8n.creates().map(r => r.jobId);
  await app.advance(5000);
  await app.reload();
  await app.until(`jobs.groups.has('${gid}')`);
  assert.equal(app.n8n.creates().length, 2, 'the reload sent nothing again');
  app.n8n.release();
  await app.advanceUntil(`(jobs.groups.get('${gid}') || {}).state === 'done' && jobs.groups.get('${gid}').handled`, { step: 2000, what: 'group done after reload' });
  assert.equal(app.n8n.creates().length, 5, 'five creates in all');
  assert.equal(new Set(app.n8n.creates().map(r => r.jobId)).size, 5);
  assert.deepEqual(app.n8n.creates().slice(0, 2).map(r => r.jobId), first);
  assert.deepEqual((await rec(app, 'tgrp_applied')).map(a => a[1]).sort(), [0, 1, 2, 3, 4], 'each member applied once');
  assert.deepEqual(await rec(app, 'tgrp_done'), [gid], 'done handler once');
});

t.test('group: cancel stops new creates and tells the server', async (h) => {
  const app = await h.newApp({ clock: true });
  app.n8n.plan(null, { type: 'hold' }, 2);
  const gid = await makeGroup(app, 5);
  await app.waitNode(() => app.n8n.creates().length === 2);
  const running = app.n8n.creates().map(r => r.jobId);
  await app.ev(`jobs.cancelGroup('${gid}')`);
  await app.until(`jobs.groups.get('${gid}').state === 'cancelled'`);
  await app.waitNode(() => app.n8n.ops('cancel').flatMap(r => r.ids).length >= 2, { what: 'server cancel for both' });
  const cancelled = app.n8n.ops('cancel').flatMap(r => r.ids);
  assert.deepEqual(cancelled.sort(), running.slice().sort());
  app.n8n.release();
  await app.advance(30000);
  assert.equal(app.n8n.creates().length, 2, 'no create after the cancel');
  assert.equal((await rec(app, 'tgrp_done')).length, 0, 'done never runs for a cancelled group');
  assert.deepEqual((await group(app, gid)).members.map(m => m[1]), ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled']);
  assert.equal((await rec(app, 'tgrp_applied')).length, 0, 'answers of cancelled jobs are not applied');
});

t.test('group: a failed member stops the group; retryMember finishes it', async (h) => {
  const app = await h.newApp({ clock: true });
  app.n8n.plan((j) => j.payload.tag === 'm2', { type: 'fail', code: 'STH-STU-422', retryable: false });
  const gid = await makeGroup(app, 5);
  await app.advanceUntil(`jobs.groups.get('${gid}').state === 'failed'`, { step: 2000, what: 'group failed' });
  await app.advance(20000); // the group stays stopped
  const g = await group(app, gid);
  assert.equal(g.members[2][1], 'failed');
  assert.equal(g.members[4][1], 'todo', 'a member not yet sent stays unsent (m3 was already in flight beside m2, so it may finish)');
  assert.ok(app.n8n.creates().every(r => ['m0', 'm1', 'm2', 'm3'].includes(r.payload.tag)));
  assert.equal((await rec(app, 'tgrp_failed')).length, 1);
  assert.equal(await app.ev(`jobs.retryMember('${gid}', 2)`), true);
  await app.advanceUntil(`(jobs.groups.get('${gid}') || {}).state === 'done' && jobs.groups.get('${gid}').handled`, { step: 2000, what: 'group done after retry' });
  assert.equal(app.n8n.creates().length, 6, 'five members plus the retried one');
  assert.equal(app.n8n.creates().filter(r => r.payload.tag === 'm2').length, 2);
  assert.deepEqual((await rec(app, 'tgrp_applied')).map(a => a[1]).sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(await rec(app, 'tgrp_done'), [gid]);
});

t.test('busy (STH-JOB-429): a tutor job waits, shows a busy note, then goes out again', async (h) => {
  const app = await h.newApp({ clock: true });
  app.n8n.plan(null, { type: 'busy' });
  const id = await app.newChat();
  await app.send('hello busy');
  await app.advanceUntil(`[...jobs.recs.values()].some(r => r.state === 'waiting' && r.waitKind === 'busy')`, { step: 1000, what: 'busy wait' });
  const jid = await app.ev(`[...jobs.recs.values()][0].id`);
  assert.match(await app.ev(`jobs.stateText(jobs.recs.get('${jid}'))`), /Busy right now/);
  await app.advanceUntil(`tutor.chats.find(c => c.id === '${id}').messages.some(m => m.role === 'model')`, { step: 2000, what: 'reply after the busy wait' });
  assert.equal(app.n8n.creates('tutor').length, 2, 'the same job id was sent again once');
  assert.equal(new Set(app.n8n.creates().map(r => r.jobId)).size, 1);
});

t.test('server job endpoint down (404): jobs switch off for a while, the request runs directly', async (h) => {
  const app = await h.newApp({ clock: true, wait: false });
  await app.until('authInitDone');
  app.n8n.helloStatus = 404;
  await app.ev(`jobs.hello()`);
  await app.until(`jobs.serverOffUntil > Date.now()`);
  assert.equal(await app.ev(`jobs.useFor('tutor')`), false);
});

t.test('auth: a refused token during polling asks for a new sign-in and carries on after', async (h) => {
  const app = await h.newApp({ clock: true });
  app.n8n.plan(null, { type: 'hold' });
  await app.newChat();
  await app.send('question while token dies');
  await app.until(`[...jobs.recs.values()].some(r => r.state === 'submitted' || r.state === 'running')`);
  app.n8n.epoch++; // every earlier token is refused now
  await app.advanceUntil(`jobs.authPaused === true`, { step: 2000, what: 'paused for sign-in' });
  await app.until(`!document.getElementById('loginOverlay').classList.contains('dismissed')`, { what: 'gate shown' });
  await app.page.fill('#loginInput', app.n8n.code);
  await app.page.check('#loginConsent');
  await app.page.click('#loginBtn');
  await app.until(`document.getElementById('loginOverlay').classList.contains('dismissed')`);
  app.n8n.release();
  await app.advanceUntil(`jobs.authPaused === false && [...jobs.recs.values()].some(r => r.state === 'done' || r.state === 'applied')`, { step: 2000, what: 'finished after sign-in' });
});

t.run();
