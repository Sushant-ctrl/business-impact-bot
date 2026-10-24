// Demo seed. Timestamps are written relative to a fixed anchor and shifted so the anchor lands on the current hour,
// which keeps the scenario (delays, stockout risk) meaningful whenever the data is (re)seeded.
import { toLocalIso, toMs } from '../../shared/logic.ts';
import type { AgentDecision, AgentKind, AgentPlan, AgentRunStatus, Order, Retailer, RetailerStock, Supplier, TimelineEvent } from '../../shared/types.ts';
import { agenticorgStatus } from './agenticorg.ts';
import {
  addEvent,
  addMessage,
  addNotification,
  clearAll,
  finishAgentRun,
  insertAgentRun,
  insertOrder,
  insertProduct,
  insertRetailer,
  insertSupplier,
  recordAgentDecision,
  recordAppliedPlan,
  saveRetailerStock,
  tx,
} from './db.ts';

const ANCHOR = '2026-10-29T09:00';

const products = [
  { id: 'cola', name: 'Fizz Cola 24×300ml', unit: 'cartons', category: 'Beverages' },
  { id: 'mango', name: 'Sunny Mango Juice 12×1L', unit: 'cartons', category: 'Beverages' },
  { id: 'chips', name: 'Crunchy Salted Chips 48-pack', unit: 'cases', category: 'Packaged snacks' },
  { id: 'detergent', name: 'BrightWash Detergent 1kg ×12', unit: 'cases', category: 'Household essentials' },
  { id: 'atta', name: 'GoldHarvest Atta 10kg', unit: 'bags', category: 'Staples' },
];

const suppliers: Supplier[] = [
  {
    id: 'distA',
    name: 'Distributor A · Apex Distribution',
    kind: 'distributor',
    city: 'Pune East',
    deliveryHours: 24,
    inventory: [
      { productId: 'cola', qty: 12, price: 500 },
      { productId: 'chips', qty: 10, price: 400 },
      { productId: 'detergent', qty: 40, price: 1150 },
      { productId: 'mango', qty: 8, price: 620 },
      { productId: 'atta', qty: 30, price: 420 },
    ],
  },
  {
    id: 'distB',
    name: 'Distributor B · Horizon Traders',
    kind: 'distributor',
    city: 'Pune West',
    deliveryHours: 34,
    inventory: [
      { productId: 'cola', qty: 20, price: 520 },
      { productId: 'chips', qty: 25, price: 410 },
      { productId: 'mango', qty: 30, price: 640 },
      { productId: 'detergent', qty: 10, price: 1180 },
      { productId: 'atta', qty: 12, price: 435 },
    ],
  },
  {
    id: 'freshlink',
    name: 'FreshLink Wholesale',
    kind: 'alternative',
    city: 'Hadapsar',
    deliveryHours: 20,
    inventory: [
      { productId: 'cola', qty: 40, price: 565 },
      { productId: 'chips', qty: 35, price: 430 },
      { productId: 'mango', qty: 12, price: 660 },
    ],
  },
  {
    id: 'metromart',
    name: 'MetroMart Cash & Carry',
    kind: 'alternative',
    city: 'Chakan',
    deliveryHours: 60,
    inventory: [
      { productId: 'cola', qty: 50, price: 485 },
      { productId: 'chips', qty: 60, price: 365 },
      { productId: 'mango', qty: 45, price: 600 },
      { productId: 'detergent', qty: 30, price: 1100 },
      { productId: 'atta', qty: 80, price: 399 },
    ],
  },
  {
    id: 'quickstock',
    name: 'QuickStock Traders',
    kind: 'alternative',
    city: 'Kothrud',
    deliveryHours: 18,
    inventory: [
      { productId: 'cola', qty: 8, price: 505 },
      { productId: 'chips', qty: 12, price: 385 },
      { productId: 'detergent', qty: 15, price: 1170 },
      { productId: 'atta', qty: 20, price: 445 },
    ],
  },
];

const retailers: Retailer[] = [
  { id: 'sharma', name: 'Sharma General Store', area: 'Viman Nagar', distributorIds: ['distA', 'distB'] },
  { id: 'patel', name: 'Patel Kirana', area: 'Kharadi', distributorIds: ['distA', 'distB'] },
  { id: 'citymart', name: 'City Mart Express', area: 'Baner', distributorIds: ['distA', 'distB'] },
  { id: 'greenbasket', name: 'Green Basket Supermarket', area: 'Aundh', distributorIds: ['distA', 'distB'] },
];

