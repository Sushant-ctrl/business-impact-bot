// Every state change in the system. Each command validates its input and ownership, applies the domain rules, and
// records timeline events and notifications for the other party.
import {
  addHours,
  days,
  findProduct,
  findRetailer,
  findSupplier,
  fmt,
  isOpen,
  isPreDispatch,
  remainingNeed,
  stockOf,
  stockoutRisk,
  toLocalIso,
  toMs,
} from '../../shared/logic.ts';
import { REASON_LABELS } from '../../shared/types.ts';
import type {
  DisruptionReason,
  Notification,
  Order,
  PaymentType,
  RecoveryRequest,
  RequestType,
  Role,
  TimelineEvent,
  World,
} from '../../shared/types.ts';
import * as repo from './db.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (message: string) => new HttpError(400, message);
const conflict = (message: string) => new HttpError(409, message);

/** Loads the world and returns helpers that write events/notifications stamped with the current time. */
function begin() {
  const w = repo.loadWorld();
  return {
    w,
    now: w.now,
    event(o: Order, label: string, actor: TimelineEvent['actor'], detail?: string) {
      repo.addEvent(o.id, w.now, label, actor, detail);
    },
    notify(role: Role, partyId: string, orderId: string, message: string, tone: Notification['tone'] = 'info') {
      repo.addNotification({ role, partyId, orderId, message, at: w.now, tone });
    },
  };
}

function ownedOrder(w: World, role: Role, partyId: string, orderId: string): Order {
  const o = w.orders.find((x) => x.id === orderId);
  if (!o || (role === 'distributor' ? o.distributorId : o.retailerId) !== partyId)
    throw new HttpError(404, `Order #${orderId} not found`);
  return o;
}

function requireDistributor(w: World, id: string) {
  const d = w.suppliers.find((s) => s.id === id && s.kind === 'distributor');
  if (!d) throw new HttpError(404, `Distributor ${id} not found`);
  return d;
}

function requireRetailer(w: World, id: string) {
  const r = w.retailers.find((x) => x.id === id);
  if (!r) throw new HttpError(404, `Retailer ${id} not found`);
  return r;
}

const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v);
const wholeNumber = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;

function futureEta(eta: unknown, now: string, field = 'ETA'): string {
  if (!isIso(eta)) throw bad(`${field} must be a date and time (YYYY-MM-DDTHH:mm).`);
  if (toMs(eta) <= toMs(now)) throw bad(`${field} must be in the future.`);
  return eta;
}

function shortText(v: unknown, max: number, field: string): string | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') throw bad(`${field} must be text.`);
  const t = v.trim();
  if (t.length > max) throw bad(`${field} must be at most ${max} characters.`);
  return t || undefined;
}

/** Returns allocated stock (and any reserved partial quantity) to the distributor's warehouse. */
function releaseReservedStock(w: World, o: Order) {
  const dist = findSupplier(w, o.distributorId);
  const item = stockOf(dist, o.productId);
  if (!item) return;
  const reserved = o.allocatedQty + (o.partial?.status === 'proposed' ? o.partial.qty : 0);
  if (reserved <= 0) return;
  item.qty += reserved;
  repo.saveInventory(dist.id, item);
  o.allocatedQty = 0;
}

// ---------------------------------------------------------------- distributor

export function reportDisruption(
  distributorId: string,
  orderId: string,
  body: { reason?: unknown; eta?: unknown; description?: unknown; message?: unknown },
) {
  const c = begin();
  const o = ownedOrder(c.w, 'distributor', distributorId, orderId);
  if (!isOpen(o)) throw conflict(`Order #${o.id} is ${o.status}.`);
  if (typeof body.reason !== 'string' || !(body.reason in REASON_LABELS)) throw bad('Select a disruption reason.');
  const eta = futureEta(body.eta, c.now, 'Revised ETA');
  if (eta === o.currentEta) throw bad('Revised ETA is the same as the current ETA.');
  const description = shortText(body.description, 200, 'Description');
  const customMessage = shortText(body.message, 500, 'Message to retailer');
  const reasonKey = body.reason as DisruptionReason;
  const reason = REASON_LABELS[reasonKey];
  const retailer = findRetailer(c.w, o.retailerId);

  o.status = 'delayed';
  o.currentEta = eta;
  o.disruption = { reason: reasonKey, description, reportedAt: c.now };
  // A new disruption reopens the decision for the retailer.
  if (o.request && o.request.status !== 'confirmed') o.request = undefined;
  repo.saveOrder(o);

  c.event(o, 'Disruption reported', 'distributor', reason + (description ? ` — ${description}` : ''));
  c.event(o, 'Revised ETA recorded', 'distributor', fmt(eta));
  c.notify(
    'retailer',
    o.retailerId,
    o.id,
    customMessage ??
      `Your order #${o.id} has been delayed due to ${reason.toLowerCase()}. Revised ETA: ${fmt(eta)}. Check available recovery options.`,
    'warning',
  );
  c.event(o, 'Retailer notified', 'system');
  const risk = stockoutRisk(o, c.now);
  c.notify(
    'distributor',
    o.distributorId,
    o.id,
    `Disruption logged for #${o.id} (${retailer.name}). ${
      risk.high
        ? `High stockout risk: ${days(risk.daysOfStock)} days of stock vs ${days(risk.daysUntilDelivery)} days to delivery.`
        : 'Retailer stock should last until the revised ETA.'
    }`,
    risk.high ? 'warning' : 'info',
  );
}

