// Background jobs: a job execution threw (the workflow is its own error workflow). The Error Trigger knows only the
// execution id; "Job - Error Lookup" mapped it to `jobId|attempt|mode`. The code comes from the error message,
// which is read here and never stored.
const raw = $input.first().json.result;
const [id, attempt, mode] = String(raw).split('|');
const t = $('Error Trigger').first().json || {};
const ex = t.execution || {};
const err = ex.error || {};
const code = jobCodeFromMessage(err.message);
const job = { id, attempt: Number(attempt), mode, ttlS: 259200 };
return [{ json: jobStoreCall(job, 'failed', { code }, '', Date.now()) }];
