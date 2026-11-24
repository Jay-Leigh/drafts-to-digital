// ── SAFE FETCH (shared logic, identical in the three scrape nodes) ──────────
// Validates the target, resolves DNS over HTTPS (dns.google) and refuses any
// private / loopback / link-local / ULA answer, then fetches with redirects
// followed MANUALLY (max 5 hops, every hop re-validated and re-resolved).
const sfHelpers = this.helpers;
const SF_MAX_HOPS = 5;
const SF_TIMEOUT_MS = 20000;
const SF_DOH_TIMEOUT_MS = 5000;
const SF_DEADLINE_MS = 45000;
const SF_MAX_BYTES = 4 * 1024 * 1024;
const SF_DOH = 'https://dns.google/resolve';
const SF_STARTED = Date.now();

function sfErr(code, message) {
  const e = new Error(message);
  e.sfCode = code;
  return e;
}

function sfParseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.some((n) => n > 255) ? null : o;
}

function sfPrivateV4(o) {
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true; // 0/8, 10/8, 127/8, 224/3
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return false;
}

function sfParseV6(str) {
  let s = String(str).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!s.includes(':')) return null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = sfParseV4(tail);
    if (!o) return null;
    s = s.slice(0, lastColon + 1) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let groups;
  if (parts.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...rest];
  } else {
    groups = head;
    if (groups.length !== 8) return null;
  }
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

// Only global unicast 2000::/3 is allowed, minus special-purpose ranges.
function sfPrivateV6(g) {
  if ((g[0] & 0xe000) !== 0x2000) return true; // ::, ::1, ::ffff:x (mapped), fe80::/10, fc00::/7, ff00::/8, ...
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  return false;
}

// The Code node sandbox has no URL global, so the URL is parsed here. The request is always made
// to a URL REBUILT from the parsed parts (canonical host), never to the raw string.
function sfNumPart(p) {
  if (p === '') return NaN;
  let radix = 10;
  let s = p;
  if (/^0x/i.test(s)) { s = s.slice(2); radix = 16; }
  else if (s.length > 1 && s[0] === '0') { s = s.slice(1); radix = 8; }
  if (s === '') return 0;
  const re = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  return re.test(s) ? parseInt(s, radix) : NaN;
}

// WHATWG "ends in a number": last label is all digits or 0x<hex>
function sfEndsInNumber(host) {
  const labels = host.split('.');
  if (labels[labels.length - 1] === '') labels.pop();
  if (!labels.length) return false;
  const last = labels[labels.length - 1];
  return /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/i.test(last);
}

// Legacy IPv4 forms (decimal 2130706433, hex 0x7f.1, octal 017700000001, short 127.1) -> [a,b,c,d] or null
function sfParseV4Legacy(host) {
  const labels = host.split('.');
  if (labels[labels.length - 1] === '') labels.pop();
  if (labels.length < 1 || labels.length > 4) return null;
  const nums = labels.map(sfNumPart);
  if (nums.some((n) => Number.isNaN(n))) return null;
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null;
  if (nums[nums.length - 1] >= Math.pow(256, 5 - nums.length)) return null;
  let ip = nums[nums.length - 1];
  for (let i = 0; i < nums.length - 1; i++) ip += nums[i] * Math.pow(256, 3 - i);
  return [Math.floor(ip / 16777216) % 256, Math.floor(ip / 65536) % 256, Math.floor(ip / 256) % 256, ip % 256];
}

