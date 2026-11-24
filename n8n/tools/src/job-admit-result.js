// Background jobs: reads the answer of ADMIT. Only 'admitted' lets the run continue into the unchanged mode chains.
// Anything else (busy, off, duplicate, key mismatch, Redis unreachable) ends the run here: nothing is spent on Gemini.
const plan = $('Job - Plan').first().json;
const r = $input.first().json || {};
const outcome = Array.isArray(r.result) && typeof r.result[0] === 'string' ? r.result[0] : 'error';
const admitted = outcome === 'admitted';
return [{ json: { admitted, outcome, job: admitted ? plan.job : null } }];
