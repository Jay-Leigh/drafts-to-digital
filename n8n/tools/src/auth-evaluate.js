// Auth Endpoint step 3: decide. Input = reply of "Auth Redis Attempt":
//   {result: [<stored access code or null>, <attempt count in this 10 min window>]}
// A failed lookup answers 'unavailable' (503). No path here throws.
const MAX_ATTEMPTS = 10;
const prep = $('Auth Prepare').first().json;
const r = $input.first().json || {};
if (!Array.isArray(r.result)) return [{ json: { outcome: 'unavailable' } }];
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
return [{ json: { outcome: match ? 'match' : 'mismatch', failKey: prep.failKey } }];
