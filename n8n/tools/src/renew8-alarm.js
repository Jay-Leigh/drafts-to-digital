// After "Renew Respond Refused" (the answer is already sent): an invalid auth:ep raises ONE short error, which the error workflow mails to the
// owner (capped at 50 mails a day). Every other refusal passes silently.
const e = $('Renew Evaluate').first().json || {};
if (e.alarm === 'auth_ep_invalid') throw new Error('STH-AUTH renewal refused: the Upstash key auth:ep is not a whole number (fix it: runbook step 23)');
return [];
