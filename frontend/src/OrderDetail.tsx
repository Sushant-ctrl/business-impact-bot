import { useState } from 'react';
import type { FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { DEMO_NOW, REASON_LABELS } from './data';
import type { DisruptionReason, Order, Role, Supplier } from './data';
import {
  addHours,
  findProduct,
  findRetailer,
  findSupplier,
  fmt,
  isOpen,
  money,
  rankSuppliers,
  remainingNeed,
  resolutionLabel,
  STATUS_LABELS,
  STATUS_TONE,
  stockOf,
  toMs,
} from './logic';
import { useStore } from './store';
import { Badge, Modal, RiskPanel, SupplierTable, Timeline } from './ui';

// Replace with the real distributor UPI ID before going live.
const DISTRIBUTOR_UPI_ID = 'sushantku24@okaxis';

export function DisruptionForm({ order, mode, onClose }: { order: Order; mode: 'report' | 'update'; onClose: () => void }) {
  const { dispatch } = useStore();
  const [reason, setReason] = useState<DisruptionReason | ''>(mode === 'update' ? order.disruption?.reason ?? 'other' : '');
  const [eta, setEta] = useState(mode === 'update' ? order.currentEta : '');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: string[] = [];
    if (mode === 'report' && !reason) errs.push('Select a disruption reason.');
    if (!eta) errs.push('Enter the revised delivery ETA.');
    else if (toMs(eta) <= toMs(DEMO_NOW)) errs.push(`Revised ETA must be after the demo clock (${fmt(DEMO_NOW)}).`);
    else if (eta === order.currentEta) errs.push('Revised ETA is the same as the current ETA.');
    if (description.length > 200) errs.push('Keep the description under 200 characters.');
    setErrors(errs);
    if (errs.length) return;
    if (mode === 'report')
      dispatch({ type: 'REPORT_DISRUPTION', orderId: order.id, reason: reason as DisruptionReason, eta, description: description.trim() || undefined });
    else dispatch({ type: 'UPDATE_ETA', orderId: order.id, eta, note: description.trim() || undefined });
    onClose();
  };

  return (
    <Modal title={`${mode === 'report' ? 'Report disruption' : 'Update delivery ETA'} · Order #${order.id}`} onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <p className="muted small">
          Current ETA: <b>{fmt(order.currentEta)}</b> · Original ETA: {fmt(order.originalEta)}
        </p>
        {mode === 'report' && (
          <label>
            Disruption reason *
            <select value={reason} onChange={(e) => setReason(e.target.value as DisruptionReason)}>
              <option value="">Select a reason…</option>
              {Object.entries(REASON_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Revised delivery ETA *
          <input type="datetime-local" value={eta} min={DEMO_NOW} onChange={(e) => setEta(e.target.value)} />
        </label>
        <label>
          {mode === 'report' ? 'Short description (optional)' : 'Note (optional)'}
          <textarea
            rows={2}
            value={description}
            maxLength={200}
            placeholder={mode === 'report' ? 'e.g. NH-48 closed near Talegaon until Saturday noon' : ''}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {errors.length > 0 && (
          <ul className="errors">
            {errors.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        <div className="row-end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            {mode === 'report' ? 'Report disruption & notify retailer' : 'Save ETA & notify retailer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UpiQrModal({ order, dist, onClose }: { order: Order; dist: Supplier; onClose: () => void }) {
  const amount = order.quantity * order.unitPrice;
  const upiUri = `upi://pay?pa=${DISTRIBUTOR_UPI_ID}&pn=${encodeURIComponent(dist.name)}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent('Order #' + order.id)}`;
  return (
    <Modal title={`Pay via UPI · Order #${order.id}`} onClose={onClose}>
      <div className="upi-qr">
        <QRCodeSVG value={upiUri} size={256} level="M" />
        <div className="upi-qr-id">UPI ID: <b>{DISTRIBUTOR_UPI_ID}</b></div>
        <div className="upi-qr-amount">Amount: <b>{money(amount)}</b></div>
        <p className="upi-qr-hint">Scan this QR code using Google Pay, PhonePe, Paytm, or any UPI app to make your payment.</p>
      </div>
    </Modal>
  );
}

export function OrderDetail({
  orderId,
  role,
  onClose,
  onGoToAllocation,
}: {
  orderId: string;
  role: Role;
  onClose: () => void;
  onGoToAllocation?: () => void;
}) {
  const { state } = useStore();
  const [form, setForm] = useState<'report' | 'update' | null>(null);
  const [showQr, setShowQr] = useState(false);
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return null;
  const product = findProduct(state, order.productId);
  const retailer = findRetailer(state, order.retailerId);
  const dist = findSupplier(state, order.distributorId);
  const res = resolutionLabel(state, order);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <div className="muted small">Order #{order.id}</div>
            <h2>
              {product.name} × {order.quantity} {product.unit}
            </h2>
            <div className="badges">
              <Badge tone={STATUS_TONE[order.status]}>{STATUS_LABELS[order.status]}</Badge>
              <Badge tone={order.paymentType === 'COD' ? 'cod' : 'prepaid'}>{order.paymentType}</Badge>
              <Badge tone={res.tone}>{res.label}</Badge>
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          <div className="kv">
            <div>
              <span>Retailer</span>
              <b>{retailer.name}</b>
            </div>
            <div>
              <span>Distributor</span>
              <b>{dist.name}</b>
            </div>
            <div>
              <span>Order value</span>
              <b>{money(order.quantity * order.unitPrice)}</b>
            </div>
            <div>
              <span>Allocated</span>
              <b>
                {order.allocatedQty}/{order.quantity}
              </b>
            </div>
            <div>
              <span>Original ETA</span>
              <b>{fmt(order.originalEta)}</b>
            </div>
            <div>
              <span>Current ETA</span>
              <b className={order.currentEta !== order.originalEta ? 'text-danger' : ''}>{fmt(order.currentEta)}</b>
            </div>
          </div>

          <div className="upi-qr-trigger">
            <button className="btn btn-sm" onClick={() => setShowQr(true)}>
              View UPI QR
            </button>
          </div>

          {order.disruption && (
            <div className="callout callout-danger">
              <b>Disruption: {REASON_LABELS[order.disruption.reason]}</b>
              {order.disruption.description && <p>{order.disruption.description}</p>}
              <div className="muted small">Reported {fmt(order.disruption.reportedAt)}</div>
            </div>
          )}

          {isOpen(order) && <RiskPanel state={state} order={order} />}

          {role === 'distributor' ? (
            <DistributorActions order={order} openForm={setForm} onGoToAllocation={onGoToAllocation} />
          ) : (
            <RetailerActions order={order} />
          )}

          <section>
            <h3>Resolution timeline</h3>
            <Timeline events={order.timeline} />
          </section>
        </div>
      </aside>
      {form && <DisruptionForm order={order} mode={form} onClose={() => setForm(null)} />}
      {showQr && <UpiQrModal order={order} dist={dist} onClose={() => setShowQr(false)} />}
    </div>
  );
}

function RequestSummary({ order }: { order: Order }) {
  const { state } = useStore();
  const r = order.request;
  if (!r) return null;
  const unit = findProduct(state, order.productId).unit;
  const text = {
    wait: `Wait for the original delivery (ETA ${fmt(order.currentEta)})`,
    alternative: r.supplierId
      ? `${order.paymentType === 'COD' ? 'Alternative order' : 'Alternative fulfilment'}: ${r.qty} ${unit} via ${findSupplier(state, r.supplierId).name}, est. ${fmt(r.eta!)}`
      : 'Alternative fulfilment',
    cancel: 'Cancel order and refund (simulated workflow — no money is moved)',
  }[r.type];
  const tone = r.status === 'pending' ? 'warning' : r.status === 'declined' ? 'danger' : 'success';
  return (
    <div className={`callout callout-${tone}`}>
      <div className="row-between">
        <b>Retailer's chosen resolution</b>
        <Badge tone={tone}>{r.status}</Badge>
      </div>
      <p>{text}</p>
      <div className="muted small">Selected {fmt(r.createdAt)}</div>
    </div>
  );
}

function DistributorActions({
  order,
  openForm,
  onGoToAllocation,
}: {
  order: Order;
  openForm: (m: 'report' | 'update') => void;
  onGoToAllocation?: () => void;
}) {
  const { state, dispatch } = useStore();
  const dist = findSupplier(state, order.distributorId);
  const product = findProduct(state, order.productId);
  const inv = stockOf(dist, order.productId)?.qty ?? 0;
  const r = order.request;
  const [partialQty, setPartialQty] = useState(Math.max(1, Math.min(inv, order.quantity - 1)));
  const [partialEta, setPartialEta] = useState(addHours(DEMO_NOW, 6));
  const [partialErr, setPartialErr] = useState('');
  const open = isOpen(order);
  const altItem = r?.supplierId ? stockOf(findSupplier(state, r.supplierId), order.productId) : undefined;
  const altShort = r?.type === 'alternative' && (altItem?.qty ?? 0) < (r.qty ?? 0);

  const propose = () => {
    if (!Number.isInteger(partialQty) || partialQty < 1) return setPartialErr('Enter a whole quantity of at least 1.');
    if (partialQty > inv) return setPartialErr(`Only ${inv} ${product.unit} in stock.`);
    if (partialQty >= order.quantity) return setPartialErr('Partial quantity must be less than the order quantity.');
    if (!partialEta || toMs(partialEta) <= toMs(DEMO_NOW)) return setPartialErr('Choose a delivery time after the demo clock.');
    setPartialErr('');
    dispatch({ type: 'PROPOSE_PARTIAL', orderId: order.id, qty: partialQty, eta: partialEta });
  };

  if (!open)
    return (
      <section>
        <h3>Recovery actions</h3>
        <RequestSummary order={order} />
        <p className="muted">This order is {order.status}. No further actions.</p>
      </section>
    );

  return (
    <section className="actions">
      <h3>Recovery actions</h3>

      {r && (
        <>
          <RequestSummary order={order} />
          {r.status === 'pending' && (
            <div className="row-end">
              {r.type === 'alternative' && (
                <>
                  <button className="btn" onClick={() => dispatch({ type: 'DISTRIBUTOR_RESPOND', orderId: order.id, decision: 'decline' })}>
                    Decline
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={altShort}
                    title={altShort ? 'Supplier no longer has enough stock' : ''}
                    onClick={() => dispatch({ type: 'DISTRIBUTOR_RESPOND', orderId: order.id, decision: 'confirm' })}
                  >
                    Confirm alternative fulfilment
                  </button>
                </>
              )}
              {r.type === 'wait' && (
                <button className="btn btn-primary" onClick={() => dispatch({ type: 'DISTRIBUTOR_RESPOND', orderId: order.id, decision: 'acknowledge' })}>
                  Acknowledge — continue delivery
                </button>
              )}
              {r.type === 'cancel' && (
                <button className="btn btn-danger" onClick={() => dispatch({ type: 'DISTRIBUTOR_RESPOND', orderId: order.id, decision: 'acknowledge' })}>
                  Acknowledge cancellation & log refund (simulated)
                </button>
              )}
            </div>
          )}
          {altShort && r.status === 'pending' && <p className="text-danger small">Supplier stock is now below the requested quantity.</p>}
        </>
      )}

      <div className="action-grid">
        <div className="action-card">
          <h4>Delivery ETA</h4>
          <p className="muted small">Log a disruption or revise the ETA. The retailer is notified automatically.</p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => openForm('report')}>
              Report disruption
            </button>
            <button className="btn" onClick={() => openForm('update')}>
              Update ETA
            </button>
          </div>
        </div>

        <div className="action-card">
          <h4>Fulfilment</h4>
          <p className="muted small">
            Warehouse stock of {product.name}: <b>{inv} {product.unit}</b>
          </p>
          <div className="row">
            {(order.status === 'awaiting_allocation' || order.status === 'partially_allocated') && onGoToAllocation && (
              <button className="btn btn-primary" onClick={onGoToAllocation}>
                Allocate available stock →
              </button>
            )}
            {order.status === 'allocated' && (
              <button className="btn" onClick={() => dispatch({ type: 'ADVANCE', orderId: order.id, to: 'in_transit' })}>
                Mark dispatched
              </button>
            )}
            {['in_transit', 'delayed', 'rerouted'].includes(order.status) && (
              <button className="btn" onClick={() => dispatch({ type: 'ADVANCE', orderId: order.id, to: 'delivered' })}>
                Mark delivered
              </button>
            )}
          </div>
        </div>
      </div>

      {order.status === 'delayed' && (
        <div className="action-card">
          <h4>Propose partial fulfilment</h4>
          {order.partial && order.partial.status !== 'declined' ? (
            <p className="small">
              {order.partial.qty} {product.unit} by {fmt(order.partial.eta)} — <b>{order.partial.status}</b> by retailer.
            </p>
          ) : inv === 0 ? (
            <p className="muted small">No warehouse stock of this product to send ahead.</p>
          ) : (
            <>
              <p className="muted small">
                Send part of the order now from warehouse stock (reserved until the retailer responds); the rest follows on the
                delayed shipment.
              </p>
              <div className="row">
                <label className="inline">
                  Qty
                  <input type="number" min={1} max={Math.min(inv, order.quantity - 1)} value={partialQty} onChange={(e) => setPartialQty(Number(e.target.value))} />
                </label>
                <label className="inline">
                  Deliver by
                  <input type="datetime-local" value={partialEta} min={DEMO_NOW} onChange={(e) => setPartialEta(e.target.value)} />
                </label>
                <button className="btn btn-primary" onClick={propose}>
                  Propose to retailer
                </button>
              </div>
              {partialErr && <p className="text-danger small">{partialErr}</p>}
            </>
          )}
        </div>
      )}

      {order.status === 'delayed' && (
        <div className="action-card">
          <h4>Suggest an alternative supplier</h4>
          <SupplierTable
            state={state}
            order={order}
            highlightId={order.suggestedSupplierId}
            action={(opt) => (
              <button
                className="btn btn-sm"
                disabled={order.suggestedSupplierId === opt.supplier.id}
                onClick={() => dispatch({ type: 'SUGGEST_SUPPLIER', orderId: order.id, supplierId: opt.supplier.id })}
              >
                {order.suggestedSupplierId === opt.supplier.id ? 'Suggested' : 'Suggest to retailer'}
              </button>
            )}
          />
        </div>
      )}
    </section>
  );
}

function RetailerActions({ order }: { order: Order }) {
  const { state, dispatch } = useStore();
  const product = findProduct(state, order.productId);
  const dist = findSupplier(state, order.distributorId);
  const r = order.request;
  const locked = r && (r.status === 'confirmed' || r.status === 'acknowledged');
  const opts = rankSuppliers(state, order);
  const defaultSupplier = order.suggestedSupplierId ?? opts[0]?.supplier.id ?? '';
  const [altSupplier, setAltSupplier] = useState(defaultSupplier);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const need = remainingNeed(order);
  const chosen = opts.find((o) => o.supplier.id === altSupplier);

  const request = (type: 'wait' | 'alternative' | 'cancel', supplierId?: string, qty?: number) =>
    dispatch({ type: 'RETAILER_REQUEST', orderId: order.id, request: type, supplierId, qty });

  return (
    <section className="actions">
      <h3>Recovery options</h3>

      {order.partial?.status === 'proposed' && (
        <div className="callout callout-info">
          <b>Partial fulfilment offered</b>
          <p>
            {dist.name} can deliver {order.partial.qty} of {order.quantity} {product.unit} by {fmt(order.partial.eta)}. The rest
            follows on the delayed shipment.
          </p>
          <div className="row-end">
            <button className="btn" onClick={() => dispatch({ type: 'RESPOND_PARTIAL', orderId: order.id, accept: false })}>
              Decline
            </button>
            <button className="btn btn-primary" onClick={() => dispatch({ type: 'RESPOND_PARTIAL', orderId: order.id, accept: true })}>
              Accept partial delivery
            </button>
          </div>
        </div>
      )}

      <RequestSummary order={order} />

      {order.status !== 'delayed' && !r && <p className="muted">No disruption on this order. Recovery options appear here if it is delayed.</p>}

      {order.status === 'delayed' && !locked && order.paymentType === 'COD' && (
        <div className="action-card">
          <h4>Alternative suppliers (COD order)</h4>
          <p className="muted small">
            Suppliers that stock {product.name} and can deliver before your estimated stockout. Requesting an alternative order
            notifies {dist.name}; your original order stays open until they confirm.
          </p>
          <SupplierTable
            state={state}
            order={order}
            highlightId={order.suggestedSupplierId}
            action={(opt) =>
              opt.beforeStockout ? (
                <button
                  className={`btn btn-sm ${opt.rank === 1 ? 'btn-primary' : ''}`}
                  disabled={r?.status === 'pending' && r.supplierId === opt.supplier.id}
                  onClick={() => request('alternative', opt.supplier.id, opt.coverQty)}
                >
                  {r?.status === 'pending' && r.supplierId === opt.supplier.id
                    ? 'Requested'
                    : opt.enoughStock
                      ? 'Request alternative order'
                      : `Request partial (${opt.coverQty})`}
                </button>
              ) : (
                <span className="muted small">Too late</span>
              )
            }
          />
        </div>
      )}

      {order.status === 'delayed' && !locked && order.paymentType === 'Prepaid' && (
        <>
          <div className="option-grid">
            <div className={`option ${r?.type === 'wait' ? 'option-selected' : ''}`}>
              <h4>1. Wait for original delivery</h4>
              <p className="muted small">Accept the revised ETA of {fmt(order.currentEta)}.</p>
              <button className="btn" disabled={r?.type === 'wait'} onClick={() => request('wait')}>
                {r?.type === 'wait' ? 'Selected' : 'Wait for delivery'}
              </button>
            </div>
            <div className={`option ${r?.type === 'alternative' ? 'option-selected' : ''}`}>
              <h4>2. Request alternative fulfilment</h4>
              <p className="muted small">Ask {dist.name} to coordinate delivery from another supplier (your payment stays with them).</p>
              <select value={altSupplier} onChange={(e) => setAltSupplier(e.target.value)}>
                {opts.map((o) => (
                  <option key={o.supplier.id} value={o.supplier.id}>
                    {o.supplier.name} — {o.coverQty}/{need} by {fmt(o.eta)}
                    {o.qualifies ? ' ✓' : !o.beforeStockout ? ' (after stockout)' : ' (partial)'}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-primary"
                disabled={!chosen || (r?.type === 'alternative' && r.supplierId === altSupplier && r.status === 'pending')}
                onClick={() => chosen && request('alternative', chosen.supplier.id, chosen.coverQty)}
              >
                Request alternative fulfilment
              </button>
            </div>
            <div className={`option ${r?.type === 'cancel' ? 'option-selected' : ''}`}>
              <h4>3. Request cancellation/refund</h4>
              <p className="muted small">Cancel and request a refund from {dist.name}. Demo only: no money is moved.</p>
              <label className="check">
                <input type="checkbox" checked={confirmCancel} onChange={(e) => setConfirmCancel(e.target.checked)} />I want to cancel this order
              </label>
              <button className="btn btn-danger" disabled={!confirmCancel || r?.type === 'cancel'} onClick={() => request('cancel')}>
                {r?.type === 'cancel' ? 'Requested' : 'Request cancellation'}
              </button>
            </div>
          </div>
          <div className="action-card">
            <h4>Recommended alternative suppliers</h4>
            <SupplierTable state={state} order={order} highlightId={order.suggestedSupplierId} />
          </div>
        </>
      )}
    </section>
  );
}
