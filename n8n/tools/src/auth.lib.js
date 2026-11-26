// v8 sign-in and renewal: ONE library for "Auth Evaluate", "Auth Build Claims" and "Renew Evaluate" (inlined by build.js), and for the
// browser-test fake (tests/lib/fake-n8n.js requires this very file). Pure functions: no network, no globals except the guarded crypto lookup.
//
// Claims of every token minted from v8 on:  {sub:'sth', sid, ac:'sth', v:2, jti, iat, exp, auth_time, ep}
//   sid = chain id (set at code entry, carried through renewals), jti = one per token, auth_time = seconds when the access code was last
//   entered (never changed by a renewal), ep = value of the Upstash key auth:ep at issue (absent key = 0).
// Renewal is stateless: exp = min(now + 7 d, auth_time + 30 d). Refused after the 30-day cap, when ep differs from auth:ep, or when
// the presented token is under RENEW_FLOOR_S old. Server time only.
const AUTH_TTL_S = 7 * 86400; // lifetime of one token
const AUTH_CAP_S = 30 * 86400; // hard cap since the access code was last entered
const AUTH_CAP_MARGIN_S = 3600; // a renewal within the last hour before the cap would give a useless token: refuse (max_age)
const RENEW_FLOOR_S = 3600; // a token younger than this is not renewed (too_early)
const RENEW_MAX_PER_HOUR = 2000; // global breaker: renewals counted per UTC hour in auth:rn:<yyyymmddhh>; above it every renewal is refused (unavailable)
const RENEW_RETRY_MS = 1800000; // what the client is told to wait after unavailable (30 min)
const AUTH_SKEW_S = 300; // a token may not be issued more than this far in the future
const EP_MAX = 999999999;

// The ONE normaliser of the epoch stored in Upstash (auth:ep). Absent (null / false / undefined) = 0. A whole number written as digits
// (1 to 9 of them) is a number. ANYTHING else (" 1", "abc", "-1", "1.5", "") is invalid: sign-in and renewal then answer unavailable.
function normEp(v) {
  if (v === null || v === undefined || v === false) return { ok: true, ep: 0 };
  if (typeof v === 'string' && /^[0-9]{1,9}$/.test(v)) return { ok: true, ep: Number(v) };
  return { ok: false };
}

function authNewId(rand) {
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (e) {}
  const r = typeof rand === 'function' ? rand : Math.random;
  const hex = (n) => { let s = ''; while (s.length < n) s += Math.floor(r() * 0x100000000).toString(16).padStart(8, '0'); return s.slice(0, n); };
  return hex(8) + '-' + hex(4) + '-4' + hex(3) + '-a' + hex(3) + '-' + hex(12);
}
const AUTH_SID_RE = /^[A-Za-z0-9-]{36}$/;

// Claims of a code sign-in (Auth Build Claims). ep = the validated epoch (a number).
function authSignInClaims(ep, nowMs, id) {
  const iat = Math.floor(nowMs / 1000);
  const jti = id || authNewId();
  return { sub: 'sth', sid: jti, ac: 'sth', v: 2, jti, iat, exp: iat + AUTH_TTL_S, auth_time: iat, ep };
}

// Strict, version-aware reading of the claims n8n verified (signature and exp only). Defence in depth against our own bugs and
// hand-made tokens. Anything unexpected is {ok:false} (answered STH-INPUT-400 / reason token). Never throws.
function renewPrepare(claims, nowMs) {
  const bad = { ok: false };
  const now = Math.floor(nowMs / 1000);
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return bad;
  const own = (k) => Object.prototype.hasOwnProperty.call(claims, k);
  const int = (v) => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 4e9;
  if (claims.sub !== 'sth') return bad;
  const iat = claims.iat, exp = claims.exp;
  if (!int(iat) || !int(exp) || iat < 1) return bad;
  if (exp - iat > AUTH_TTL_S + 60 || exp <= iat) return bad;
  if (iat > now + AUTH_SKEW_S) return bad;
  if (claims.v === 1) {
    // a v1 token (minted by v7 and before) carries no auth_time and no ep: the cap starts at its own iat (= the code entry), ep is 0.
    // A v1 token that DOES carry them was not minted by us.
    if (own('auth_time') || own('ep')) return bad;
    if (now - iat >= AUTH_CAP_S) return bad;
    const sid = typeof claims.sid === 'string' && AUTH_SID_RE.test(claims.sid) ? claims.sid : authNewId();
    return { ok: true, v: 1, sid, iat, exp, authTime: iat, ep: 0 };
  }
  if (claims.v === 2) {
    // a v2 token MUST carry them: a missing auth_time would silently restart the 30-day cap, so it is refused instead
    const at = claims.auth_time, ep = claims.ep;
    if (!int(at) || at < 1 || at > iat) return bad;
    if (now - at >= AUTH_CAP_S) return bad;
    if (exp > at + AUTH_CAP_S + 60) return bad;
    if (!int(ep) || ep < 0 || ep > EP_MAX) return bad;
    if (typeof claims.sid !== 'string' || !AUTH_SID_RE.test(claims.sid)) return bad;
    return { ok: true, v: 2, sid: claims.sid, iat, exp, authTime: at, ep };
  }
  return bad;
}

