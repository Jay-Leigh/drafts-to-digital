// Template/Reviewer: same output shape as the previous HTTP Request node (response format text -> {data}).
const SF_URL = $('Normalize Multipart Body').first().json.body.url;
try {
  const r = await safeFetch(SF_URL, {});
  if (r.statusCode >= 400) return [{ json: { error: 'HTTP ' + r.statusCode, statusCode: r.statusCode } }];
  return [{ json: { data: r.text } }];
} catch (e) {
  return [{ json: { error: e.sfCode ? e.message : 'Fetch failed', blocked: e.sfCode === 'blocked_url' } }];
}
