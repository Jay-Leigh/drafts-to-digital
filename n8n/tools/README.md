# n8n build and test harness

Builds `../sth-workflow-v1..v7*.json` from `live.json` (export of the live workflow, credential ids only) plus the code in `src/`. Run from this folder.

- `node build.js`: writes `sth-workflow-v1..v7-*.json` here (ignored by git) and `gen/*.lib.js` (the `Studio - Validate` library the unit tests load). v1..v6 must stay byte-identical to the committed files in `..`; v7 is the new one.
- `node validate.js`: structure, credentials, secrets, diff against live, per-version rules (v7: settings, fallback output, no retry on job calls, expiries).
- `node tests/t-*.js`: unit tests (Code nodes in an n8n-like sandbox, Lua on a real Redis). Needs `redis-server --port 6391`; `t-v7.js` is the v7 suite.
- `e2e/`: suites against a local n8n 2.29.7 with mocked Upstash, Gemini and DNS. Setup once: `mkdir n8nrun && cd n8nrun && npm i n8n@2.29.7 --legacy-peer-deps`; `redis-server --port 6390`; `127.0.0.1 a.pub.test` in the hosts file; `node e2e/mock.js`. `e2e/reload.sh v7-bundle` imports a test copy and starts n8n.
- `./run-all.sh`: build, validate, every suite for v1..v7, then copies `sth-workflow-v7-bundle.json` to `..`. `WF_V7=1` (with `WF_V6=1`) switches the few v6 expectations that v7 changes on purpose (15 sources, ten hello modes, J4 meter factor 8.33).
- Regenerate `live.json`: n8n > the live workflow > Download, save here; check it holds no secret (`grep -iE "AIza|ya29|secret|token"` must show code only).
- All keys, tokens and secrets in `tests/` and `e2e/` are fixed fake test values.
- New v7 sources: `src/job7-*`, `quota7-*`, `studio7*`, `j4-settle.js`, `route7-unknown.js`; the patching is `buildV7` in `build.js`.
