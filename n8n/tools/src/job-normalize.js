// Normalizes the request body (multipart "payload" field merged in). v4: a background job run enters here from
// "Job - Admitted?" and reads the original request straight from "Job Start Endpoint" (no extra copy of the body).
// The job record {id, attempt, mode, startedAt, deadlineAt} is added as `_job` at the TOP LEVEL of the item, which a
// client cannot set; `body.job` (the client's envelope) is removed, and the mode in the body must equal the job's mode.
const fromJob = $('Job Start Endpoint').isExecuted;
const item = fromJob ? $('Job Start Endpoint').first() : $input.first();
let body = item.json.body || {};

if (typeof body.payload === 'string') {
  let parsed;
  try {
    parsed = JSON.parse(body.payload);
  } catch (e) {
    // A job error must never carry a piece of the request: the parser message can quote it.
    if (fromJob) throw new Error('STH-INPUT-400 Malformed multipart "payload" field');
    throw new Error('Malformed multipart "payload" field: ' + e.message);
  }
  body = { ...body, ...parsed };
  delete body.payload;
}

let _job;
if (fromJob) {
  _job = $('Job - Admit Result').first().json.job;
  delete body.job;
  if (!_job || body.mode !== _job.mode) throw new Error('STH-INPUT-400 The job mode does not match the request');
}

return [{ json: { ...item.json, body, ...(_job ? { _job } : {}) }, binary: item.binary }];
