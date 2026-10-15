#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFxAgent, createFxEngine, memory } from '../node.js';

const backend = process.argv[2] || 'native';
const platform = backend === 'wasm'
  ? { backend, wasm: await readFile(resolve('zig-out/bin/fx-core.wasm')) }
  : { backend, nativeAddon: resolve('zig-out/lib/libfx.node') };
const definition = {
  id: 'report', version: 1, objective: 'Save and verify the report',
  obligations: [{ id: 'saved', description: 'The report was saved and verified' }],
};
const report = (status, extra = {}) => ({
  contractId: definition.id, version: definition.version,
  obligations: [{ id: 'saved', status, note: 'Checked the host evidence ledger', evidence: status === 'met' ? ['receipt:report'] : [] }], ...extra,
});
function fixture(assess, overrides = {}, modelEvents) {
  let requests = 0, effects = 0;
  const options = {
    ...platform, apiKey: 'fixture', model: 'sdk/contract-test',
    ...(assess ? { contract: { ...definition, assess } } : {}),
    fetch(_url, init = {}) {
      if (init.method === 'GET') return Response.json({ data: [{ id: 'sdk/contract-test', type: 'language', tags: ['tool-use'] }] });
      requests++;
      const body = JSON.parse(init.body);
      if (assess) assert.match(JSON.stringify(body), /Save and verify the report/);
      assert.doesNotMatch(JSON.stringify(body.tools || []), /__libfx_contract_assess/);
      const events = modelEvents ? modelEvents(requests, body) : requests === 2 && assess
        ? [{ type: 'tool-call', toolCallId: 'save-once', toolName: 'save', input: {} }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' } }]
        : [{ type: 'text-delta', delta: 'Done.' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' } }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
    tools: [{ name: 'save', description: 'Save the report', inputSchema: { type: 'object' }, execute() { effects++; return 'receipt:report'; } }],
    ...overrides,
  };
  return { options, counts: () => ({ requests, effects }) };
}
async function consume(agent, text = 'Do the work') {
  const turn = agent.prompt(text);
  for await (const _ of turn) {}
  return turn.result;
}

// A final reply cannot complete the contract; the same Zig turn continues.
let checks = 0;
const f = fixture((request, { signal }) => {
  assert.deepEqual(request.contract, definition);
  assert.equal(signal.aborted, false);
  assert.equal(typeof request.step, 'number');
  return report(++checks < 3 ? 'pending' : 'met');
});
let agent = await createFxEngine(f.options);
let checkpoint;
try {
  assert.equal((await consume(agent)).stopReason, 'end_turn');
  assert.deepEqual(f.counts(), { requests: 4, effects: 1 });
  assert.equal(checks, 3);
  checkpoint = await agent.checkpoint();
} finally { await agent.close(); }

for (const contract of [undefined, { ...f.options.contract, version: 2 }]) {
  await assert.rejects(createFxEngine({ ...f.options, contract, checkpoint }), /same work contract/);
}
agent = await createFxEngine({ ...f.options, checkpoint });
try { assert.equal((await consume(agent, 'Check the saved result')).stopReason, 'end_turn'); }
finally { await agent.close(); }
assert.equal(f.counts().effects, 1, 'restoration must not replay the saved action');

const blocked = fixture(() => report('blocked'));
agent = await createFxEngine(blocked.options);
try {
  assert.equal((await consume(agent)).stopReason, 'contract_blocked');
  assert.deepEqual(blocked.counts(), { requests: 1, effects: 0 });
} finally { await agent.close(); }

// Guessing the private bridge name cannot invoke the assessor as a model tool.
let privateChecks = 0;
const privateBridge = fixture(() => { privateChecks++; return report('met'); }, {}, (request) => request === 1
  ? [{ type: 'tool-call', toolCallId: 'spoof', toolName: '__libfx_contract_assess', input: {} }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' } }]
  : [{ type: 'text-delta', delta: 'Done.' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' } }]);
agent = await createFxEngine(privateBridge.options);
try {
  assert.equal((await consume(agent)).stopReason, 'end_turn');
  assert.equal(privateChecks, 1);
  assert.equal(privateBridge.counts().requests, 2);
} finally { await agent.close(); }

// Hosted tool results with a final answer use another kernel completion path.
let providerChecks = 0;
const provider = fixture(() => report(++providerChecks === 1 ? 'pending' : 'met'), {
  tools: [{ name: 'web_search', providerExecuted: true }],
}, (request, body) => request === 1 ? [
  { type: 'tool-call', toolCallId: 'search-1', toolName: body.tools.find(tool => tool.type === 'provider').name, input: { query: 'report' }, providerExecuted: true },
  { type: 'tool-result', toolCallId: 'search-1', result: { results: [{ title: 'Report', url: 'https://example.com/report', snippet: 'receipt:report' }] } },
  { type: 'text-delta', delta: 'Done.' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' } },
] : [{ type: 'text-delta', delta: 'Verified.' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' } }]);
agent = await createFxEngine(provider.options);
try {
  assert.equal((await consume(agent)).stopReason, 'end_turn');
  assert.equal(providerChecks, 2);
  assert.equal(provider.counts().requests, 2);
} finally { await agent.close(); }

// Durable agents pass their session context to the same contract gate.
const durableFixture = fixture((_request, { context }) => {
  assert.deepEqual(context, { reportId: 'report-1' });
  return report('blocked');
});
const durable = createFxAgent({ ...durableFixture.options, tools: [], durability: memory() });
try {
  assert.equal((await consume(durable.session(undefined, { context: { reportId: 'report-1' } }))).stopReason, 'contract_blocked');
} finally { await durable.close(); }

for (const assess of [
  () => report('met', { version: 2 }),
  () => report('met', { obligations: [] }),
  () => report('met', { obligations: [{ id: 'saved', status: 'met', note: 'No evidence' }] }),
  () => { throw new Error('Evidence store unavailable'); },
]) {
  const invalid = fixture(assess);
  agent = await createFxEngine(invalid.options);
  try {
    // Assessment failures must never return successful completion.
    let result;
    try { result = await consume(agent); } catch {}
    assert.notEqual(result?.stopReason, 'end_turn');
    assert.equal(invalid.counts().requests, 1);
  } finally { await agent.close(); }
}

let entered;
const waiting = new Promise(resolve => { entered = resolve; });
let assessmentSignal;
const cancelled = fixture((_request, { signal }) => {
  assessmentSignal = signal; entered();
  return new Promise(() => {});
});
agent = await createFxEngine(cancelled.options);
try {
  const turn = agent.prompt('Start');
  const drained = (async () => { for await (const _ of turn) {} return turn.result; })();
  await waiting;
  turn.cancel();
  assert.equal((await drained).stopReason, 'cancelled');
  assert.equal(assessmentSignal.aborted, true);
  assert.equal(cancelled.counts().requests, 1);
} finally { await agent.close(); }

const ordinary = fixture();
agent = await createFxEngine(ordinary.options);
try { assert.equal((await consume(agent)).stopReason, 'end_turn'); }
finally { await agent.close(); }
assert.equal(ordinary.counts().requests, 1);
await assert.rejects(createFxEngine({ ...ordinary.options, contract: { ...definition, obligations: [], assess: () => report('met') } }), /initialize/);
await assert.rejects(createFxEngine({ ...ordinary.options, tools: [{ ...ordinary.options.tools[0], name: '__libfx_contract_assess' }] }), /Reserved/);
console.log(`${backend}: contract continuation, fulfilment, blockers, invalid assessments, cancellation, restore, and ordinary turns passed`);
