import { useState } from 'react';
import type { FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  addHours,
  findProduct,
  findRetailer,
  findSupplier,
  fmt,
  isOpen,
  isPreDispatch,
  money,
  remainingNeed,
  resolutionLabel,
  STATUS_LABELS,
  STATUS_TONE,
  stockOf,
  toMs,
} from '../../shared/logic.ts';
import { REASON_LABELS } from '../../shared/types.ts';
import type { DisruptionReason, Order, RequestType, Supplier } from '../../shared/types.ts';
import { DisruptionAgentSection } from './Agents.tsx';
import { usePortal } from './api.tsx';
import { Badge, Modal, RiskPanel, SupplierTable, Thread, Timeline } from './ui.tsx';

// Replace with the real distributor UPI ID before going live.
const DISTRIBUTOR_UPI_ID = 'sushantku24@okaxis';

interface DisruptionDraft {
  reason: DisruptionReason;
  eta: string | null;
  description: string;
  retailerMessage: string;
  source: 'ai' | 'rules';
  note?: string;
}

export function DisruptionForm({ order, mode, onClose }: { order: Order; mode: 'report' | 'update'; onClose: () => void }) {
  const { view, act, ask } = usePortal();
  const [reason, setReason] = useState<DisruptionReason | ''>(mode === 'update' ? (order.disruption?.reason ?? 'other') : '');
  const [eta, setEta] = useState(mode === 'update' ? order.currentEta : '');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');
  const [freeText, setFreeText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftInfo, setDraftInfo] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const draft = async () => {
    setDrafting(true);
    setDraftInfo('');
    try {
      const d = await ask<DisruptionDraft>('/ai/parse-disruption', { orderId: order.id, text: freeText });
      setReason(d.reason);
      if (d.eta) setEta(d.eta);
      setDescription(d.description);
      setMessage(d.retailerMessage);
      setDraftInfo(
        (d.source === 'ai' ? 'Filled in by AI — review before sending.' : 'Filled in with keyword rules — review before sending.') +
          (d.eta ? '' : ' No timing found: set the revised ETA yourself.') +
          (d.note ? ` ${d.note}` : ''),
      );
    } catch (e) {
      setDraftInfo((e as Error).message);
    }
    setDrafting(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: string[] = [];
    if (mode === 'report' && !reason) errs.push('Select a disruption reason.');
    if (!eta) errs.push('Enter the revised delivery ETA.');
    else if (toMs(eta) <= Date.now()) errs.push('Revised ETA must be in the future.');
    else if (eta === order.currentEta) errs.push('Revised ETA is the same as the current ETA.');
    if (description.length > 200) errs.push('Keep the description under 200 characters.');
    setErrors(errs);
    if (errs.length) return;
    setSaving(true);
    const ok =
      mode === 'report'
        ? await act('POST', `/orders/${order.id}/disruption`, { reason, eta, description, message }, `Disruption reported · ${findRetailer(view, order.retailerId).name} notified`)
        : await act('POST', `/orders/${order.id}/eta`, { eta, note: description }, 'ETA updated · retailer notified');
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Modal title={`${mode === 'report' ? 'Report disruption' : 'Update delivery ETA'} · Order #${order.id}`} onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <p className="muted small">
          Current ETA: <b>{fmt(order.currentEta)}</b> · Original ETA: {fmt(order.originalEta)}
        </p>
        {mode === 'report' && (
          <div className="ai-box">
            <label>
              Describe what happened <span className="muted small">— AI fills in the form for you</span>
              <textarea
                rows={2}
                value={freeText}
                maxLength={1000}
                placeholder="e.g. Truck stuck behind a landslide on the Katraj ghat, should reach them tomorrow evening"
                onChange={(e) => setFreeText(e.target.value)}
              />
            </label>
            <div className="row">
              <button type="button" className="btn btn-ai" disabled={!freeText.trim() || drafting} onClick={draft}>
                {drafting ? 'Drafting…' : '✦ Draft report'}
              </button>
              {draftInfo && <span className="muted small">{draftInfo}</span>}
            </div>
          </div>
        )}
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
          <input type="datetime-local" value={eta} min={view.now} onChange={(e) => setEta(e.target.value)} />
        </label>
        <label>
          {mode === 'report' ? 'Short description for the order log (optional)' : 'Note (optional)'}
          <textarea
            rows={2}
            value={description}
            maxLength={200}
            placeholder={mode === 'report' ? 'e.g. NH-48 closed near Talegaon until Saturday noon' : ''}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {mode === 'report' && (
          <label>
            Message to retailer (optional)
            <textarea
              rows={3}
              value={message}
              maxLength={500}
              placeholder="Leave empty to send the standard delay notice."
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
        )}
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
          <button type="submit" className="btn btn-primary" disabled={saving}>
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
        <div className="upi-qr-id">
          UPI ID: <b>{DISTRIBUTOR_UPI_ID}</b>
        </div>
        <div className="upi-qr-amount">
          Amount: <b>{money(amount)}</b>
        </div>
        <p className="upi-qr-hint">Scan this QR code using Google Pay, PhonePe, Paytm, or any UPI app to make your payment.</p>
      </div>
    </Modal>
  );
}

export function OrderDetail({ orderId, onClose, onGoToAllocation }: { orderId: string; onClose: () => void; onGoToAllocation?: () => void }) {
  const { view: state, role, act } = usePortal();
  const [form, setForm] = useState<'report' | 'update' | null>(null);
  const [showQr, setShowQr] = useState(false);
  const order = state.orders.find((o) => o.id === orderId);
  if (!order)
    return (
      <div className="overlay" onMouseDown={onClose}>
        <aside className="drawer" onMouseDown={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>Order #{orderId}</h2>
            <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="drawer-body muted">This order is not part of this account.</div>
        </aside>
      </div>
    );
  const product = findProduct(state, order.productId);
  const retailer = findRetailer(state, order.retailerId);
  const dist = findSupplier(state, order.distributorId);
  const res = resolutionLabel(state, order);
  const messages = state.messages.filter((m) => m.orderId === order.id);

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

          {order.disruption && isOpen(order) && (
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

          {role === 'distributor' && <DisruptionAgentSection orderId={order.id} hasDisruption={Boolean(order.disruption) && isOpen(order)} />}

          <section>
            <h3>Messages</h3>
            <Thread
              messages={messages}
              me={role}
              names={{ distributor: dist.name, retailer: retailer.name }}
              onSend={async (body) => (await act('POST', `/orders/${order.id}/messages`, { body })) !== null}
            />
          </section>

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
  const { view: state } = usePortal();
  const r = order.request;
  if (!r) return null;
  const unit = findProduct(state, order.productId).unit;
  const text = {
    wait: `Wait for the original delivery (ETA ${fmt(order.currentEta)})`,
    alternative: r.supplierId
      ? `${order.paymentType === 'COD' ? 'Alternative order' : 'Alternative fulfilment'}: ${r.qty} ${unit} via ${findSupplier(state, r.supplierId).name}, est. ${fmt(r.eta!)}`
      : 'Alternative fulfilment',
    cancel:
      order.paymentType === 'Prepaid' ? 'Cancel order and refund (simulated workflow — no money is moved)' : 'Cancel order (cash on delivery — nothing to refund)',
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
  const { view: state, act } = usePortal();
  const dist = findSupplier(state, order.distributorId);
  const product = findProduct(state, order.productId);
  const inv = stockOf(dist, order.productId)?.qty ?? 0;
  const r = order.request;
  const [partialQty, setPartialQty] = useState(Math.max(1, Math.min(inv, order.quantity - 1)));
  const [partialEta, setPartialEta] = useState(addHours(state.now, 6));
  const [partialErr, setPartialErr] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const open = isOpen(order);
  const altItem = r?.supplierId ? stockOf(findSupplier(state, r.supplierId), order.productId) : undefined;
  const altShort = r?.type === 'alternative' && (altItem?.qty ?? 0) < (r.qty ?? 0);
  const path = `/orders/${order.id}`;

  const propose = () => {
    if (!Number.isInteger(partialQty) || partialQty < 1) return setPartialErr('Enter a whole quantity of at least 1.');
    if (partialQty > inv) return setPartialErr(`Only ${inv} ${product.unit} in stock.`);
    if (partialQty >= order.quantity) return setPartialErr('Partial quantity must be less than the order quantity.');
    if (!partialEta || toMs(partialEta) <= Date.now()) return setPartialErr('Choose a delivery time in the future.');
    setPartialErr('');
    act('POST', `${path}/partial`, { qty: partialQty, eta: partialEta }, 'Partial fulfilment proposed');
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
                  <button className="btn" onClick={() => act('POST', `${path}/respond`, { decision: 'decline' }, 'Request declined')}>
                    Decline
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={altShort}
                    title={altShort ? 'Supplier no longer has enough stock' : ''}
                    onClick={() => act('POST', `${path}/respond`, { decision: 'confirm' }, 'Alternative fulfilment confirmed')}
                  >
                    Confirm alternative fulfilment
                  </button>
                </>
              )}
              {r.type === 'wait' && (
                <button className="btn btn-primary" onClick={() => act('POST', `${path}/respond`, { decision: 'acknowledge' }, 'Acknowledged')}>
                  Acknowledge — continue delivery
                </button>
              )}
              {r.type === 'cancel' && (
                <button className="btn btn-danger" onClick={() => act('POST', `${path}/respond`, { decision: 'acknowledge' }, 'Cancellation acknowledged')}>
                  Acknowledge cancellation{order.paymentType === 'Prepaid' ? ' & log refund (simulated)' : ''}
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
          <p className="muted small">Log a disruption or revise the ETA. The retailer is notified instantly.</p>
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
            Warehouse stock of {product.name}:{' '}
            <b>
              {inv} {product.unit}
            </b>
          </p>
          <div className="row">
            {(order.status === 'awaiting_allocation' || order.status === 'partially_allocated') && onGoToAllocation && (
              <button className="btn btn-primary" onClick={onGoToAllocation}>
                Allocate available stock →
              </button>
            )}
            {order.status === 'allocated' && (
              <button className="btn btn-primary" onClick={() => act('POST', `${path}/advance`, { to: 'in_transit' }, 'Marked dispatched')}>
                Mark dispatched
              </button>
            )}
            {['in_transit', 'delayed', 'rerouted'].includes(order.status) && (
              <button className="btn" onClick={() => act('POST', `${path}/advance`, { to: 'delivered' }, 'Marked delivered')}>
                Mark delivered
              </button>
            )}
            {isPreDispatch(order) && !rejecting && (
              <button className="btn btn-danger-ghost" onClick={() => setRejecting(true)}>
                Reject order
              </button>
            )}
          </div>
          {rejecting && (
            <div className="row reject-row">
              <input value={rejectReason} maxLength={200} placeholder="Reason shown to the retailer" onChange={(e) => setRejectReason(e.target.value)} />
              <button className="btn" onClick={() => setRejecting(false)}>
                Keep
              </button>
              <button
                className="btn btn-danger"
                disabled={!rejectReason.trim()}
                onClick={() => act('POST', `${path}/reject`, { reason: rejectReason }, 'Order rejected · retailer notified')}
              >
                Reject
              </button>
            </div>
          )}
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
                  <input type="datetime-local" value={partialEta} min={state.now} onChange={(e) => setPartialEta(e.target.value)} />
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
                onClick={() => act('POST', `${path}/suggest`, { supplierId: opt.supplier.id }, 'Suggestion sent to retailer')}
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

interface Advice {
  recommendation: RequestType | 'accept_partial';
  supplierId?: string;
  qty?: number;
  headline: string;
  reasoning: string;
  source: 'ai' | 'rules';
  note?: string;
}

const ADVICE_ACTION: Record<Advice['recommendation'], string> = {
  wait: 'Wait for delivery',
  alternative: 'Request this alternative',
  cancel: 'Request cancellation',
  accept_partial: 'Accept partial delivery',
};

function AdviceCard({ order, request }: { order: Order; request: (type: RequestType, supplierId?: string, qty?: number) => void }) {
  const { act, ask } = usePortal();
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setAdvice(await ask<Advice>('/ai/recovery-advice', { orderId: order.id }));
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };

  const apply = () => {
    if (!advice) return;
    if (advice.recommendation === 'accept_partial') act('POST', `/orders/${order.id}/partial-response`, { accept: true }, 'Partial delivery accepted');
    else request(advice.recommendation, advice.supplierId, advice.qty);
  };

  return (
    <div className="ai-box">
      <div className="row-between">
        <h4>✦ What should I do?</h4>
        <button className="btn btn-ai btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Thinking…' : advice ? 'Ask again' : 'Get a recommendation'}
        </button>
      </div>
      {!advice && !error && <p className="muted small">Weighs your shelf stock, the revised ETA, supplier prices and any partial offer.</p>}
      {error && <p className="text-danger small">{error}</p>}
      {advice && (
        <>
          <p className="strong">{advice.headline}</p>
          <p className="small">{advice.reasoning}</p>
          <div className="row-between">
            <span className="muted small">
              {advice.source === 'ai' ? 'AI recommendation' : 'Rule-based recommendation'}
              {advice.note ? ` · ${advice.note}` : ''}
            </span>
            <button className="btn btn-primary btn-sm" onClick={apply}>
              {ADVICE_ACTION[advice.recommendation]}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RetailerActions({ order }: { order: Order }) {
  const { view: state, act } = usePortal();
  const product = findProduct(state, order.productId);
  const dist = findSupplier(state, order.distributorId);
  const r = order.request;
  const locked = r && (r.status === 'confirmed' || r.status === 'acknowledged');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const need = remainingNeed(order);
  const path = `/orders/${order.id}`;

  const request = (type: RequestType, supplierId?: string, qty?: number) =>
    act('POST', `${path}/request`, { request: type, supplierId, qty }, `Sent to ${dist.name}`);

  if (isPreDispatch(order))
    return (
      <section className="actions">
        <h3>Order actions</h3>
        <p className="muted small">
          {dist.name} hasn't dispatched this order yet ({order.allocatedQty}/{order.quantity} {product.unit} allocated). You can still
          cancel it at no cost.
        </p>
        <div className="row">
          <input value={cancelReason} maxLength={200} placeholder="Reason (optional)" onChange={(e) => setCancelReason(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={confirmCancel} onChange={(e) => setConfirmCancel(e.target.checked)} />
            Cancel this order
          </label>
          <button className="btn btn-danger" disabled={!confirmCancel} onClick={() => act('POST', `${path}/cancel`, { reason: cancelReason }, 'Order cancelled')}>
            Cancel order
          </button>
        </div>
      </section>
    );

  return (
    <section className="actions">
      <h3>Recovery options</h3>

      {order.partial?.status === 'proposed' && (
        <div className="callout callout-info">
          <b>Partial fulfilment offered</b>
          <p>
            {dist.name} can deliver {order.partial.qty} of {order.quantity} {product.unit} by {fmt(order.partial.eta)}. The rest follows
            on the delayed shipment.
          </p>
          <div className="row-end">
            <button className="btn" onClick={() => act('POST', `${path}/partial-response`, { accept: false }, 'Partial delivery declined')}>
              Decline
            </button>
            <button className="btn btn-primary" onClick={() => act('POST', `${path}/partial-response`, { accept: true }, 'Partial delivery accepted')}>
              Accept partial delivery
            </button>
          </div>
        </div>
      )}

      <RequestSummary order={order} />

      {order.status !== 'delayed' && !r && <p className="muted">No disruption on this order. Recovery options appear here if it is delayed.</p>}

      {order.status === 'delayed' && !locked && (
        <>
          <AdviceCard order={order} request={request} />
          <div className="option-grid option-grid-2">
            <div className={`option ${r?.type === 'wait' ? 'option-selected' : ''}`}>
              <h4>Wait for the delivery</h4>
              <p className="muted small">Accept the revised ETA of {fmt(order.currentEta)}.</p>
              <button className="btn" disabled={r?.type === 'wait' && r.status === 'pending'} onClick={() => request('wait')}>
                {r?.type === 'wait' && r.status === 'pending' ? 'Selected' : 'Wait for delivery'}
              </button>
            </div>
            <div className={`option ${r?.type === 'cancel' ? 'option-selected' : ''}`}>
              <h4>{order.paymentType === 'Prepaid' ? 'Cancel & request refund' : 'Cancel the order'}</h4>
              <p className="muted small">
                {order.paymentType === 'Prepaid'
                  ? `Cancel and request a refund from ${dist.name}. Simulated: no money is moved.`
                  : 'Cash on delivery: nothing has been paid, so there is nothing to refund.'}
              </p>
              <label className="check">
                <input type="checkbox" checked={confirmCancel} onChange={(e) => setConfirmCancel(e.target.checked)} />I want to cancel this order
              </label>
              <button className="btn btn-danger" disabled={!confirmCancel || (r?.type === 'cancel' && r.status === 'pending')} onClick={() => request('cancel')}>
                {r?.type === 'cancel' && r.status === 'pending' ? 'Requested' : 'Request cancellation'}
              </button>
            </div>
          </div>
          <div className="action-card">
            <h4>Get it from another supplier</h4>
            <p className="muted small">
              {order.paymentType === 'COD'
                ? `Place an alternative order for the ${need} ${product.unit} you still need.`
                : `Ask ${dist.name} to coordinate delivery of the ${need} ${product.unit} you still need from another supplier (your payment stays with them).`}{' '}
              Your original order stays open until {dist.name} confirms.
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
                    {r?.status === 'pending' && r.supplierId === opt.supplier.id ? 'Requested' : opt.enoughStock ? 'Request' : `Request ${opt.coverQty}`}
                  </button>
                ) : (
                  <span className="muted small">Too late</span>
                )
              }
            />
          </div>
        </>
      )}
    </section>
  );
}
