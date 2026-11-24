// Minimal RESP client for the tests (real Redis 7 on :6390). cmd(['GET','k']) -> value; errors throw.
const net = require('net');
function parse(b, i) {
  if (i >= b.length) throw new Error('incomplete');
  const t = String.fromCharCode(b[i]); const e = b.indexOf('\r\n', i);
  if (e < 0) throw new Error('incomplete');
  const line = b.slice(i + 1, e).toString();
  if (t === '+') return { v: line, n: e + 2 };
  if (t === '-') return { err: line, n: e + 2 };
  if (t === ':') return { v: Number(line), n: e + 2 };
  if (t === '$') { const len = Number(line); if (len < 0) return { v: null, n: e + 2 }; if (b.length < e + 2 + len + 2) throw new Error('incomplete'); return { v: b.slice(e + 2, e + 2 + len).toString(), n: e + 2 + len + 2 }; }
  if (t === '*') { const len = Number(line); if (len < 0) return { v: null, n: e + 2 }; let p = e + 2; const out = []; for (let k = 0; k < len; k++) { const r = parse(b, p); out.push(r.err ? new Error(r.err) : r.v); p = r.n; } return { v: out, n: p }; }
  throw new Error('bad resp');
}
function cmd(args, port = Number(process.env.REDIS_PORT || 6390)) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1'); let buf = Buffer.alloc(0);
    sock.on('error', reject);
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); try { const r = parse(buf, 0); sock.end(); r.err ? reject(new Error(r.err)) : resolve(r.v); } catch (e) { if (e.message !== 'incomplete') { sock.end(); reject(e); } } });
    sock.write('*' + args.length + '\r\n' + args.map((a) => { const b = Buffer.from(String(a)); return '$' + b.length + '\r\n' + b.toString('binary') + '\r\n'; }).join(''), 'binary');
  });
}
module.exports = { cmd };
