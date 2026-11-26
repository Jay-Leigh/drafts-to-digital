// End-to-end checks of what v7 adds on the server side that is not one tool: the version gate (hello), the Route by Mode fallback, the budget op,
// part / reduce / digest only as bulk jobs, the reserved job slots and the bulk cap, the bulk soft ceiling (cfg:bulk_ratio) and retry metering
// (a repeat is never billed without being metered; a timeout or 5xx is metered at the worst case).
//   node e2e/run-v7.js   after: STUDIO_TEST_TIMEOUT_MS=6000 J4_TEST_TIMEOUT_MS=8000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v7-bundle
const L = require('./lib7');
const { t, post, state, reset, setKey, queue, redis, usageNow, gcalls, login, mkJob, hdr, create, op, stOne, waitState, hgetall, errOf, sleep, today } = L;

async function main() {
  const E0 = (await L.execs()).length;
  await reset();
  const tok = await login('71.1.1.1'); const H = hdr(tok);

  console.log('[hello gate and the Route by Mode fallback]');
  let r = await post('sth-job', { v: 1, op: 'status', jobs: [] }, H);
  t(r.status === 200 && r.json.ok === true && r.json.v === 7 && r.json.caps.maxSources === 15 && r.json.caps.bulkCap === 2 && r.json.caps.reserve === 2 && r.json.caps.jobCap === 4 && r.json.modes.length === 10 && Math.abs(r.json.now - Date.now()) < 5000, 'hello answers v 7 and the caps (15 sources, bulk cap 2, reserve 2, total 4)', r.text);
  t((await post('sth-job', { v: 1, op: 'status', jobs: [] })).status === 401, 'hello needs the token');
  for (const [name, body] of [['unknown mode', { mode: 'nope' }], ['no mode', {}], ['studio_zzz', { mode: 'studio_zzz', v: 1 }]]) {
    r = await post('student-tools-v2', body, H);
    t(r.status === 200 && r.json && r.json.ok === false && r.json.error.code === 'STH-INPUT-400' && r.json.error.reason === 'mode', `sync ${name}: a clean STH-INPUT-400 (reason mode), not an empty or 500 answer`, [r.status, r.text.slice(0, 200)]);
  }
  t((await gcalls()).length === 0 && usageNow() === 0, 'no Gemini call, nothing metered');
  r = await post('student-tools-v2', tutorBody('hello'), H); t(r.status === 200 && r.json && typeof r.json.result === 'string', 'a known mode still answers (tutor)', r.text.slice(0, 120));

  console.log('[budget op]');
  r = await post('sth-job', { v: 1, op: 'budget', jobs: [] }); t(r.status === 401, 'budget needs the token');
  r = await post('sth-job', { v: 1, op: 'budget', jobs: [] }, H);
  t(r.status === 200 && r.json.ok === true && r.json.v === 7 && r.json.ceiling === null && r.json.remaining === null && r.json.used === usageNow() && r.json.studioMaxTokens === 400000 && r.json.mrMaxUnits === 2000000 && r.json.bulkRatio === 0.6 && r.json.day === today, 'budget without owner keys: no ceiling, defaults (400000 tokens, 2,000,000 units, ratio 0.6)', r.text);
  await setKey('cfg:daily_units', '3100000'); await setKey('usage:' + today, '1000000'); await setKey('cfg:studio_max_tokens', '600000'); await setKey('cfg:mr_max_units', '1500000'); await setKey('cfg:bulk_ratio', '0.5');
  await fetch(L.M + '/_state'); // flush nothing; just ensure the mock is up
  const c0 = (await state()).log.filter((l) => l.cmd).length;
  r = await post('sth-job', { v: 1, op: 'budget', jobs: [] }, H);
  t(r.json.used === 1000000 && r.json.ceiling === 3100000 && r.json.remaining === 2100000 && r.json.studioMaxTokens === 600000 && r.json.mrMaxUnits === 1500000 && r.json.bulkRatio === 0.5 && r.json.bulkCeiling === 1550000 && r.json.bulkRemaining === 550000, 'budget with owner keys', r.text);
  t((await state()).log.filter((l) => l.cmd).length - c0 === 1, 'budget = 1 Upstash command (one MGET)');
  for (const bad of [{ v: 1, op: 'budget', jobs: [{ id: 'j_' + 'A'.repeat(22), key: 'k' + 'A'.repeat(42) }] }, { v: 1, op: 'budget' }, { v: 2, op: 'budget', jobs: [] }]) { r = await post('sth-job', bad, H); t(r.json.ok === false && r.json.error.code === 'STH-INPUT-400', `budget ${JSON.stringify(bad).slice(0, 40)} -> STH-INPUT-400`); }
  await fetch(L.M + '/_down?on=1'); r = await post('sth-job', { v: 1, op: 'budget', jobs: [] }, H); await fetch(L.M + '/_down?on=0');
  t(r.status === 200 && r.json.ok === true && r.json.remaining === null && r.json.used === null && r.json.mrMaxUnits === 2000000, 'Redis down: fail-open (remaining null)', r.text);
  for (const k of ['cfg:daily_units', 'usage:' + today, 'cfg:studio_max_tokens', 'cfg:mr_max_units', 'cfg:bulk_ratio']) redis('DEL', k);

  console.log('[part / reduce / digest only as bulk jobs]');
  await reset(); H.authorization = 'Bearer ' + (await login('71.1.2.2'));
  const n0 = (await gcalls()).length;
  const dgJob = { ...L.dgBody() };
  const syncCases = [['digest part', L.dgBody()], ['quiz part', L.base('quiz', 'studio_quiz', { options: { count: 20, difficulty: 'easy' }, part: { i: 1, n: 2, count: 5 } })], ['mind map reduce', L.redBody('mindmap', 'studio_mindmap')], ['infographic reduce', L.redBody('infographic', 'studio_infographic')]];
  for (const [name, body] of syncCases) { r = await post('student-tools-v2', body, H); t(r.json.ok === false && r.json.error.code === 'STH-INPUT-400' && r.json.error.reason === 'job_only', `sync ${name}: refused (job_only)`, r.text.slice(0, 160)); }
  t((await gcalls()).length === n0, 'no Gemini call for the refused requests');
  await queue('valid');
  let j = mkJob('studio_digest'); await create(j, dgJob, H); let s = await waitState(j, H);
  t(s.state === 'succeeded', 'digest part as a job: succeeded (digest is always bulk)', s); r = await op('result', [j], H);
  t(r.json.result.ok === true && r.json.result.artifact.tool === 'digest' && r.json.result.artifact.strategy === 'part' && r.json.result.artifact.promptVersion === 'studio-2026-12-a' && r.json.result.artifact.data.topics.length === 1 && r.json.result.artifact.data.figures[0].verified === true && JSON.stringify(r.json.result.artifact.part) === '{"i":1,"n":3}', 'the digest artifact: tool, strategy part, part {i, n}, verified figure', r.text.slice(0, 300));
  await op('ack', [j], H);
  j = mkJob('studio_quiz'); const qpart = L.base('quiz', 'studio_quiz', { options: { count: 20, difficulty: 'easy' }, part: { i: 1, n: 2, count: 5 } });
  await create(j, qpart, H); s = await waitState(j, H); t(s.state === 'failed' && errOf(s) === 'STH-INPUT-400' && s.error.reason === 'not_bulk', 'a quiz part in a job without the bulk flag: failed STH-INPUT-400 not_bulk (the client cannot skip the bulk cap)', s);
  j = mkJob('studio_quiz', 1, { bulk: true }); await create(j, qpart, H); s = await waitState(j, H); r = await op('result', [j], H);
  t(s.state === 'succeeded' && r.json.result.artifact.tool === 'quiz' && r.json.result.artifact.strategy === 'part' && r.json.result.artifact.data.questions.length === 5, 'the same quiz part with bulk: true: succeeded, 5 questions (the part count)', s);
  j = mkJob('studio_mindmap', 1, { bulk: true }); await create(j, L.redBody('mindmap', 'studio_mindmap'), H); s = await waitState(j, H); r = await op('result', [j], H);
  t(s.state === 'succeeded' && r.json.result.artifact.strategy === 'reduce' && r.json.result.artifact.tool === 'mindmap', 'mind map reduce as a bulk job: succeeded, strategy reduce', s);
  const cites = r.json.result.artifact.data.nodes.flatMap((n) => n.cites).map((c) => c.source + ':' + c.page);
  t(cites.length > 0 && cites.every((c) => c === 'S1:1' || c === 'S1:3' || c === 'S1:0'), 'reduce citations are only those of the digests (pages 1 and 3) or page 0', [...new Set(cites)]);
  const last = (await gcalls()).at(-1).body.contents[0].parts.map((p) => p.text).join('\n');
  t(/<digest part="1">/.test(last) && /<digest part="3">/.test(last) && !/<source id="S1" name="Book.pdf" type="pdf" pages=/.test(last) && /strategy: reduce/.test(last), 'the Gemini request holds the digests, not the sources');
  j = mkJob('studio_mindmap', 1, { bulk: true }); await create(j, L.redBody('mindmap', 'studio_mindmap', { digests: [] }), H); s = await waitState(j, H); t(s.state === 'failed' && errOf(s) === 'STH-INPUT-400', 'reduce with no digests: failed STH-INPUT-400', s);
  j = mkJob('studio_digest'); await create(j, L.dgBody({ sources: [{ id: 'S1', name: 'big', kind: 'txt', markers: 'none', text: 'x'.repeat(900000) }] }), H); s = await waitState(j, H);
  t(s.state === 'failed' && errOf(s) === 'STH-STU-413' && s.error.reason === 'part_too_big' && s.error.maxTokens === 200000, 'a part above 200000 tokens: failed STH-STU-413 part_too_big with maxTokens 200000', s);
  const gBefore = (await gcalls()).length;
  j = mkJob('studio_digest'); await create(j, L.dgBody({ part: { i: 9, n: 3 } }), H); s = await waitState(j, H); t(s.state === 'failed' && errOf(s) === 'STH-INPUT-400' && (await gcalls()).length === gBefore, 'bad part: failed before Gemini');

  console.log('[reserved slots and the bulk cap: 2 bulk + the tutor]');
  await reset(); H.authorization = 'Bearer ' + (await login('71.1.3.3'));
  await queue('', 'slow:6000');
  const t1 = mkJob('transcribe'), t2 = mkJob('transcribe'), t3 = mkJob('template');
  const slowJ4 = (mode) => L.j4Body(mode, 'hello [[mock:hang5000]]');
  await create(t1, slowJ4('transcribe'), H); await create(t2, slowJ4('transcribe'), H); await sleep(1200);
  t((await stOne(t1, H)).state === 'running' && (await stOne(t2, H)).state === 'running' && redis('ZCARD', 'sth:jobs:run:bulk') === '2' && redis('ZCARD', 'sth:jobs:run:transcribe') === '0', '2 transcribe jobs running: both in the bulk set only (a bulk job is not in its mode set)');
  await create(t3, slowJ4('template'), H); s = await waitState(t3, H, ['rejected', 'failed', 'running', 'succeeded'], 8000);
  t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429', 'a 3rd bulk job (template) is busy: STH-JOB-429, although only 2 of 4 slots are used', s);
  const d1 = mkJob('studio_digest'); await create(d1, L.dgBody(), H); s = await waitState(d1, H, ['rejected', 'failed', 'running', 'succeeded'], 8000); t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429', 'a digest job is busy too (same bulk cap)', s);
  const tu1 = mkJob('tutor'), tu2 = mkJob('tutor');
  const tt0 = Date.now(); await create(tu1, tutorBody('hello one'), H); await create(tu2, tutorBody('hello two'), H);
  const s1 = await waitState(tu1, H, DONE_S, 20000), s2 = await waitState(tu2, H, DONE_S, 20000);
  t(s1.state === 'succeeded' && s2.state === 'succeeded' && Date.now() - tt0 < 6000, 'the 2 reserved slots: two tutor jobs run and finish while 2 bulk jobs hold their slots (before the bulk jobs end)', [s1.state, s2.state, Date.now() - tt0]);
  const tu3 = mkJob('tutor'); await create(tu3, tutorBody('hello three'), H); s = await waitState(tu3, H, ['rejected', 'running', 'succeeded', 'failed'], 3000);
  t(['running', 'succeeded'].includes(s.state), 'the tutor is never refused while it has its own slots', s);
  const sa = await waitState(t1, H, DONE_S, 30000), sb = await waitState(t2, H, DONE_S, 30000);
  t(sa.state === 'succeeded' && sb.state === 'succeeded' && redis('ZCARD', 'sth:jobs:run:bulk') === '0' && redis('ZCARD', 'sth:jobs:run:transcribe') === '0', 'both transcribe jobs finish; bulk set empty again (STORE frees both sets)', [sa.state, sb.state]);
  const ok3 = mkJob('template'); await create(ok3, L.j4Body('template'), H); s = await waitState(ok3, H); t(s.state === 'succeeded', 'a bulk slot is free again: a template job runs', s);
  // a map-reduce part (quiz with bulk: true) counts as bulk
  await queue('', 'slow:5000');
  const p1 = mkJob('studio_quiz', 1, { bulk: true }), p2 = mkJob('studio_digest');
  await create(p1, L.base('quiz', 'studio_quiz', { options: { count: 20, difficulty: 'easy' }, part: { i: 1, n: 2, count: 5 } }), H); await create(p2, L.dgBody(), H); await sleep(1200);
  t(redis('ZCARD', 'sth:jobs:run:bulk') === '2', 'a quiz part (bulk: true) and a digest part: 2 in the bulk set');
  const p3 = mkJob('studio_digest'); await create(p3, L.dgBody(), H); s = await waitState(p3, H, ['rejected', 'running', 'succeeded', 'failed'], 8000); t(s.state === 'rejected', 'a third bulk job is refused', s);
  const p4 = mkJob('studio_quiz'); await create(p4, L.base('quiz', 'studio_quiz', { options: { count: 10, difficulty: 'easy' } }), H); s = await waitState(p4, H, ['rejected', 'running', 'succeeded', 'failed'], 8000);
  t(s.state === 'running', 'an ordinary quiz job is admitted while a quiz part runs (a bulk job does not hold the per-mode slot of other users)', s);
  const p5 = mkJob('studio_quiz'); await create(p5, L.base('quiz', 'studio_quiz', { options: { count: 10, difficulty: 'easy' } }), H); const s5 = await waitState(p5, H, ['rejected', 'running', 'succeeded', 'failed'], 8000);
  t(s5.state === 'rejected' && errOf(s5) === 'STH-JOB-429', 'a second ordinary quiz job is still refused (per-mode cap 1 for non-bulk jobs, as v6)', s5);
  await waitState(p4, H, DONE_S, 30000);
  await waitState(p1, H, DONE_S, 30000); await waitState(p2, H, DONE_S, 30000);
  await queue('', 'valid');
  t(hgetall('sth:jobs:n:' + today).busy >= '3', 'busy counted');

  console.log('[bulk soft ceiling (cfg:bulk_ratio)]');
  await reset(); H.authorization = 'Bearer ' + (await login('71.1.4.4'));
  await setKey('cfg:daily_units', '1000000'); await setKey('usage:' + today, '600000');
  const g0 = (await gcalls()).length;
  let b1 = mkJob('studio_digest'); await create(b1, L.dgBody(), H); s = await waitState(b1, H);
  t(s.state === 'failed' && errOf(s) === 'STH-QUOTA-430' && s.error.reason === 'bulk' && (await gcalls()).length === g0, 'usage 600000 of 1000000 (default ratio 0.6): a digest job is refused STH-QUOTA-430 reason bulk, no Gemini call', s);
  b1 = mkJob('transcribe'); await create(b1, L.j4Body('transcribe'), H); s = await waitState(b1, H); t(s.state === 'failed' && errOf(s) === 'STH-QUOTA-430' && s.error.reason === 'bulk', 'a transcribe JOB is bulk too', s);
  b1 = mkJob('studio_quiz', 1, { bulk: true }); await create(b1, L.base('quiz', 'studio_quiz', { options: { count: 20, difficulty: 'easy' }, part: { i: 1, n: 2, count: 5 } }), H); s = await waitState(b1, H); t(s.state === 'failed' && errOf(s) === 'STH-QUOTA-430' && s.error.reason === 'bulk', 'a map-reduce part is bulk');
  r = await post('student-tools-v2', L.j4Body('transcribe'), H); t(r.json && typeof r.json.text === 'string', 'a DIRECT transcribe request is not bulk (unchanged)', r.text.slice(0, 120));
  b1 = mkJob('tutor'); await create(b1, tutorBody('hi'), H); s = await waitState(b1, H); t(s.state === 'succeeded', 'tutor job: still allowed (the rest of the day)', s);
  b1 = mkJob('studio_infographic'); await create(b1, L.igBody(), H); s = await waitState(b1, H); t(s.state === 'succeeded', 'an infographic job is not bulk: allowed');
  r = await post('student-tools-v2', L.base('quiz', 'studio_quiz', { options: { count: 20, difficulty: 'easy' } }), H); t(r.json.ok === true, 'a direct quiz is not bulk: allowed');
  await setKey('cfg:bulk_ratio', '0.9'); b1 = mkJob('studio_digest'); await create(b1, L.dgBody(), H); s = await waitState(b1, H); t(s.state === 'succeeded', 'cfg:bulk_ratio 0.9: a digest job is allowed at usage ~650000 of 1000000');
  await setKey('usage:' + today, '950000'); b1 = mkJob('studio_digest'); await create(b1, L.dgBody(), H); s = await waitState(b1, H); t(s.state === 'failed' && s.error.reason === 'bulk', 'usage 950000 >= 0.9 x 1000000: refused again');
  await setKey('usage:' + today, '1000000'); b1 = mkJob('tutor'); await create(b1, tutorBody('hi'), H); s = await waitState(b1, H); t(s.state === 'failed' && errOf(s) === 'STH-QUOTA-430' && !s.error.reason, 'at the hard ceiling: the tutor is refused with the plain STH-QUOTA-430 (no reason)', s);
  redis('DEL', 'cfg:daily_units'); redis('DEL', 'cfg:bulk_ratio'); redis('DEL', 'usage:' + today);

  console.log('[retry metering: no repeat without a meter entry]');
  await reset(); H.authorization = 'Bearer ' + (await login('71.1.5.5'));
  const est = (body) => Math.ceil(JSON.stringify(body).length / 4);
  const worst = (tokens, maxOut) => Math.round(tokens + 2500 + 8.33 * (maxOut + 1024));
  const tokens1 = Math.ceil(L.TEXT1.length / 4);
  // infographic, sync
  await queue('503,503,503'); let u0 = usageNow(); let gc0 = (await gcalls()).length; r = await post('student-tools-v2', L.igBody(), H);
  t(r.json.ok === false && r.json.error.code === 'STH-STU-409' && r.json.error.reason === 'upstream' && (await gcalls()).length - gc0 === 1, 'infographic, sync, 503: ONE Gemini call (never repeated), STH-STU-409', [r.text.slice(0, 120), (await gcalls()).length - gc0]);
  t(usageNow() - u0 === worst(tokens1, 8192), `...metered at the worst case: ${worst(tokens1, 8192)} units`, usageNow() - u0);
  await queue('hang:20000'); u0 = usageNow(); gc0 = (await gcalls()).length; r = await post('student-tools-v2', L.igBody(), H);
  t(r.json.ok === false && r.json.error.reason === 'unreachable' && (await gcalls()).length - gc0 === 1 && usageNow() - u0 === worst(tokens1, 8192), 'infographic, sync, time-out: one call, metered at the worst case', [r.text.slice(0, 120), usageNow() - u0]);
  await queue('429,valid'); u0 = usageNow(); gc0 = (await gcalls()).length; r = await post('student-tools-v2', L.igBody(), H);
  t(r.json.ok === true && (await gcalls()).length - gc0 === 2 && usageNow() - u0 === Math.round(5000 + 8.33 * 1200), 'a 429 is repeated (never billed): 2 calls, metered once at the real usage', [(await gcalls()).length - gc0, usageNow() - u0]);
  await queue('500,valid'); u0 = usageNow(); gc0 = (await gcalls()).length; r = await post('student-tools-v2', L.slBody(), H);
  t(r.json.ok === false && (await gcalls()).length - gc0 === 1 && usageNow() - u0 === worst(tokens1, 16384), 'slides, sync, 500: one call, metered at the worst case (16384 output limit)', [r.text.slice(0, 100), usageNow() - u0]);
  await queue('empty,valid'); u0 = usageNow(); gc0 = (await gcalls()).length; r = await post('student-tools-v2', L.igBody(), H);
  t(r.json.ok === false && r.json.error.reason === 'empty' && (await gcalls()).length - gc0 === 1 && usageNow() - u0 === Math.round(5000 + 8.33 * 1200), 'an empty answer is not repeated; billed and metered once', [r.text.slice(0, 100), usageNow() - u0]);
  // digest part, job
  await queue('503,503,503'); u0 = usageNow(); gc0 = (await gcalls()).length; let jj = mkJob('studio_digest'); await create(jj, L.dgBody(), H); s = await waitState(jj, H);
  t(s.state === 'failed' && errOf(s) === 'STH-STU-409' && s.error.retryable === true && (await gcalls()).length - gc0 === 1 && usageNow() - u0 === worst(tokens1, 8192), 'digest part (job), 503: one call, retryable STH-STU-409, metered at the worst case', [s, (await gcalls()).length - gc0, usageNow() - u0]);
  await queue('503,valid'); gc0 = (await gcalls()).length; jj = mkJob('studio_quiz', 1, { bulk: true }); await create(jj, L.base('quiz', 'studio_quiz', { options: { count: 20, difficulty: 'easy' }, part: { i: 1, n: 2, count: 5 } }), H); s = await waitState(jj, H);
  t(s.state === 'failed' && (await gcalls()).length - gc0 === 1, 'a quiz PART (job) is not repeated after a 503 (the app retries the whole job, visibly)', [s.state, (await gcalls()).length - gc0]);
  await queue('503,503,503'); gc0 = (await gcalls()).length; u0 = usageNow(); jj = mkJob('studio_quiz'); await create(jj, L.base('quiz', 'studio_quiz', { options: { count: 20, difficulty: 'easy' } }), H); s = await waitState(jj, H);
  t(s.state === 'failed' && (await gcalls()).length - gc0 === 3 && usageNow() === u0, 'an ordinary quiz job: unchanged v6 behaviour (3 calls inside the job, last failure not metered)', [(await gcalls()).length - gc0, usageNow() - u0]);
  await queue('503,503,503'); gc0 = (await gcalls()).length; u0 = usageNow(); r = await post('student-tools-v2', L.mmBody(), H); t(r.json.ok === false && (await gcalls()).length - gc0 === 3 && usageNow() === u0, 'a direct mind map: unchanged (3 calls, nothing metered for the failure)');
  await queue('valid');
  // J4: direct request keeps its 3 tries; the job makes one call
  gc0 = (await gcalls()).length; u0 = usageNow(); r = await post('student-tools-v2', L.j4Body('transcribe', 'hello [[mock:fail2-503-a]]'), H);
  t(r.status === 200 && r.json && r.json.text === 'MOCK GEMINI REPLY' && (await gcalls()).length - gc0 === 3, 'transcribe, direct: node-level retries as before (2 failures + 1 success = 3 calls)', [r.status, r.text.slice(0, 100), (await gcalls()).length - gc0]);
  t(usageNow() - u0 === Math.round(100 + 8.33 * 75), 'direct transcribe: the answer is metered once with the factor 8.33', usageNow() - u0);
  gc0 = (await gcalls()).length; u0 = usageNow(); jj = mkJob('transcribe'); await create(jj, L.j4Body('transcribe', 'hello [[mock:503]]'), H); s = await waitState(jj, H);
  const jb = (await gcalls()).slice(gc0).at(-1); const chars = jb.body.contents.flatMap((c) => c.parts).reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
  t(s.state === 'failed' && errOf(s) === 'STH-AI-503' && s.error.retryable === true && (await gcalls()).length - gc0 === 1, 'transcribe JOB, 503: ONE call, failed STH-AI-503 (retryable: the app starts attempt 2)', [s, (await gcalls()).length - gc0]);
  t(usageNow() - u0 === Math.round(Math.ceil(chars / 4) + 8.33 * (8192 + 2048)), `...metered at the worst case: prompt ${Math.ceil(chars / 4)} + 8.33 x (8192 + 2048)`, [usageNow() - u0, Math.ceil(chars / 4)]);
  gc0 = (await gcalls()).length; u0 = usageNow(); jj = mkJob('template'); await create(jj, L.j4Body('template', '[[mock:429]]'), H); s = await waitState(jj, H);
  t(s.state === 'failed' && errOf(s) === 'STH-AI-429' && (await gcalls()).length - gc0 === 1 && usageNow() === u0, 'template JOB, 429: one call, STH-AI-429, nothing metered (a 429 is not billed)', [s, usageNow() - u0]);
  gc0 = (await gcalls()).length; u0 = usageNow(); jj = mkJob('reviewer'); await create(jj, L.j4Body('reviewer', '[[mock:hang30000]]'), H); s = await waitState(jj, H, DONE_S, 60000);
  t(s.state === 'failed' && errOf(s) === 'STH-AI-504' && (await gcalls()).length - gc0 === 1 && usageNow() - u0 > 20000, 'reviewer JOB, Gemini hangs (8 s test time-out): one call, STH-AI-504, metered at the worst case', [s, (await gcalls()).length - gc0, usageNow() - u0]);
  jj = mkJob('transcribe'); await create(jj, L.j4Body('transcribe', 'ok text'), H); s = await waitState(jj, H); r = await op('result', [jj], H);
  t(s.state === 'succeeded' && r.json.result.text === 'MOCK GEMINI REPLY' && Object.keys(r.json.result).join() === 'text', 'transcribe JOB, good answer: succeeded, result {text} (the direct answer)', r.text.slice(0, 120));
  const direct = await post('student-tools-v2', L.j4Body('transcribe', 'ok text'), H); t(JSON.stringify(direct.json) === JSON.stringify(r.json.result), 'the stored result equals the direct answer byte for byte');
  console.log('[the workflow stays healthy]');
  const bad = (await L.execs()).slice(E0).filter((e) => e.status === 'crashed'); // only this run's executions (an earlier n8n kill leaves old 'crashed' rows)
  t(bad.length === 0, 'no crashed execution', bad.map((b) => b.id));
  L.done('E2E v7 gate / bulk / metering');
}
const DONE_S = L.DONE;
const { tutorBody } = L;
main().catch((e) => { console.log('CRASH', e); process.exit(1); });
