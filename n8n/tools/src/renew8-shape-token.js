// Renew Endpoint step 5: the signed token, or a fixed unavailable answer when signing failed (the Respond node is always reached).
const t = $input.first().json && $input.first().json.token;
const e = $('Renew Evaluate').first().json;
if (typeof t !== 'string' || !t) return [{ json: { ok: false, reply: { ok: false, error: { code: 'STH-AUTH-503', retryable: true, retryAfterMs: 1800000, reason: 'unavailable' } } } }];
return [{ json: { ok: true, token: t, expiresAt: e.expiresAt, authExpiresAt: e.authExpiresAt, now: e.now } }];
