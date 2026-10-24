import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

// A fake AgenticOrg: records requests and replies with whatever the current test queued.
type Reply = { status: number; body: unknown };
const requests: { url: string; auth?: string; body: { action: string; inputs: { task: string }; context: Record<string, unknown> } }[] = [];
let reply: Reply = { status: 200, body: {} };
const fake = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push({ url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw) });
  res.writeHead(reply.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(reply.body));
});
await new Promise<void>((r) => fake.listen(0, r));
after(() => fake.close());

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'recoverroute-ao-')), 'test.db');
process.env.AGENTICORG_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.AGENTICORG_API_KEY = 'test-key';

const ao = await import('../src/agenticorg.ts');
const { seed } = await import('../src/seed.ts');
const cmd = await import('../src/commands.ts');
const { loadAgentRuns, loadNotifications, loadWorld, tx } = await import('../src/db.ts');
const { addHours } = await import('../../shared/logic.ts');

/** Starts a run and resolves once the background call has finished. */
const finish = (start: (done: () => void) => string) =>
  new Promise<string>((resolve) => {
    let id = '';
    id = start(() => resolve(id));
  });
const runById = (id: string) => loadAgentRuns('distA').find((r) => r.id === id)!;

beforeEach(() => {
  seed();
  requests.length = 0;
});

const PLAN_OUTPUT = `## Allocation plan
| Priority | Order | Qty |
|---|---|---|
| 1 | #1046 | 12 |

\`\`\`json
{"allocations": [{"orderId": "1046", "qty": 12}, {"orderId": "1047", "qty": 5}, {"orderId": "9999", "qty": 3}],
 "sourcing": [{"orderId": "1046", "supplierId": "quickstock", "qty": 6}, {"orderId": "1047", "supplierId": "nope", "qty": 1}]}
\`\`\``;

