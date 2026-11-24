// Background jobs: shared helpers of "Job - Classify Outcome" and "Job - Error Outcome" (pure functions, no globals).
const JOB_CODE_RE = /^STH-[A-Z]{2,10}-\d{3}$/;
function jobUtf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
function jobDay(ms) { return new Date(ms).toISOString().slice(0, 10).replace(/-/g, ''); }
// Only a code with the fixed shape is ever stored; anything else becomes STH-SRV-500.
function jobCleanCode(c) { return typeof c === 'string' && JOB_CODE_RE.test(c) ? c : 'STH-SRV-500'; }
// The error code of a thrown error, taken from its message. The message itself is never stored.
function jobCodeFromMessage(msg) {
  const m = String(msg == null ? '' : msg);
  const code = m.match(/STH-[A-Z]{2,10}-\d{3}/);
  if (code) return code[0];
  // n8n reports a thrown Code error without the text before the first colon: "HTTP 500 mock failure [line 13]"
  const http = m.match(/^(?:Tutor Gemini failed: )?HTTP (\d{3})\b/);
  if (http && ['500', '503', '504'].includes(http[1])) return 'STH-AI-' + http[1];
  if (http && http[1] === '403') return 'STH-AI-403';
  if (/timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|connection was aborted/i.test(m)) return 'STH-AI-504';
  return 'STH-SRV-500';
}
// The arguments of the STORE script. state is 'succeeded' or 'failed'; err is {code, reason?, maxTokens?}; result is the JSON text.
function jobStoreCall(job, state, err, result, now) {
  const e = { code: jobCleanCode(err && err.code) };
  if (err && typeof err.reason === 'string' && /^[a-z0-9_]{1,40}$/.test(err.reason)) e.reason = err.reason;
  if (err && Number.isInteger(err.maxTokens) && err.maxTokens >= 0 && err.maxTokens <= 100000000) e.maxTokens = err.maxTokens;
  return {
    state,
    code: state === 'failed' ? e.code : '',
    keys: ['sth:job:' + job.id, 'sth:jobr:' + job.id, 'sth:jobs:run:' + job.mode, 'sth:jobs:n:' + jobDay(now)],
    argv: [job.attempt, state, state === 'failed' ? JSON.stringify(e) : '', state === 'succeeded' ? result : '', now, job.ttlS, job.id + ':' + job.attempt],
  };
}
