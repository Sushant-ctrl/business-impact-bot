// Domain types shared by the server and the portals. All times are local-time ISO strings ("YYYY-MM-DDTHH:mm").

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
export type RequestType = 'wait' | 'alternative' | 'cancel';

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
  distributorIds: string[]; // distributors this retailer can order from
}

/** A retailer's shelf stock. `qty` is the server's current estimate (last count minus sales since). */
export interface RetailerStock {
  retailerId: string;
  productId: string;
  qty: number;
  avgDailySales: number;
  countedAt: string;
}

export interface TimelineEvent {
  id: string;
  at: string;
  label: string;
  detail?: string;
  actor: 'system' | 'distributor' | 'retailer';
}

export interface RecoveryRequest {
  type: RequestType;
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

export interface Disruption {
  reason: DisruptionReason;
  description?: string;
  reportedAt: string;
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
  disruption?: Disruption;
  // Filled from the retailer's current stock of this product when the view is built.
  retailerStock: number;
  avgDailySales: number;
  request?: RecoveryRequest;
  partial?: PartialProposal;
  suggestedSupplierId?: string;
  cancelReason?: string;
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

export interface Message {
  id: string;
  orderId: string;
  role: Role;
  body: string;
  at: string;
}

/** Everything the domain logic needs to compute risk, rankings and allocation plans. */
export interface World {
  now: string;
  products: Product[];
  suppliers: Supplier[];
  retailers: Retailer[];
  orders: Order[];
}

/** What a portal receives: the world scoped to one distributor or retailer. */
export interface PortalView extends World {
  role: Role;
  partyId: string;
  stock: RetailerStock[];
  notifications: Notification[];
  messages: Message[];
  ai: { enabled: boolean; model: string };
}

export interface Accounts {
  distributors: { id: string; name: string; city: string }[];
  retailers: { id: string; name: string; area: string }[];
}

export const REASON_LABELS: Record<DisruptionReason, string> = {
  road_closure: 'Road closure',
  weather: 'Weather',
  vehicle_breakdown: 'Vehicle breakdown',
  warehouse_delay: 'Warehouse delay',
  other: 'Other',
};
