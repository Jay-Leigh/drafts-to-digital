'use strict';
// Tutor: chats, direct and job sends, resume after reload, and the per-chat drafts (sth_tutor_drafts).
const { suite, assert } = require('../lib/harness');
const { studioItem } = require('../lib/common');

const t = suite('02-tutor');
const H = 3600e3;
const modelCount = (app, id) => app.ev(`tutor.chats.find(c => c.id === ${JSON.stringify(id)}).messages.filter(m => m.role === 'model').length`);

t.test('chat: new chat, direct send (jobs off) gets one reply', async (h) => {
  const app = await h.newApp({ jobs: false });
  await app.goto('#tutor');
  await app.page.click('#tutorLandingNewChat');
  await app.until(`state.currentRoute === 'tutor' && !!tutor.currentId && tutorDraft.chatId === tutor.currentId`);
  const id = await app.ev('tutor.currentId');
  await app.send('What is osmosis?');
  await app.until(`tutor.chats.find(c => c.id === '${id}').messages.length === 2 && !tutor.pending.has('${id}')`);
  assert.equal(app.n8n.direct('tutor').length, 1);
  assert.equal(app.n8n.creates().length, 0, 'no job when the flag is off');
  const body = app.n8n.direct('tutor')[0].payload;
  assert.equal(body.messages[body.messages.length - 1].text, 'What is osmosis?');
  assert.equal(await app.ev(`tutor.chats.find(c => c.id === '${id}').messages[1].text`), 'Tutor reply to: What is osmosis?');
  assert.equal(await app.ev(`tutor.chats.find(c => c.id === '${id}').title`), 'What is osmosis?');
  await app.until(`document.querySelectorAll('#tutorMessages .message, #tutorMessages [class*="msg"]').length >= 2`).catch(() => {});
  assert.deepEqual(app.pageErrors, []);
});

t.test('chat: send as a job, result applied once, acknowledged', async (h) => {
  const app = await h.newApp({ clock: true });
  const id = await app.newChat();
  await app.send('Explain mitosis');
  await app.advanceUntil(`tutor.chats.find(c => c.id === '${id}').messages.some(m => m.role === 'model')`, { what: 'job reply applied' });
  assert.equal(app.n8n.creates('tutor').length, 1);
  assert.equal(app.n8n.direct('tutor').length, 0);
  const job = app.n8n.list()[0];
  // keep polling for a while: the answer must not be applied twice
  await app.advance(40000);
  assert.equal(await modelCount(app, id), 1);
  assert.equal(job.resultServed, 1, 'result fetched once');
  assert.equal(job.acked, true, 'acknowledged so the server can delete it');
  assert.equal(await app.ev(`tutor.chats.find(c => c.id === '${id}').messages[1].id`), `r_${job.id}`);
});

t.test('chat: reload in the middle of a job resumes it without sending again', async (h) => {
  const app = await h.newApp({ clock: true });
  app.n8n.plan(null, { type: 'hold' });
  const id = await app.newChat();
  await app.send('Long question');
  await app.until(`[...jobs.recs.values()].some(r => r.kind === 'tutor' && (r.state === 'submitted' || r.state === 'running'))`);
  assert.equal(app.n8n.creates('tutor').length, 1);
  await app.reload();
  await app.openChat(id);
  assert.equal(await modelCount(app, id), 0, 'still waiting');
  assert.equal(await app.ev(`tutor.answering('${id}')`), true, 'the chat shows it is still answering');
  app.n8n.release();
  await app.advanceUntil(`tutor.chats.find(c => c.id === '${id}').messages.some(m => m.role === 'model')`);
  assert.equal(app.n8n.creates('tutor').length, 1, 'no second create after the reload');
  assert.equal(await modelCount(app, id), 1);
});

// ── drafts ──
t.test('drafts: typed text is saved after a pause, for its own chat only', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A');
  await app.type('draft for A');
  assert.deepEqual(await app.drafts(), {}, 'not saved on every key (400 ms pause first)');
  await app.until(`!!JSON.parse(storageGet('sth_tutor_drafts') || '{}')['${a}']`);
  assert.equal((await app.drafts())[a].t, 'draft for A');
  const b = await app.newChat('B');
  assert.equal(await app.page.inputValue('#tutorInput'), '', 'the other chat starts empty');
  assert.equal(Object.keys(await app.drafts()).length, 1);
  await app.type('draft for B');
  await app.until(`!!JSON.parse(storageGet('sth_tutor_drafts') || '{}')['${b}']`);
  await app.openChat(a);
  assert.equal(await app.page.inputValue('#tutorInput'), 'draft for A', 'back restores A');
  await app.openChat(b);
  assert.equal(await app.page.inputValue('#tutorInput'), 'draft for B');
  assert.equal((await app.drafts())[a].t, 'draft for A', 'A is untouched');
});

t.test('drafts: switching chats quickly saves the old text first', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A');
  const b = await app.newChat('B');
  await app.openChat(a);
  await app.type('quick text');
  await app.openChat(b); // before the 400 ms timer
  assert.equal((await app.drafts())[a].t, 'quick text');
  assert.equal(await app.page.inputValue('#tutorInput'), '');
});