export function updateEta(distributorId: string, orderId: string, body: { eta?: unknown; note?: unknown }) {
  const c = begin();
  const o = ownedOrder(c.w, 'distributor', distributorId, orderId);
  if (!isOpen(o)) throw conflict(`Order #${o.id} is ${o.status}.`);
  const eta = futureEta(body.eta, c.now, 'Revised ETA');
  if (eta === o.currentEta) throw bad('Revised ETA is the same as the current ETA.');
  const note = shortText(body.note, 200, 'Note');
  o.currentEta = eta;
  repo.saveOrder(o);
  c.event(o, 'Revised ETA recorded', 'distributor', fmt(eta) + (note ? ` — ${note}` : ''));
  c.notify('retailer', o.retailerId, o.id, `Order #${o.id}: delivery ETA updated to ${fmt(eta)}.${note ? ` ${note}` : ''}`);
  c.event(o, 'Retailer notified', 'system');
}

export function confirmAllocation(distributorId: string, body: { allocations?: unknown }) {
  const c = begin();
  const dist = requireDistributor(c.w, distributorId);
  if (!Array.isArray(body.allocations)) throw bad('allocations must be a list.');
  for (const a of body.allocations as { orderId?: unknown; qty?: unknown }[]) {
    const o = ownedOrder(c.w, 'distributor', distributorId, String(a.orderId));
    if (!wholeNumber(a.qty, 0)) throw bad(`#${o.id}: quantity must be a whole number ≥ 0.`);
    if (a.qty === 0) continue;
    if (o.status !== 'awaiting_allocation' && o.status !== 'partially_allocated')
      throw conflict(`Order #${o.id} is no longer waiting for stock.`);
    const item = stockOf(dist, o.productId);
    const need = o.quantity - o.allocatedQty;
    const qty = a.qty as number;
    if (qty > need) throw bad(`#${o.id}: only ${need} still needed.`);
    if (!item || qty > item.qty) throw conflict(`#${o.id}: only ${item?.qty ?? 0} in stock.`);

    item.qty -= qty;
    repo.saveInventory(dist.id, item);
    o.allocatedQty += qty;
    o.status = o.allocatedQty >= o.quantity ? 'allocated' : 'partially_allocated';
    repo.saveOrder(o);
    const unit = findProduct(c.w, o.productId).unit;
    c.event(o, 'Stock allocated', 'distributor', `${qty} ${unit} (${o.allocatedQty}/${o.quantity} total)`);
    const short = o.quantity - o.allocatedQty;
    c.notify(
      'retailer',
      o.retailerId,
      o.id,
      short > 0
        ? `Order #${o.id}: ${o.allocatedQty} of ${o.quantity} ${unit} allocated. ${short} ${unit} are short — alternative suppliers are available in your portal.`
        : `Order #${o.id}: all ${o.quantity} ${unit} allocated and ready to dispatch.`,
      short > 0 ? 'warning' : 'success',
    );
  }
}

export function suggestSupplier(distributorId: string, orderId: string, body: { supplierId?: unknown }) {
  const c = begin();
  const o = ownedOrder(c.w, 'distributor', distributorId, orderId);
  const sup = c.w.suppliers.find((s) => s.id === body.supplierId && s.id !== distributorId);
  if (!sup) throw bad('Unknown supplier.');
  const dist = findSupplier(c.w, distributorId);
  const product = findProduct(c.w, o.productId);
  o.suggestedSupplierId = sup.id;
  repo.saveOrder(o);
  c.event(o, 'Alternative supplier suggested', 'distributor', sup.name);
  c.notify('retailer', o.retailerId, o.id, `${dist.name} suggests ${sup.name} as an alternative for order #${o.id} (${product.name}).`);
}

