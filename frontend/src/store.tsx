import { createContext, useContext, useEffect, useReducer } from 'react';
import type { Dispatch, ReactNode } from 'react';
import { DEMO_NOW, REASON_LABELS, seedState } from './data';
import type { AppState, DisruptionReason, Notification, Order, RecoveryRequest, Role, TimelineEvent } from './data';
import { addHours, days, findProduct, findRetailer, findSupplier, fmt, remainingNeed, stockOf, stockoutRisk } from './logic';

export type Action =
  | { type: 'REPORT_DISRUPTION'; orderId: string; reason: DisruptionReason; eta: string; description?: string }
  | { type: 'UPDATE_ETA'; orderId: string; eta: string; note?: string }
  | { type: 'CONFIRM_ALLOCATION'; distributorId: string; allocations: { orderId: string; qty: number }[] }
  | { type: 'SUGGEST_SUPPLIER'; orderId: string; supplierId: string }
  | { type: 'PROPOSE_PARTIAL'; orderId: string; qty: number; eta: string }
  | { type: 'RESPOND_PARTIAL'; orderId: string; accept: boolean }
  | { type: 'RETAILER_REQUEST'; orderId: string; request: 'wait' | 'alternative' | 'cancel'; supplierId?: string; qty?: number }
  | { type: 'DISTRIBUTOR_RESPOND'; orderId: string; decision: 'confirm' | 'acknowledge' | 'decline' }
  | { type: 'ADVANCE'; orderId: string; to: 'in_transit' | 'delivered' }
  | { type: 'MARK_READ'; role: Role; partyId: string }
  | { type: 'RESET' }
  | { type: 'REPLACE'; state: AppState };

const STORAGE_KEY = 'disruption-recovery-demo-v1';

/** Small mutable context for one action: advances the demo clock and records events/notifications. */
function makeCtx(s: AppState) {
  s.clock = addHours(s.clock, 2 / 60);
  const nextId = (p: string) => `${p}-${s.seq++}`;
  return {
    event(o: Order, label: string, actor: TimelineEvent['actor'], detail?: string) {
      o.timeline.push({ id: nextId('e'), at: s.clock, label, actor, detail });
    },
    notify(role: Role, partyId: string, orderId: string, message: string, tone: Notification['tone'] = 'info') {
      s.notifications.unshift({ id: nextId('n'), role, partyId, orderId, message, at: s.clock, read: false, tone });
    },
  };
}