// [retailer, product, qty on shelf at the anchor, average daily sales]
const shelf: [string, string, number, number][] = [
  ['sharma', 'cola', 8, 5],
  ['sharma', 'chips', 14, 3],
  ['sharma', 'atta', 9, 2],
  ['patel', 'chips', 6, 4],
  ['patel', 'cola', 4, 3],
  ['patel', 'detergent', 7, 1],
  ['citymart', 'cola', 25, 4],
  ['citymart', 'chips', 20, 5],
  ['citymart', 'mango', 11, 3],
  ['greenbasket', 'mango', 10, 4],
  ['greenbasket', 'detergent', 3, 1.5],
  ['greenbasket', 'atta', 15, 3],
];

type SeedOrder = Omit<Order, 'retailerStock' | 'avgDailySales' | 'timeline'> & {
  timeline: Omit<TimelineEvent, 'id'>[];
};

const placed = (at: string): Omit<TimelineEvent, 'id'> => ({ at, label: 'Order placed', actor: 'retailer' });

const orders: SeedOrder[] = [
  {
    id: '1042',
    retailerId: 'sharma',
    distributorId: 'distA',
    productId: 'cola',
    quantity: 20,
    allocatedQty: 20,
    unitPrice: 500,
    paymentType: 'Prepaid',
    placedAt: '2026-10-27T11:30',
    originalEta: '2026-10-30T10:00',
    currentEta: '2026-10-30T10:00',
    status: 'in_transit',
    timeline: [
      placed('2026-10-27T11:30'),
      { at: '2026-10-27T11:32', label: 'Payment received (prepaid)', actor: 'system' },
      { at: '2026-10-27T11:55', label: 'Stock allocated', detail: '20 cartons (20/20 total)', actor: 'distributor' },
      { at: '2026-10-29T06:15', label: 'Dispatched from Apex warehouse', actor: 'distributor' },
    ],
  },
  {
    id: '1043',
    retailerId: 'patel',
    distributorId: 'distA',
    productId: 'chips',
    quantity: 30,
    allocatedQty: 30,
    unitPrice: 400,
    paymentType: 'COD',
    placedAt: '2026-10-26T16:00',
    originalEta: '2026-10-29T18:00',
    currentEta: '2026-10-31T12:00',
    status: 'delayed',
    disruption: {
      reason: 'vehicle_breakdown',
      description: 'Truck MH-12 broke down near Shikrapur; replacement vehicle arranged.',
      reportedAt: '2026-10-29T07:40',
    },
    timeline: [
      placed('2026-10-26T16:00'),
      { at: '2026-10-28T20:00', label: 'Dispatched from Apex warehouse', actor: 'distributor' },
      { at: '2026-10-29T07:40', label: 'Disruption reported', detail: 'Vehicle breakdown', actor: 'distributor' },
      { at: '2026-10-29T07:40', label: 'Revised ETA recorded', detail: '+42 hours', actor: 'distributor' },
      { at: '2026-10-29T07:41', label: 'Retailer notified', actor: 'system' },
    ],
  },
  {
    id: '1045',
    retailerId: 'greenbasket',
    distributorId: 'distB',
    productId: 'mango',
    quantity: 25,
    allocatedQty: 25,
    unitPrice: 640,
    paymentType: 'Prepaid',
    placedAt: '2026-10-26T10:00',
    originalEta: '2026-10-30T12:00',
    currentEta: '2026-11-01T11:00',
    status: 'delayed',
    disruption: {
      reason: 'weather',
      description: 'Heavy rain on the ghat section; convoy held by authorities.',
      reportedAt: '2026-10-29T08:10',
    },
    timeline: [
      placed('2026-10-26T10:00'),
      { at: '2026-10-26T10:02', label: 'Payment received (prepaid)', actor: 'system' },
      { at: '2026-10-28T22:00', label: 'Dispatched from Horizon warehouse', actor: 'distributor' },
      { at: '2026-10-29T08:10', label: 'Disruption reported', detail: 'Weather', actor: 'distributor' },
      { at: '2026-10-29T08:10', label: 'Revised ETA recorded', detail: '+47 hours', actor: 'distributor' },
      { at: '2026-10-29T08:11', label: 'Retailer notified', actor: 'system' },
    ],
  },
  {
    id: '1046',
    retailerId: 'patel',
    distributorId: 'distA',
    productId: 'cola',
    quantity: 18,
    allocatedQty: 0,
    unitPrice: 500,
    paymentType: 'COD',
    placedAt: '2026-10-28T09:15',
    originalEta: '2026-10-31T10:00',
    currentEta: '2026-10-31T10:00',
    status: 'awaiting_allocation',
    timeline: [placed('2026-10-28T09:15')],
  },
  {
    id: '1047',
    retailerId: 'citymart',
    distributorId: 'distA',
    productId: 'cola',
    quantity: 15,
    allocatedQty: 0,
    unitPrice: 500,
    paymentType: 'Prepaid',
    placedAt: '2026-10-28T14:40',
    originalEta: '2026-11-01T10:00',
    currentEta: '2026-11-01T10:00',
    status: 'awaiting_allocation',
    timeline: [
      placed('2026-10-28T14:40'),
      { at: '2026-10-28T14:41', label: 'Payment received (prepaid)', actor: 'system' },
    ],
  },
  {
    id: '1048',
    retailerId: 'greenbasket',
    distributorId: 'distA',
    productId: 'detergent',
    quantity: 10,
    allocatedQty: 0,
    unitPrice: 1150,
    paymentType: 'COD',
    placedAt: '2026-10-28T17:20',
    originalEta: '2026-10-30T15:00',
    currentEta: '2026-10-30T15:00',
    status: 'awaiting_allocation',
    timeline: [placed('2026-10-28T17:20')],
  },
  {
    id: '1049',
    retailerId: 'citymart',
    distributorId: 'distB',
    productId: 'chips',
    quantity: 12,
    allocatedQty: 12,
    unitPrice: 410,
    paymentType: 'COD',
    placedAt: '2026-10-25T12:00',
    originalEta: '2026-10-27T10:00',
    currentEta: '2026-10-27T10:00',
    status: 'delivered',
    timeline: [
      placed('2026-10-25T12:00'),
      { at: '2026-10-26T08:00', label: 'Stock allocated', detail: '12 cases (12/12 total)', actor: 'distributor' },
      { at: '2026-10-26T18:00', label: 'Dispatched from Horizon warehouse', actor: 'distributor' },
      { at: '2026-10-27T09:40', label: 'Fulfilment confirmed', detail: 'Delivered to retailer', actor: 'distributor' },
    ],
  },
];