export function proposePartial(distributorId: string, orderId: string, body: { qty?: unknown; eta?: unknown }) {
  const c = begin();
  const o = ownedOrder(c.w, 'distributor', distributorId, orderId);
  if (o.status !== 'delayed') throw conflict('Partial fulfilment can only be proposed on delayed orders.');
  if (o.partial && o.partial.status !== 'declined') throw conflict('A partial fulfilment is already on this order.');
  const dist = findSupplier(c.w, distributorId);
  const product = findProduct(c.w, o.productId);
  const item = stockOf(dist, o.productId);
  if (!wholeNumber(body.qty, 1)) throw bad('Enter a whole quantity of at least 1.');
  const qty = body.qty as number;
  if (qty >= o.quantity) throw bad('Partial quantity must be less than the order quantity.');
  if (!item || qty > item.qty) throw conflict(`Only ${item?.qty ?? 0} ${product.unit} in stock.`);
  const eta = futureEta(body.eta, c.now, 'Delivery time');

  item.qty -= qty; // reserved while the retailer decides
  repo.saveInventory(dist.id, item);
  o.partial = { qty, eta, status: 'proposed' };
  repo.saveOrder(o);
  c.event(o, 'Partial fulfilment proposed', 'distributor', `${qty} ${product.unit} from warehouse stock by ${fmt(eta)}`);
  c.notify(
    'retailer',
    o.retailerId,
    o.id,
    `${dist.name} can send ${qty} of ${o.quantity} ${product.unit} for order #${o.id} by ${fmt(eta)}, with the rest following on the delayed shipment. Accept or decline in your portal.`,
  );
}

export function respondToRequest(distributorId: string, orderId: string, body: { decision?: unknown }) {
  const c = begin();
  const o = ownedOrder(c.w, 'distributor', distributorId, orderId);
  const r = o.request;
  if (!r || r.status !== 'pending') throw conflict('There is no pending retailer request on this order.');
  const dist = findSupplier(c.w, distributorId);
  const product = findProduct(c.w, o.productId);
  const decision = body.decision;

  if (decision === 'decline') {
    if (r.type !== 'alternative') throw bad('Only alternative requests can be declined.');
    r.status = 'declined';
    repo.saveOrder(o);
    c.event(o, 'Distributor response', 'distributor', 'Alternative request declined');
    c.notify('retailer', o.retailerId, o.id, `${dist.name} could not arrange the alternative for order #${o.id}. Please choose another option.`, 'warning');
    return;
  }

  if (r.type === 'alternative') {
    if (decision !== 'confirm') throw bad('Confirm or decline the alternative request.');
    const sup = findSupplier(c.w, r.supplierId!);
    const item = stockOf(sup, o.productId);
    if (!item || item.qty < (r.qty ?? 0)) throw conflict(`${sup.name} no longer has ${r.qty} ${product.unit} in stock.`);
    item.qty -= r.qty!;
    repo.saveInventory(sup.id, item);
    r.status = 'confirmed';
    if ((r.qty ?? 0) >= remainingNeed(o)) {
      o.status = 'rerouted';
      o.currentEta = r.eta!;
    }
    repo.saveOrder(o);
    c.event(o, 'Distributor response', 'distributor', `Alternative confirmed with ${sup.name}`);
    c.event(o, 'Fulfilment confirmed', 'system', `${r.qty} ${product.unit} via ${sup.name}, ETA ${fmt(r.eta!)}`);
    c.notify('retailer', o.retailerId, o.id, `Confirmed: ${r.qty} ${product.unit} for order #${o.id} will be delivered by ${sup.name}, ETA ${fmt(r.eta!)}.`, 'success');
    return;
  }

  if (decision !== 'acknowledge') throw bad('Acknowledge the retailer request.');
  r.status = 'acknowledged';
  if (r.type === 'wait') {
    repo.saveOrder(o);
    c.event(o, 'Distributor response', 'distributor', `Acknowledged — delivery continues, ETA ${fmt(o.currentEta)}`);
    c.notify('retailer', o.retailerId, o.id, `${dist.name} acknowledged: order #${o.id} continues on the revised ETA ${fmt(o.currentEta)}.`, 'success');
  } else {
    if (o.partial?.status === 'proposed') releaseReservedStock(c.w, { ...o, allocatedQty: 0 });
    o.status = 'cancelled';
    repo.saveOrder(o);
    c.event(o, 'Distributor response', 'distributor', 'Cancellation acknowledged; refund request logged (simulated, no money moved)');
    c.notify(
      'retailer',
      o.retailerId,
      o.id,
      `${dist.name} acknowledged the cancellation of order #${o.id}. Refund request recorded (simulated — no payment has been processed).`,
    );
  }
}

