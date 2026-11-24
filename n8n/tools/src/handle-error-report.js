// Handle error reports from the frontend.
// Input: reply of "Error Rate Limit" (Redis INCR err:YYYYMMDD, {result: <count>}).
// Every interpolated value is redacted, cut to 300 chars and HTML-escaped.
// Over the daily cap (50) -> drop silently; the webhook still answers 200.
const MAX_PER_DAY = 50;
__ERR_LIB__
const rl = $input.first().json;
const count = Number(rl && rl.result);
if (!(Number.isFinite(count) && count >= 1 && count <= MAX_PER_DAY)) {
  return [{ json: { drop: true } }];
}

const body = $('Normalize Multipart Body').first().json.body || {};
const err = body.error && typeof body.error === 'object' ? body.error : {};

return [{
  json: {
    drop: false,
    to: 'jayleigh.dev@gmail.com',
    subject: `[Student Tools Hub Error] ${new Date().toISOString()}`,
    htmlBody: `
      <h2>Student Tools Hub — Error Report</h2>
      <p><strong>Timestamp:</strong> ${safe(body.timestamp)}</p>
      <p><strong>User Agent:</strong> ${safe(body.userAgent)}</p>
      <p><strong>User Message:</strong> ${safe(err.userMessage)}</p>
      <hr/>
      <h3>Technical Detail</h3>
      <pre style="background:#f4f4f4;padding:12px;border-radius:6px;font-size:13px;overflow-x:auto;">${safe(err.technicalDetail)}</pre>
    `
  }
}];