function sfParseUrl(raw) {
  if (typeof raw !== 'string') throw sfErr('blocked_url', 'Invalid URL');
  const input = raw.trim();
  if (!input || input.length > 2048) throw sfErr('blocked_url', 'Invalid URL');
  // whitespace, control characters and backslashes (WHATWG treats \ like /) are refused outright
  if (/[\x00-\x20\x7f\\]/.test(input)) throw sfErr('blocked_url', 'Invalid URL');
  const m = /^(https?):\/\/([^/?#]*)([/?#][^]*)?$/i.exec(input);
  if (!m) throw sfErr('blocked_url', 'Only http and https URLs are allowed');
  const scheme = m[1].toLowerCase();
  const authority = m[2];
  let rest = m[3] || '';
  if (authority.includes('@')) throw sfErr('blocked_url', 'URLs with credentials are not allowed');
  if (authority.includes('[') || authority.includes(']')) throw sfErr('blocked_url', 'IPv6 addresses are not allowed');
  if (authority.includes('%')) throw sfErr('blocked_url', 'Invalid host');
  let host = authority;
  const colon = authority.indexOf(':');
  if (colon >= 0) {
    host = authority.slice(0, colon);
    const port = authority.slice(colon + 1);
    const def = scheme === 'https' ? 443 : 80;
    if (port !== '' && !(/^[0-9]{1,5}$/.test(port) && Number(port) === def)) throw sfErr('blocked_url', 'Custom ports are not allowed');
  }
  host = host.toLowerCase();
  if (!host) throw sfErr('blocked_url', 'Invalid host');
  let isIp = false;
  if (sfEndsInNumber(host)) {
    const o = sfParseV4Legacy(host);
    if (!o) throw sfErr('blocked_url', 'Invalid host');
    if (sfPrivateV4(o)) throw sfErr('blocked_url', 'Private addresses are not allowed');
    host = o.join('.');
    isIp = true;
  } else {
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (!/^[a-z0-9_-]{1,63}(\.[a-z0-9_-]{1,63})*$/.test(host) || host.length > 253) throw sfErr('blocked_url', 'Invalid host');
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.localdomain') ||
      host.endsWith('.home.arpa')
    ) throw sfErr('blocked_url', 'Internal host names are not allowed');
    if (!host.includes('.')) throw sfErr('blocked_url', 'Host name must contain a dot');
  }
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  rest = rest.replace(/[^\x21-\x7e]/gu, (ch) => encodeURIComponent(ch));
  if (rest === '' || rest[0] === '?') rest = '/' + rest;
  return { scheme, host, isIp, rest, href: scheme + '://' + host + rest };
}

// Resolve a redirect Location against the current URL without URL(); result is re-validated by sfParseUrl.
function sfResolveLocation(loc, base) {
  const l = String(loc).trim();
  if (/^https?:\/\//i.test(l)) return l;
  if (/^[a-z][a-z0-9+.-]*:/i.test(l)) throw sfErr('blocked_url', 'Invalid redirect target');
  if (l.startsWith('//')) return base.scheme + ':' + l;
  if (l.startsWith('/')) return base.scheme + '://' + base.host + l;
  const baseNoQuery = base.rest.split('?')[0];
  if (l.startsWith('?')) return base.scheme + '://' + base.host + baseNoQuery + l;
  if (l.startsWith('#') || l === '') return base.href;
  const dir = baseNoQuery.slice(0, baseNoQuery.lastIndexOf('/') + 1);
  const qIdx = l.search(/[?#]/);
  const relPath = qIdx >= 0 ? l.slice(0, qIdx) : l;
  const tail = qIdx >= 0 ? l.slice(qIdx) : '';
  const out = [];
  for (const seg of (dir + relPath).split('/').slice(1)) {
    if (seg === '..') out.pop();
    else if (seg !== '.') out.push(seg);
  }
  return base.scheme + '://' + base.host + '/' + out.join('/') + tail;
}

const sfDnsCache = {};
async function sfDoh(host, type) {
  let res;
  try {
    res = await sfHelpers.httpRequest({
      method: 'GET',
      url: `${SF_DOH}?name=${encodeURIComponent(host)}&type=${type}`,
      headers: { accept: 'application/dns-json' },
      json: true,
      timeout: SF_DOH_TIMEOUT_MS,
    });
  } catch (e) {
    throw sfErr('dns_failed', 'Could not verify the host name (DNS lookup failed)');
  }
  if (typeof res === 'string') {
    try { res = JSON.parse(res); } catch (e) { res = null; }
  }
  if (!res || typeof res.Status !== 'number') throw sfErr('dns_failed', 'Could not verify the host name (bad DNS answer)');
  return res;
}

async function sfAssertPublicHost(chk) {
  if (chk.isIp) return;
  if (sfDnsCache[chk.host]) return;
  const addrs = [];
  for (const [type, rrType] of [['A', 1], ['AAAA', 28]]) {
    const res = await sfDoh(chk.host, type);
    if (res.Status !== 0 && res.Status !== 3) throw sfErr('dns_failed', 'Could not verify the host name (DNS error)');
    for (const a of Array.isArray(res.Answer) ? res.Answer : []) {
      if (a && a.type === rrType) addrs.push({ rrType, data: String(a.data) });
    }
  }
  if (addrs.length === 0) throw sfErr('dns_failed', 'Host name did not resolve');
  for (const a of addrs) {
    if (a.rrType === 1) {
      const o = sfParseV4(a.data);
      if (!o || sfPrivateV4(o)) throw sfErr('blocked_url', 'Host resolves to a private address');
    } else {
      const g = sfParseV6(a.data);
      if (!g || sfPrivateV6(g)) throw sfErr('blocked_url', 'Host resolves to a private address');
    }
  }
  sfDnsCache[chk.host] = true;
}

async function safeFetch(rawUrl, headers) {
  let chk = sfParseUrl(rawUrl);
  for (let hop = 0; hop <= SF_MAX_HOPS; hop++) {
    if (Date.now() - SF_STARTED > SF_DEADLINE_MS) throw sfErr('timeout', 'The website took too long to respond');
    await sfAssertPublicHost(chk);
    let resp;
    try {
      resp = await sfHelpers.httpRequest({
        method: 'GET',
        url: chk.href,
        headers: headers || {},
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        disableFollowRedirect: true,
        skipSslCertificateValidation: false,
        encoding: 'arraybuffer',
        json: false,
        timeout: SF_TIMEOUT_MS,
        maxContentLength: SF_MAX_BYTES,
        maxBodyLength: SF_MAX_BYTES,
      });
    } catch (e) {
      throw sfErr('fetch_failed', 'The website could not be reached');
    }
    const status = Number(resp.statusCode);
    const rh = resp.headers || {};
    if ([301, 302, 303, 307, 308].includes(status) && rh.location) {
      if (hop === SF_MAX_HOPS) throw sfErr('too_many_redirects', 'Too many redirects');
      chk = sfParseUrl(sfResolveLocation(Array.isArray(rh.location) ? rh.location[0] : rh.location, chk));
      continue;
    }
    const raw = resp.body;
    const buf = Buffer.isBuffer(raw) ? raw : raw == null ? Buffer.alloc(0) : Buffer.from(raw);
    if (buf.length > SF_MAX_BYTES) throw sfErr('too_large', 'The page is too large');
    const ct = String(Array.isArray(rh['content-type']) ? rh['content-type'][0] : rh['content-type'] || '').toLowerCase();
    const textual = !ct || /^text\//.test(ct) || /^application\/(xhtml\+xml|xml|json|rss\+xml|atom\+xml|ld\+json)/.test(ct);
    const cs = /charset=([^;\s]+)/.exec(ct);
    const enc = cs && /^(latin1|iso-8859-1|windows-1252)$/.test(cs[1].replace(/["']/g, '')) ? 'latin1' : 'utf8';
    return {
      statusCode: status,
      statusMessage: resp.statusMessage || '',
      headers: rh,
      finalUrl: chk.href,
      text: textual ? buf.toString(enc) : '',
    };
  }
  throw sfErr('too_many_redirects', 'Too many redirects');
}
// ── end SAFE FETCH ──────────────────────────────────────────────────────────
