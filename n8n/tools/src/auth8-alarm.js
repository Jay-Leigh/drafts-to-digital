// After "Auth Respond 503" (the answer is already sent): a configuration fault found during sign-in raises ONE short error, which the
// error workflow mails to the owner (capped at 50 mails a day). Any other 503 (Redis down, cap lookup failed) passes silently.
const e = $('Auth Evaluate').first().json || {};
if (e.alarm === 'auth_ep_invalid') throw new Error('STH-AUTH sign-in refused: the Upstash key auth:ep is not a whole number (fix it: runbook step 23)');
return [];
