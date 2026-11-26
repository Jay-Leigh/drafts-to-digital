// Renew Endpoint step 3: decide. Input = reply of "Renew Read Epoch" ({result: [<renewals this UTC hour>, <auth:ep or null>]}). Server time only.
// Rules in order: no Redis answer -> unavailable (fail closed); hourly breaker -> busy; unusable claims -> token; invalid auth:ep -> unavailable (+ alarm);
// epoch differs -> revoked; 30-day cap -> max_age; token younger than 1 h -> too_early; else ok. See the library above.
const prep = $('Renew Prepare').first().json.prep;
const out = renewDecide(prep, $input.first().json || {}, Date.now());
if (out.outcome === 'ok') return [{ json: { outcome: 'ok', claimsJson: JSON.stringify(out.claims), expiresAt: out.expiresAt, authExpiresAt: out.authExpiresAt, now: out.now, alarm: '' } }];
return [{ json: { outcome: 'refused', reason: out.reason, reply: out.reply, alarm: out.alarm || '' } }];
