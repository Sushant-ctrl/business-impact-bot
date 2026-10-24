import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { days, findProduct, fmt, money, rankSuppliers, stockoutRisk } from '../../shared/logic.ts';
import type { SupplierOption } from '../../shared/logic.ts';
import type { Message, Notification, Order, Role, TimelineEvent, World } from '../../shared/types.ts';
import type { Toast } from './api.tsx';

export function Badge({ tone = 'neutral', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Metric({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: string }) {
  return (
    <div className={`card metric ${tone ? `metric-${tone}` : ''}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {hint && <div className="metric-hint">{hint}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (t: T) => void; items: [T, ReactNode][] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={value === key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} onClick={() => onDismiss(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

export function Notifications({
  items,
  onOpen,
  onMarkRead,
}: {
  items: Notification[];
  onOpen: (orderId: string) => void;
  onMarkRead: () => void;
}) {
  const unread = items.filter((n) => !n.read).length;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Notifications {unread > 0 && <span className="count">{unread}</span>}</h3>
        {unread > 0 && (
          <button className="btn btn-link" onClick={onMarkRead}>
            Mark all read
          </button>
        )}
      </div>
      {items.length === 0 && <p className="muted">No notifications yet.</p>}
      <ul className="notes">
        {items.map((n) => (
          <li key={n.id} className={`note note-${n.tone} ${n.read ? '' : 'note-unread'}`}>
            <p>{n.message}</p>
            <div className="note-meta">
              <span>{fmt(n.at)}</span>
              <button className="btn btn-link" onClick={() => onOpen(n.orderId)}>
                View order #{n.orderId} →
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id} className={`tl-${e.actor}`}>
          <div className="tl-dot" />
          <div>
            <div className="tl-label">{e.label}</div>
            {e.detail && <div className="tl-detail">{e.detail}</div>}
            <div className="tl-meta">
              {fmt(e.at)} · {e.actor}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Thread({
  messages,
  me,
  names,
  onSend,
}: {
  messages: Message[];
  me: Role;
  names: Record<Role, string>;
  onSend: (body: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [messages.length]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    if (await onSend(text.trim())) setText('');
    setSending(false);
  };

  return (
    <div className="thread">
      <div className="thread-list">
        {messages.length === 0 && <p className="muted small">No messages yet. Messages notify the other party instantly.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role === me ? 'bubble-me' : ''}`}>
            <div className="bubble-meta">
              {names[m.role]} · {fmt(m.at)}
            </div>
            {m.body}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="thread-form" onSubmit={submit}>
        <input value={text} maxLength={1000} placeholder="Write a message…" onChange={(e) => setText(e.target.value)} />
        <button className="btn btn-primary" disabled={!text.trim() || sending}>
          Send
        </button>
      </form>
    </div>
  );
}

export function RiskPanel({ state, order }: { state: World; order: Order }) {
  const r = stockoutRisk(order, state.now);
  const unit = findProduct(state, order.productId).unit;
  return (
    <div className={`risk ${r.high ? 'risk-high' : 'risk-low'}`}>
      <div className="risk-head">
        <strong>Stockout risk</strong>
        <Badge tone={r.high ? 'danger' : 'success'}>{r.high ? 'High risk' : 'Low risk'}</Badge>
      </div>
      <div className="risk-grid">
        <div>
          <span>Current stock</span>
          <b>
            {order.retailerStock} {unit}
          </b>
        </div>
        <div>
          <span>Avg daily sales</span>
          <b>{order.avgDailySales} / day</b>
        </div>
        <div>
          <span>Days remaining</span>
          <b>{days(r.daysOfStock)} days</b>
        </div>
        <div>
          <span>Days to delivery</span>
          <b>{days(r.daysUntilDelivery)} days</b>
        </div>
      </div>
      <p className="assumption">
        {r.stockoutAt && (
          <>
            Estimated stockout: <b>{fmt(r.stockoutAt)}</b>.{' '}
          </>
        )}
        Shelf stock is the retailer's last count minus average daily sales since then. It is high risk when stock runs out at or
        before the current ETA ({fmt(order.currentEta)}).
      </p>
    </div>
  );
}

export function SupplierTable({
  state,
  order,
  action,
  highlightId,
}: {
  state: World;
  order: Order;
  action?: (opt: SupplierOption) => ReactNode;
  highlightId?: string;
}) {
  const opts = rankSuppliers(state, order);
  const unit = findProduct(state, order.productId).unit;
  if (opts.length === 0) return <p className="muted">No other supplier stocks this product.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Supplier</th>
            <th>Available</th>
            <th>Price</th>
            <th>Est. delivery</th>
            <th>Before stockout?</th>
            <th>Fit</th>
            {action && <th />}
          </tr>
        </thead>
        <tbody>
          {opts.map((o) => (
            <tr key={o.supplier.id} className={o.supplier.id === highlightId ? 'row-hl' : ''}>
              <td>{o.rank}</td>
              <td>
                <div className="strong">{o.supplier.name}</div>
                <div className="muted small">
                  {o.supplier.city}
                  {o.supplier.id === highlightId && ' · suggested by your distributor'}
                </div>
              </td>
              <td>
                {o.available} {unit}
              </td>
              <td>{money(o.price)}</td>
              <td>{fmt(o.eta)}</td>
              <td>{o.beforeStockout ? <Badge tone="success">Yes</Badge> : <Badge tone="danger">No</Badge>}</td>
              <td>
                {o.qualifies ? (
                  <Badge tone="success">{o.rank === 1 ? 'Best match' : 'Full quantity'}</Badge>
                ) : o.beforeStockout ? (
                  <Badge tone="warning">Partial · {o.coverQty}</Badge>
                ) : (
                  <Badge tone="neutral">Arrives late</Badge>
                )}
              </td>
              {action && <td className="right">{action(o)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="assumption">
        Ranked by: 1) enough stock for the full quantity, 2) delivery before estimated stockout, 3) lowest price. Stock and prices
        are live.
      </p>
    </div>
  );
}
