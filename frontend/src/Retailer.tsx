import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  addHours,
  awaitingResolution,
  days,
  daysBetween,
  findProduct,
  findRetailer,
  findSupplier,
  fmt,
  isOpen,
  money,
  needsRetailerDecision,
  resolutionLabel,
  STATUS_LABELS,
  STATUS_TONE,
  stockOf,
  stockoutRisk,
} from '../../shared/logic.ts';
import { REASON_LABELS } from '../../shared/types.ts';
import type { PaymentType } from '../../shared/types.ts';
import { usePortal } from './api.tsx';
import { Badge, Metric, Notifications, Tabs } from './ui.tsx';

export type RetailerTab = 'orders' | 'new' | 'stock';

export function RetailerDashboard({
  tab,
  setTab,
  openOrder,
}: {
  tab: RetailerTab;
  setTab: (t: RetailerTab) => void;
  openOrder: (id: string) => void;
}) {
  const { view: state, partyId, act } = usePortal();
  const retailer = findRetailer(state, partyId);
  const orders = state.orders;
  const open = orders.filter(isOpen);
  const delayed = orders.filter((o) => o.status === 'delayed');
  const highRisk = open.filter((o) => stockoutRisk(o, state.now).high);
  const needsDecision = orders.filter(needsRetailerDecision);
  const lowStock = state.stock.filter((s) => s.avgDailySales > 0 && s.qty / s.avgDailySales < 3);
  const [reorderProduct, setReorderProduct] = useState<string | undefined>();

  return (
    <div className="layout">
      <div className="main">
        <div className="page-head">
          <div>
            <h1>{retailer.name}</h1>
            <p className="muted">Retailer portal · {retailer.area}</p>
          </div>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              ['orders', <>Orders {needsDecision.length > 0 && <span className="count">{needsDecision.length}</span>}</>],
              ['new', 'Place order'],
              ['stock', <>My stock {lowStock.length > 0 && <span className="count">{lowStock.length}</span>}</>],
            ]}
          />
        </div>

        <div className="metrics">
          <Metric label="Open orders" value={open.length} hint={`${orders.length} total`} />
          <Metric label="Delayed orders" value={delayed.length} tone={delayed.length ? 'danger' : undefined} />
          <Metric label="High stockout risk" value={highRisk.length} tone={highRisk.length ? 'danger' : undefined} hint="products running out before delivery" />
          <Metric label="Decisions needed" value={needsDecision.length} tone={needsDecision.length ? 'warning' : undefined} />
        </div>

        {needsDecision.length > 0 && tab === 'orders' && (
          <div className="callout callout-warning banner">
            <b>Action needed:</b>{' '}
            {needsDecision.map((o) => (
              <button key={o.id} className="btn btn-link" onClick={() => openOrder(o.id)}>
                Order #{o.id}
              </button>
            ))}{' '}
            {needsDecision.length === 1 ? 'needs' : 'need'} a recovery decision.
          </div>
        )}

        {tab === 'orders' && <OrderList openOrder={openOrder} />}
        {tab === 'new' && (
          <PlaceOrder
            key={reorderProduct}
            initialProduct={reorderProduct}
            onPlaced={(id) => {
              setTab('orders');
              openOrder(id);
            }}
          />
        )}
        {tab === 'stock' && (
          <Stock
            onReorder={(productId) => {
              setReorderProduct(productId);
              setTab('new');
            }}
          />
        )}
      </div>
      <div className="side">
        <Notifications items={state.notifications} onOpen={openOrder} onMarkRead={() => act('POST', '/notifications/read')} />
      </div>
    </div>
  );
}

