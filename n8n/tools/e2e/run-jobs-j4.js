// End-to-end checks of transcribe / template / reviewer as background jobs (v7): same answer as the direct request, failure codes, caps, no text in records.
//   node e2e/run-jobs-j4.js   after: STUDIO_TEST_TIMEOUT_MS=6000 J4_TEST_TIMEOUT_MS=8000 e2e/reload.sh v7-bundle
const L = require('./lib7');
const { t, post, reset, setKey, redis, gcalls, login, mkJob, hdr, create, op, stOne, waitState, errOf, execs, sleep, state, today } = L;
(async () => {
  const E0 = (await execs()).length;
  await reset(); const H = hdr(await login('75.1.1.1'));
  console.log('[J4 jobs: success, same answer as the direct request]');
  for (const mode of ['transcribe', 'template', 'reviewer']) {
    const j = mkJob(mode); const t0 = Date.now(); let r = await create(j, L.j4Body(mode, 'some text'), H);
    t(r.status === 200 && r.text === '{"ok":true,"accepted":true}' && Date.now() - t0 < 3000, `${mode}: create answers at once`);
    const s = await waitState(j, H); const direct = await post('student-tools-v2', L.j4Body(mode, 'some text'), H); r = await op('result', [j], H);
    t(s.state === 'succeeded' && s.attempt === 1 && r.json.mode === mode && JSON.stringify(r.json.result) === JSON.stringify(direct.json) && r.json.result.text === 'MOCK GEMINI REPLY', `${mode} job succeeded; the stored answer equals the direct answer`, [s, r.text.slice(0, 200)]);
    const rec = L.hgetall('sth:job:' + j.id); t(rec.m === mode && rec.kh === L.sha(j.key) && !JSON.stringify(rec).includes('some text') && !JSON.stringify(rec).includes(j.key), `${mode}: the record holds mode and key hash, no text`);
    t(Number(redis('TTL', 'sth:job:' + j.id)) > 259000 && Number(redis('TTL', 'sth:jobr:' + j.id)) > 259000, `${mode}: 72 h`);
    await op('ack', [j], H);
    t(redis('ZCARD', 'sth:jobs:run:' + mode) === '0' && redis('ZCARD', 'sth:jobs:run:bulk') === '0', `${mode}: slots free after the run`);
  }
  console.log('[J4 jobs: failures store a fixed code]');
  const F = [
    ['transcribe', 'text [[mock:safety]]', 'STH-AI-451', false], ['transcribe', 'text [[mock:recite]]', 'STH-AI-452', false], ['template', 'text [[mock:safety]]', 'STH-AI-451', false], ['reviewer', 'text [[mock:recite]]', 'STH-AI-452', false],
    ['transcribe', 'x [[mock:500]]', 'STH-AI-500', true], ['template', 'x [[mock:503]]', 'STH-AI-503', true], ['reviewer', 'x [[mock:429]]', 'STH-AI-429', true], ['transcribe', 'x [[mock:400]]', 'STH-SRV-500', true],
    ['transcribe', 'x [[mock:empty]]', 'STH-SRV-500', true], ['transcribe', 'x [[mock:hang30000]]', 'STH-AI-504', true],
  ];
  for (const [mode, text, code, retryable] of F) {
    const j = mkJob(mode); const g0 = (await gcalls()).length; await create(j, L.j4Body(mode, text), H); const s = await waitState(j, H, L.DONE, 60000);
    t(s.state === 'failed' && errOf(s) === code && s.error.retryable === retryable && s.resultBytes === 0 && (await gcalls()).length - g0 === 1, `${mode} ${text.match(/mock:(\w+)/)[1]} -> failed ${code}${retryable ? ' (retryable)' : ''}, one Gemini call`, [s, (await gcalls()).length - g0]);
    const rr = await op('result', [j], H); t(rr.json.ok === false && rr.json.error.code === 'STH-JOB-404', 'no result stored');
  }
  { const MARK = 'ZZSECRETJOBZZ' + 'q'.repeat(20); const j = mkJob('transcribe'); await create(j, L.j4Body('transcribe', MARK + ' [[mock:503]]'), H); await waitState(j, H);
    const st = await state(); const all = JSON.stringify(st.store); t(!all.includes('ZZSECRET'), 'no request text anywhere in Redis'); }
  console.log('[J4 jobs: caps, kill switch, cancel, quota]');
  await reset(); H.authorization = 'Bearer ' + (await login('75.1.2.2'));
  const slow = (mode) => L.j4Body(mode, 'hang [[mock:hang5000]]');
  const a = mkJob('transcribe'), b = mkJob('transcribe'), c = mkJob('transcribe'); await create(a, slow('transcribe'), H); await create(b, slow('transcribe'), H); await sleep(1000); await create(c, slow('transcribe'), H);
  let s = await waitState(c, H, ['rejected', 'running', 'succeeded'], 8000); t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429', 'transcribe: 2 at once (cap 2), the 3rd is busy', s);
  await waitState(a, H, L.DONE, 30000); await waitState(b, H, L.DONE, 30000);
  const t1 = mkJob('template'), t2 = mkJob('template'); await create(t1, slow('template'), H); await sleep(800); await create(t2, slow('template'), H); s = await waitState(t2, H, ['rejected', 'running', 'succeeded'], 8000); t(s.state !== 'rejected', 'template: a bulk job is governed by the bulk cap only (2): a second template job runs', s);
  const t3 = mkJob('reviewer'); await create(t3, slow('reviewer'), H); s = await waitState(t3, H, ['rejected', 'running', 'succeeded'], 8000); t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429', 'the third bulk job (reviewer) is busy', s); await waitState(t1, H, L.DONE, 30000); await waitState(t2, H, L.DONE, 30000);
  const k = mkJob('reviewer'); await create(k, slow('reviewer'), H); await sleep(600); let r = await op('cancel', [k], H); t(r.json.ok === true && (await stOne(k, H)).state === 'cancelled', 'cancel a running reviewer job'); await sleep(6000);
  t((await stOne(k, H)).state === 'cancelled' && redis('EXISTS', 'sth:jobr:' + k.id) === '0', 'the late answer is discarded');
  await setKey('cfg:jobs_max_running', '0'); const kj = mkJob('transcribe'); await create(kj, L.j4Body('transcribe'), H); s = await waitState(kj, H); t(s.state === 'rejected' && errOf(s) === 'STH-JOB-503', 'kill switch (cfg:jobs_max_running 0): STH-JOB-503 (the app falls back to the direct request)', s); redis('DEL', 'cfg:jobs_max_running');
  await setKey('cfg:daily_units', '1'); await setKey('usage:' + today, '5'); const qj = mkJob('template'); const g0 = (await gcalls()).length; await create(qj, L.j4Body('template'), H); s = await waitState(qj, H);
  t(s.state === 'failed' && errOf(s) === 'STH-QUOTA-430' && !s.error.reason && (await gcalls()).length === g0, 'the hard ceiling stops a J4 job: STH-QUOTA-430, no Gemini call', s); redis('DEL', 'cfg:daily_units'); redis('DEL', 'usage:' + today);
  const mj = mkJob('transcribe'); await create(mj, { ...L.j4Body('transcribe'), mode: 'template' }, H); s = await waitState(mj, H); t(s.state === 'failed' && errOf(s) === 'STH-INPUT-400', 'body mode must equal the job mode');
  console.log('[J4 jobs: the keys all expire]');
  const keys = redis('KEYS', 'sth:*').split('\n').filter(Boolean); let bad = [];
  for (const kk of keys) if (Number(redis('TTL', kk)) < 0) bad.push(kk);
  t(keys.length > 0 && bad.length === 0, 'every sth: key has a TTL', bad);
  t((await execs()).slice(E0).filter((e) => e.status === 'crashed').length === 0, 'no crashed execution');
  L.done('E2E J4 jobs');
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