const AUTH_REFUSALS = {
  too_early: { code: 'STH-AUTH-425', retryable: false },
  max_age: { code: 'STH-AUTH-440', retryable: false },
  revoked: { code: 'STH-AUTH-441', retryable: false },
  unavailable: { code: 'STH-AUTH-503', retryable: true },
  busy: { code: 'STH-AUTH-503', retryable: true },
  token: { code: 'STH-INPUT-400', retryable: false },
};
function authRefusal(reason) {
  const r = AUTH_REFUSALS[reason] || AUTH_REFUSALS.unavailable;
  const error = { code: r.code, retryable: r.retryable };
  if (r.retryable) error.retryAfterMs = RENEW_RETRY_MS;
  error.reason = reason;
  return { ok: false, error };
}

// The decision. prep = renewPrepare(...) (or {ok:false}); reply = the Upstash answer of "Renew Read Epoch" ({result:[<renewals this hour>, <auth:ep or null>]});
// nowMs = server time. Rules in order: no Redis answer -> unavailable (fail closed); hourly breaker -> busy; unusable claims -> token;
// invalid auth:ep -> unavailable (+ alarm); ep differs -> revoked; 30-day cap -> max_age; token too young -> too_early; else ok with the new claims.
// Returns {outcome:'ok', claims, expiresAt, authExpiresAt, now} or {outcome:'refused', reason, reply, alarm?}.
function renewDecide(prep, reply, nowMs, id) {
  const now = Math.floor(nowMs / 1000);
  const refuse = (reason, alarm) => ({ outcome: 'refused', reason, reply: authRefusal(reason), ...(alarm ? { alarm } : {}) });
  const res = reply && typeof reply === 'object' ? reply.result : null;
  if (!Array.isArray(res) || res.length < 2) return refuse('unavailable');
  const n = res[0];
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return refuse('unavailable');
  if (n > RENEW_MAX_PER_HOUR) return refuse('busy');
  if (!prep || prep.ok !== true) return refuse('token');
  const stored = normEp(res[1]);
  if (!stored.ok) return refuse('unavailable', 'auth_ep_invalid');
  if (prep.ep !== stored.ep) return refuse('revoked');
  if (now - prep.authTime >= AUTH_CAP_S - AUTH_CAP_MARGIN_S) return refuse('max_age');
  if (now - prep.iat < RENEW_FLOOR_S) return refuse('too_early');
  const jti = id || authNewId();
  const exp = Math.min(now + AUTH_TTL_S, prep.authTime + AUTH_CAP_S);
  const claims = { sub: 'sth', sid: prep.sid, ac: 'sth', v: 2, jti, iat: now, exp, auth_time: prep.authTime, ep: stored.ep };
  return { outcome: 'ok', claims, expiresAt: new Date(exp * 1000).toISOString(), authExpiresAt: new Date((prep.authTime + AUTH_CAP_S) * 1000).toISOString(), now: nowMs };
}
// --- end AUTH LIB ---
if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign(module.exports || {}, { normEp, authNewId, authSignInClaims, renewPrepare, renewDecide, authRefusal, AUTH_TTL_S, AUTH_CAP_S, AUTH_CAP_MARGIN_S, RENEW_FLOOR_S, RENEW_MAX_PER_HOUR, RENEW_RETRY_MS, AUTH_SID_RE });
