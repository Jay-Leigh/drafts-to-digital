// Workflow error e-mail: workflow name, node name, execution id and a short,
// redacted message only. No JSON dump of the error object.
// Input = reply of "Workflow Error Rate Limit" (shared daily counter err:YYYYMMDD, max 50 e-mails/day
// across client error reports and workflow errors). Over the cap or counter unreadable -> drop silently.
const MAX_PER_DAY = 50;
__ERR_LIB__
const rl = $input.first().json;
const count = Number(rl && rl.result);
if (!(Number.isFinite(count) && count >= 1 && count <= MAX_PER_DAY)) {
  return [{ json: { drop: true } }];
}

const error = $('Error Trigger').first().json || {};
const wf = error.workflow || {};
const ex = error.execution || {};
const exErr = ex.error || {};
const nodeName = ex.lastNodeExecuted || (exErr.node && exErr.node.name) || 'N/A';
const subjectName = cut(wf.name || 'Unknown', 80).replace(/[\r\n]+/g, ' ');

return [{
  json: {
    drop: false,
    to: 'jayleigh.dev@gmail.com',
    subject: `[STH Workflow Error] ${subjectName} — ${new Date().toISOString()}`,
    htmlBody: `
      <h2>n8n Workflow Error — Student Tools Hub</h2>
      <p><strong>Workflow:</strong> ${safe(wf.name || 'N/A')}</p>
      <p><strong>Node:</strong> ${safe(nodeName)}</p>
      <p><strong>Execution ID:</strong> ${safe(ex.id || 'N/A')}</p>
      <p><strong>Message:</strong> ${safe(exErr.message || 'Unknown error')}</p>
    `
  }
}];