// AgenticOrg history showing the human in the loop: runs held for approval and approved or rejected (with the
// distributor's reason), a plan the distributor overrode before applying, one applied as proposed, and a current plan
// still waiting for a decision. Listed oldest first; the last allocation run per distributor is the one on screen.
type SeedRun = {
  kind: AgentKind;
  distributorId: string;
  orderId?: string;
  createdAt: string;
  finishedAt: string;
  status: AgentRunStatus;
  confidence: number;
  platformRunId: string;
  latencyMs: number;
  costUsd: number;
  output: string;
  plan?: AgentPlan;
  decision?: { decision: AgentDecision; at: string; note?: string };
  applied?: { at: string; allocations: AgentPlan['allocations'] };
};

const agentRuns: SeedRun[] = [
  {
    kind: 'allocation',
    distributorId: 'distB',
    createdAt: '2026-10-26T07:50',
    finishedAt: '2026-10-26T07:51',
    status: 'completed',
    confidence: 0.93,
    platformRunId: 'msg_3f1a9c20b7d4',
    latencyMs: 11820,
    costUsd: 0.001732,
    output: `## Allocation plan

| Priority | Order | Retailer | Product | Need | Allocate | Days of cover |
|---|---|---|---|---|---|---|
| 1 | #1049 | City Mart Express | Crunchy Salted Chips 48-pack | 12 | 12 | 4.6 |

Warehouse has 37 cases of chips, so #1049 is covered in full. No alternate sourcing needed.

**Approval summary:** 12 cases from own stock at ₹410, no premium. Nothing committed.`,
    plan: { allocations: [{ orderId: '1049', qty: 12 }], sourcing: [] },
    applied: { at: '2026-10-26T08:00', allocations: [{ orderId: '1049', qty: 12 }] },
  },
  {
    kind: 'allocation',
    distributorId: 'distA',
    createdAt: '2026-10-27T11:45',
    finishedAt: '2026-10-27T11:46',
    status: 'hitl_triggered',
    confidence: 0.7,
    platformRunId: 'msg_8c27e05a41f9',
    latencyMs: 12940,
    costUsd: 0.001966,
    output: `## Allocation plan

| Priority | Order | Retailer | Product | Need | Allocate |
|---|---|---|---|---|---|
| 1 | #1042 | Sharma General Store | Fizz Cola 24×300ml | 20 | 16 |

Hold back **4 cartons** of the 32 in stock: Patel Kirana has about 1.3 days of cola left and usually reorders midweek.
Sharma still has about 3.5 days of cover, so a short delivery of 16 is safe.

**Approval summary:** 16 cartons to #1042 (₹8,000). 4 cartons reserved. Needs distributor approval.`,
    plan: { allocations: [{ orderId: '1042', qty: 16 }], sourcing: [] },
    decision: {
      decision: 'approved',
      at: '2026-10-27T11:52',
      note: 'Approving the plan, but Sharma prepaid for 20, so they get all 20. Patel’s next order comes out of Thursday’s inbound.',
    },
    applied: { at: '2026-10-27T11:55', allocations: [{ orderId: '1042', qty: 20 }] },
  },
  {
    kind: 'disruption',
    distributorId: 'distA',
    orderId: '1043',
    createdAt: '2026-10-29T07:40',
    finishedAt: '2026-10-29T07:41',
    status: 'hitl_triggered',
    confidence: 0.7,
    platformRunId: 'msg_51be7d93c0a2',
    latencyMs: 8710,
    costUsd: 0.001288,
    output: `## Disruption card · Order #1043

**Impact: High.** Patel Kirana has 6 cases of chips and sells 4/day (≈ 1.5 days of cover). The revised ETA is ≈ 2.2 days
away, so they run out about 16 hours before the replacement truck arrives. Estimated lost sales: ≈ 2.7 cases (₹1,080).

**Suggested recovery**
1. Ask FreshLink Wholesale (Hadapsar, 20 h) for a 10-case top-up at ₹430.
2. Or offer an emergency partial of 10 cases from the Apex warehouse.

**Message to retailer**
> Hi Patel ji, our truck with your 30 cases of chips broke down near Shikrapur. A replacement leaves tomorrow night. We can send 10 cases sooner so you don't run out. Shall we?`,
    decision: { decision: 'approved', at: '2026-10-29T07:44', note: 'Card is right. Messaging Patel myself about the replacement truck.' },
  },
  {
    kind: 'disruption',
    distributorId: 'distB',
    orderId: '1045',
    createdAt: '2026-10-29T08:10',
    finishedAt: '2026-10-29T08:11',
    status: 'hitl_triggered',
    confidence: 0.65,
    platformRunId: 'msg_c4092fe61b38',
    latencyMs: 10350,
    costUsd: 0.001517,
    output: `## Disruption card · Order #1045

**Impact: Medium.** Green Basket has 10 cartons of mango juice and sells 4/day (≈ 2.5 days of cover). The convoy is held
on the ghat; revised ETA ≈ 3.1 days away.

**Suggested recovery**
1. Order a 15-carton top-up from MetroMart Cash & Carry at ₹600, **delivered within 24 hours**.

**Message to retailer**
> Hi, heavy rain has held our convoy on the ghat. We're arranging 15 cartons from MetroMart, arriving tomorrow.`,
    decision: {
      decision: 'rejected',
      at: '2026-10-29T08:25',
      note: 'MetroMart is in Chakan with 60 h delivery, not 24 h, so it would land after our convoy. Calling Green Basket instead.',
    },
  },
  {
    kind: 'allocation',
    distributorId: 'distA',
    createdAt: '2026-10-29T08:30',
    finishedAt: '2026-10-29T08:31',
    status: 'hitl_triggered',
    confidence: 0.7,
    platformRunId: 'msg_877e4db1d96f',
    latencyMs: 13374,
    costUsd: 0.002119,
    output: `## Allocation plan

| Priority | Order | Retailer | Product | Need | Allocate | Days of cover |
|---|---|---|---|---|---|---|
| 1 | #1046 | Patel Kirana | Fizz Cola 24×300ml | 18 | 12 | 1.3 |
| 2 | #1048 | Green Basket Supermarket | BrightWash Detergent 1kg ×12 | 10 | 10 | 2.0 |
| 3 | #1047 | City Mart Express | Fizz Cola 24×300ml | 15 | 0 | 6.3 |

## Alternate sourcing

| Order | Shortfall | Supplier | Qty | Price | Arrives |
|---|---|---|---|---|---|
| #1046 | 6 | QuickStock Traders | 6 | ₹505 | ≈ 18 h, before stockout |
| #1047 | 15 | MetroMart Cash & Carry | 15 | ₹485 | ≈ 60 h, before stockout |
| #1043 (delayed) | — | FreshLink Wholesale | 10 | ₹430 | ≈ 20 h, before stockout |

**Approval summary:** 22 units from own stock; 31 units from alternates for ₹14,605. Nothing committed.`,
    plan: {
      allocations: [
        { orderId: '1046', qty: 12 },
        { orderId: '1048', qty: 10 },
        { orderId: '1047', qty: 0 },
      ],
      sourcing: [
        { orderId: '1046', supplierId: 'quickstock', qty: 6 },
        { orderId: '1047', supplierId: 'metromart', qty: 15 },
        { orderId: '1043', supplierId: 'freshlink', qty: 10 },
      ],
    },
  },
];

