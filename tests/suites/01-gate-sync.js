'use strict';
// Gate and sync smoke: the app opens unlocked, the v6/v7 server gate and the release date, 10 vs 15 sources, Drive sync push and pull.
const { suite, assert, FakeN8n } = require('../lib/harness');
const { studioItem, connectDrive, RELEASE_MS, AFTER, BEFORE, fx } = require('../lib/common');

const t = suite('01-gate-sync');

t.test('opens unlocked with a stored token and consent', async (h) => {
  const app = await h.newApp({});
  assert.equal(await app.ev(`document.getElementById('appContent').classList.contains('unlocked')`), true);
  assert.equal(await app.ev(`document.getElementById('loginOverlay').classList.contains('dismissed')`), true);
  assert.equal(await app.ev('state.currentRoute'), 'home');
  assert.deepEqual(app.pageErrors, []);
  assert.deepEqual(app.blocked, [], 'no unexpected external request');
  assert.equal(app.n8n.of('auth').length, 0, 'no sign-in request when the token is stored');
});

t.test('gate: no token shows the sign-in; wrong code refused; right code unlocks', async (h) => {
  const app = await h.newApp({ signedIn: false });
  assert.equal(await app.ev(`document.getElementById('appContent').classList.contains('unlocked')`), false);
  await app.page.fill('#loginInput', 'wrong');
  await app.page.check('#loginConsent');
  await app.page.click('#loginBtn');
  await app.until(`/Incorrect access code/.test(document.getElementById('loginError').textContent)`);
  assert.equal(await app.ev(`document.getElementById('appContent').classList.contains('unlocked')`), false);
  await app.page.fill('#loginInput', app.n8n.code);
  await app.page.click('#loginBtn');
  await app.until(`document.getElementById('appContent').classList.contains('unlocked') && authInitDone`);
  assert.equal(app.n8n.of('auth').length, 2);
  assert.ok(await app.ev(`storageGet('sth_token') && JSON.parse(storageGet('sth_token')).t.split('.').length === 3`));
  assert.ok(await app.ev(`JSON.parse(storageGet('sth_consent')).termsVersion === TERMS_VERSION`));
});

t.test('gate: valid token but old consent version asks only for the tick', async (h) => {
  const app = await h.newApp({ consent: false, wait: false });
  await app.until(`document.getElementById('loginForm').classList.contains('consent-only')`);
  assert.equal(await app.ev(`document.getElementById('appContent').classList.contains('unlocked')`), false);
  const stale = await h.newApp({ seed: { sth_consent: JSON.stringify({ acceptedAt: '2020-01-01T00:00:00Z', termsVersion: '2020-01-01' }) }, consent: false, wait: false });
  await stale.until(`document.getElementById('loginForm').classList.contains('consent-only')`);
  await stale.page.check('#loginConsent');
  await stale.page.click('#loginBtn');
  await stale.until(`document.getElementById('appContent').classList.contains('unlocked') && authInitDone`);
  assert.equal(await stale.ev('JSON.parse(storageGet("sth_consent")).termsVersion === TERMS_VERSION'), true);
});

t.test('hello v7: 15 sources, jobs on; v7 tools wait for 26 Nov 2026', async (h) => {
  const before = await h.newApp({ now: BEFORE });
  assert.equal(await before.ev('serverHas(7)'), true);
  assert.equal(await before.ev('studioMaxSources()'), 15);
  assert.equal(await before.ev('studioV7Released()'), false);
  assert.equal(await before.ev('studioV7Live()'), false);
  assert.equal(await before.ev('STUDIO_TOOLS.infographic.enabled || STUDIO_TOOLS.slides.enabled'), false);
  assert.equal(await before.ev('studioMrOn()'), false);
  assert.equal(await before.ev(`jobs.useFor('tutor') && jobs.useFor('studio_mindmap')`), true);
  const after = await h.newApp({ now: AFTER });
  assert.equal(await after.ev('studioV7Live()'), true);
  assert.equal(await after.ev('STUDIO_TOOLS.infographic.enabled && STUDIO_TOOLS.slides.enabled'), true);
  assert.equal(await after.ev('studioMrOn()'), true);
  assert.equal(await after.ev('service.server.maxParts'), 16);
  assert.equal(await after.ev('service.server.reduceMax'), 300000);
});