export function advanceOrder(distributorId: string, orderId: string, body: { to?: unknown }) {
  const c = begin();
  const o = ownedOrder(c.w, 'distributor', distributorId, orderId);
  const dist = findSupplier(c.w, distributorId);
  if (body.to === 'in_transit') {
    if (o.status !== 'allocated') throw conflict('Only fully allocated orders can be dispatched.');
    o.status = 'in_transit';
    repo.saveOrder(o);
    c.event(o, `Dispatched from ${dist.name}`, 'distributor');
    c.notify('retailer', o.retailerId, o.id, `Order #${o.id} has been dispatched. ETA ${fmt(o.currentEta)}.`);
    return;
  }
  if (body.to !== 'delivered') throw bad('Unknown status.');
  if (!['in_transit', 'delayed', 'rerouted'].includes(o.status)) throw conflict('Only shipped orders can be marked delivered.');
  o.status = 'delivered';
  repo.saveOrder(o);

  // Delivered goods land on the retailer's shelf.
  const stock = repo.loadStock(c.now).find((s) => s.retailerId === o.retailerId && s.productId === o.productId);
  repo.saveRetailerStock({
    retailerId: o.retailerId,
    productId: o.productId,
    qty: (stock?.qty ?? 0) + o.quantity,
    avgDailySales: stock?.avgDailySales ?? 0,
    countedAt: c.now,
  });
  const unit = findProduct(c.w, o.productId).unit;
  c.event(o, 'Fulfilment confirmed', 'distributor', `Delivered to retailer · ${o.quantity} ${unit} added to shelf stock`);
  c.notify('retailer', o.retailerId, o.id, `Order #${o.id} has been delivered. ${o.quantity} ${unit} added to your stock.`, 'success');
}

export function rejectOrder(distributorId: string, orderId: string, body: { reason?: unknown }) {
  const c = begin();
  const o = ownedOrder(c.w, 'distributor', distributorId, orderId);
  if (!isPreDispatch(o)) throw conflict('Only orders that have not been dispatched can be rejected.');
  const reason = shortText(body.reason, 200, 'Reason');
  if (!reason) throw bad('Give the retailer a reason.');
  releaseReservedStock(c.w, o);
  o.status = 'cancelled';
  o.cancelReason = 'Rejected by distributor';
  repo.saveOrder(o);
  c.event(o, 'Order rejected', 'distributor', reason);
  c.notify('retailer', o.retailerId, o.id, `${findSupplier(c.w, distributorId).name} rejected order #${o.id}: ${reason}`, 'warning');
}

export function updateInventory(distributorId: string, productId: string, body: { qty?: unknown; price?: unknown }) {
  const c = begin();
  const dist = requireDistributor(c.w, distributorId);
  if (!c.w.products.some((p) => p.id === productId)) throw new HttpError(404, 'Unknown product.');
  const item = stockOf(dist, productId) ?? { productId, qty: 0, price: 0 };
  if (body.qty !== undefined) {
    if (!wholeNumber(body.qty, 0)) throw bad('Stock must be a whole number ≥ 0.');
    item.qty = body.qty as number;
  }
  if (body.price !== undefined) {
    if (typeof body.price !== 'number' || !(body.price > 0)) throw bad('Price must be a positive number.');
    item.price = Math.round(body.price * 100) / 100;
  }
  if (item.price <= 0) throw bad('Set a price for a newly stocked product.');
  repo.saveInventory(dist.id, item);
}

// ---------------------------------------------------------------- retailer

