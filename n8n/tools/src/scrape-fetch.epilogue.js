// Scrape mode: same output shape as the previous HTTP Request node (full response, body as text).
const SF_URL = ($input.first().json.body || {}).url;
const SF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
try {
  const r = await safeFetch(SF_URL, SF_HEADERS);
  return [{ json: { statusCode: r.statusCode, statusMessage: r.statusMessage, headers: r.headers, body: r.text } }];
} catch (e) {
  return [{ json: { error: e.sfCode ? e.message : 'Fetch failed', blocked: e.sfCode === 'blocked_url' } }];
}