t.test('release boundary: 26 Nov 2026 00:00 UTC exactly', async (h) => {
  const app = await h.newApp({ now: RELEASE_MS - 3600e3 });
  const at = (ms) => app.ev(`(() => { const real = Date.now; Date.now = () => ${ms}; try { return studioV7Released(); } finally { Date.now = real; } })()`);
  assert.equal(await at(RELEASE_MS - 1), false);
  assert.equal(await at(RELEASE_MS), true);
  assert.equal(await at(RELEASE_MS + 1), true);
  assert.equal(await app.ev('studioV7Released()'), false, 'an hour before it is off');
  await app.page.clock.runFor(3600e3 + 5);
  assert.equal(await app.ev('studioV7Released()'), true, 'and on once the time has come');
});

t.test('hello v6 server (no v): 10 sources, v7 never live, even after the date', async (h) => {
  const app = await h.newApp({ v: 0, now: AFTER });
  assert.equal(await app.ev('service.server.v'), 0);
  assert.equal(await app.ev('service.server.seen'), true);
  assert.equal(await app.ev('serverHas(7)'), false);
  assert.equal(await app.ev('studioMaxSources()'), 10);
  assert.equal(await app.ev('studioV7Live()'), false);
  assert.equal(await app.ev('studioMrOn()'), false);
  assert.equal(await app.ev('STUDIO_TOOLS.infographic.enabled'), false);
  assert.equal(await app.ev(`jobs.useFor('tutor')`), true, 'jobs still work on a v6 server');
  assert.equal(await app.ev(`jobs.useFor('transcribe')`), false, 'v6 server does not list the J4 modes');
});

t.test('server hello can lower the source cap and turn jobs off', async (h) => {
  const app = await h.newApp({ now: AFTER, fake: { caps: { maxSources: 12 } } });
  assert.equal(await app.ev('studioMaxSources()'), 12);
  const off = await h.newApp({ now: AFTER, fake: { jobsEnabled: false } });
  assert.equal(await off.ev(`jobs.useFor('tutor')`), false);
  assert.equal(await off.ev('studioMrOn()'), false);
});

t.test('jobs flag off in this browser: direct path, no hello, 10 sources', async (h) => {
  const app = await h.newApp({ jobs: false, now: AFTER, wait: false });
  await app.until('authInitDone && studio.ready');
  await h.sleep(300);
  assert.equal(await app.ev('jobs.enabled()'), false);
  assert.equal(await app.ev(`jobs.useFor('tutor')`), false);
  assert.equal(app.n8n.of('job').length, 0, 'no job endpoint call');
  assert.equal(await app.ev('studioMaxSources()'), 10);
});

t.test('10 vs 15 sources in the Studio plan', async (h) => {
  const items = Array.from({ length: 12 }, (_, i) => fx.kbItem(`doc${i}.txt`, { tokens: 100 }));
  const v7 = await h.newApp({});
  await v7.seedKb(items);
  const ok = await v7.ev(`studio.plan(kb.cache.map(i => i.id)).reason`);
  assert.equal(ok, '', 'twelve sources are fine on v7');
  const v6 = await h.newApp({ v: 0 });
  await v6.seedKb(items);
  assert.equal(await v6.ev(`studio.plan(kb.cache.map(i => i.id)).reason`), 'Choose fewer sources.');
  assert.equal(await v6.ev(`studio.plan(kb.cache.slice(0, 10).map(i => i.id)).reason`), '');
  const sixteen = await h.newApp({});
  await sixteen.seedKb(Array.from({ length: 16 }, (_, i) => fx.kbItem(`d${i}.txt`, { tokens: 50 })));
  assert.equal(await sixteen.ev(`studio.plan(kb.cache.map(i => i.id)).reason`), 'Choose fewer sources.', '16 sources are refused on v7');
});