t.test('drafts: a reload restores the draft', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A');
  await app.type('survives reload');
  await app.until(`!!JSON.parse(storageGet('sth_tutor_drafts') || '{}')['${a}']`);
  await app.reload();
  await app.openChat(a);
  assert.equal(await app.page.inputValue('#tutorInput'), 'survives reload');
});

t.test('drafts: pagehide saves text typed less than 400 ms ago', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A');
  await app.type('last second');
  await app.ev(`window.dispatchEvent(new Event('pagehide'))`);
  assert.equal((await app.drafts())[a].t, 'last second');
});

t.test('drafts: expire after 48 h (49 h gone, 47 h kept)', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A'), b = await app.newChat('B'), c = await app.newChat('C');
  const now = Date.now();
  await app.ev(`storageSet('sth_tutor_drafts', JSON.stringify({ '${a}': { t: 'old 49h', at: ${now - 49 * H} }, '${b}': { t: 'recent 47h', at: ${now - 47 * H} }, '${c}': { t: 'fresh', at: ${now - 1000} } }))`);
  assert.equal(await app.ev(`tutorDraft.get('${a}')`), '');
  assert.equal(await app.ev(`tutorDraft.get('${b}')`), 'recent 47h');
  assert.equal(await app.ev(`tutorDraft.get('${c}')`), 'fresh');
  await app.reload();
  await app.openChat(a);
  assert.equal(await app.page.inputValue('#tutorInput'), '');
  await app.openChat(b);
  assert.equal(await app.page.inputValue('#tutorInput'), 'recent 47h');
  // writing any draft prunes the expired one from storage
  await app.type('recent 47h plus');
  await app.until(`JSON.parse(storageGet('sth_tutor_drafts'))['${b}'].t === 'recent 47h plus'`);
  assert.equal((await app.drafts())[a], undefined, 'the 49 h draft is gone from storage');
});

t.test('drafts: unchanged text keeps its original time', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A');
  const old = Date.now() - 10 * H;
  await app.ev(`storageSet('sth_tutor_drafts', JSON.stringify({ '${a}': { t: 'kept text', at: ${old} } }))`);
  await app.reload();
  await app.openChat(a);
  assert.equal(await app.page.inputValue('#tutorInput'), 'kept text');
  await app.ev(`tutorDraft.save()`);
  await app.ev(`window.dispatchEvent(new Event('pagehide'))`);
  assert.equal((await app.drafts())[a].at, old, 'time unchanged');
  await app.type('kept text!');
  await app.until(`JSON.parse(storageGet('sth_tutor_drafts'))['${a}'].t === 'kept text!'`);
  assert.ok((await app.drafts())[a].at > old, 'a real change takes a new time');
});

t.test('drafts: an empty box removes the draft; send clears it', async (h) => {
  const app = await h.newApp({ clock: true });
  const a = await app.newChat('A');
  await app.type('something');
  await app.until(`!!JSON.parse(storageGet('sth_tutor_drafts') || '{}')['${a}']`);
  await app.type('   ');
  await app.until(`!JSON.parse(storageGet('sth_tutor_drafts') || '{}')['${a}']`);
  await app.type('to send');
  await app.until(`!!JSON.parse(storageGet('sth_tutor_drafts') || '{}')['${a}']`);
  await app.page.press('#tutorInput', 'Enter');
  assert.equal((await app.drafts())[a], undefined, 'sending clears it at once');
  assert.equal(await app.page.inputValue('#tutorInput'), '');
  await app.advance(1000);
  assert.equal((await app.drafts())[a], undefined, 'and the pending timer does not bring it back');
});

t.test('drafts: deleting a chat removes its draft', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A');
  await app.type('goodbye');
  await app.until(`!!JSON.parse(storageGet('sth_tutor_drafts') || '{}')['${a}']`);
  const del = app.ev(`tutor.deleteChat('${a}')`);
  await app.confirm(true);
  await del;
  assert.equal((await app.drafts())[a], undefined);
});

t.test('drafts: at most 50 are kept (oldest go first)', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A');
  const now = Date.now();
  const many = {};
  for (let i = 0; i < 60; i++) many[`other_${i}`] = { t: `d${i}`, at: now - 60000 + i * 100 };
  await app.ev(`storageSet('sth_tutor_drafts', ${JSON.stringify(JSON.stringify(many))})`);
  await app.type('the newest');
  await app.until(`JSON.parse(storageGet('sth_tutor_drafts'))['${a}']`);
  const map = await app.drafts();
  assert.equal(Object.keys(map).length, 50);
  assert.ok(map[a], 'the new draft is kept');
  assert.equal(map.other_0, undefined, 'the oldest went');
  assert.ok(map.other_59, 'the newest of the others stayed');
});