export function reducer(prev: AppState, action: Action): AppState {
  if (action.type === 'RESET') return seedState();
  if (action.type === 'REPLACE') return action.state;

  const s = structuredClone(prev);

  if (action.type === 'MARK_READ') {
    s.notifications.forEach((n) => {
      if (n.role === action.role && n.partyId === action.partyId) n.read = true;
    });
    return s;
  }

  const ctx = makeCtx(s);

  if (action.type === 'CONFIRM_ALLOCATION') {
    const dist = findSupplier(s, action.distributorId);
    for (const { orderId, qty } of action.allocations) {
      const o = s.orders.find((x) => x.id === orderId)!;
      const item = stockOf(dist, o.productId);
      // Clamp so inventory never goes negative and an order is never over-allocated.
      const give = Math.max(0, Math.min(qty, item?.qty ?? 0, o.quantity - o.allocatedQty));
      if (!item || give === 0) continue;
      item.qty -= give;
      o.allocatedQty += give;
      o.status = o.allocatedQty >= o.quantity ? 'allocated' : 'partially_allocated';
      const unit = findProduct(s, o.productId).unit;
      ctx.event(o, 'Stock allocated', 'distributor', `${give} ${unit} (${o.allocatedQty}/${o.quantity} total)`);
      const short = o.quantity - o.allocatedQty;
      ctx.notify(
        'retailer',
        o.retailerId,
        o.id,
        short > 0
          ? `Order #${o.id}: ${o.allocatedQty} of ${o.quantity} ${unit} allocated. ${short} ${unit} are short — alternative suppliers are available in your dashboard.`
          : `Order #${o.id}: all ${o.quantity} ${unit} allocated and ready to dispatch.`,
        short > 0 ? 'warning' : 'success',
      );
    }
    return s;
  }

  const o = s.orders.find((x) => x.id === action.orderId)!;
  const product = findProduct(s, o.productId);
  const dist = findSupplier(s, o.distributorId);
  const retailer = findRetailer(s, o.retailerId);

  switch (action.type) {
    case 'REPORT_DISRUPTION': {
      const reason = REASON_LABELS[action.reason];
      o.status = 'delayed';
      o.currentEta = action.eta;
      o.disruption = { reason: action.reason, description: action.description, reportedAt: s.clock };
      // A new disruption reopens the decision for the retailer.
      if (o.request && o.request.status !== 'confirmed') o.request = undefined;
      ctx.event(o, 'Disruption reported', 'distributor', reason + (action.description ? ` — ${action.description}` : ''));
      ctx.event(o, 'Revised ETA recorded', 'distributor', fmt(action.eta));
      ctx.notify(
        'retailer',
        o.retailerId,
        o.id,
        `Your order #${o.id} has been delayed due to ${reason.toLowerCase()}. Revised ETA: ${fmt(action.eta)}. Check available recovery options.`,
        'warning',
      );
      ctx.event(o, 'Retailer notified', 'system');
      const risk = stockoutRisk(o);
      ctx.notify(
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
      break;
    }
    case 'UPDATE_ETA': {
      o.currentEta = action.eta;
      ctx.event(o, 'Revised ETA recorded', 'distributor', fmt(action.eta) + (action.note ? ` — ${action.note}` : ''));
      ctx.notify('retailer', o.retailerId, o.id, `Order #${o.id}: delivery ETA updated to ${fmt(action.eta)}.`, 'info');
      ctx.event(o, 'Retailer notified', 'system');
      break;
    }
    case 'SUGGEST_SUPPLIER': {
      const sup = findSupplier(s, action.supplierId);
      o.suggestedSupplierId = sup.id;
      ctx.event(o, 'Alternative supplier suggested', 'distributor', sup.name);
      ctx.notify(
        'retailer',
        o.retailerId,
        o.id,
        `${dist.name} suggests ${sup.name} as an alternative for order #${o.id} (${product.name}).`,
        'info',
      );
      break;
    }
    case 'PROPOSE_PARTIAL': {
      const item = stockOf(dist, o.productId);
      const qty = Math.min(action.qty, item?.qty ?? 0, o.quantity - 1);
      if (!item || qty <= 0) return prev;
      item.qty -= qty; // reserved while the retailer decides
      o.partial = { qty, eta: action.eta, status: 'proposed' };
      ctx.event(o, 'Partial fulfilment proposed', 'distributor', `${qty} ${product.unit} from warehouse stock by ${fmt(action.eta)}`);
      ctx.notify(
        'retailer',
        o.retailerId,
        o.id,
        `${dist.name} can send ${qty} of ${o.quantity} ${product.unit} for order #${o.id} by ${fmt(action.eta)}, with the rest following on the delayed shipment. Accept or decline in your dashboard.`,
        'info',
      );
      break;
    }
    case 'RESPOND_PARTIAL': {
      if (!o.partial || o.partial.status !== 'proposed') return prev;
      if (action.accept) {
        o.partial.status = 'accepted';
        ctx.event(o, 'Partial fulfilment accepted', 'retailer', `${o.partial.qty} ${product.unit} by ${fmt(o.partial.eta)}`);
        ctx.event(o, 'Fulfilment confirmed', 'system', `Partial: ${o.partial.qty} ${product.unit}`);
      } else {
        o.partial.status = 'declined';
        const item = stockOf(dist, o.productId);
        if (item) item.qty += o.partial.qty; // release the reservation
        ctx.event(o, 'Partial fulfilment declined', 'retailer', 'Reserved stock released');
      }
      ctx.notify(
        'distributor',
        o.distributorId,
        o.id,
        `${retailer.name} ${action.accept ? 'accepted' : 'declined'} the partial fulfilment for order #${o.id}.`,
        action.accept ? 'success' : 'warning',
      );
      break;
    }
    case 'RETAILER_REQUEST': {
      const req: RecoveryRequest = { type: action.request, status: 'pending', createdAt: s.clock };
      let what = '';
      if (action.request === 'alternative' && action.supplierId) {
        const sup = findSupplier(s, action.supplierId);
        req.supplierId = sup.id;
        req.qty = action.qty ?? remainingNeed(o);
        req.eta = addHours(DEMO_NOW, sup.deliveryHours);
        what =
          o.paymentType === 'COD'
            ? `has requested an alternative order of ${req.qty} ${product.unit} from ${sup.name}`
            : `has requested alternative fulfilment (${req.qty} ${product.unit} via ${sup.name})`;
      } else if (action.request === 'wait') {
        what = `will wait for the original delivery (ETA ${fmt(o.currentEta)})`;
      } else {
        what = 'has requested cancellation and a refund';
      }
      o.request = req;
      const label = { wait: 'Wait for original delivery', alternative: 'Request alternative fulfilment', cancel: 'Request cancellation/refund' }[action.request];
      ctx.event(o, 'Recovery option selected', 'retailer', label);
      const risk = stockoutRisk(o);
      ctx.notify(
        'distributor',
        o.distributorId,
        o.id,
        `Order #${o.id} is delayed. ${retailer.name} has ${days(risk.daysOfStock)} days of inventory remaining and ${what}.`,
        action.request === 'wait' ? 'info' : 'warning',
      );
      break;
    }
    case 'DISTRIBUTOR_RESPOND': {
      const r = o.request;
      if (!r || r.status !== 'pending') return prev;
      if (action.decision === 'decline') {
        r.status = 'declined';
        ctx.event(o, 'Distributor response', 'distributor', 'Alternative request declined');
        ctx.notify('retailer', o.retailerId, o.id, `${dist.name} could not arrange the alternative for order #${o.id}. Please choose another option.`, 'warning');
        break;
      }
      if (r.type === 'alternative') {
        const sup = findSupplier(s, r.supplierId!);
        const item = stockOf(sup, o.productId);
        if (!item || item.qty < (r.qty ?? 0)) return prev; // UI blocks this; never go negative
        item.qty -= r.qty!;
        r.status = 'confirmed';
        if ((r.qty ?? 0) >= remainingNeed(o)) {
          o.status = 'rerouted';
          o.currentEta = r.eta!;
        }
        ctx.event(o, 'Distributor response', 'distributor', `Alternative confirmed with ${sup.name}`);
        ctx.event(o, 'Fulfilment confirmed', 'system', `${r.qty} ${product.unit} via ${sup.name}, ETA ${fmt(r.eta!)}`);
        ctx.notify('retailer', o.retailerId, o.id, `Confirmed: ${r.qty} ${product.unit} for order #${o.id} will be delivered by ${sup.name}, ETA ${fmt(r.eta!)}.`, 'success');
      } else if (r.type === 'wait') {
        r.status = 'acknowledged';
        ctx.event(o, 'Distributor response', 'distributor', `Acknowledged — delivery continues, ETA ${fmt(o.currentEta)}`);
        ctx.notify('retailer', o.retailerId, o.id, `${dist.name} acknowledged: order #${o.id} continues on the revised ETA ${fmt(o.currentEta)}.`, 'success');
      } else {
        r.status = 'acknowledged';
        o.status = 'cancelled';
        ctx.event(o, 'Distributor response', 'distributor', 'Cancellation acknowledged; refund request logged (simulated, no money moved)');
        ctx.notify(
          'retailer',
          o.retailerId,
          o.id,
          `${dist.name} acknowledged the cancellation of order #${o.id}. Refund request recorded (demo only — no payment has been processed).`,
          'info',
        );
      }
      break;
    }
    case 'ADVANCE': {
      o.status = action.to;
      if (action.to === 'in_transit') ctx.event(o, `Dispatched from ${dist.name}`, 'distributor');
      else {
        ctx.event(o, 'Fulfilment confirmed', 'distributor', 'Delivered to retailer');
        ctx.notify('retailer', o.retailerId, o.id, `Order #${o.id} has been delivered.`, 'success');
      }
      break;
    }
  }
  return s;
}

function load(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* fall through to seed */
  }
  return seedState();
}

const StoreContext = createContext<{ state: AppState; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable: state still works in memory */
    }
  }, [state]);

  // Keep two browser windows (one per role) in sync during the demo.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) dispatch({ type: 'REPLACE', state: JSON.parse(e.newValue) });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore outside provider');
  return ctx;
}