export function placeOrder(
  retailerId: string,
  body: { distributorId?: unknown; productId?: unknown; quantity?: unknown; paymentType?: unknown },
): string {
  const c = begin();
  const retailer = requireRetailer(c.w, retailerId);
  const dist = c.w.suppliers.find((s) => s.id === body.distributorId);
  if (!dist || !retailer.distributorIds.includes(dist.id)) throw bad('Choose one of your distributors.');
  const item = typeof body.productId === 'string' ? stockOf(dist, body.productId) : undefined;
  if (!item) throw bad(`${dist.name} does not carry that product.`);
  if (!wholeNumber(body.quantity, 1) || (body.quantity as number) > 10_000) throw bad('Enter a quantity between 1 and 10,000.');
  if (body.paymentType !== 'COD' && body.paymentType !== 'Prepaid') throw bad('Choose COD or Prepaid.');
  const product = findProduct(c.w, item.productId);
  const quantity = body.quantity as number;

  // Promise delivery at the distributor's typical lead time, rounded up to the next full hour.
  const etaMs = toMs(addHours(c.now, dist.deliveryHours));
  const eta = toLocalIso(Math.ceil(etaMs / 3_600_000) * 3_600_000);
  const order: Order = {
    id: '',
    retailerId,
    distributorId: dist.id,
    productId: product.id,
    quantity,
    allocatedQty: 0,
    unitPrice: item.price,
    paymentType: body.paymentType as PaymentType,
    placedAt: c.now,
    originalEta: eta,
    currentEta: eta,
    status: 'awaiting_allocation',
    retailerStock: 0,
    avgDailySales: 0,
    timeline: [],
  };
  order.id = repo.insertOrder(order);
  c.event(order, 'Order placed', 'retailer', `${quantity} ${product.unit} @ ${item.price}/${product.unit.replace(/s$/, '')}`);
  if (order.paymentType === 'Prepaid') c.event(order, 'Payment received (prepaid, simulated)', 'system');
  c.notify(
    'distributor',
    dist.id,
    order.id,
    `New order #${order.id} from ${retailer.name}: ${quantity} ${product.unit} of ${product.name} (${order.paymentType}).${
      item.qty < quantity ? ` Only ${item.qty} in stock — allocation will be partial.` : ''
    }`,
    item.qty < quantity ? 'warning' : 'info',
  );
  return order.id;
}

export function retailerRequest(
  retailerId: string,
  orderId: string,
  body: { request?: unknown; supplierId?: unknown; qty?: unknown },
) {
  const c = begin();
  const o = ownedOrder(c.w, 'retailer', retailerId, orderId);
  if (o.status !== 'delayed') throw conflict('Recovery options are only available on delayed orders.');
  if (o.request && (o.request.status === 'confirmed' || o.request.status === 'acknowledged'))
    throw conflict('A recovery option has already been agreed for this order.');
  const type = body.request as RequestType;
  if (!['wait', 'alternative', 'cancel'].includes(type)) throw bad('Unknown recovery option.');
  const product = findProduct(c.w, o.productId);
  const retailer = findRetailer(c.w, retailerId);
  const req: RecoveryRequest = { type, status: 'pending', createdAt: c.now };

  let what: string;
  if (type === 'alternative') {
    const sup = c.w.suppliers.find((s) => s.id === body.supplierId && s.id !== o.distributorId);
    const item = sup && stockOf(sup, o.productId);
    if (!sup || !item || item.qty <= 0) throw bad('That supplier does not have this product in stock.');
    const need = remainingNeed(o);
    const qty = body.qty === undefined ? Math.min(need, item.qty) : body.qty;
    if (!wholeNumber(qty, 1) || (qty as number) > need) throw bad(`Quantity must be between 1 and ${need}.`);
    if ((qty as number) > item.qty) throw conflict(`${sup.name} only has ${item.qty} ${product.unit}.`);
    req.supplierId = sup.id;
    req.qty = qty as number;
    req.eta = addHours(c.now, sup.deliveryHours);
    what =
      o.paymentType === 'COD'
        ? `has requested an alternative order of ${req.qty} ${product.unit} from ${sup.name}`
        : `has requested alternative fulfilment (${req.qty} ${product.unit} via ${sup.name})`;
  } else if (type === 'wait') {
    what = `will wait for the original delivery (ETA ${fmt(o.currentEta)})`;
  } else {
    what = 'has requested cancellation and a refund';
  }

  o.request = req;
  repo.saveOrder(o);
  const label = { wait: 'Wait for original delivery', alternative: 'Request alternative fulfilment', cancel: 'Request cancellation/refund' }[type];
  c.event(o, 'Recovery option selected', 'retailer', label);
  const risk = stockoutRisk(o, c.now);
  c.notify(
    'distributor',
    o.distributorId,
    o.id,
    `Order #${o.id} is delayed. ${retailer.name} has ${days(risk.daysOfStock)} days of inventory remaining and ${what}.`,
    type === 'wait' ? 'info' : 'warning',
  );
}

