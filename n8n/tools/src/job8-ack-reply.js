// Background jobs: answer to `ack`. Per job the script returns 1 (collected / deleted), 2 (nothing of the caller's is stored), 0 (still running:
// not touched) or 3 (v8: the answer is claimed by ANOTHER nonce: left alone, the caller's lease was taken over). 1 and 2 count as acknowledged,
// so a repeated ack is harmless; 3 is listed in `notYours` so the client knows.
const plan = $('Job - Plan').first().json;
const rows = $input.all().map((i) => i.json);
if (rows.length !== plan.jobs.length || rows.some((r) => !r || typeof r.result !== 'number')) {
  return [{ json: { ok: false, error: { code: 'STH-SRV-503', retryable: true, retryAfterMs: 20000 } } }];
}
return [{ json: { ok: true, acked: plan.jobs.filter((j, i) => rows[i].result === 1 || rows[i].result === 2).map((j) => j.id), notYours: plan.jobs.filter((j, i) => rows[i].result === 3).map((j) => j.id) } }];
