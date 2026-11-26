// Auth Endpoint step 3 (v8): decide. Input = reply of "Auth Redis Attempt":
//   {result: [<stored access code or null>, <attempt count in this 10 min window>, <auth:ep or null>]}
// A failed lookup answers 'unavailable' (503). On a match the epoch is validated by the ONE shared normaliser (normEp): a stored auth:ep
// that is not a whole number answers 'unavailable' (and raises an alarm that mails the owner) instead of silently minting epoch 0.
// The epoch is only looked at on a match, so a wrong code gives the same answer whatever auth:ep holds. No path here throws.
const MAX_ATTEMPTS = 10;
const prep = $('Auth Prepare').first().json;
const r = $input.first().json || {};
if (!Array.isArray(r.result) || r.result.length !== 3) return [{ json: { outcome: 'unavailable' } }];
const stored = typeof r.result[0] === 'string' ? r.result[0].trim() : '';
const attempts = Number(r.result[1]);
if (!Number.isFinite(attempts)) return [{ json: { outcome: 'unavailable' } }];
if (attempts > MAX_ATTEMPTS) return [{ json: { outcome: 'blocked' } }];

// Constant-time comparison over the longer of the two strings.
const given = prep.code.trim();
const n = Math.max(given.length, stored.length, 1);
let diff = given.length ^ stored.length;
for (let i = 0; i < n; i++) diff |= (given.charCodeAt(i) || 0) ^ (stored.charCodeAt(i) || 0);
const match = diff === 0 && stored.length > 0 && !prep.codeTooLong;
if (!match) return [{ json: { outcome: 'mismatch', failKey: prep.failKey } }];
const ep = normEp(r.result[2]);
if (!ep.ok) return [{ json: { outcome: 'unavailable', alarm: 'auth_ep_invalid' } }];
return [{ json: { outcome: 'match', failKey: prep.failKey, ep: ep.ep } }];