t.test('drafts: text is cut at 20,000 characters', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A');
  await app.type('x'.repeat(25000));
  await app.until(`!!JSON.parse(storageGet('sth_tutor_drafts') || '{}')['${a}']`);
  assert.equal((await app.drafts())[a].t.length, 20000);
});

t.test('drafts: Ask-the-tutor prefill lands in its own chat only', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A'), b = await app.newChat('B');
  await app.openChat(a);
  await app.ev(`studio.pendingPrompt = { chatId: '${b}', text: 'Explain this node', what: 'mind map', at: Date.now() }`);
  await app.openChat(a);
  assert.equal(await app.page.inputValue('#tutorInput'), '', 'a prompt for B is not put into A');
  assert.ok(await app.ev('studio.pendingPrompt !== null'), 'and it waits for B');
  await app.openChat(b);
  await app.until(`document.getElementById('tutorInput').value === 'Explain this node'`);
  assert.equal(await app.ev('studio.pendingPrompt'), null);
  await app.until(`!!JSON.parse(storageGet('sth_tutor_drafts') || '{}')['${b}']`);
  const map = await app.drafts();
  assert.equal(map[b].t, 'Explain this node');
  assert.equal(map[a], undefined, 'A has no draft');
  await app.openChat(a);
  assert.equal(await app.page.inputValue('#tutorInput'), '');
});

t.test('drafts: a prompt older than 15 s is dropped; a typed draft asks before it is replaced', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A');
  await app.openChat(a);
  await app.ev(`studio.pendingPrompt = { chatId: '${a}', text: 'stale', what: 'mind map', at: Date.now() - 20000 }`);
  await app.ev(`studio.flushPrompt('${a}')`);
  assert.equal(await app.page.inputValue('#tutorInput'), '');
  await app.type('my own words');
  await app.ev(`studio.pendingPrompt = { chatId: '${a}', text: 'fresh prompt', what: 'mind map', at: Date.now() }`);
  await app.ev(`studio.flushPrompt('${a}')`);
  await app.page.waitForSelector('#confirmOverlay.open');
  await app.confirm(false);
  assert.equal(await app.page.inputValue('#tutorInput'), 'my own words', 'Cancel keeps what was typed');
});

t.test('drafts: another tab\'s change is taken when the box is not focused', async (h) => {
  const app = await h.newApp({});
  const a = await app.newChat('A');
  await app.type('mine');
  await app.until(`!!JSON.parse(storageGet('sth_tutor_drafts') || '{}')['${a}']`);
  const other = await app.context.newPage();
  await other.goto(`${app.pg.url}/privacy.html`);
  // focused: kept
  await app.page.focus('#tutorInput');
  await other.evaluate((id) => localStorage.setItem('sth_tutor_drafts', JSON.stringify({ [id]: { t: 'from the other tab', at: Date.now() } })), a);
  await h.sleep(300);
  assert.equal(await app.page.inputValue('#tutorInput'), 'mine', 'a focused box is not overwritten');
  // not focused: taken
  await app.page.evaluate(() => document.getElementById('tutorInput').blur());
  await other.evaluate((id) => localStorage.setItem('sth_tutor_drafts', JSON.stringify({ [id]: { t: 'second from other', at: Date.now() } })), a);
  await app.until(`document.getElementById('tutorInput').value === 'second from other'`, { what: 'storage event taken' });
  await other.close();
});

t.test('drafts: storage blocked does not throw', async (h) => {
  const app = await h.newApp({ storageBlocked: true, signedIn: false, wait: false });
  await app.page.fill('#loginInput', app.n8n.code);
  await app.page.check('#loginConsent');
  await app.page.click('#loginBtn');
  await app.until(`document.getElementById('appContent').classList.contains('unlocked') && authInitDone && !tutor.loading`, { timeout: 20000 });
  const id = await app.newChat('A');
  await app.type('no storage here');
  await h.sleep(700);
  assert.equal(await app.ev(`tutorDraft.get('${id}')`), '');
  await app.ev('tutorDraft.save()');
  await app.ev(`window.dispatchEvent(new Event('pagehide'))`);
  assert.equal(await app.page.inputValue('#tutorInput'), 'no storage here', 'the text stays in the box');
  assert.deepEqual(app.pageErrors, []);
});

// page.js renderMarkdown(): el.innerHTML = marked.parse(text). marked does not sanitise, so HTML in a model reply (which can echo a hostile attached document or web page) runs.
t.known('chat: HTML in a tutor reply is shown as text and never runs', async (h) => {
  const app = await h.newApp({ jobs: false });
  app.n8n.handlers.tutor = () => ({ text: 'Look: <img src=x onerror="window.__xss=1"> and <b>bold</b>' });
  const id = await app.newChat();
  await app.send('hello');
  await app.until(`tutor.chats.find(c => c.id === '${id}').messages.length === 2`);
  await h.sleep(800);
  assert.equal(await app.page.evaluate(() => window.__xss), undefined, 'no script ran from the reply');
  assert.equal(await app.page.evaluate(() => document.querySelectorAll('#tutorMessages img[src="x"]').length), 0, 'no element was made from the reply');
});

t.run();
