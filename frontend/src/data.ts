// Types and seed data for the demo. All times are local-time ISO strings ("YYYY-MM-DDTHH:mm").

export type Role = 'distributor' | 'retailer';
export type PaymentType = 'COD' | 'Prepaid';
export type DeliveryStatus =
  | 'awaiting_allocation'
  | 'partially_allocated'
  | 'allocated'
  | 'in_transit'
  | 'delayed'
  | 'rerouted'
  | 'delivered'
  | 'cancelled';
export type DisruptionReason = 'road_closure' | 'weather' | 'vehicle_breakdown' | 'warehouse_delay' | 'other';

export interface Product {
  id: string;
  name: string;
  unit: string;
  category: string;
}

export interface InventoryItem {
  productId: string;
  qty: number;
  price: number;
}

export interface Supplier {
  id: string;
  name: string;
  kind: 'distributor' | 'alternative';
  city: string;
  deliveryHours: number; // typical lead time to retailers in the area
  inventory: InventoryItem[];
}

export interface Retailer {
  id: string;
  name: string;
  area: string;
}

export interface TimelineEvent {
  id: string;
  at: string;
  label: string;
  detail?: string;
  actor: 'system' | 'distributor' | 'retailer';
}

export interface RecoveryRequest {
  type: 'wait' | 'alternative' | 'cancel';
  supplierId?: string;
  qty?: number;
  eta?: string;
  status: 'pending' | 'confirmed' | 'acknowledged' | 'declined';
  createdAt: string;
}

export interface PartialProposal {
  qty: number;
  eta: string;
  status: 'proposed' | 'accepted' | 'declined';
}

export interface Order {
  id: string;
  retailerId: string;
  distributorId: string;
  productId: string;
  quantity: number;
  allocatedQty: number;
  unitPrice: number;
  paymentType: PaymentType;
  placedAt: string;
  originalEta: string;
  currentEta: string;
  status: DeliveryStatus;
  disruption?: { reason: DisruptionReason; description?: string; reportedAt: string };
  retailerStock: number;
  avgDailySales: number;
  request?: RecoveryRequest;
  partial?: PartialProposal;
  suggestedSupplierId?: string;
  timeline: TimelineEvent[];
}

export interface Notification {
  id: string;
  role: Role;
  partyId: string;
  orderId: string;
  message: string;
  at: string;
  read: boolean;
  tone: 'info' | 'warning' | 'success';
}

export interface AppState {
  clock: string; // demo clock, advances a couple of minutes per action
  seq: number;
  products: Product[];
  suppliers: Supplier[];
  retailers: Retailer[];
  orders: Order[];
  notifications: Notification[];
}

// Stockout and ETA maths are measured from this fixed moment so the demo is reproducible.
export const DEMO_NOW = '2026-10-29T09:00';

export const REASON_LABELS: Record<DisruptionReason, string> = {
  road_closure: 'Road closure',
  weather: 'Weather',
  vehicle_breakdown: 'Vehicle breakdown',
  warehouse_delay: 'Warehouse delay',
  other: 'Other',
};

const products: Product[] = [
  { id: 'cola', name: 'Fizz Cola 24×300ml', unit: 'cartons', category: 'Beverages' },
  { id: 'mango', name: 'Sunny Mango Juice 12×1L', unit: 'cartons', category: 'Beverages' },
  { id: 'chips', name: 'Crunchy Salted Chips 48-pack', unit: 'cases', category: 'Packaged snacks' },
  { id: 'detergent', name: 'BrightWash Detergent 1kg ×12', unit: 'cases', category: 'Household essentials' },
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
    ],
  },
];

const retailers: Retailer[] = [
  { id: 'sharma', name: 'Sharma General Store', area: 'Viman Nagar' },
  { id: 'patel', name: 'Patel Kirana', area: 'Kharadi' },
  { id: 'citymart', name: 'City Mart Express', area: 'Baner' },
  { id: 'greenbasket', name: 'Green Basket Supermarket', area: 'Aundh' },
];

const placed = (id: string, at: string): TimelineEvent[] => [
  { id: `${id}-placed`, at, label: 'Order placed', actor: 'retailer' },
];

const orders: Order[] = [
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
    retailerStock: 8,
    avgDailySales: 5,
    timeline: [
      ...placed('1042', '2026-10-27T11:30'),
      { id: '1042-pay', at: '2026-10-27T11:32', label: 'Payment received (prepaid)', actor: 'system' },
      { id: '1042-disp', at: '2026-10-29T06:15', label: 'Dispatched from Apex warehouse', actor: 'distributor' },
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
    retailerStock: 6,
    avgDailySales: 4,
    timeline: [
      ...placed('1043', '2026-10-26T16:00'),
      { id: '1043-disp', at: '2026-10-28T20:00', label: 'Dispatched from Apex warehouse', actor: 'distributor' },
      { id: '1043-dis', at: '2026-10-29T07:40', label: 'Disruption reported', detail: 'Vehicle breakdown', actor: 'distributor' },
      { id: '1043-eta', at: '2026-10-29T07:40', label: 'Revised ETA recorded', detail: 'Sat 31 Oct, 12:00 pm', actor: 'distributor' },
      { id: '1043-not', at: '2026-10-29T07:41', label: 'Retailer notified', actor: 'system' },
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
    retailerStock: 10,
    avgDailySales: 4,
    timeline: [
      ...placed('1045', '2026-10-26T10:00'),
      { id: '1045-pay', at: '2026-10-26T10:02', label: 'Payment received (prepaid)', actor: 'system' },
      { id: '1045-disp', at: '2026-10-28T22:00', label: 'Dispatched from Horizon warehouse', actor: 'distributor' },
      { id: '1045-dis', at: '2026-10-29T08:10', label: 'Disruption reported', detail: 'Weather', actor: 'distributor' },
      { id: '1045-eta', at: '2026-10-29T08:10', label: 'Revised ETA recorded', detail: 'Sun 1 Nov, 11:00 am', actor: 'distributor' },
      { id: '1045-not', at: '2026-10-29T08:11', label: 'Retailer notified', actor: 'system' },
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
    retailerStock: 4,
    avgDailySales: 3,
    timeline: placed('1046', '2026-10-28T09:15'),
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
    retailerStock: 25,
    avgDailySales: 4,
    timeline: [
      ...placed('1047', '2026-10-28T14:40'),
      { id: '1047-pay', at: '2026-10-28T14:41', label: 'Payment received (prepaid)', actor: 'system' },
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
    retailerStock: 3,
    avgDailySales: 1.5,
    timeline: placed('1048', '2026-10-28T17:20'),
  },
];

const notifications: Notification[] = [
  {
    id: 'n-seed-1',
    role: 'retailer',
    partyId: 'patel',
    orderId: '1043',
    message:
      'Your order #1043 has been delayed due to a vehicle breakdown. Revised ETA: Sat 31 Oct, 12:00 pm. Check available recovery options.',
    at: '2026-10-29T07:41',
    read: false,
    tone: 'warning',
  },
  {
    id: 'n-seed-2',
    role: 'retailer',
    partyId: 'greenbasket',
    orderId: '1045',
    message:
      'Your order #1045 has been delayed due to weather. Revised ETA: Sun 1 Nov, 11:00 am. Check available recovery options.',
    at: '2026-10-29T08:11',
    read: false,
    tone: 'warning',
  },
];

export function seedState(): AppState {
  // Deep copy so reducer mutations of a fresh state never touch the seed.
  return structuredClone({
    clock: DEMO_NOW,
    seq: 1,
    products,
    suppliers,
    retailers,
    orders,
    notifications,
  });
}
