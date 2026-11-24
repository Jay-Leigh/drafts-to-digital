// Background jobs: a job run reached one of the four ends of the tutor / Studio chains. Works out what to store:
// the state, and (on success) exactly the answer the synchronous request would have returned. Stored errors hold
// a fixed code (and whitelisted reason / maxTokens) only, never request text or Gemini text.
const job = $('Job - Admit Result').first().json.job;
const r = $input.first().json || {};
const now = Date.now();
const TUTOR_MARKERS = { Busy: 'STH-AI-429', 'No reply': 'STH-AI-204', Blocked: 'STH-AI-451', 'Transcription blocked': 'STH-AI-452' };
let state = 'failed';
let err = { code: 'STH-SRV-500' };
if (r.ok === true) {
  state = 'succeeded';
} else if (r.ok === false && r.error && typeof r.error === 'object') {
  err = { code: r.error.code, reason: r.error.reason, maxTokens: r.error.maxTokens };
} else if (r.ok === undefined && typeof r.result === 'string') {
  const m = r.result.match(/^\[(Busy|No reply|Blocked|Transcription blocked)\]/);
  if (m) err = { code: TUTOR_MARKERS[m[1]] };
  else state = 'succeeded';
}
let text = '';
if (state === 'succeeded') {
  text = JSON.stringify(r);
  if (jobUtf8Len(text) > job.maxBytes) {
    state = 'failed';
    err = { code: 'STH-JOB-413' };
    text = '';
  }
}
return [{ json: jobStoreCall(job, state, err, text, now) }];
