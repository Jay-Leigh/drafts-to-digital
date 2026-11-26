// End-to-end checks of what v8 adds, against a real n8n 2.29.7 running the imported v8 test copy (external HTTP -> mock; real Redis 7 on :6390, so the Lua
// scripts run for real): sign-in claims v2, the renew webhook (JWT Auth in front, the verdicts, the cap, the epoch, the breaker, fail closed), algorithm
// confusion and tampered tokens, CORS, the alarms, and the job pickup ops (claim, collected, result 409).
//   node e2e/run-renew.js          after: STUDIO_TEST_TIMEOUT_MS=6000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v8-bundle
//   node e2e/run-renew.js extra    after: WF_DIR=<folder built with STH_EXTRA_ORIGIN=https://school.example.org> e2e/reload.sh v8-bundle   (the extra-origin build, review B1)
const L = require('./lib7');
const { t, post, reset, redis, login, mkJob, hdr, create, op, waitState, hgetall, execs, tutorBody, sleep, ORIGIN, B, M } = L;
const crypto = require('crypto');
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const EXTRA = 'https://school.example.org';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
// a token signed like n8n's JWT credential (HS256, the test secret); alg / key / payload can be bent
function sign(claims, { alg = 'HS256', key = SECRET, header, tamperPayload } = {}) {
  const h = b64(header || { alg, typ: 'JWT' });
  let p = b64(claims);
  const hmac = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }[alg];
  const sig = alg === 'none' ? '' : crypto.createHmac(hmac || 'sha256', key).update(`${h}.${p}`).digest('base64url');
  if (tamperPayload) p = b64(tamperPayload);
  return `${h}.${p}.${sig}`;
}
const dec = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
const NOW = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
const SID = '11111111-2222-4333-8444-555555555555';
const v2 = (o = {}) => { const n = NOW(); return { sub: 'sth', sid: SID, ac: 'sth', v: 2, jti: crypto.randomUUID(), iat: n - 2 * DAY, exp: n + 5 * DAY, auth_time: n - 3 * DAY, ep: 0, ...o }; };
const v1 = (o = {}) => { const n = NOW(); const j = crypto.randomUUID(); return { sub: 'sth', sid: j, ac: 'sth', v: 1, jti: j, iat: n - 2 * DAY, exp: n + 5 * DAY, ...o }; };
const renew = (tok, extra = {}) => post('student-tools-renew', { v: 1 }, tok ? { authorization: 'Bearer ' + tok, ...extra } : extra);
async function raw(method, p, headers = {}) { const res = await fetch(B + '/' + p, { method, headers }); const text = await res.text(); return { status: res.status, text, headers: res.headers }; }
const errCode = (r) => r.json && r.json.error && r.json.error.code;
const reasonOf = (r) => r.json && r.json.error && r.json.error.reason;
const hourKey = () => 'auth:rn:' + new Date().toISOString().slice(0, 13).replace(/\D/g, '');