export function respondToPartial(retailerId: string, orderId: string, body: { accept?: unknown }) {
  const c = begin();
  const o = ownedOrder(c.w, 'retailer', retailerId, orderId);
  if (!o.partial || o.partial.status !== 'proposed') throw conflict('There is no partial fulfilment offer to answer.');
  if (typeof body.accept !== 'boolean') throw bad('accept must be true or false.');
  const product = findProduct(c.w, o.productId);
  const retailer = findRetailer(c.w, retailerId);
  if (body.accept) {
    o.partial.status = 'accepted';
    c.event(o, 'Partial fulfilment accepted', 'retailer', `${o.partial.qty} ${product.unit} by ${fmt(o.partial.eta)}`);
    c.event(o, 'Fulfilment confirmed', 'system', `Partial: ${o.partial.qty} ${product.unit}`);
  } else {
    const dist = findSupplier(c.w, o.distributorId);
    const item = stockOf(dist, o.productId);
    if (item) {
      item.qty += o.partial.qty; // release the reservation
      repo.saveInventory(dist.id, item);
    }
    o.partial.status = 'declined';
    c.event(o, 'Partial fulfilment declined', 'retailer', 'Reserved stock released');
  }
  repo.saveOrder(o);
  c.notify(
    'distributor',
    o.distributorId,
    o.id,
    `${retailer.name} ${body.accept ? 'accepted' : 'declined'} the partial fulfilment for order #${o.id}.`,
    body.accept ? 'success' : 'warning',
  );
}

export function cancelOrder(retailerId: string, orderId: string, body: { reason?: unknown }) {
  const c = begin();
  const o = ownedOrder(c.w, 'retailer', retailerId, orderId);
  if (!isPreDispatch(o))
    throw conflict('This order has already shipped. Use the recovery options to request cancellation instead.');
  const reason = shortText(body.reason, 200, 'Reason');
  releaseReservedStock(c.w, o);
  o.status = 'cancelled';
  o.cancelReason = 'Cancelled by retailer';
  repo.saveOrder(o);
  c.event(o, 'Order cancelled', 'retailer', reason);
  c.notify(
    'distributor',
    o.distributorId,
    o.id,
    `${findRetailer(c.w, retailerId).name} cancelled order #${o.id} before dispatch${reason ? `: ${reason}` : ''}. Allocated stock was returned to the warehouse.`,
    'warning',
  );
}

export function updateShelfStock(retailerId: string, productId: string, body: { qty?: unknown; avgDailySales?: unknown }) {
  const c = begin();
  requireRetailer(c.w, retailerId);
  if (!c.w.products.some((p) => p.id === productId)) throw new HttpError(404, 'Unknown product.');
  if (typeof body.qty !== 'number' || !(body.qty >= 0) || body.qty > 100_000) throw bad('Stock must be a number ≥ 0.');
  if (typeof body.avgDailySales !== 'number' || !(body.avgDailySales >= 0) || body.avgDailySales > 10_000)
    throw bad('Average daily sales must be a number ≥ 0.');
  repo.saveRetailerStock({ retailerId, productId, qty: body.qty, avgDailySales: body.avgDailySales, countedAt: c.now });
}

// ---------------------------------------------------------------- both

export function postMessage(role: Role, partyId: string, orderId: string, body: { body?: unknown }) {
  const c = begin();
  const o = ownedOrder(c.w, role, partyId, orderId);
  const text = shortText(body.body, 1000, 'Message');
  if (!text) throw bad('Message is empty.');
  repo.addMessage({ orderId: o.id, role, body: text, at: c.now });
  const sender = role === 'distributor' ? findSupplier(c.w, partyId).name : findRetailer(c.w, partyId).name;
  const preview = text.length > 120 ? text.slice(0, 117) + '…' : text;
  if (role === 'distributor') c.notify('retailer', o.retailerId, o.id, `${sender} on order #${o.id}: “${preview}”`);
  else c.notify('distributor', o.distributorId, o.id, `${sender} on order #${o.id}: “${preview}”`);
}

export function markNotificationsRead(role: Role, partyId: string) {
  repo.markRead(role, partyId);
}
