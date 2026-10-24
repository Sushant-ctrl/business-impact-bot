// Demo seed. Timestamps are written relative to a fixed anchor and shifted so the anchor lands on the current hour,
// which keeps the scenario (delays, stockout risk) meaningful whenever the data is (re)seeded.
import { toLocalIso, toMs } from '../../shared/logic.ts';
import type { Order, Retailer, RetailerStock, Supplier, TimelineEvent } from '../../shared/types.ts';
import {
  addEvent,
  addMessage,
  addNotification,
  clearAll,
  insertOrder,
  insertProduct,
  insertRetailer,
  insertSupplier,
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
  { id: 'chabra', name: 'Chabra Stores', area: 'Hadapsar', distributorIds: ['distA', 'distB'] },
  { id: 'pawan', name: 'Pawan Kirana', area: 'Kothrud', distributorIds: ['distA', 'distB'] },
  { id: 'shubham', name: 'Shubham Mart', area: 'Wakad', distributorIds: ['distA', 'distB'] },
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
  ['chabra', 'cola', 12, 4],
  ['chabra', 'atta', 10, 2],
  ['pawan', 'chips', 9, 3],
  ['pawan', 'detergent', 5, 1],
  ['shubham', 'mango', 14, 3],
  ['shubham', 'chips', 16, 4],
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
