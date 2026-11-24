// ── helpers: redact secrets, truncate, escape HTML ──
function redact(v) {
  return String(v == null ? '' : v)
    .replace(/(authorization["']?\s*[:=]\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted-token]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, '[redacted-jwt]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-key]')
    .replace(/((?:token|key|secret|password|passwd|authorization|auth|credential)s?["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_\-+\/=]{40,}/g, '[redacted-long]');
}
function cut(v, n) {
  const max = n || 300;
  let s = typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  s = redact(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const safe = (v) => esc(cut(v, 300));