t.test('Drive sync: first connect writes the sync file with KB, chats and study aids', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedKb([fx.kbItem('notes.txt', { tokens: 80 })]);
  await app.seedItems([studioItem('mindmap', { id: 'mm_one' })]);
  await app.ev(`tutor.newChatFor({ title: 'Chat one' })`);
  await connectDrive(app);
  const files = app.drive.byName('sth-userdata-v1.json');
  assert.equal(files.length, 1);
  const data = app.drive.json(files[0].id);
  assert.equal(data.kbItems.length, 1);
  assert.equal(data.tutorChats.length, 1);
  assert.equal(data.studio.items.length, 1);
  assert.equal(data.studio.items[0].id, 'mm_one');
  const hidden = app.drive.byName('sth-studio-mm_one.json');
  assert.equal(hidden.length, 1, 'the study aid has its own hidden file');
  assert.equal(app.drive.json(hidden[0].id).artifact.tool, 'mindmap');
  assert.equal(await app.ev('getSyncFileId() === ' + JSON.stringify(files[0].id)), true);
});

t.test('Drive sync: pull brings in another device\'s KB item, chat and study aid', async (h) => {
  const drive = new (require('../lib/harness').FakeDrive)();
  const artId = drive.add('sth-studio-remote_aid.json', { v: 1, id: 'remote_aid', tool: 'mindmap', artifact: studioItem('mindmap').artifact });
  const now = Date.now();
  drive.add('sth-userdata-v1.json', {
    kbItems: [fx.kbItem('remote.txt', { tokens: 60, id: 'k_remote' })],
    tutorChats: [{ id: 'chat_remote', title: 'From phone', messages: [{ id: 'm1', ts: now, role: 'user', text: 'hi' }], attachedKnowledgeIds: [], timestamp: now, updated: now }],
    createdDocs: [], removedDocIds: [], syncedAt: now,
    studio: { v: 1, items: [{ id: 'remote_aid', tool: 'mindmap', title: 'Map from phone', language: 'en', topic: '', options: {}, sourceIds: ['k_remote'], sourceNames: ['remote.txt'], createdAt: now - 1000, updatedAt: now - 500, driveFileId: artId, artifactBytes: 100 }], progress: {}, deleted: [] },
  });
  const app = await h.newApp({ drive, now: AFTER });
  await connectDrive(app);
  assert.equal(await app.ev(`kb.cache.some(i => i.id === 'k_remote')`), true);
  assert.equal(await app.ev(`tutor.chats.some(c => c.id === 'chat_remote')`), true);
  assert.equal(await app.ev(`studio.items.some(i => i.id === 'remote_aid' && i.status === 'ready')`), true);
  // opening it reads the hidden file
  await app.goto('#studio/remote_aid');
  await app.until(`studio.items.find(i => i.id === 'remote_aid').artifact !== null`, { what: 'artifact fetched from Drive' });
});

t.test('Drive sync: a later push sends new data; a deleted aid\'s file goes', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedItems([studioItem('quiz', { id: 'qz_a' })]);
  await connectDrive(app);
  assert.equal(app.drive.byName('sth-studio-qz_a.json').length, 1);
  await app.seedKb([fx.kbItem('later.txt', { tokens: 50 })]);
  await app.ev('pushToDrive()');
  const data = app.drive.json(app.drive.byName('sth-userdata-v1.json')[0].id);
  assert.ok(data.kbItems.some(i => i.name === 'later.txt'));
  // delete the aid (confirm dialog)
  const del = app.ev(`studio.remove('qz_a')`);
  await app.confirm(true);
  await del;
  await app.ev('pushToDrive()');
  assert.equal(app.drive.byName('sth-studio-qz_a.json').length, 0, 'hidden file deleted');
});

t.run();
