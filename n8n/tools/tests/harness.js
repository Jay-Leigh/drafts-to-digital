// Runs n8n Code-node source the way the JS task runner does: async function body, restricted globals.
// IMPORTANT: no URL / URLSearchParams / crypto / process / fetch in the context (verified against n8n 2.29.7).
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function makeContext() {
  const ctx = vm.createContext({
    Buffer, TextDecoder, TextEncoder, setTimeout, clearTimeout, btoa, atob,
    console: { log() {}, error() {} },
  });
  return ctx;
}

function item(json, binary) { return binary ? { json, binary } : { json }; }
function listApi(items) {
  return { first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] };
}

async function runCode(code, { input = [], nodes = {}, helpers = {}, runIndex = 0, executed = null, execution = { id: '1' } } = {}) {
  const ctx = makeContext();
  const fn = vm.runInContext('(async function($input, $json, $, $node, $runIndex, $now, $execution){\n' + code + '\n})', ctx);
  const $input = listApi(input);
  const $ = (name) => {
    if (!nodes[name]) throw new Error(`Node "${name}" hasn't been executed`);
    const api = listApi(nodes[name]);
    api.isExecuted = true;
    return api;
  };
  // $('X').isExecuted for a node that has not run: false (n8n 2.29.7), instead of throwing
  const $wrap = (name) => (nodes[name] || (executed && name in executed) ? $(name) : { isExecuted: false, first: () => { throw new Error(`Node "${name}" hasn't been executed`); }, all: () => { throw new Error(`Node "${name}" hasn't been executed`); } });
  return fn.call({ helpers }, $input, input[0] && input[0].json, $wrap, {}, runIndex, new Date(), execution);
}

function loadWorkflow(file) { if (process.env.MUT_FILE && /v1-additive/.test(file)) file = process.env.MUT_FILE; return JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(__dirname, '..', file), 'utf8')); }
function codeOf(wf, name) {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error('no node ' + name);
  return n.parameters.jsCode;
}
module.exports = { runCode, item, loadWorkflow, codeOf, makeContext };
