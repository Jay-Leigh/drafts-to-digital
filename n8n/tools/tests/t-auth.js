// Unit tests for the v8 sign-in and token renewal (docs/design-signin-sync.md B + docs/review-signin-sync-BD.md B1-B11): the shared library
// (src/auth.lib.js, the code the fake in tests/lib/fake-n8n.js also uses), every new / changed Code node of sth-workflow-v8-bundle.json run
// through the n8n-like harness, and the two Redis scripts on a REAL Redis 7 (port 6391). Run: redis-server --port 6391 & node tests/t-auth.js
const fs = require('fs');
const path = require('path');
const { cmd } = require('./resp');
const { runCode, loadWorkflow, codeOf } = require('./harness');
const A = require('../src/auth.lib.js');
const R = (...a) => cmd(a.flat(), 6391);
let pass = 0, fail = 0;
const t = (c, name, extra) => { if (c) pass++; else { fail++; console.log('  FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); } };
const v8 = loadWorkflow('sth-workflow-v8-bundle.json');
const nodeOf = (n) => v8.nodes.find((x) => x.name === n);
const DAY = 86400, HOUR = 3600;
const NOW = 1800000000000; // ms; 2027-01-15
const S = Math.floor(NOW / 1000);
const SID = '11111111-2222-4333-8444-555555555555';
// a v2 token's claims, as n8n hands them to the workflow (jwtPayload)
const c2 = (o = {}) => ({ sub: 'sth', sid: SID, ac: 'sth', v: 2, jti: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', iat: S - 2 * DAY, exp: S + 5 * DAY, auth_time: S - 10 * DAY, ep: 0, ...o });
const c1 = (o = {}) => ({ sub: 'sth', sid: SID, ac: 'sth', v: 1, jti: SID, iat: S - 2 * DAY, exp: S + 5 * DAY, ...o });
const reply = (n = 1, ep = null) => ({ result: [n, ep] });
// a token whose code entry was `ago` seconds ago and whose exp respects the cap (as any token we mint does)
const aged = (ago, o = {}) => c2({ auth_time: S - ago, exp: Math.min(S + 5 * DAY, S - ago + 30 * DAY), ...o });
const dec = (claims, rep = reply(), now = NOW) => A.renewDecide(A.renewPrepare(claims, now), rep, now, 'new-id-new-id-new-id-new-id-new-id-');
const reason = (o) => (o.outcome === 'ok' ? 'ok' : o.reason);
const wipe = (c) => { const o = { ...c }; for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

(async () => {
  console.log('[normEp: one normaliser for the stored epoch]');
  for (const [v, want] of [[null, 0], [undefined, 0], [false, 0], ['0', 0], ['1', 1], ['42', 42], ['007', 7], ['999999999', 999999999]]) { const r = A.normEp(v); t(r.ok && r.ep === want, `normEp(${JSON.stringify(v)}) = ${want}`, r); }
  for (const v of [' 1', '1 ', 'abc', '-1', '1.5', '', '1e3', '1234567890', 1, 0, {}, [], true, 'NaN', '0x1', '+1', '١']) t(A.normEp(v).ok === false, `normEp(${JSON.stringify(v)}) is invalid`, A.normEp(v));

  console.log('[renewPrepare: strict, version-aware claims (review B9)]');
  let p = A.renewPrepare(c2(), NOW);
  t(p.ok && p.v === 2 && p.sid === SID && p.authTime === S - 10 * DAY && p.ep === 0 && p.iat === S - 2 * DAY, 'a good v2 token is read as it is', p);
  p = A.renewPrepare(c1(), NOW);
  t(p.ok && p.v === 1 && p.authTime === S - 2 * DAY && p.ep === 0 && p.sid === SID, 'a v1 token: the cap starts at its own iat (= the code entry), epoch 0, sid = its chain id', p);
  p = A.renewPrepare(c1({ sid: 'short', jti: 'short' }), NOW);
  t(p.ok && A.AUTH_SID_RE.test(p.sid) && p.sid !== 'short', 'a v1 token whose sid is not 36 characters gets a fresh chain id', p);
  const bads = {
    'null claims': null, 'string claims': 'x', 'array claims': [], 'empty object': {},
    'sub missing': c2({ sub: undefined }), 'sub other': c2({ sub: 'tester' }), 'sub number': c2({ sub: 1 }),
    'iat missing': c2({ iat: undefined }), 'iat string': c2({ iat: String(S - 2 * DAY) }), 'iat float': c2({ iat: S - 2 * DAY + 0.5 }), 'exp missing': c2({ exp: undefined }), 'exp NaN': c2({ exp: NaN }),
    'exp before iat': c2({ exp: S - 3 * DAY }), 'lifetime over 7 d + 60 s': c2({ exp: S - 2 * DAY + 7 * DAY + 61 }), 'iat 301 s in the future': c2({ iat: S + 301, exp: S + 301 + DAY, auth_time: S }),
    'v missing': c2({ v: undefined }), 'v 3': c2({ v: 3 }), 'v "2"': c2({ v: '2' }), 'v 0': c2({ v: 0 }),
    'v2 without auth_time (must NOT restart the cap)': c2({ auth_time: undefined }), 'v2 auth_time string': c2({ auth_time: String(S - 10 * DAY) }), 'v2 auth_time after iat': c2({ auth_time: S - DAY }), 'v2 auth_time 0': c2({ auth_time: 0 }), 'v2 auth_time float': c2({ auth_time: S - 10 * DAY + 0.1 }),
    'v2 auth_time 30 days ago (past the cap)': c2({ auth_time: S - 30 * DAY, iat: S - 3 * DAY, exp: S + 2 * DAY }), 'v2 exp beyond auth_time + 30 d': c2({ auth_time: S - 29 * DAY, exp: S + 2 * DAY, iat: S - 5 * DAY }),
    'v2 without ep': c2({ ep: undefined }), 'v2 ep string': c2({ ep: '0' }), 'v2 ep negative': c2({ ep: -1 }), 'v2 ep float': c2({ ep: 1.5 }), 'v2 ep too large': c2({ ep: 1e9 }), 'v2 ep null': c2({ ep: null }),
    'v2 without sid': c2({ sid: undefined }), 'v2 sid 35 chars': c2({ sid: SID.slice(1) }), 'v2 sid 37 chars': c2({ sid: SID + 'x' }), 'v2 sid with a space': c2({ sid: SID.slice(0, 35) + ' ' }), 'v2 sid object': c2({ sid: {} }),
    'v1 carrying auth_time (smuggled)': c1({ auth_time: S - 40 * DAY }), 'v1 carrying ep': c1({ ep: 0 }), 'v1 older than the cap': c1({ iat: S - 31 * DAY, exp: S - 24 * DAY }),
  };
  for (const [name, claims] of Object.entries(bads)) t(A.renewPrepare(claims, NOW).ok === false, `bad claims refused: ${name}`, claims && wipe(claims));
  { const polluted = JSON.parse('{"sub":"sth","v":2,"iat":' + (S - 2 * DAY) + ',"exp":' + (S + 5 * DAY) + ',"auth_time":' + (S - 10 * DAY) + ',"ep":0,"sid":"' + SID + '","__proto__":{"ep":9}}');
    p = A.renewPrepare(polluted, NOW); t(p.ok && p.ep === 0 && ({}).ep === undefined, 'a __proto__ key in the claims changes nothing', p); }

  console.log('[renewDecide: the rules, in order]');
  let o = dec(c2());
  const lt = (x) => x.claims.exp - x.claims.iat;
  t(o.outcome === 'ok' && o.claims.sub === 'sth' && o.claims.ac === 'sth' && o.claims.v === 2 && o.claims.sid === SID && o.claims.auth_time === S - 10 * DAY && o.claims.ep === 0 && o.claims.iat === S && o.claims.exp === S + 7 * DAY && o.claims.jti === 'new-id-new-id-new-id-new-id-new-id-' && Object.keys(o.claims).sort().join() === 'ac,auth_time,ep,exp,iat,jti,sid,sub,v', 'ok: sid and auth_time carried, new jti, iat = now, exp = now + 7 d, v 2', o);
  t(o.expiresAt === new Date((S + 7 * DAY) * 1000).toISOString() && o.authExpiresAt === new Date((S - 10 * DAY + 30 * DAY) * 1000).toISOString() && o.now === NOW, 'ok: expiresAt, authExpiresAt (auth_time + 30 d) and now');
  o = dec(aged(28 * DAY));
  t(o.outcome === 'ok' && o.claims.exp === S - 28 * DAY + 30 * DAY && lt(o) === 2 * DAY, 'ok near the cap: exp = auth_time + 30 d, not now + 7 d (the cap wins)', o.claims);
  o = dec(aged(30 * DAY - HOUR - 1));
  t(o.outcome === 'ok' && o.claims.exp === S + HOUR + 1, 'edge: 1 s before the last-hour margin still renews (a token of 1 h + 1 s)', o.claims);
  t(reason(dec(aged(30 * DAY - HOUR))) === 'max_age', 'edge: exactly 30 d - 1 h since the code entry -> max_age');
  t(reason(dec(aged(29 * DAY + 23 * HOUR + 1800))) === 'max_age', 'capped (29 d 23 h 30 min) -> max_age');
  o = dec(c2({ auth_time: S - 30 * DAY, iat: S - 3 * DAY, exp: S + 2 * DAY })); t(reason(o) === 'token', 'past the cap (30 d) with a still-valid exp: unusable claims (never renewed)', o);
  // the same capped token on the wire
  o = dec(aged(29 * DAY + 23 * HOUR + 1800)); t(o.outcome === 'refused' && o.reply.error.code === 'STH-AUTH-440' && o.reply.error.retryable === false && o.reply.error.reason === 'max_age' && !o.alarm, 'max_age answer: STH-AUTH-440, not retryable', o.reply);
  // epoch
  t(reason(dec(c2({ ep: 0 }), reply(1, '1'))) === 'revoked' && dec(c2({ ep: 0 }), reply(1, '1')).reply.error.code === 'STH-AUTH-441', 'wrong epoch: token 0, stored 1 -> revoked (STH-AUTH-441)');
  t(reason(dec(c2({ ep: 1 }), reply(1, null))) === 'revoked', 'wrong epoch: token 1, auth:ep absent (deleted / evicted) -> revoked (every legitimate chain is refused, none is revived)');
  t(reason(dec(c2({ ep: 2 }), reply(1, '3'))) === 'revoked' && reason(dec(c2({ ep: 3 }), reply(1, '2'))) === 'revoked', 'wrong epoch both ways');
  o = dec(c2({ ep: 1 }), reply(1, '1')); t(o.outcome === 'ok' && o.claims.ep === 1, 'matching epoch 1: ok, the new token carries ep 1');
  o = dec(c2({ ep: 7 }), reply(1, '007')); t(o.outcome === 'ok' && o.claims.ep === 7, 'stored "007" is the number 7 (one normaliser for sign-in and renewal)');
  o = dec(c1(), reply(1, '1')); t(reason(o) === 'revoked', 'a v1 token (epoch 0) after the owner bumped auth:ep -> revoked (the safe direction)');
  o = dec(c1(), reply(1, null)); t(o.outcome === 'ok' && o.claims.v === 2 && o.claims.ep === 0 && o.claims.auth_time === S - 2 * DAY && o.claims.sid === SID, 'a v1 token renews into v2 with auth_time = its own iat: the 30-day cap does NOT restart', o.claims);
  { const old = c1({ iat: S - 6 * DAY, exp: S + DAY }); o = dec(old); t(o.outcome === 'ok' && o.claims.auth_time === S - 6 * DAY && o.claims.exp === S + 7 * DAY, 'v1 token of 6 days: auth_time = its iat (6 days ago), not now', o.claims); }
  // invalid auth:ep
  for (const v of [' 1', 'abc', '-1', '1.5', '', '1e3', '1234567890']) { o = dec(c2(), reply(1, v)); t(o.outcome === 'refused' && o.reason === 'unavailable' && o.alarm === 'auth_ep_invalid' && o.reply.error.code === 'STH-AUTH-503' && o.reply.error.retryable === true, `auth:ep ${JSON.stringify(v)} -> unavailable + alarm (never "revoked forever", never a silent 0)`, o); }
  // Redis failure: fail closed
  for (const bad of [null, {}, { error: 'down' }, { result: null }, { result: 'x' }, { result: [] }, { result: [1] }, { result: ['1', null] }, { result: [0, null] }, { result: [NaN, null] }, { result: [-1, null] }]) {
    o = A.renewDecide(A.renewPrepare(c2(), NOW), bad, NOW); t(o.outcome === 'refused' && o.reason === 'unavailable' && o.reply.error.code === 'STH-AUTH-503' && o.reply.error.retryable === true && o.reply.error.retryAfterMs === 1800000 && !o.alarm, `Redis failure ${JSON.stringify(bad)} fails closed (unavailable, retry in 30 min), even for a good token`, o);
  }
  t(reason(A.renewDecide(A.renewPrepare(null, NOW), { error: 'down' }, NOW)) === 'unavailable' && reason(A.renewDecide(undefined, undefined, NOW)) === 'unavailable', 'Redis failure beats unusable claims');
  // too early
  t(reason(dec(c2({ iat: S - 3599 }))) === 'too_early' && dec(c2({ iat: S - 3599 })).reply.error.code === 'STH-AUTH-425', 'token 3599 s old -> too_early (STH-AUTH-425)');
  t(reason(dec(c2({ iat: S - 3600 }))) === 'ok', 'token 3600 s old renews');
  t(reason(dec(c2({ iat: S + 200, exp: S + 200 + DAY, auth_time: S }))) === 'too_early', 'a token 200 s in the future (inside the 300 s skew) is too_early, not ok');
  t(reason(dec(c2({ iat: S - 100, auth_time: S - 100, exp: S + 7 * DAY - 100 }))) === 'too_early', 'a fresh token (100 s) is too_early');
  // priority order
  t(reason(dec(aged(29 * DAY + 23 * HOUR + 1800, { ep: 0, iat: S - 100 }), reply(1, '1'))) === 'revoked', 'order: revoked before max_age and too_early');
  t(reason(dec(aged(29 * DAY + 23 * HOUR + 1800, { iat: S - 100 }))) === 'max_age', 'order: max_age before too_early');
  t(reason(dec(c2({ ep: 5 }), reply(2001, '1'))) === 'busy', 'order: the hourly breaker beats everything after it');
  t(reason(dec(c2({ sub: 'x' }), reply(1, null))) === 'token' && dec(c2({ sub: 'x' }), reply(1, null)).reply.error.code === 'STH-INPUT-400', 'unusable claims -> STH-INPUT-400 (reason token)');
  // breaker
  t(reason(dec(c2(), reply(2000, null))) === 'ok' && reason(dec(c2(), reply(2001, null))) === 'busy' && dec(c2(), reply(2001, null)).reply.error.code === 'STH-AUTH-503' && dec(c2(), reply(2001, null)).reply.error.retryAfterMs === 1800000, 'replay budget: the 2000th renewal of the hour passes, the 2001st is refused (STH-AUTH-503, retry 30 min)');
  // property: a chain renewed once a day never outlives auth_time + 30 d and always ends at the cap
  { let claims = c2({ iat: S - 2 * DAY - 1, exp: S + 5 * DAY, auth_time: S - 2 * DAY - 1 }); const at0 = claims.auth_time; let last = -1, firstRefusal = null, ok = 0, maxExp = 0, nowS = S;
    for (let d = 0; d <= 45; d++) { const nowMs = (S + d * DAY) * 1000; nowS = S + d * DAY; const r = A.renewDecide(A.renewPrepare(claims, nowMs), reply(1, null), nowMs, 'x'.repeat(36));
      if (nowS >= claims.exp) { if (!firstRefusal) firstRefusal = 'expired day ' + d; break; }
      if (r.outcome === 'ok') { ok++; last = d; claims = r.claims; maxExp = Math.max(maxExp, claims.exp); t(claims.auth_time === at0 && claims.exp <= at0 + 30 * DAY && claims.exp - claims.iat <= 7 * DAY, `chain day ${d}: auth_time unchanged, exp <= auth_time + 30 d, lifetime <= 7 d`, claims); }
      else { firstRefusal = firstRefusal || r.reason + ' day ' + d; if (r.reason !== 'max_age' && r.reason !== 'token') t(false, 'unexpected refusal in the chain', r); } }
    t(ok >= 25 && maxExp === at0 + 30 * DAY && /max_age|token|expired/.test(firstRefusal), 'a chain renewed daily: no chain outlives auth_time + 30 d, it ends by max_age / expiry', { ok, last, firstRefusal, maxExp, at0 }); }

  console.log('[built nodes of the v8 bundle]');
  // Auth Evaluate
  const aeCode = codeOf(v8, 'Auth Evaluate');
  const P = (code, extra = {}) => ({ code, codeTooLong: false, failKey: 'auth:fail:1.1.1.1', ...extra });
  const ev = async (prep, result) => (await runCode(aeCode, { input: [{ json: result }], nodes: { 'Auth Prepare': [{ json: prep }] } }))[0].json;
  let r = await ev(P('secret'), { result: ['secret', 1, null] }); t(r.outcome === 'match' && r.ep === 0 && r.failKey === 'auth:fail:1.1.1.1', 'Auth Evaluate: match, auth:ep absent = epoch 0', r);
  r = await ev(P('secret'), { result: ['secret', 1, '4'] }); t(r.outcome === 'match' && r.ep === 4, 'Auth Evaluate: match carries the stored epoch', r);
  for (const v of [' 1', 'abc', '-1', '', '1.5']) { r = await ev(P('secret'), { result: ['secret', 1, v] }); t(r.outcome === 'unavailable' && r.alarm === 'auth_ep_invalid' && r.ep === undefined, `Auth Evaluate: right code + invalid auth:ep ${JSON.stringify(v)} -> unavailable + alarm, no token`, r); }
  { const same = JSON.stringify(await ev(P('bad'), { result: ['secret', 1, 'abc'] })), other = JSON.stringify(await ev(P('bad'), { result: ['secret', 1, '3'] })); t(same === other && JSON.parse(same).outcome === 'mismatch' && !JSON.parse(same).alarm, 'a WRONG code gives the same answer whatever auth:ep holds (no oracle on the configuration)'); }
  r = await ev(P('bad'), { result: ['secret', 11, 'abc'] }); t(r.outcome === 'blocked', 'blocked still comes first');
  for (const [code, n] of [['secret', 1], ['bad', 1], ['bad', 11]]) for (const bad of [{ result: ['secret', n] }, { result: ['secret', n, null, null] }, { result: 'str' }, { error: 'x' }, {}, null]) { r = await ev(P(code), bad); t(r.outcome === 'unavailable', `Auth Evaluate: a reply that is not [code, count, ep] (${JSON.stringify(bad)}) -> unavailable`, r); }
  t((await ev(P('Secret'), { result: ['secret', 1, null] })).outcome === 'mismatch' && (await ev(P(''), { result: ['', 1, null] })).outcome === 'mismatch' && (await ev(P('x'), { result: [null, 1, null] })).outcome === 'mismatch', 'Auth Evaluate: case, empty-equals-empty and missing code behave as in v1');
  // Auth Build Claims
  const bcCode = codeOf(v8, 'Auth Build Claims');
  const mk = async (ep) => (await runCode(bcCode, { nodes: { 'Auth Evaluate': [{ json: { outcome: 'match', ep } }] } }))[0].json;
  const cl = []; for (let i = 0; i < 200; i++) cl.push(await mk(i % 3));
  const parsed = cl.map((x) => JSON.parse(x.claimsJson));
  t(parsed.every((c, i) => c.sub === 'sth' && c.sid === c.jti && c.ac === 'sth' && c.v === 2 && c.exp - c.iat === 604800 && c.auth_time === c.iat && c.ep === i % 3 && A.AUTH_SID_RE.test(c.jti) && Object.keys(c).sort().join() === 'ac,auth_time,ep,exp,iat,jti,sid,sub,v'), 'Auth Build Claims: {sub, sid = jti (36 chars), ac, v 2, jti, iat, exp = iat + 7 d, auth_time = iat, ep}', parsed[0]);
  t(new Set(parsed.map((c) => c.jti)).size === 200 && Math.abs(parsed[0].iat - Date.now() / 1000) < 3 && Math.abs(new Date(cl[0].expiresAt).getTime() / 1000 - parsed[0].exp) < 1, '200 distinct jti, iat is now, expiresAt = exp');
  for (const bad of [-1, 1.5, '1', null, undefined, 1e9]) { const x = await mk(bad); t(x.claimsJson === '' && x.expiresAt === '', `Auth Build Claims: epoch ${JSON.stringify(bad)} -> nothing to sign (fails closed)`); }
  // a minted token renews (round trip through the built nodes)
  { const mint = JSON.parse((await mk(0)).claimsJson); const later = (mint.iat + 2 * DAY) * 1000;
    const prepNode = codeOf(v8, 'Renew Prepare'), evNode = codeOf(v8, 'Renew Evaluate');
    const prep = (await runCode(prepNode, { input: [{ json: { headers: {}, body: {}, jwtPayload: mint } }] }))[0].json.prep;
    t(prep.ok === true && prep.v === 2 && prep.authTime === mint.iat && prep.sid === mint.sid, 'Renew Prepare reads a freshly minted v2 token', prep);
    const out = (await runCode(`Date.now = () => ${later};\n` + evNode, { input: [{ json: { result: [3, null] } }], nodes: { 'Renew Prepare': [{ json: { prep: { ...prep, iat: mint.iat } } }] } }))[0].json;
    t(out.outcome === 'ok' && JSON.parse(out.claimsJson).auth_time === mint.iat && JSON.parse(out.claimsJson).sid === mint.sid, 'sign-in token -> renewal two days later keeps sid and auth_time', out); }

  // Renew Prepare / Evaluate / Shape Token / alarms through the harness
  const rp = async (jwtPayload) => (await runCode(codeOf(v8, 'Renew Prepare'), { input: [{ json: { headers: {}, body: { v: 1, junk: 'x' }, jwtPayload } }] }))[0].json.prep;
  t((await rp(undefined)).ok === false && (await rp(null)).ok === false && (await rp('x')).ok === false, 'Renew Prepare: a request WITHOUT jwtPayload (no JWT in front) is never renewed');
  t((await rp(c2({ iat: Math.floor(Date.now() / 1000) - 2 * DAY, exp: Math.floor(Date.now() / 1000) + 5 * DAY, auth_time: Math.floor(Date.now() / 1000) - 3 * DAY }))).ok === true, 'Renew Prepare: the body is ignored; good claims are read');
  const re = async (prep, result, nowMs = NOW) => (await runCode(`Date.now = () => ${nowMs};\n` + codeOf(v8, 'Renew Evaluate'), { input: [{ json: result }], nodes: { 'Renew Prepare': [{ json: { prep } }] } }))[0].json;
  r = await re(A.renewPrepare(c2(), NOW), { result: [1, null] });
  t(r.outcome === 'ok' && typeof r.claimsJson === 'string' && JSON.parse(r.claimsJson).exp === S + 7 * DAY && r.alarm === '' && /^\d{4}-/.test(r.expiresAt) && /^\d{4}-/.test(r.authExpiresAt) && r.now === NOW, 'Renew Evaluate (node): ok carries claimsJson, expiresAt, authExpiresAt, now', r);
  r = await re(A.renewPrepare(c2(), NOW), { result: [1, 'abc'] }); t(r.outcome === 'refused' && r.reason === 'unavailable' && r.alarm === 'auth_ep_invalid' && r.reply.error.code === 'STH-AUTH-503', 'Renew Evaluate (node): invalid auth:ep -> refused + alarm', r);
  r = await re(A.renewPrepare(c2(), NOW), { error: { message: 'timeout' } }); t(r.outcome === 'refused' && r.reason === 'unavailable' && r.alarm === '', 'Renew Evaluate (node): Redis error output (continueRegularOutput) fails closed', r);
  r = await re({ ok: false }, { result: [1, null] }); t(r.outcome === 'refused' && r.reason === 'token' && r.reply.error.code === 'STH-INPUT-400', 'Renew Evaluate (node): unusable claims -> STH-INPUT-400', r);
  const shape = async (tok, ev2 = { expiresAt: 'E', authExpiresAt: 'A', now: 5 }) => (await runCode(codeOf(v8, 'Renew Shape Token'), { input: [{ json: tok }], nodes: { 'Renew Evaluate': [{ json: ev2 }] } }))[0].json;
  r = await shape({ token: 'a.b.c' }); t(r.ok === true && r.token === 'a.b.c' && r.expiresAt === 'E' && r.authExpiresAt === 'A' && r.now === 5, 'Renew Shape Token: ok');
  for (const bad of [{ error: 'x' }, {}, { token: '' }, { token: 5 }]) { r = await shape(bad); t(r.ok === false && r.reply.error.code === 'STH-AUTH-503' && r.reply.error.retryable === true, `Renew Shape Token: signing failed ${JSON.stringify(bad)} -> a fixed unavailable answer (a Respond node is always reached)`); }
  const throws = async (name, nodes) => { try { await runCode(codeOf(v8, name), { nodes }); return false; } catch (e) { return /auth:ep/.test(e.message) && e.message.length < 200 ? e.message : 'other:' + e.message; } };
  t(await throws('Renew Alarm', { 'Renew Evaluate': [{ json: { alarm: 'auth_ep_invalid' } }] }), 'Renew Alarm throws one short message for an invalid auth:ep');
  t((await runCode(codeOf(v8, 'Renew Alarm'), { nodes: { 'Renew Evaluate': [{ json: { alarm: '' } }] } })).length === 0, 'Renew Alarm stays quiet for every other refusal');
  t(await throws('Auth Alarm', { 'Auth Evaluate': [{ json: { alarm: 'auth_ep_invalid' } }] }), 'Auth Alarm throws one short message for an invalid auth:ep');
  t((await runCode(codeOf(v8, 'Auth Alarm'), { nodes: { 'Auth Evaluate': [{ json: { outcome: 'unavailable' } }] } })).length === 0, 'Auth Alarm stays quiet for a plain 503 (Redis down)');
  t(!/eyJ|token|Bearer|secret/i.test(JSON.stringify(['Renew Alarm', 'Auth Alarm'].map((n) => codeOf(v8, n)))), 'alarms mention no token');

  console.log('[Redis scripts on a real Redis 7]');
  await R('FLUSHALL');
  const attemptBody = nodeOf('Auth Redis Attempt').parameters.jsonBody;
  const evalExpr = (expr, $json = {}) => new Function('$json', '"use strict"; return (' + expr.slice(3, -2) + ');')($json);
  let ac = evalExpr(attemptBody, { failKey: 'auth:fail:1.2.3.4' });
  t(ac[0] === 'EVAL' && ac[2] === '3' && ac[3] === 'auth:code' && ac[4] === 'auth:fail:1.2.3.4' && ac[5] === 'auth:ep' && ac[6] === '600', 'Auth Redis Attempt command: 3 keys (auth:code, auth:fail:<ip>, auth:ep), EX 600', ac.slice(2));
  const run = (c) => R(c);
  await R('SET', 'auth:code', 'letmein');
  let a1 = await run(ac); t(Array.isArray(a1) && a1.length === 3 && a1[0] === 'letmein' && a1[1] === 1 && a1[2] === null, 'sign-in script: [code, 1, null] when auth:ep is absent (3 elements survive the Lua nil / false)', a1);
  await R('SET', 'auth:ep', '3'); a1 = await run(ac); t(a1.length === 3 && a1[1] === 2 && a1[2] === '3', 'sign-in script returns auth:ep as the third element', a1);
  await R('DEL', 'auth:code'); a1 = await run(ac); t(a1.length === 3 && a1[0] === null && a1[2] === '3', 'no access code: [null, n, "3"]', a1);
  { const ttl = await R('TTL', 'auth:fail:1.2.3.4'); t(ttl > 590 && ttl <= 600, 'the attempt window is still 600 s', ttl); }
  await R('SET', 'auth:ep', 'abc'); a1 = await run(ac); t(a1[2] === 'abc', 'junk in auth:ep is passed on as it is (the Code node refuses it)', a1);
  t((await R('GET', 'auth:ep')) === 'abc', 'the script never writes auth:ep');
  await R('FLUSHALL');
  const hourExpr = (await R('TIME')) && nodeOf('Renew Read Epoch').parameters.jsonBody;
  const rc = evalExpr(hourExpr);
  t(rc[0] === 'EVAL' && rc[2] === '2' && /^auth:rn:\d{10}$/.test(rc[3]) && rc[4] === 'auth:ep' && rc[5] === '7200' && rc[3] === 'auth:rn:' + new Date().toISOString().slice(0, 13).replace(/\D/g, ''), 'Renew Read Epoch command: breaker key auth:rn:<yyyymmddhh>, auth:ep, 7200 s', rc.slice(2));
  let x = await run(rc); t(Array.isArray(x) && x[0] === 1 && x[1] === null, 'renew script: [1, null] (first renewal this hour, auth:ep absent)', x);
  { const ttl = await R('TTL', rc[3]); t(ttl > 7100 && ttl <= 7200, 'breaker key expires after 2 h', ttl); }
  await R('SET', 'auth:ep', '2'); x = await run(rc); t(x[0] === 2 && x[1] === '2', 'renew script counts and reads the epoch in one call', x);
  await R('EXPIRE', rc[3], 1000); await run(rc); t((await R('TTL', rc[3])) <= 1000, 'the expiry is set once (a fixed window), later renewals do not extend it');
  // replay budget with the real script + the real decision
  await R('SET', rc[3], '1995'); await R('SET', 'auth:ep', '0');
  const outs = []; for (let i = 0; i < 10; i++) { const rep = { result: await run(rc) }; outs.push(reason(A.renewDecide(A.renewPrepare(c2(), NOW), rep, NOW))); }
  t(outs.join() === 'ok,ok,ok,ok,ok,busy,busy,busy,busy,busy', 'replay budget end to end: renewals 1996-2000 pass, 2001 onwards are refused (busy)', outs);
  await R('DEL', rc[3]); await R('DEL', 'auth:ep');
  // a hand-typed value in Redis end to end
  for (const bad of [' 1', 'abc']) { await R('SET', 'auth:ep', bad); const rep = { result: await run(rc) }; t(reason(A.renewDecide(A.renewPrepare(c2(), NOW), rep, NOW)) === 'unavailable', `end to end: auth:ep ${JSON.stringify(bad)} -> unavailable`); }
  // Redis failure is an error output
  t(reason(A.renewDecide(A.renewPrepare(c2(), NOW), { error: 'connect ETIMEDOUT' }, NOW)) === 'unavailable', 'Redis unreachable: fails closed');
  await R('FLUSHALL');

  console.log('[wiring and no secrets]');
  const re5 = nodeOf('Renew Endpoint');
  t(re5.parameters.authentication === 'jwtAuth' && re5.parameters.responseMode === 'responseNode', 'Renew Endpoint requires the JWT (a missing / garbage / expired token never reaches the workflow)');
  const src = [codeOf(v8, 'Renew Prepare'), codeOf(v8, 'Renew Evaluate'), codeOf(v8, 'Auth Evaluate'), codeOf(v8, 'Auth Build Claims')].join('\n');
  t(!/process\.|require\(|fetch\(|console\.log|Authorization|Bearer|headers\.authorization/i.test(src.replace(/\/\/.*$/gm, '')), 'the renewal code never touches the Authorization header, the token text or the console (nothing to leak into a mail)');
  t(!/auth:code/.test(codeOf(v8, 'Renew Evaluate')) && !/GET.*auth:code/.test(nodeOf('Renew Read Epoch').parameters.jsonBody), 'renewal never reads the access code');
  console.log(`\nt-auth: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