function OrderList({ openOrder }: { openOrder: (id: string) => void }) {
  const { view: state } = usePortal();
  const [show, setShow] = useState<'open' | 'all'>('open');
  const orders = state.orders.filter((o) => show === 'all' || isOpen(o));

  return (
    <>
      <div className="row-between list-head">
        <h3>Your orders</h3>
        <div className="filters">
          <button className={show === 'open' ? 'active' : ''} onClick={() => setShow('open')}>
            Open
          </button>
          <button className={show === 'all' ? 'active' : ''} onClick={() => setShow('all')}>
            All
          </button>
        </div>
      </div>
      <div className="order-cards">
        {orders.map((o) => {
          const p = findProduct(state, o.productId);
          const risk = stockoutRisk(o, state.now);
          const res = resolutionLabel(state, o);
          return (
            <div key={o.id} className={`card order-card ${o.status === 'delayed' ? 'order-delayed' : ''}`}>
              <div className="row-between">
                <span className="muted small">
                  Order #{o.id} · {findSupplier(state, o.distributorId).name}
                </span>
                <Badge tone={o.paymentType === 'COD' ? 'cod' : 'prepaid'}>{o.paymentType}</Badge>
              </div>
              <h3>
                {p.name} × {o.quantity} {p.unit}
              </h3>
              <div className="badges">
                <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABELS[o.status]}</Badge>
                {awaitingResolution(o) && o.status === 'delayed' && !o.request && <Badge tone="danger">Decision needed</Badge>}
              </div>
              <div className="kv kv-compact">
                <div>
                  <span>Original ETA</span>
                  <b>{fmt(o.originalEta)}</b>
                </div>
                <div>
                  <span>Revised ETA</span>
                  <b className={o.currentEta !== o.originalEta ? 'text-danger' : ''}>{o.currentEta !== o.originalEta ? fmt(o.currentEta) : 'On schedule'}</b>
                </div>
                <div>
                  <span>Value</span>
                  <b>{money(o.quantity * o.unitPrice)}</b>
                </div>
                <div>
                  <span>Disruption</span>
                  <b>{o.disruption && isOpen(o) ? REASON_LABELS[o.disruption.reason] : '—'}</b>
                </div>
              </div>
              {isOpen(o) && (
                <div className={`stockline ${risk.high ? 'text-danger' : ''}`}>
                  Stock {o.retailerStock} ÷ {o.avgDailySales}/day = <b>{days(risk.daysOfStock)} days</b> vs {days(risk.daysUntilDelivery)} days to
                  delivery
                  <Badge tone={risk.high ? 'danger' : 'success'}>{risk.high ? 'High risk' : 'Low risk'}</Badge>
                </div>
              )}
              <div className="row-between">
                <Badge tone={res.tone}>{res.label}</Badge>
                <button className={`btn btn-sm ${o.status === 'delayed' ? 'btn-primary' : ''}`} onClick={() => openOrder(o.id)}>
                  {o.status === 'delayed' ? 'View recovery options' : 'View details'}
                </button>
              </div>
            </div>
          );
        })}
        {orders.length === 0 && <p className="muted">No {show === 'open' ? 'open ' : ''}orders. Use “Place order” to order stock.</p>}
      </div>
    </>
  );
}

