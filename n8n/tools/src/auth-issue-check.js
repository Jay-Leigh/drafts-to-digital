// Auth Endpoint (match only): per-IP cap on SUCCESSFUL issuances, 20 per hour (key auth:ok:<ip>,
// never cleared). Input = reply of "Auth Issue Cap" ({result: <count in this hour>}).
const MAX_ISSUED_PER_HOUR = 20;
const n = Number(($input.first().json || {}).result);
if (!Number.isFinite(n) || n < 1) return [{ json: { outcome: 'unavailable' } }];
return [{ json: { outcome: n > MAX_ISSUED_PER_HOUR ? 'capped' : 'ok' } }];