export function seed() {
  const shift = toMs(currentHour()) - toMs(ANCHOR);
  const t = (iso: string) => toLocalIso(toMs(iso) + shift);
  const now = t(ANCHOR);

  tx(() => {
    clearAll();
    products.forEach(insertProduct);
    suppliers.forEach((s) => insertSupplier(structuredClone(s)));
    retailers.forEach(insertRetailer);
    shelf.forEach(([retailerId, productId, qty, avgDailySales]) =>
      saveRetailerStock({ retailerId, productId, qty, avgDailySales, countedAt: now } satisfies RetailerStock),
    );

    for (const { timeline, ...o } of orders) {
      insertOrder({
        ...o,
        placedAt: t(o.placedAt),
        originalEta: t(o.originalEta),
        currentEta: t(o.currentEta),
        disruption: o.disruption && { ...o.disruption, reportedAt: t(o.disruption.reportedAt) },
        retailerStock: 0,
        avgDailySales: 0,
        timeline: [],
      });
      timeline.forEach((e) => addEvent(o.id, t(e.at), e.label, e.actor, e.detail));
    }

    addNotification({
      role: 'retailer',
      partyId: 'patel',
      orderId: '1043',
      message:
        'Your order #1043 has been delayed due to a vehicle breakdown. A replacement truck is on the way — check your recovery options.',
      at: t('2026-10-29T07:41'),
      tone: 'warning',
    });
    addNotification({
      role: 'retailer',
      partyId: 'greenbasket',
      orderId: '1045',
      message: 'Your order #1045 has been delayed due to weather on the ghat section. Check your recovery options.',
      at: t('2026-10-29T08:11'),
      tone: 'warning',
    });
    addNotification({
      role: 'distributor',
      partyId: 'distA',
      orderId: '1046',
      message: 'New order #1046 from Patel Kirana: 18 cartons of Fizz Cola 24×300ml (COD).',
      at: t('2026-10-28T09:15'),
      tone: 'info',
    });
    const agents = agenticorgStatus().agents;
    for (const r of agentRuns) {
      const id = insertAgentRun({ kind: r.kind, agentId: agents[r.kind].id, distributorId: r.distributorId, orderId: r.orderId, createdAt: t(r.createdAt) });
      finishAgentRun(id, {
        status: r.status,
        confidence: r.confidence,
        output: r.output,
        plan: r.plan,
        finishedAt: t(r.finishedAt),
        platformRunId: r.platformRunId,
        hitlReason: r.status === 'hitl_triggered' ? `confidence ${r.confidence.toFixed(3)} < floor 0.9` : undefined,
        latencyMs: r.latencyMs,
        costUsd: r.costUsd,
      });
      if (r.decision) recordAgentDecision(id, r.decision.decision, t(r.decision.at), r.decision.note);
      if (r.applied) recordAppliedPlan(id, r.applied.allocations, t(r.applied.at));
    }
    addNotification({
      role: 'distributor',
      partyId: 'distA',
      orderId: '1046',
      message: 'Stock Allocation & Alternate Sourcing Agent needs your approval: plan for orders #1046, #1047 and #1048.',
      at: t('2026-10-29T08:31'),
      tone: 'warning',
    });

    addMessage({
      orderId: '1043',
      role: 'distributor',
      body: 'Replacement truck leaves Shikrapur tomorrow night. Sorry for the trouble — tell us if you need a top-up sooner.',
      at: t('2026-10-29T07:45'),
    });
  });
}

function currentHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return toLocalIso(d.getTime());
}
