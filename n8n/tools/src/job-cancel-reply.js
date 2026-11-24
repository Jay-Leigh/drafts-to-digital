// Background jobs: answer to `cancel`: the state after the attempt. A job that already finished keeps its state
// (the client then fetches or discards the result); an unknown job or wrong key answers "unknown".
const plan = $('Job - Plan').first().json;
const rows = $input.all().map((i) => i.json);
if (rows.length !== plan.jobs.length || rows.some((r) => !r || typeof r.result !== 'string')) {
  return [{ json: { ok: false, error: { code: 'STH-SRV-503', retryable: true, retryAfterMs: 20000 } } }];
}
const states = plan.jobs.map((j, i) => ({ id: j.id, state: rows[i].result }));
return [{ json: { ok: true, state: states[0].state, jobs: states } }];
