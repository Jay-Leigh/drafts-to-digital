const assert = require('assert');
const { runCode, loadWorkflow, codeOf, makeContext } = require('./harness');
const vm = require('vm');
let pass = 0, fail = 0;
const t = (c, name, extra) => { if (c) pass++; else { fail++; console.log('  FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };

const DOH = 'https://dns.google/resolve';
function net({ dns = {}, sites = {}, dohFail = false, dohRaw = null } = {}) {
  const calls = [];
  const helpers = {
    async httpRequest(o) {
      calls.push(o);
      if (o.url.startsWith(DOH)) {
        if (dohFail) throw new Error('doh down');
        if (dohRaw !== null) return dohRaw;
        const m = /name=([^&]+)&type=(\w+)/.exec(o.url);
        const key = decodeURIComponent(m[1]) + '/' + m[2];
        return dns[key] || (dns[decodeURIComponent(m[1]) + '/*'] ? dns[decodeURIComponent(m[1]) + '/*'] : { Status: 0 });
      }
      const s = sites[o.url];
      if (!s) throw new Error('ECONNREFUSED ' + o.url);
      if (typeof s === 'function') return s(o);
      return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>hello</html>'), ...s };
    },
  };
  return { helpers, calls, fetched: () => calls.filter((c) => !c.url.startsWith(DOH)).map((c) => c.url), doh: () => calls.filter((c) => c.url.startsWith(DOH)) };
}
const A = (...ips) => ({ Status: 0, Answer: ips.map((d) => ({ name: 'x.', type: 1, TTL: 60, data: d })) });
const AAAA = (...ips) => ({ Status: 0, Answer: ips.map((d) => ({ name: 'x.', type: 28, TTL: 60, data: d })) });
const dnsFor = (host, a, aaaa) => ({ [host + '/A']: a || { Status: 0 }, [host + '/AAAA']: aaaa || { Status: 0 } });

(async () => {
  const wf = loadWorkflow('sth-workflow-v1-additive.json');
  const codeFetch = codeOf(wf, 'Scrape — Fetch URL');
  const codeTpl = codeOf(wf, 'Scrape Template URL');
  const codeRev = codeOf(wf, 'Scrape Reviewer URL');
  // The three nodes share identical library text
  const lib = (c) => c.slice(0, c.indexOf('// ── end SAFE FETCH'));
  t(lib(codeFetch) === lib(codeTpl) && lib(codeTpl) === lib(codeRev), 'three scrape nodes embed identical Safe Fetch library');
  t(vm.runInContext('typeof URL', makeContext()) === 'undefined', 'test sandbox has no URL global (matches n8n 2.29.7 Code node)');
  t(!/new URL\(/.test(lib(codeFetch)), 'library does not use new URL()');
  t(!/require\(/.test(codeFetch) && !/process\./.test(codeFetch), 'library uses no require/process');

  const scrape = async (url, n = net(), code = codeFetch) => {
    const out = await runCode(code, { input: [{ json: { body: { url } } }], nodes: { 'Normalize Multipart Body': [{ json: { body: { url } } }] }, helpers: n.helpers });
    return out[0].json;
  };

  // ───────── blocked before any network access ─────────
  const blockedNoNet = [
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://127.1/', 'http://0177.0.0.01/', 'http://0x7f.0x0.0x0.0x1/',
    'http://0/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[2001:db8::1]/', 'http://[fe80::1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://169.254.169.254.nip.io/x'.replace('.nip.io', ''), 'http://metadata.google.internal/', 'http://localhost/', 'http://localhost./', 'http://LOCALHOST/',
    'http://foo.localhost/', 'http://printer.local/', 'http://db.internal/', 'http://intranet/', 'http://a.localdomain/', 'http://router.home.arpa/',
    'http://10.1.1.1/', 'http://10.255.255.255/', 'http://100.64.0.1/', 'http://100.127.255.254/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/',
    'http://224.0.0.1/', 'http://239.1.1.1/', 'http://240.0.0.1/', 'http://255.255.255.255/', 'http://192.0.0.1/', 'http://198.18.0.1/',
    'http://example.com:8080/', 'http://example.com:22/', 'http://example.com:443/', 'https://example.com:80/', 'https://example.com:8443/', 'http://example.com:0/',
    'file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,hi', 'ws://example.com/', 'example.com', '//example.com/', '/etc/passwd',
    'http://user:pw@example.com/', 'http://example.com@127.0.0.1/', 'http://127.0.0.1#@example.com/', 'http://example.com\\@127.0.0.1/', 'http://a.com%2F@127.0.0.1/', 'http://exämple.com/', 'http://example.com/a b',
    'http://1.2.3.4.5/', 'http://256.1.1.1/', 'http://', 'http:///', 'https://', '', '   ', null, undefined, 12345, { a: 1 }, 'http://' + 'a'.repeat(300) + '.com/', 'http://a..com/', 'http://-/x',
  ];
  for (const u of blockedNoNet) {
    const n = net();
    const r = await scrape(u, n);
    t(r.error && r.blocked === true && n.calls.length === 0, `blocked without any network call: ${JSON.stringify(u)}`, { r, calls: n.calls.length });
  }
  // Non-blocked errors must not be flagged as blocked and must not leak details
  // ───────── resolves to private (DoH) ─────────
  const privDns = [
    ['A 10.0.0.5', dnsFor('evil.com', A('10.0.0.5'))],
    ['A 127.0.0.1 (rebinding)', dnsFor('evil.com', A('127.0.0.1'))],
    ['A 169.254.169.254', dnsFor('evil.com', A('169.254.169.254'))],
    ['A 192.168.0.9', dnsFor('evil.com', A('192.168.0.9'))],
    ['A 100.64.1.1', dnsFor('evil.com', A('100.64.1.1'))],
    ['public A + private A', dnsFor('evil.com', A('93.184.216.34', '10.0.0.1'))],
    ['AAAA ::1', dnsFor('evil.com', A('93.184.216.34'), AAAA('::1'))],
    ['AAAA fe80::1', dnsFor('evil.com', null, AAAA('fe80::1'))],
    ['AAAA fc00::1 (ULA)', dnsFor('evil.com', null, AAAA('fc00::1'))],
    ['AAAA fd12:3456::1 (ULA)', dnsFor('evil.com', null, AAAA('fd12:3456::1'))],
    ['AAAA ::ffff:7f00:1', dnsFor('evil.com', null, AAAA('::ffff:7f00:1'))],
    ['AAAA ::ffff:127.0.0.1', dnsFor('evil.com', null, AAAA('::ffff:127.0.0.1'))],
    ['AAAA ::ffff:8.8.8.8 (mapped public still refused)', dnsFor('evil.com', null, AAAA('::ffff:8.8.8.8'))],
    ['AAAA 64:ff9b::7f00:1 (NAT64)', dnsFor('evil.com', null, AAAA('64:ff9b::7f00:1'))],
    ['AAAA 2002:7f00:1:: (6to4)', dnsFor('evil.com', null, AAAA('2002:7f00:1::'))],
    ['AAAA ::', dnsFor('evil.com', null, AAAA('::'))],
    ['AAAA ff02::1', dnsFor('evil.com', null, AAAA('ff02::1'))],
    ['AAAA garbage', dnsFor('evil.com', null, AAAA('not-an-ip'))],
    ['A garbage', dnsFor('evil.com', A('999.1.1.1'))],
  ];
  for (const [label, dns] of privDns) {
    const n = net({ dns, sites: { 'http://evil.com/': {} } });
    const r = await scrape('http://evil.com/', n);
    t(r.error && r.blocked === true && n.fetched().length === 0, `DoH ${label}: blocked, target never fetched`, { r, f: n.fetched() });
  }
  // fail-closed DNS problems (not "blocked" flag, but no fetch)
  for (const [label, o] of [['NXDOMAIN', { dns: { 'nx.com/A': { Status: 3 }, 'nx.com/AAAA': { Status: 3 } } }], ['no answers', { dns: {} }], ['DoH down', { dohFail: true }], ['DoH garbage', { dohRaw: 'garbage' }], ['DoH null', { dohRaw: null, dns: { 'nx.com/A': null } }], ['SERVFAIL', { dns: { 'nx.com/A': { Status: 2 }, 'nx.com/AAAA': { Status: 2 } } }]]) {
    const n = net({ ...o, sites: { 'http://nx.com/': {} } });
    const r = await scrape('http://nx.com/', n);
    t(r.error && n.fetched().length === 0, `DNS ${label}: fail closed`, r);
  }
  // ───────── public OK ─────────
  {
    const n = net({ dns: dnsFor('example.com', A('93.184.216.34', '93.184.216.35'), AAAA('2606:2800:220:1:248:1893:25c8:1946')), sites: { 'http://example.com/': { body: Buffer.from('<html><body>ok</body></html>') } } });
    const r = await scrape('http://example.com', n);
    t(r.statusCode === 200 && r.body === '<html><body>ok</body></html>' && !r.error, 'public example.com OK (fullResponse shape)', r);
    const o = n.calls.find((c) => !c.url.startsWith(DOH));
    t(o.url === 'http://example.com/', 'request URL canonical http://example.com/', o.url);
    t(o.disableFollowRedirect === true && o.ignoreHttpStatusErrors === true && o.returnFullResponse === true && o.skipSslCertificateValidation === false, 'redirect auto-follow off, status errors ignored, full response, TLS verification on');
    t(o.timeout === 20000, '20 s timeout', o.timeout);
    t(o.maxContentLength === 4 * 1024 * 1024, 'size cap passed to helper', o.maxContentLength);
    t(o.headers['User-Agent'] && /Mozilla/.test(o.headers['User-Agent']) && !o.headers.Authorization && !o.headers.authorization, 'scrape headers kept, no Authorization');
    t(n.doh().length === 2 && n.doh().every((d) => d.timeout === 5000), 'one A + one AAAA DoH query, 5 s timeout');
  }
  {
    const n = net({ dns: dnsFor('example.com', A('93.184.216.34')), sites: { 'https://example.com/p?q=1': {}, 'http://example.com/': {} } });
    let r = await scrape('HTTPS://EXAMPLE.com:443/p?q=1#frag', n); t(r.statusCode === 200, 'upper-case host, explicit default port, fragment dropped', r);
    t(n.fetched()[0] === 'https://example.com/p?q=1', 'canonical URL fetched', n.fetched());
    r = await scrape('http://example.com.:80', n); t(r.statusCode === 200 && n.fetched()[1] === 'http://example.com/', 'trailing dot + :80 normalised', n.fetched());
    r = await scrape('  http://example.com  ', n); t(r.statusCode === 200, 'surrounding whitespace trimmed');
  }
  {
    const n = net({ sites: { 'http://93.184.216.34/x': {} } });
    const r = await scrape('http://93.184.216.34/x', n); t(r.statusCode === 200 && n.doh().length === 0, 'public IPv4 literal allowed, no DNS needed', r);
    const n2 = net({ sites: { 'http://93.184.216.34/': {} } });
    const r2 = await scrape('http://1572395042', n2); t(r2.statusCode === 200 && n2.fetched()[0] === 'http://93.184.216.34/', 'decimal-encoded PUBLIC IP is canonicalised before fetch', n2.fetched());
  }
  {
    const n = net({ dns: dnsFor('example.com', A('93.184.216.34')), sites: { 'http://example.com/a%20b%C3%A9?x=%20': {} } });
    const r = await scrape('http://example.com/a%20bé?x=%20', n); t(r.statusCode === 200, 'non-ascii path/query percent-encoded, existing %xx kept', { r, f: n.fetched() });
  }
  // ───────── redirects ─────────
  {
    const sites = {
      'http://a.com/r1': { statusCode: 301, headers: { location: '/r2' }, body: Buffer.alloc(0) },
      'http://a.com/r2': { statusCode: 302, headers: { location: 'http://b.com/final?x=1' }, body: Buffer.alloc(0) },
      'http://b.com/final?x=1': { body: Buffer.from('<html>FINAL</html>') },
    };
    const n = net({ dns: { ...dnsFor('a.com', A('93.184.216.34')), ...dnsFor('b.com', A('93.184.216.35')) }, sites });
    const r = await scrape('http://a.com/r1', n); t(r.body === '<html>FINAL</html>', 'relative + absolute redirects followed', r);
    t(n.fetched().length === 3, 'three requests', n.fetched());
    t(n.doh().some((d) => /name=b\.com/.test(d.url)), 'redirect target resolved via DoH again');
  }
  const redirTests = [
    ['redirect to http://127.0.0.1/', 'http://127.0.0.1/secret'],
    ['redirect to http://localhost/', 'http://localhost/'],
    ['redirect to metadata IP', 'http://169.254.169.254/computeMetadata/v1/'],
    ['redirect to decimal IP', 'http://2130706433/'],
    ['redirect to [::1]', 'http://[::1]/'],
    ['redirect to file:', 'file:///etc/passwd'],
    ['redirect to gopher:', 'gopher://a.com/_x'],
    ['redirect to javascript:', 'javascript:alert(1)'],
    ['redirect to :8080', 'http://b.com:8080/'],
    ['redirect to host resolving private', 'http://priv.com/'],
    ['redirect to creds URL', 'http://u:p@b.com/'],
    ['redirect to .internal', 'http://x.internal/'],
  ];
  for (const [label, loc] of redirTests) {
    const sites = { 'http://a.com/r': { statusCode: 302, headers: { location: loc }, body: Buffer.alloc(0) }, 'http://127.0.0.1/secret': {}, 'http://localhost/': {}, 'http://priv.com/': {} };
    const n = net({ dns: { ...dnsFor('a.com', A('93.184.216.34')), ...dnsFor('b.com', A('93.184.216.35')), ...dnsFor('priv.com', A('10.9.9.9')) }, sites });
    const r = await scrape('http://a.com/r', n);
    t(r.error && r.blocked === true && n.fetched().length === 1, `${label}: blocked at hop 2, only first request made`, { r, f: n.fetched() });
  }
  {
    // relative redirect forms
    const mk = (loc, expectUrl) => async () => {
      const sites = { 'http://a.com/d1/d2/r': { statusCode: 302, headers: { location: loc }, body: Buffer.alloc(0) }, [expectUrl]: { body: Buffer.from('<html>T</html>') } };
      const n = net({ dns: { ...dnsFor('a.com', A('93.184.216.34')), ...dnsFor('other.com', A('93.184.216.40')) }, sites });
      const r = await scrape('http://a.com/d1/d2/r', n);
      t(r.body === '<html>T</html>', `redirect Location ${JSON.stringify(loc)} -> ${expectUrl}`, { r, f: n.fetched() });
    };
    await mk('x', 'http://a.com/d1/d2/x')();
    await mk('../y', 'http://a.com/d1/y')();
    await mk('../../z/q?w=1', 'http://a.com/z/q?w=1')();
    await mk('./k', 'http://a.com/d1/d2/k')();
    await mk('/abs', 'http://a.com/abs')();
    await mk('?only=q', 'http://a.com/d1/d2/r?only=q')();
    await mk('//other.com/p', 'http://other.com/p')();
  }
  {
    // redirect limits
    const sites = {};
    for (let i = 0; i < 8; i++) sites[`http://a.com/h${i}`] = { statusCode: 302, headers: { location: `/h${i + 1}` }, body: Buffer.alloc(0) };
    sites['http://a.com/h5'] = { body: Buffer.from('<html>five</html>') };
    let n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites });
    let r = await scrape('http://a.com/h0', n); t(r.body === '<html>five</html>' && n.fetched().length === 6, '5 redirects followed (6 requests) then content', { r, f: n.fetched().length });
    sites['http://a.com/h5'] = { statusCode: 302, headers: { location: '/h6' }, body: Buffer.alloc(0) };
    n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites });
    r = await scrape('http://a.com/h0', n); t(r.error && /redirect/i.test(r.error) && n.fetched().length === 6, 'the 6th redirect is refused', { r, f: n.fetched().length });
    n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites: { 'http://a.com/loop': { statusCode: 302, headers: { location: '/loop' }, body: Buffer.alloc(0) } } });
    r = await scrape('http://a.com/loop', n); t(r.error && n.fetched().length === 6, 'redirect loop ends after 6 requests', { r, f: n.fetched().length });
    n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites: { 'http://a.com/nl': { statusCode: 302, headers: {}, body: Buffer.from('<html>nolocation</html>') } } });
    r = await scrape('http://a.com/nl', n); t(r.statusCode === 302 && r.body === '<html>nolocation</html>', '3xx without Location returned as-is', r);
  }
  // ───────── status / size / content ─────────
  {
    let n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites: { 'http://a.com/404': { statusCode: 404, body: Buffer.from('nope') } } });
    let r = await scrape('http://a.com/404', n); t(r.statusCode === 404 && !r.error, 'scrape: 404 returned with statusCode (Clean HTML maps it)', r);
    r = await scrape('http://a.com/404', n, codeTpl); t(r.error === 'HTTP 404' && !r.data, 'template: 404 -> {error}', r);
    r = await scrape('http://a.com/404', n, codeRev); t(r.error === 'HTTP 404', 'reviewer: 404 -> {error}', r);
    n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites: { 'http://a.com/ok': { body: Buffer.from('<p>T</p>') } } });
    r = await scrape('http://a.com/ok', n, codeTpl); t(r.data === '<p>T</p>', 'template: {data}', r);
    t(!n.calls.find((c) => !c.url.startsWith(DOH)).headers['User-Agent'], 'template/reviewer: no extra headers (as before)');
    r = await scrape('http://a.com/ok', n, codeRev); t(r.data === '<p>T</p>', 'reviewer: {data}', r);
    r = await scrape('http://127.0.0.1/', net(), codeTpl); t(r.error && r.blocked && !r.data, 'template: blocked', r);
    r = await scrape('http://127.0.0.1/', net(), codeRev); t(r.error && r.blocked && !r.data, 'reviewer: blocked', r);
    n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites: { 'http://a.com/big': { body: Buffer.alloc(5 * 1024 * 1024, 65) } } });
    r = await scrape('http://a.com/big', n); t(r.error && /large/i.test(r.error), '5 MB body refused (size limit)', r);
    n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites: { 'http://a.com/pdf': { headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-1.4') } } });
    r = await scrape('http://a.com/pdf', n); t(r.statusCode === 200 && r.body === '', 'binary content-type -> empty body (Clean HTML says no content)', r);
    n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites: { 'http://a.com/l1': { headers: { 'content-type': 'text/html; charset=ISO-8859-1' }, body: Buffer.from([0x63, 0x61, 0x66, 0xe9]) } } });
    r = await scrape('http://a.com/l1', n); t(r.body === 'café', 'latin1 charset decoded', r);
    n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites: { 'http://a.com/ab': (o) => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: new Uint8Array([104, 105]).buffer }) } });
    r = await scrape('http://a.com/ab', n); t(r.body === 'hi', 'ArrayBuffer body handled', r);
    n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites: {} });
    r = await scrape('http://a.com/refused', n); t(r.error === 'The website could not be reached' && !r.blocked, 'connection error -> generic message, no internals', r);
    n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites: { 'http://a.com/boom': () => { throw new TypeError('secret internal detail /etc/x'); } } });
    r = await scrape('http://a.com/boom', n); t(!JSON.stringify(r).includes('secret internal'), 'internal error text not leaked', r);
  }
  {
    // DoH cache: same host twice (redirect back) queried once
    const sites = { 'http://a.com/1': { statusCode: 302, headers: { location: '/2' }, body: Buffer.alloc(0) }, 'http://a.com/2': {} };
    const n = net({ dns: dnsFor('a.com', A('93.184.216.34')), sites });
    await scrape('http://a.com/1', n); t(n.doh().length === 2, 'DNS verdict cached per run (2 DoH calls for 2 hops same host)', n.doh().length);
  }
  console.log(`safefetch unit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
