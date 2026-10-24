import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'recoverroute-')), 'test.db');
delete process.env.OPENROUTER_API_KEY;

const { addHours, stockOf, stockoutRisk } = await import('../../shared/logic.ts');
const { seed } = await import('../src/seed.ts');
const cmd = await import('../src/commands.ts');
const { portalView } = await import('../src/views.ts');
const { tx } = await import('../src/db.ts');
const ai = await import('../src/ai.ts');

const run = <T>(fn: () => T) => tx(fn);
const dView = (id = 'distA') => portalView('distributor', id);
const rView = (id: string) => portalView('retailer', id);
const order = (v: ReturnType<typeof dView>, id: string) => v.orders.find((o) => o.id === id)!;
const inv = (v: ReturnType<typeof dView>, supplierId: string, productId: string) =>
  stockOf(v.suppliers.find((s) => s.id === supplierId)!, productId)?.qty;

beforeEach(() => seed());

test('portals only see their own orders', () => {
  assert.ok(dView('distA').orders.every((o) => o.distributorId === 'distA'));
  assert.deepEqual(rView('sharma').orders.map((o) => o.id), ['1042']);
  assert.throws(() => run(() => cmd.retailerRequest('patel', '1042', { request: 'wait' })), /not found/);
  assert.throws(() => run(() => cmd.updateEta('distB', '1042', { eta: '2099-01-01T10:00' })), /not found/);
});

test('disruption → alternative supplier → distributor confirms', () => {
  const now = dView().now;
  run(() => cmd.reportDisruption('distA', '1042', { reason: 'road_closure', eta: addHours(now, 55), description: 'NH-48 closed' }));
  const r = rView('sharma');
  const o = order(r, '1042');
  assert.equal(o.status, 'delayed');
  assert.ok(stockoutRisk(o, r.now).high, '8 cartons at 5/day should run out before a 55h ETA');
  assert.match(r.notifications[0].message, /delayed due to road closure/);

  run(() => cmd.retailerRequest('sharma', '1042', { request: 'alternative', supplierId: 'freshlink', qty: 20 }));
  assert.equal(order(dView(), '1042').request?.status, 'pending');

  run(() => cmd.respondToRequest('distA', '1042', { decision: 'confirm' }));
  const d = dView();
  assert.equal(order(d, '1042').status, 'rerouted');
  assert.equal(inv(d, 'freshlink', 'cola'), 20);
});

test('validation rejects bad input without changing data', () => {
  assert.throws(() => run(() => cmd.reportDisruption('distA', '1042', { reason: 'aliens', eta: '2099-01-01T10:00' })), /reason/);
  assert.throws(() => run(() => cmd.reportDisruption('distA', '1042', { reason: 'weather', eta: '2000-01-01T10:00' })), /future/);
  assert.throws(() => run(() => cmd.confirmAllocation('distA', { allocations: [{ orderId: '1046', qty: 13 }] })), /only 12 in stock/);
  assert.equal(order(dView(), '1046').allocatedQty, 0);
  assert.equal(inv(dView(), 'distA', 'cola'), 12);
});

test('allocation, dispatch and delivery update stock on both sides', () => {
  run(() => cmd.confirmAllocation('distA', { allocations: [{ orderId: '1048', qty: 10 }] }));
  let d = dView();
  assert.equal(order(d, '1048').status, 'allocated');
  assert.equal(inv(d, 'distA', 'detergent'), 30);

  const before = rView('greenbasket').stock.find((s) => s.productId === 'detergent')!.qty;
  run(() => cmd.advanceOrder('distA', '1048', { to: 'in_transit' }));
  run(() => cmd.advanceOrder('distA', '1048', { to: 'delivered' }));
  d = dView();
  assert.equal(order(d, '1048').status, 'delivered');
  const after = rView('greenbasket').stock.find((s) => s.productId === 'detergent')!.qty;
  assert.ok(Math.abs(after - (before + 10)) < 0.2, `shelf stock ${before} → ${after}`);
});

test('placing and cancelling an order returns allocated stock', () => {
  const id = run(() => cmd.placeOrder('sharma', { distributorId: 'distA', productId: 'atta', quantity: 10, paymentType: 'Prepaid' }));
  let d = dView();
  assert.equal(order(d, id).status, 'awaiting_allocation');
  assert.equal(order(d, id).unitPrice, 420);
  assert.match(d.notifications[0].message, new RegExp(`New order #${id}`));

  run(() => cmd.confirmAllocation('distA', { allocations: [{ orderId: id, qty: 10 }] }));
  assert.equal(inv(dView(), 'distA', 'atta'), 20);
  run(() => cmd.cancelOrder('sharma', id, { reason: 'Found it cheaper' }));
  d = dView();
  assert.equal(order(d, id).status, 'cancelled');
  assert.equal(inv(d, 'distA', 'atta'), 30);
  assert.throws(() => run(() => cmd.cancelOrder('patel', '1043', {})), /already shipped/);
});

test('declined partial fulfilment releases the reserved stock', () => {
  const now = dView().now;
  run(() => cmd.proposePartial('distA', '1043', { qty: 6, eta: addHours(now, 4) }));
  assert.equal(inv(dView(), 'distA', 'chips'), 4);
  run(() => cmd.respondToPartial('patel', '1043', { accept: false }));
  assert.equal(inv(dView(), 'distA', 'chips'), 10);
  assert.equal(order(dView(), '1043').partial?.status, 'declined');
});

test('messages notify the other party', () => {
  run(() => cmd.postMessage('retailer', 'patel', '1043', { body: 'Can you send 10 cases today?' }));
  const d = dView();
  assert.equal(d.messages.at(-1)?.body, 'Can you send 10 cases today?');
  assert.match(d.notifications[0].message, /Patel Kirana on order #1043/);
});

test('AI helpers fall back to rules without an API key', async () => {
  const draft = await ai.parseDisruption(dView(), '1046', 'Heavy rain and flooding, about 2 days late');
  assert.equal(draft.source, 'rules');
  assert.equal(draft.reason, 'weather');
  assert.ok(draft.eta);

  const advice = await ai.recoveryAdvice(rView('patel'), '1043');
  assert.equal(advice.source, 'rules');
  assert.ok(['alternative', 'wait', 'cancel'].includes(advice.recommendation));
});
