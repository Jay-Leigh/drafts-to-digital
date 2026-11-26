'use strict';
// Reads tests/.results/*.json (written by every suite) and prints the final table; exit code 1 when any test failed or a suite did not report.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', '.results');
const suitesDir = path.join(__dirname, '..', 'suites');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
const rows = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const expected = fs.readdirSync(suitesDir).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));
const only = process.env.SUITES ? process.env.SUITES.split(/\s+/) : null;
let pass = 0, total = 0, bad = false;
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('suite', 28)} ${pad('pass/total', 11)} ${pad('skipped', 8)} ${pad('known', 6)} ${pad('warn', 5)} time`);
console.log('-'.repeat(70));
for (const name of expected) {
  if (only && !only.some(s => name.startsWith(s))) continue;
  const r = rows.find(x => x.suite === name);
  if (!r) { console.log(`${pad(name, 28)} NO RESULT (the suite crashed)`); bad = true; continue; }
  pass += r.pass; total += r.total;
  if (r.pass !== r.total) bad = true;
  console.log(`${pad(name, 28)} ${pad(`${r.pass}/${r.total}`, 11)} ${pad(r.skipped || 0, 8)} ${pad(r.known || 0, 6)} ${pad((r.warnings || []).length, 5)} ${(r.ms / 1000).toFixed(1)} s${r.pass !== r.total ? '   <-- FAIL' : ''}`);
}
console.log('-'.repeat(70));
console.log(`${pad('TOTAL', 28)} ${pad(`${pass}/${total}`, 11)}  ${bad ? 'FAIL' : 'PASS'}`);
const fails = rows.flatMap(r => r.results.filter(x => !x.ok).map(x => `${r.suite}: ${x.title}`));
if (fails.length) { console.log('\nFAILED TESTS:'); for (const f of fails) console.log(`  ${f}`); }
const known = rows.flatMap(r => r.results.filter(x => x.known).map(x => `${r.suite}: ${x.title}`));
if (known.length) { console.log('\nKNOWN ISSUES (bugs in the page, reported not fixed):'); for (const f of known) console.log(`  ${f}`); }
const warns = rows.flatMap(r => (r.warnings || []).map(w => `${r.suite}: ${w}`));
if (warns.length) { console.log('\nWARNINGS:'); for (const w of warns) console.log(`  ${w}`); }
process.exit(bad ? 1 : 0);