function PlaceOrder({ initialProduct, onPlaced }: { initialProduct?: string; onPlaced: (orderId: string) => void }) {
  const { view: state, partyId, act } = usePortal();
  const retailer = findRetailer(state, partyId);
  const distributors = retailer.distributorIds.map((id) => findSupplier(state, id));
  const [productId, setProductId] = useState(initialProduct ?? '');
  const shelf = state.stock.find((s) => s.productId === productId);
  const suggestedQty = shelf && shelf.avgDailySales > 0 ? Math.max(1, Math.ceil(shelf.avgDailySales * 7 - shelf.qty)) : 10;
  const [quantity, setQuantity] = useState(String(suggestedQty));
  const [distributorId, setDistributorId] = useState('');
  const [paymentType, setPaymentType] = useState<PaymentType>('COD');
  const [saving, setSaving] = useState(false);

  const products = state.products.filter((p) => distributors.some((d) => stockOf(d, p.id)));
  const qty = Number(quantity);
  const offers = productId
    ? distributors.flatMap((d) => {
        const item = stockOf(d, productId);
        return item ? [{ d, item, eta: addHours(state.now, d.deliveryHours) }] : [];
      })
    : [];
  // Default to the offer that can cover the quantity soonest, then cheapest.
  const best = [...offers].sort(
    (a, b) => Number(b.item.qty >= qty) - Number(a.item.qty >= qty) || a.d.deliveryHours - b.d.deliveryHours || a.item.price - b.item.price,
  )[0];
  const chosen = offers.find((o) => o.d.id === distributorId) ?? best;
  const cover = shelf && shelf.avgDailySales > 0 ? shelf.qty / shelf.avgDailySales : Infinity;
  const valid = chosen && Number.isInteger(qty) && qty >= 1 && qty <= 10_000;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    const res = await act<{ result: string }>(
      'POST',
      '/orders',
      { distributorId: chosen.d.id, productId, quantity: qty, paymentType },
      `Order placed with ${chosen.d.name}`,
    );
    setSaving(false);
    if (res) onPlaced(res.result);
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Place a new order</h3>
      </div>
      <form className="form place-order" onSubmit={submit}>
        <div className="form-row">
          <label>
            Product
            <select
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                setDistributorId('');
                const s = state.stock.find((x) => x.productId === e.target.value);
                if (s && s.avgDailySales > 0) setQuantity(String(Math.max(1, Math.ceil(s.avgDailySales * 7 - s.qty))));
              }}
            >
              <option value="">Choose a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Quantity {productId && <span className="muted small">({findProduct(state, productId).unit})</span>}
            <input type="number" min={1} max={10000} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </label>
          <label>
            Payment
            <select value={paymentType} onChange={(e) => setPaymentType(e.target.value as PaymentType)}>
              <option value="COD">Cash on delivery</option>
              <option value="Prepaid">Prepaid (simulated)</option>
            </select>
          </label>
        </div>

        {shelf && (
          <p className="muted small">
            You have about <b>{shelf.qty}</b> on the shelf, selling {shelf.avgDailySales}/day → <b>{days(cover)} days</b> of cover. Suggested
            quantity covers 7 days of sales.
          </p>
        )}

        {offers.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>Distributor</th>
                  <th>In stock</th>
                  <th>Price</th>
                  <th>Total</th>
                  <th>Est. delivery</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {offers.map((o) => {
                  const late = Number.isFinite(cover) && daysBetween(state.now, o.eta) > cover;
                  return (
                    <tr key={o.d.id} className={chosen?.d.id === o.d.id ? 'row-hl clickable' : 'clickable'} onClick={() => setDistributorId(o.d.id)}>
                      <td>
                        <input type="radio" name="dist" checked={chosen?.d.id === o.d.id} onChange={() => setDistributorId(o.d.id)} />
                      </td>
                      <td className="strong">{o.d.name}</td>
                      <td>
                        {o.item.qty}
                        {o.item.qty < qty && <div className="text-danger small">short by {qty - o.item.qty}</div>}
                      </td>
                      <td>{money(o.item.price)}</td>
                      <td>{Number.isInteger(qty) && qty > 0 ? money(qty * o.item.price) : '—'}</td>
                      <td>
                        {fmt(o.eta)}
                        {late && <div className="text-danger small">after you run out</div>}
                      </td>
                      <td>{best?.d.id === o.d.id && <Badge tone="success">Recommended</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="row-end">
          <button className="btn btn-primary" disabled={!valid || saving}>
            {chosen && valid ? `Place order · ${money(qty * chosen.item.price)}` : 'Place order'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Stock({ onReorder }: { onReorder: (productId: string) => void }) {
  const { view: state, act } = usePortal();
  const [editing, setEditing] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [rate, setRate] = useState('');
  const [adding, setAdding] = useState('');
  const untracked = state.products.filter((p) => !state.stock.some((s) => s.productId === p.id));

  const startEdit = (productId: string, q: number, r: number) => {
    setEditing(productId);
    setQty(String(q));
    setRate(String(r));
  };
  const save = async (productId: string) => {
    if (await act('PUT', `/stock/${productId}`, { qty: Number(qty), avgDailySales: Number(rate) }, 'Stock count saved')) {
      setEditing(null);
      setAdding('');
    }
  };
  const valid = qty !== '' && Number(qty) >= 0 && rate !== '' && Number(rate) >= 0;
  const incoming = (productId: string) =>
    state.orders.filter((o) => isOpen(o) && o.productId === productId).reduce((a, o) => a + o.quantity, 0);

  const rows = state.stock
    .map((s) => ({ s, cover: s.avgDailySales > 0 ? s.qty / s.avgDailySales : Infinity }))
    .sort((a, b) => a.cover - b.cover);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Shelf stock</h3>
          <p className="muted small">
            Estimated from your last count minus average daily sales since. Update the count whenever you check the shelf; deliveries
            are added automatically.
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th>On shelf (est.)</th>
              <th>Avg sales / day</th>
              <th>Days of cover</th>
              <th>Incoming</th>
              <th>Last counted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, cover }) => {
              const p = findProduct(state, s.productId);
              const inc = incoming(s.productId);
              return editing === s.productId ? (
                <tr key={s.productId}>
                  <td className="strong">{p.name}</td>
                  <td>
                    <input className="qty" type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} />
                  </td>
                  <td>
                    <input className="qty" type="number" min={0} step="0.5" value={rate} onChange={(e) => setRate(e.target.value)} />
                  </td>
                  <td colSpan={3} />
                  <td className="right">
                    <button className="btn btn-sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>{' '}
                    <button className="btn btn-sm btn-primary" disabled={!valid} onClick={() => save(s.productId)}>
                      Save
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={s.productId}>
                  <td className="strong">
                    {p.name}
                    <div className="muted small">{p.category}</div>
                  </td>
                  <td>
                    {s.qty} {p.unit}
                  </td>
                  <td>{s.avgDailySales}</td>
                  <td>
                    <Badge tone={cover < 2 ? 'danger' : cover < 4 ? 'warning' : 'success'}>{days(cover)} days</Badge>
                  </td>
                  <td>{inc > 0 ? `${inc} ${p.unit}` : <span className="muted">—</span>}</td>
                  <td className="small muted">{fmt(s.countedAt)}</td>
                  <td className="right">
                    <button className="btn btn-sm" onClick={() => startEdit(s.productId, s.qty, s.avgDailySales)}>
                      Update count
                    </button>{' '}
                    <button className={`btn btn-sm ${cover < 3 && inc === 0 ? 'btn-primary' : ''}`} onClick={() => onReorder(s.productId)}>
                      Reorder
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {untracked.length > 0 && (
        <div className="row add-product">
          <select
            value={adding}
            onChange={(e) => {
              setAdding(e.target.value);
              setQty('');
              setRate('');
              setEditing(null);
            }}
            aria-label="Product"
          >
            <option value="">Track another product…</option>
            {untracked.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {adding && (
            <>
              <input type="number" min={0} placeholder="On shelf" value={qty} onChange={(e) => setQty(e.target.value)} />
              <input type="number" min={0} step="0.5" placeholder="Sales / day" value={rate} onChange={(e) => setRate(e.target.value)} />
              <button className="btn" disabled={!valid} onClick={() => save(adding)}>
                Add
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