test('allocation run sends live data and stores a validated plan', async () => {
  reply = { status: 200, body: { status: 'completed', confidence: 82, output: PLAN_OUTPUT } };
  const id = await finish((done) => ao.startAllocationRun('distA', done));

  const req = requests[0];
  assert.equal(req.url, '/api/v1/agents/60201cd3-74b3-4a53-a762-fbb7b1bce836/run');
  assert.equal(req.auth, 'Bearer test-key');
  assert.equal(req.body.action, 'process');
  assert.match(req.body.inputs.task, /#1046 · Patel Kirana/);
  assert.match(req.body.inputs.task, /supplierId=quickstock/);
  assert.match(req.body.inputs.task, /```json block/);

  const run = runById(id);
  assert.equal(run.status, 'completed');
  assert.equal(run.confidence, 0.82, 'percentages are normalised to 0–1');
  assert.ok(!run.output!.includes('```json'), 'the JSON plan is stripped from the write-up');
  // Cola stock is 12: #1046 takes all of it, so #1047's 5 is clamped to 0; the unknown order is dropped.
  assert.deepEqual(run.plan!.allocations, [
    { orderId: '1046', qty: 12 },
    { orderId: '1047', qty: 0 },
  ]);
  assert.deepEqual(run.plan!.sourcing, [{ orderId: '1046', supplierId: 'quickstock', qty: 6 }]);
});

test('parses the live API response shape', async () => {
  reply = {
    status: 200,
    body: {
      run_id: 'msg_877e4db1d96f',
      status: 'hitl_triggered',
      output: { raw_output: PLAN_OUTPUT, status: 'completed' },
      confidence: 0.7,
      hitl_trigger: 'confidence 0.700 < floor 0.9',
      performance: { total_latency_ms: 3248, llm_tokens_used: 2883, llm_cost_usd: 0.001081 },
      error: null,
    },
  };
  const run = runById(await finish((done) => ao.startAllocationRun('distA', done)));
  assert.equal(run.status, 'hitl_triggered');
  assert.equal(run.platformRunId, 'msg_877e4db1d96f');
  assert.equal(run.hitlReason, 'confidence 0.700 < floor 0.9');
  assert.equal(run.latencyMs, 3248);
  assert.equal(run.costUsd, 0.001081);
  assert.match(run.output!, /^## Allocation plan/);
  assert.deepEqual(run.plan!.sourcing, [{ orderId: '1046', supplierId: 'quickstock', qty: 6 }], 'held runs keep their plan as a draft');
});

test('supplier suggestions are sent once, only for completed runs', async () => {
  reply = { status: 200, body: { status: 'completed', confidence: 0.95, output: PLAN_OUTPUT } };
  const id = await finish((done) => ao.startAllocationRun('distA', done));

  assert.equal(tx(() => ao.sendSourcingSuggestions('distA', id)), 1);
  assert.equal(loadWorld().orders.find((o) => o.id === '1046')!.suggestedSupplierId, 'quickstock');
  assert.match(loadNotifications('retailer', 'patel')[0].message, /suggests QuickStock Traders/);
  assert.throws(() => tx(() => ao.sendSourcingSuggestions('distA', id)), /already sent/);

  reply = { status: 200, body: { status: 'hitl_triggered', confidence: 0.7, output: PLAN_OUTPUT } };
  const held = await finish((done) => ao.startAllocationRun('distA', done));
  assert.equal(runById(held).status, 'hitl_triggered');
  assert.throws(() => tx(() => ao.sendSourcingSuggestions('distA', held)), /Approve it in AgenticOrg/);
});

test('disruption run targets the Disruption Assistant and notifies on approval holds', async () => {
  const now = loadWorld().now;
  tx(() => cmd.reportDisruption('distA', '1042', { reason: 'road_closure', eta: addHours(now, 55), description: 'NH-48 closed' }));
  reply = { status: 200, body: { status: 'hitl_triggered', confidence: 0.6, output: { text: '**Impact: High**' } } };
  const id = await finish((done) => ao.startDisruptionRun('distA', '1042', done));

  assert.equal(requests[0].url, '/api/v1/agents/82c0d41d-ab8c-4d64-877c-4b5317b8ba21/run');
  assert.match(requests[0].body.inputs.task, /Road closure — NH-48 closed/);
  assert.equal(requests[0].body.context.orderId, '1042');
  const run = runById(id);
  assert.equal(run.orderId, '1042');
  assert.equal(run.output, '**Impact: High**', 'object outputs are reduced to their text');
  assert.match(loadNotifications('distributor', 'distA')[0].message, /needs your approval in AgenticOrg for order #1042/);

  assert.throws(() => ao.startDisruptionRun('distA', '1046', () => {}), /active disruption/);
});

test('API errors are stored as failed runs with a hint', async () => {
  reply = { status: 403, body: { detail: 'missing scope agents:run' } };
  const id = await finish((done) => ao.startAllocationRun('distA', done));
  const run = runById(id);
  assert.equal(run.status, 'failed');
  assert.match(run.error!, /AgenticOrg 403: missing scope agents:run\. Check AGENTICORG_API_KEY/);
});

test('a shortfall split across suppliers yields one suggestion per order', () => {
  const plan = {
    allocations: [],
    sourcing: [
      { orderId: '1043', supplierId: 'quickstock', qty: 12 },
      { orderId: '1043', supplierId: 'freshlink', qty: 18 },
      { orderId: '1046', supplierId: 'quickstock', qty: 6 },
      { orderId: '1049', supplierId: 'metromart', qty: 5 }, // delivered order: skipped
    ],
  };
  assert.deepEqual(ao.suggestionsToSend(plan, loadWorld()), [
    { orderId: '1043', supplierId: 'quickstock', qty: 12 },
    { orderId: '1046', supplierId: 'quickstock', qty: 6 },
  ]);
});

test('requests are rejected when the integration is not configured', () => {
  const key = process.env.AGENTICORG_API_KEY;
  delete process.env.AGENTICORG_API_KEY;
  try {
    assert.equal(ao.agenticorgStatus().enabled, false);
    assert.throws(() => ao.startAllocationRun('distA', () => {}), /not configured/);
  } finally {
    process.env.AGENTICORG_API_KEY = key;
  }
});