async function mainSuite() {
  await reset();
  console.log('[sign-in: claims v2]');
  const tok0 = await login('81.1.1.1'); const c0 = dec(tok0);
  t(c0.v === 2 && c0.sub === 'sth' && c0.ac === 'sth' && c0.sid === c0.jti && c0.sid.length === 36 && c0.auth_time === c0.iat && c0.ep === 0 && c0.exp - c0.iat === 604800 && Object.keys(c0).sort().join() === 'ac,auth_time,ep,exp,iat,jti,sid,sub,v', 'the token from the access code is v2: sid = jti, auth_time = iat, ep 0, 7 days', c0);
  let H = hdr(tok0);
  t((await post('sth-job', { v: 1, op: 'status', jobs: [] }, H)).json.v === 8, 'hello says v 8 (with the new token)');

  console.log('[renew: JWT Auth in front, answers, headers]');
  let r = await renew(null); t(r.status === 401 && /No token/i.test(r.text), 'no Authorization header -> 401 No token provided (the workflow never runs)', [r.status, r.text]);
  r = await renew('garbage'); t(r.status === 403, 'garbage token -> 403', [r.status, r.text]);
  r = await renew(tok0); t(r.status === 200 && r.json && r.json.ok === false && errCode(r) === 'STH-AUTH-425' && reasonOf(r) === 'too_early' && r.json.error.retryable === false, 'a token under 1 h old -> 200 {ok:false, STH-AUTH-425 too_early}', r.text);
  t(r.headers.get('access-control-allow-origin') === ORIGIN && /no-store/.test(r.headers.get('cache-control') || ''), 'the refusal carries the CORS header and Cache-Control: no-store');
  const t0 = Date.now(); r = await renew(sign(v2())); const ms = Date.now() - t0;
  t(r.status === 200 && r.json.ok === true && typeof r.json.token === 'string' && r.json.token.split('.').length === 3 && typeof r.json.expiresAt === 'string' && typeof r.json.authExpiresAt === 'string' && Math.abs(r.json.now - Date.now()) < 5000, 'an old enough token is renewed: {ok:true, token, expiresAt, authExpiresAt, now}', r.text.slice(0, 200));
  t(r.headers.get('access-control-allow-origin') === ORIGIN && /no-store/.test(r.headers.get('cache-control') || ''), 'the success carries CORS and no-store');
  const old = v2(); r = await renew(sign(old)); const nc = dec(r.json.token);
  t(nc.v === 2 && nc.sub === 'sth' && nc.ac === 'sth' && nc.sid === old.sid && nc.auth_time === old.auth_time && nc.jti !== old.jti && nc.ep === 0 && nc.exp - nc.iat === 604800 && Math.abs(nc.iat - NOW()) < 5 && Object.keys(nc).sort().join() === 'ac,auth_time,ep,exp,iat,jti,sid,sub,v' && new Date(r.json.expiresAt).getTime() / 1000 === nc.exp && new Date(r.json.authExpiresAt).getTime() / 1000 === old.auth_time + 30 * DAY, 'the new token: same sid and auth_time, a new jti, iat = now, exp = now + 7 d', nc);
  t((await post('sth-job', { v: 1, op: 'status', jobs: [] }, hdr(r.json.token))).json.ok === true, 'n8n accepts the renewed token on /sth-job (it verifies with the same secret)');
  t(ms < 5000, 'a renewal answers quickly (every branch reaches a Respond node)', ms);
  r = await renew(sign(v2({ jti: crypto.randomUUID() })), { origin: 'https://evil.example' }); t(r.status === 200, 'a renewal from another origin is answered (CORS decides what the browser may read)');
  console.log('[renew: the cap]');
  const n = NOW();
  r = await renew(sign(v2({ auth_time: n - 26 * DAY, iat: n - 2 * DAY, exp: n - 26 * DAY + 30 * DAY + 120 }))); t(r.status === 200 && r.json.ok === false && errCode(r) === 'STH-INPUT-400', 'a token whose exp is beyond auth_time + 30 d is refused as unusable claims (STH-INPUT-400)', r.text);
  r = await renew(sign(v2({ auth_time: n - 25 * DAY, exp: n - 25 * DAY + 30 * DAY }))); t(r.json.ok === true && dec(r.json.token).exp === n - 25 * DAY + 30 * DAY, 'a chain 25 days old: the new exp is auth_time + 30 d (5 days), not now + 7 d', dec(r.json.token));
  r = await renew(sign(v2({ auth_time: n - (30 * DAY - 1800), iat: n - 2 * DAY, exp: n - (30 * DAY - 1800) + 30 * DAY }))); t(r.json.ok === false && errCode(r) === 'STH-AUTH-440' && reasonOf(r) === 'max_age', 'a chain in the last hour before the 30-day cap -> STH-AUTH-440 max_age', r.text);
  r = await renew(sign(v2({ auth_time: undefined }))); t(r.json.ok === false && errCode(r) === 'STH-INPUT-400' && reasonOf(r) === 'token', 'a v2 token WITHOUT auth_time is refused (it would restart the cap)', r.text);
  r = await renew(sign(v1({ auth_time: n - 60 * DAY }))); t(r.json.ok === false && errCode(r) === 'STH-INPUT-400', 'a v1 token that carries auth_time is refused');
  const o1 = v1(); r = await renew(sign(o1)); const c1 = r.json.ok && dec(r.json.token);
  t(c1 && c1.v === 2 && c1.auth_time === o1.iat && c1.ep === 0 && c1.sid.length === 36, 'a v1 token (what v7 minted) renews into v2 with auth_time = ITS iat (the cap does not restart)', c1);
  console.log('[renew: algorithm confusion, tampering, expiry (n8n)]');
  const good = v2();
  for (const [name, tok] of [
    ['alg none', sign(good, { alg: 'none' })], ['HS512 with the same secret', sign(good, { alg: 'HS512' })], ['HS384 with the same secret', sign(good, { alg: 'HS384' })],
    ['an RS256 header with an HS256 signature', sign(good, { header: { alg: 'RS256', typ: 'JWT' } })], ['signed with another secret', sign(good, { key: 'another-secret-another-secret-12345' })],
    ['a payload edited after signing (ep)', sign(good, { tamperPayload: { ...good, ep: 5 } })], ['a payload edited after signing (auth_time)', sign(good, { tamperPayload: { ...good, auth_time: NOW() } })],
    ['expired one second ago', sign(v2({ exp: NOW() - 1 }))], ['not valid yet (nbf in the future)', sign(v2({ nbf: NOW() + 3600 }))], ['an empty signature', sign(good).split('.').slice(0, 2).join('.') + '.'], ['two parts only', sign(good).split('.').slice(0, 2).join('.')],
  ]) {
    r = await renew(tok); const r2 = await post('sth-job', { v: 1, op: 'status', jobs: [] }, hdr(tok));
    t(r.status === 403 && r2.status === 403, `${name}: 403 on the renew path AND on /sth-job`, [r.status, r.text.slice(0, 80), r2.status]);
  }
  r = await renew(sign(v2({ exp: NOW() + 30 })));  t(r.status === 200, 'control: a token that expires in 30 s still passes n8n (the decision is ours)', r.status);
  t((await post('student-tools-renew', {}, { authorization: 'Bearer ' + sign(good), 'content-type': 'text/plain' })).status === 200, 'the request body and its type are ignored');

  console.log('[renew: the epoch auth:ep]');
  redis('SET', 'auth:ep', '1');
  r = await renew(sign(v2({ ep: 0 }))); t(r.json.ok === false && errCode(r) === 'STH-AUTH-441' && reasonOf(r) === 'revoked', 'after INCR auth:ep an older chain is refused: STH-AUTH-441 revoked', r.text);
  t((await post('sth-job', { v: 1, op: 'status', jobs: [] }, hdr(sign(v2({ ep: 0 })))))?.json?.ok === true, 'but the token itself keeps working until its own exp (only renewal stops)');
  r = await renew(sign(v2({ ep: 1 }))); t(r.json.ok === true && dec(r.json.token).ep === 1, 'a chain of epoch 1 renews (and keeps ep 1)');
  const s1 = await login('81.1.1.2'); t(dec(s1).ep === 1, 'a code sign-in now mints ep 1');
  redis('DEL', 'auth:ep'); r = await renew(sign(v2({ ep: 1 }))); t(r.json.ok === false && errCode(r) === 'STH-AUTH-441', 'auth:ep deleted: epoch-1 chains are refused (nothing is revived)', r.text);
  r = await renew(sign(v2({ ep: 0 }))); t(r.json.ok === true, 'and epoch-0 chains renew again: this is why the runbook says "never DEL auth:ep"');
  const E0 = (await execs()).length;
  redis('SET', 'auth:ep', 'abc'); r = await renew(sign(v2())); t(r.status === 200 && r.json.ok === false && errCode(r) === 'STH-AUTH-503' && reasonOf(r) === 'unavailable' && r.json.error.retryable === true && r.json.error.retryAfterMs === 1800000, 'auth:ep "abc": renewal unavailable (STH-AUTH-503), never revoked-forever', r.text);
  await sleep(1500);
  { const ex = (await execs()).slice(E0); const alarm = ex.find((e) => e.run && e.run['Renew Alarm']); t(!!alarm && alarm.status === 'error', 'the invalid epoch raised an error in "Renew Alarm" AFTER the answer was sent (the error workflow mails it)', ex.map((e) => [e.id, e.status, Object.keys(e.run)])); }
  let bad = await post('student-tools-auth', { code: 'letmein' }, { 'x-forwarded-for': '6.6.6.6, 81.1.1.3' }); t(bad.status === 503 && bad.json.error === 'unavailable', 'sign-in with the right code while auth:ep is "abc": 503, no token (never a silent epoch 0)', [bad.status, bad.text]);
  bad = await post('student-tools-auth', { code: 'wrong' }, { 'x-forwarded-for': '6.6.6.6, 81.1.1.3' }); t(bad.status === 401 && bad.json.error === 'invalid_code', 'a wrong code still answers 401 invalid_code (no oracle on auth:ep)');
  await sleep(1500); { const ex = (await execs()); t(ex.some((e) => e.run && e.run['Auth Alarm'] && e.status === 'error'), 'the sign-in alarm fired for the right code only'); }
  redis('SET', 'auth:ep', ' 1'); r = await renew(sign(v2())); t(errCode(r) === 'STH-AUTH-503', 'auth:ep " 1" (a space): unavailable');
  redis('DEL', 'auth:ep');
  r = await post('student-tools-auth', { code: 'letmein' }, { 'x-forwarded-for': '6.6.6.6, 81.1.1.4' }); t(r.status === 200 && dec(r.json.token).ep === 0, 'auth:ep absent: sign-in works again (ep 0)');

  console.log('[renew: breaker and fail closed]');
  redis('SET', hourKey(), '2000', 'EX', '7200'); r = await renew(sign(v2())); const edge = r.json.ok === false && reasonOf(r) === 'busy';
  t(edge && errCode(r) === 'STH-AUTH-503' && r.json.error.retryable === true, 'the 2001st renewal of the hour is refused: STH-AUTH-503 (busy), retry in 30 min', r.text);
  t(Number(redis('GET', hourKey())) >= 2001 && Number(redis('TTL', hourKey())) > 0 && Number(redis('TTL', hourKey())) <= 7200, 'the breaker key counts every call and expires in 2 h', redis('TTL', hourKey()));
  redis('DEL', hourKey());
  r = await renew(sign(v2())); t(r.json.ok === true, 'a new hour: renewal works again');
  await fetch(M + '/_down?on=1'); r = await renew(sign(v2())); const rs = await post('student-tools-auth', { code: 'letmein' }, { 'x-forwarded-for': '6.6.6.6, 81.1.1.5' }); await fetch(M + '/_down?on=0');
  t(r.status === 200 && r.json.ok === false && errCode(r) === 'STH-AUTH-503' && reasonOf(r) === 'unavailable', 'Redis down: renewal FAILS CLOSED (unavailable), a perfectly good token is not renewed', r.text);
  t(rs.status === 503, 'Redis down: sign-in fails closed too (503)', rs.status);
  console.log('[renew: CORS preflight]');
  r = await raw('OPTIONS', 'student-tools-renew', { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' });
  t((r.status === 204 || r.status === 200) && r.headers.get('access-control-allow-origin') === ORIGIN && /authorization/i.test(r.headers.get('access-control-allow-headers') || ''), 'preflight from the app origin: allowed, authorization header allowed', [r.status, [...r.headers.entries()].filter(([k]) => /access-control/.test(k))]);
  r = await raw('OPTIONS', 'student-tools-renew', { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' });
  t(!(r.headers.get('access-control-allow-origin') || '').includes('evil.example') && r.headers.get('access-control-allow-origin') !== '*', 'preflight from another origin: no Access-Control-Allow-Origin for it', r.headers.get('access-control-allow-origin'));
  if (process.argv[3] !== 'skip-extra-origin-checks') for (const p of ['student-tools-renew', 'student-tools-auth', 'sth-job', 'sth-job-start', 'student-tools-v2']) { r = await raw('OPTIONS', p, { origin: EXTRA, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' }); t(r.headers.get('access-control-allow-origin') !== EXTRA, `plain build: ${p} does not allow ${EXTRA}`); }

  console.log('[job pickup on real n8n: claim, result 409, ack, collected]');
  await reset(); H = hdr(await login('81.2.2.2'));
  const job = mkJob('tutor'); await create(job, tutorBody('hello'), H); let s = await waitState(job, H); t(s.state === 'succeeded', 'a tutor job succeeds', s);
  const N1 = crypto.randomBytes(32).toString('base64url'), N2 = crypto.randomBytes(32).toString('base64url');
  const cl = (j, nonce) => post('sth-job', { v: 1, op: 'claim', jobs: [{ id: j.id, key: j.key, nonce }] }, H);
  r = await cl(job, N1); t(r.json.ok === true && r.json.mode === 'tutor' && r.json.result && typeof r.json.result.result === 'string', 'claim: the answer and its mode', r.text.slice(0, 200));
  r = await cl(job, N2); t(r.json.ok === false && errCode(r) === 'STH-JOB-409' && reasonOf(r) === 'claimed', 'a second nonce: STH-JOB-409', r.text);
  r = await op('result', [job], H); t(errCode(r) === 'STH-JOB-409', '`result` inside the lease: STH-JOB-409 (the v7 way cannot bypass a claim)', r.text);
  r = await post('sth-job', { v: 1, op: 'ack', jobs: [{ id: job.id, key: job.key, nonce: N2 }] }, H); t(r.json.ok === true && r.json.acked.length === 0 && r.json.notYours.join() === job.id, 'ack with the other nonce: notYours', r.text);
  r = await post('sth-job', { v: 1, op: 'ack', jobs: [{ id: job.id, key: job.key, nonce: N1 }] }, H); t(r.json.ok === true && r.json.acked.join() === job.id, 'ack with the winner\'s nonce: acked', r.text);
  s = await op('status', [job], H); t(s.json.jobs[0].state === 'collected' && s.json.jobs[0].resultBytes === 0, 'status: collected', s.text);
  const rec = hgetall('sth:job:' + job.id); t(rec.st === 'collected' && !rec.cl && !rec.x && !rec.rb && !redis('EXISTS', 'sth:jobr:' + job.id).startsWith('1') && Number(redis('TTL', 'sth:job:' + job.id)) > 259000, 'the record is a contentless note (72 h); the answer is gone', rec);
  r = await create({ ...job, attempt: 2 }, tutorBody('hello'), H); await sleep(800); s = await op('status', [job], H);
  t(s.json.jobs[0].state === 'collected', 're-creating the job (attempt 2) does not re-run it: still collected (a duplicate)', s.text);
  t((await L.gcalls()).length === 1, 'one Gemini call only for this job (the duplicate was not re-run)', (await L.gcalls()).length);
  r = await cl(job, N1); t(r.json.ok === true && r.json.state === 'collected' && r.json.result === undefined, 'claim after collection: {state: collected}', r.text);
  r = await op('result', [job], H); t(errCode(r) === 'STH-JOB-404', 'result after collection: 404');
  r = await post('sth-job', { v: 1, op: 'claim', jobs: [{ id: job.id, key: job.key }] }, H); t(errCode(r) === 'STH-INPUT-400', 'claim without a nonce: STH-INPUT-400');
  // a cached v7 page: result + ack, no nonce
  const j2 = mkJob('tutor'); await create(j2, tutorBody('hello again'), H); await waitState(j2, H);
  r = await op('result', [j2], H); t(r.json.ok === true, 'unclaimed: `result` works (v7 page)'); r = await op('ack', [j2], H); t(r.json.ok === true && r.json.acked.join() === j2.id && hgetall('sth:job:' + j2.id).st === 'collected', 'unclaimed: v7-style ack -> collected');
}

async function extraSuite() {
  await reset();
  console.log('[extra-origin build: every webhook answers the second origin (review B1)]');
  const tok = await login('82.1.1.1'); const H = hdr(tok);
  for (const origin of [ORIGIN, EXTRA]) {
    for (const p of ['student-tools-renew', 'student-tools-auth', 'sth-job', 'sth-job-start', 'student-tools-v2']) {
      const r = await raw('OPTIONS', p, { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' });
      t(r.headers.get('access-control-allow-origin') === origin, `preflight ${p} from ${origin}: allowed`, r.headers.get('access-control-allow-origin'));
    }
    const r = await fetch(B + '/student-tools-renew', { method: 'POST', headers: { 'content-type': 'application/json', origin, authorization: 'Bearer ' + sign(v2()) }, body: '{"v":1}' });
    t(r.status === 200 && r.headers.get('access-control-allow-origin') === origin && (await r.json()).ok === true, `a renewal from ${origin} is answered with its own Access-Control-Allow-Origin`);
  }
  const r = await raw('OPTIONS', 'student-tools-renew', { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
  t(!(r.headers.get('access-control-allow-origin') || '').includes('evil'), 'a third origin is still refused');
  void H;
}

(async () => {
  if (process.argv[2] === 'extra') await extraSuite(); else await mainSuite();
  L.done('run-renew' + (process.argv[2] === 'extra' ? ' (extra origin)' : ''));
})().catch((e) => { console.error(e); process.exit(2); });
