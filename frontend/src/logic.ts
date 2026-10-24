import { DEMO_NOW } from './data';
import type { AppState, DeliveryStatus, Order, Supplier } from './data';

const HOUR = 3_600_000;

export const toMs = (iso: string) => new Date(iso).getTime();

export function toLocalIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const addHours = (iso: string, hours: number) => toLocalIso(toMs(iso) + hours * HOUR);

export function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const money = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

export const days = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '∞');

export const findSupplier = (s: AppState, id: string) => s.suppliers.find((x) => x.id === id)!;
export const findRetailer = (s: AppState, id: string) => s.retailers.find((x) => x.id === id)!;
export const findProduct = (s: AppState, id: string) => s.products.find((x) => x.id === id)!;

export const stockOf = (supplier: Supplier, productId: string) =>
  supplier.inventory.find((i) => i.productId === productId);

export const isOpen = (o: Order) => o.status !== 'delivered' && o.status !== 'cancelled';

export interface Risk {
  daysOfStock: number;
  daysUntilDelivery: number;
  stockoutAt: string;
  high: boolean;
}

/** Estimated days remaining = current stock / average daily sales, compared with time until the current ETA. */
export function stockoutRisk(o: Order): Risk {
  const daysOfStock = o.avgDailySales > 0 ? o.retailerStock / o.avgDailySales : Infinity;
  const daysUntilDelivery = Math.max(0, (toMs(o.currentEta) - toMs(DEMO_NOW)) / (24 * HOUR));
  const stockoutAt = Number.isFinite(daysOfStock) ? addHours(DEMO_NOW, daysOfStock * 24) : '';
  return { daysOfStock, daysUntilDelivery, stockoutAt, high: isOpen(o) && daysOfStock <= daysUntilDelivery };
}

/** Quantity still to be covered after any accepted partial fulfilment. */
export const remainingNeed = (o: Order) =>
  o.quantity - (o.partial && o.partial.status !== 'declined' ? o.partial.qty : 0);

export interface SupplierOption {
  supplier: Supplier;
  available: number;
  price: number;
  eta: string;
  enoughStock: boolean;
  beforeStockout: boolean;
  qualifies: boolean;
  coverQty: number;
  rank: number;
}

/**
 * Ranking: (1) enough stock, (2) delivers before estimated stockout, (3) lowest price.
 * Suppliers that arrive in time but are short are kept as partial-fulfilment options.
 */
export function rankSuppliers(state: AppState, o: Order): SupplierOption[] {
  const need = remainingNeed(o);
  const risk = stockoutRisk(o);
  const options = state.suppliers
    .filter((s) => s.id !== o.distributorId)
    .flatMap((supplier) => {
      const item = stockOf(supplier, o.productId);
      if (!item || item.qty <= 0) return [];
      const eta = addHours(DEMO_NOW, supplier.deliveryHours);
      const enoughStock = item.qty >= need;
      const beforeStockout = !risk.stockoutAt || toMs(eta) <= toMs(risk.stockoutAt);
      return [
        {
          supplier,
          available: item.qty,
          price: item.price,
          eta,
          enoughStock,
          beforeStockout,
          qualifies: enoughStock && beforeStockout,
          coverQty: Math.min(item.qty, need),
          rank: 0,
        },
      ];
    });
  const tier = (x: SupplierOption) => (x.qualifies ? 0 : x.beforeStockout ? 1 : x.enoughStock ? 2 : 3);
  options.sort((a, b) => tier(a) - tier(b) || a.price - b.price);
  options.forEach((x, i) => (x.rank = i + 1));
  return options;
}

export interface AllocationLine {
  order: Order;
  need: number;
  daysOfStock: number;
  suggested: number;
  available: number;
}

/** Orders still needing stock from this distributor, most urgent (fewest days of stock) first. */
export function allocationPlan(state: AppState, distributorId: string): AllocationLine[] {
  const dist = findSupplier(state, distributorId);
  const pending = state.orders
    .filter((o) => o.distributorId === distributorId)
    .filter((o) => o.status === 'awaiting_allocation' || o.status === 'partially_allocated')
    .sort((a, b) => stockoutRisk(a).daysOfStock - stockoutRisk(b).daysOfStock);
  const left: Record<string, number> = {};
  dist.inventory.forEach((i) => (left[i.productId] = i.qty));
  return pending.map((order) => {
    const need = order.quantity - order.allocatedQty;
    const available = left[order.productId] ?? 0;
    const suggested = Math.min(need, available);
    left[order.productId] = available - suggested;
    return { order, need, daysOfStock: stockoutRisk(order).daysOfStock, suggested, available };
  });
}

export const STATUS_LABELS: Record<DeliveryStatus, string> = {
  awaiting_allocation: 'Awaiting allocation',
  partially_allocated: 'Partially allocated',
  allocated: 'Allocated · ready to dispatch',
  in_transit: 'In transit',
  delayed: 'Delayed',
  rerouted: 'Rerouted via alternative',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const STATUS_TONE: Record<DeliveryStatus, string> = {
  awaiting_allocation: 'neutral',
  partially_allocated: 'warning',
  allocated: 'info',
  in_transit: 'info',
  delayed: 'danger',
  rerouted: 'success',
  delivered: 'success',
  cancelled: 'neutral',
};

export function resolutionLabel(state: AppState, o: Order): { label: string; tone: string } {
  if (o.status === 'delivered') return { label: 'Fulfilled', tone: 'success' };
  const r = o.request;
  if (r) {
    const supplierName = r.supplierId ? findSupplier(state, r.supplierId).name : '';
    if (r.type === 'wait')
      return r.status === 'acknowledged'
        ? { label: 'Waiting for revised delivery (agreed)', tone: 'success' }
        : { label: 'Retailer will wait · awaiting acknowledgement', tone: 'warning' };
    if (r.type === 'alternative') {
      if (r.status === 'confirmed') return { label: `Alternative confirmed · ${supplierName}`, tone: 'success' };
      if (r.status === 'declined') return { label: 'Alternative request declined', tone: 'danger' };
      return { label: 'Alternative requested · awaiting distributor', tone: 'warning' };
    }
    if (r.type === 'cancel')
      return r.status === 'acknowledged'
        ? { label: 'Cancelled · refund request acknowledged (simulated)', tone: 'neutral' }
        : { label: 'Cancellation/refund requested', tone: 'warning' };
  }
  if (o.partial?.status === 'proposed') return { label: 'Partial fulfilment proposed', tone: 'warning' };
  if (o.status === 'delayed') return { label: 'Awaiting retailer decision', tone: 'danger' };
  if (o.partial?.status === 'accepted') return { label: 'Partial fulfilment accepted', tone: 'info' };
  return { label: 'No action needed', tone: 'neutral' };
}

/** Delayed orders, or orders with a retailer request the distributor hasn't answered yet. */
export function awaitingResolution(o: Order): boolean {
  if (!isOpen(o)) return false;
  if (o.request?.status === 'pending') return true;
  if (o.partial?.status === 'proposed') return true;
  if (o.status !== 'delayed') return false;
  return !o.request || o.request.status === 'declined';
}
