import { useMemo, useState } from 'react';
import {
  allocationPlan,
  awaitingResolution,
  days,
  findProduct,
  findRetailer,
  findSupplier,
  fmt,
  isOpen,
  money,
  rankSuppliers,
  resolutionLabel,
  STATUS_LABELS,
  STATUS_TONE,
  stockoutRisk,
} from '../../shared/logic.ts';
import { REASON_LABELS } from '../../shared/types.ts';
import type { InventoryItem, Order } from '../../shared/types.ts';
import { usePortal } from './api.tsx';
import { DisruptionForm } from './OrderDetail.tsx';
import { Badge, Metric, Notifications, Tabs } from './ui.tsx';

export type DistributorTab = 'overview' | 'allocation' | 'retailers';
type Filter = 'all' | 'attention' | 'delayed' | 'COD' | 'Prepaid';

export function DistributorDashboard({
  tab,
  setTab,
  openOrder,
}: {
  tab: DistributorTab;
  setTab: (t: DistributorTab) => void;
  openOrder: (id: string) => void;
}) {
  const { view: state, partyId, act } = usePortal();
  const dist = findSupplier(state, partyId);
  const orders = state.orders;
  const plan = allocationPlan(state, partyId);

  const delayed = orders.filter((o) => o.status === 'delayed');
  const atRisk = new Set(orders.filter((o) => stockoutRisk(o, state.now).high).map((o) => o.retailerId));
  const awaiting = orders.filter(awaitingResolution);
  const totalUnits = dist.inventory.reduce((a, i) => a + i.qty, 0);
  const openValue = orders.filter(isOpen).reduce((a, o) => a + o.quantity * o.unitPrice, 0);

  return (
    <div className="layout">
      <div className="main">
        <div className="page-head">
          <div>
            <h1>{dist.name}</h1>
            <p className="muted">Distributor portal · {dist.city}</p>
          </div>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              ['overview', 'Orders'],
              ['allocation', <>Inventory & allocation {plan.length > 0 && <span className="count">{plan.length}</span>}</>],
              ['retailers', <>Retailers {atRisk.size > 0 && <span className="count">{atRisk.size}</span>}</>],
            ]}
          />
        </div>

        <div className="metrics">
          <Metric label="Open orders" value={orders.filter(isOpen).length} hint={`${money(openValue)} in value`} />
          <Metric label="Delayed orders" value={delayed.length} tone={delayed.length ? 'danger' : undefined} />
          <Metric label="Warehouse stock" value={totalUnits} hint={`units across ${dist.inventory.length} SKUs`} />
          <Metric label="Retailers at stockout risk" value={atRisk.size} tone={atRisk.size ? 'warning' : undefined} />
          <Metric label="Awaiting resolution" value={awaiting.length} tone={awaiting.length ? 'warning' : undefined} />
        </div>

        {tab === 'overview' && <Overview orders={orders} openOrder={openOrder} />}
        {tab === 'allocation' && <Allocation openOrder={openOrder} />}
        {tab === 'retailers' && <Retailers openOrder={openOrder} />}
      </div>

      <div className="side">
        <Notifications items={state.notifications} onOpen={openOrder} onMarkRead={() => act('POST', '/notifications/read')} />
      </div>
    </div>
  );
}

function Overview({ orders, openOrder }: { orders: Order[]; openOrder: (id: string) => void }) {
  const { view: state } = usePortal();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [reporting, setReporting] = useState<Order | null>(null);
  const disrupted = orders.filter((o) => o.disruption && isOpen(o));
  const q = query.trim().toLowerCase();
  const shown = orders
    .filter((o) =>
      filter === 'all'
        ? true
        : filter === 'attention'
          ? awaitingResolution(o)
          : filter === 'delayed'
            ? o.status === 'delayed'
            : o.paymentType === filter,
    )
    .filter(
      (o) =>
        !q ||
        o.id.includes(q) ||
        findRetailer(state, o.retailerId).name.toLowerCase().includes(q) ||
        findProduct(state, o.productId).name.toLowerCase().includes(q),
    );

  return (
    <>
      {disrupted.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Active disruptions</h3>
          </div>
          <div className="disruptions">
            {disrupted.map((o) => {
              const res = resolutionLabel(state, o);
              const risk = stockoutRisk(o, state.now);
              return (
                <button key={o.id} className="disruption" onClick={() => openOrder(o.id)}>
                  <div className="row-between">
                    <b>
                      #{o.id} · {findRetailer(state, o.retailerId).name}
                    </b>
                    <Badge tone={o.paymentType === 'COD' ? 'cod' : 'prepaid'}>{o.paymentType}</Badge>
                  </div>
                  <div className="small">
                    {REASON_LABELS[o.disruption!.reason]} · ETA {fmt(o.originalEta)} → <b>{fmt(o.currentEta)}</b>
                  </div>
                  <div className="row">
                    <Badge tone={risk.high ? 'danger' : 'success'}>{days(risk.daysOfStock)}d stock</Badge>
                    <Badge tone={res.tone}>{res.label}</Badge>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Orders</h3>
          <div className="row">
            <input className="search" type="search" placeholder="Search order, retailer, product" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="filters">
              {(['all', 'attention', 'delayed', 'COD', 'Prepaid'] as Filter[]).map((f) => (
                <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {{ all: 'All', attention: 'Needs action', delayed: 'Delayed', COD: 'COD', Prepaid: 'Prepaid' }[f]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Retailer</th>
                <th>Product</th>
                <th>Value</th>
                <th>Payment</th>
                <th>ETA (orig → current)</th>
                <th>Status</th>
                <th>Retailer stock</th>
                <th>Resolution</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => {
                const p = findProduct(state, o.productId);
                const risk = stockoutRisk(o, state.now);
                const res = resolutionLabel(state, o);
                return (
                  <tr key={o.id} className="clickable" onClick={() => openOrder(o.id)}>
                    <td className="strong">#{o.id}</td>
                    <td>{findRetailer(state, o.retailerId).name}</td>
                    <td>
                      {p.name}
                      <div className="muted small">
                        {o.quantity} {p.unit}
                      </div>
                    </td>
                    <td>{money(o.quantity * o.unitPrice)}</td>
                    <td>
                      <Badge tone={o.paymentType === 'COD' ? 'cod' : 'prepaid'}>{o.paymentType}</Badge>
                    </td>
                    <td className="small">
                      {fmt(o.originalEta)}
                      {o.currentEta !== o.originalEta && <div className="text-danger">→ {fmt(o.currentEta)}</div>}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABELS[o.status]}</Badge>
                      {o.disruption && isOpen(o) && <div className="muted small">{REASON_LABELS[o.disruption.reason]}</div>}
                    </td>
                    <td>{isOpen(o) ? <Badge tone={risk.high ? 'danger' : 'success'}>{days(risk.daysOfStock)} days</Badge> : '—'}</td>
                    <td>
                      <Badge tone={res.tone}>{res.label}</Badge>
                    </td>
                    <td className="right" onClick={(e) => e.stopPropagation()}>
                      {isOpen(o) && (
                        <button className="btn btn-sm" onClick={() => setReporting(o)}>
                          Report disruption
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={10} className="muted center">
                    No orders match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {reporting && <DisruptionForm order={reporting} mode="report" onClose={() => setReporting(null)} />}
    </>
  );
}

function InventoryCard({ item, demand }: { item: InventoryItem; demand: number }) {
  const { view: state, act } = usePortal();
  const p = findProduct(state, item.productId);
  const [editing, setEditing] = useState(false);
  const [add, setAdd] = useState('');
  const [price, setPrice] = useState(String(item.price));

  const save = async () => {
    const extra = add === '' ? 0 : Number(add);
    const newPrice = Number(price);
    if (!Number.isInteger(extra) || item.qty + extra < 0) return;
    if (!(newPrice > 0)) return;
    const ok = await act('PUT', `/inventory/${item.productId}`, { qty: item.qty + extra, price: newPrice }, `${p.name} updated`);
    if (ok) {
      setEditing(false);
      setAdd('');
    }
  };

  return (
    <div className={`inv ${demand > item.qty ? 'inv-short' : ''}`}>
      <div className="muted small">{p.category}</div>
      <b>{p.name}</b>
      <div className="inv-qty">
        {item.qty} <span className="muted small">{p.unit}</span>
      </div>
      <div className="small">
        {money(item.price)} / {p.unit.replace(/s$/, '')}
        {demand > 0 && <span className={demand > item.qty ? 'text-danger' : 'muted'}> · demand {demand}</span>}
      </div>
      {editing ? (
        <div className="inv-edit">
          <label className="inline">
            Receive / adjust
            <input type="number" value={add} placeholder="+0" onChange={(e) => setAdd(e.target.value)} />
          </label>
          <label className="inline">
            Price ₹
            <input type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-link inv-edit-link" onClick={() => setEditing(true)}>
          Restock / edit
        </button>
      )}
    </div>
  );
}

function AddProduct() {
  const { view: state, partyId, act } = usePortal();
  const dist = findSupplier(state, partyId);
  const missing = state.products.filter((p) => !dist.inventory.some((i) => i.productId === p.id));
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  if (missing.length === 0) return null;
  const valid = productId && Number.isInteger(Number(qty)) && Number(qty) >= 0 && Number(price) > 0;
  return (
    <div className="row add-product">
      <select value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Product">
        <option value="">Start stocking a product…</option>
        {missing.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input type="number" min={0} placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} />
      <input type="number" min={1} placeholder="Price ₹" value={price} onChange={(e) => setPrice(e.target.value)} />
      <button
        className="btn"
        disabled={!valid}
        onClick={async () => {
          if (await act('PUT', `/inventory/${productId}`, { qty: Number(qty), price: Number(price) }, 'Product added to warehouse')) {
            setProductId('');
            setQty('');
            setPrice('');
          }
        }}
      >
        Add
      </button>
    </div>
  );
}

function Allocation({ openOrder }: { openOrder: (id: string) => void }) {
  const { view: state, partyId, act } = usePortal();
  const dist = findSupplier(state, partyId);
  const plan = useMemo(() => allocationPlan(state, partyId), [state, partyId]);
  const recommended = () => Object.fromEntries(plan.map((l) => [l.order.id, String(l.suggested)]));
  const [edits, setEdits] = useState<Record<string, string>>(recommended);
  const [done, setDone] = useState(false);
  // When the plan changes (allocation confirmed, inventory moved elsewhere), start again from the recommendation.
  const planSig = JSON.stringify(plan.map((l) => [l.order.id, l.need, l.suggested]));
  const [seenSig, setSeenSig] = useState(planSig);
  if (seenSig !== planSig) {
    setSeenSig(planSig);
    setEdits(recommended());
  }

  const qtyOf = (id: string) => Number(edits[id] ?? 0);
  const errors: string[] = [];
  plan.forEach((l) => {
    const v = edits[l.order.id];
    if (v === '' || !Number.isInteger(Number(v)) || Number(v) < 0) errors.push(`#${l.order.id}: enter a whole number ≥ 0.`);
    else if (Number(v) > l.need) errors.push(`#${l.order.id}: cannot allocate more than the ${l.need} still needed.`);
  });
  dist.inventory.forEach((i) => {
    const used = plan.filter((l) => l.order.productId === i.productId).reduce((a, l) => a + (qtyOf(l.order.id) || 0), 0);
    if (used > i.qty) errors.push(`${findProduct(state, i.productId).name}: ${used} allocated but only ${i.qty} in stock.`);
  });
  const isManual = plan.some((l) => qtyOf(l.order.id) !== l.suggested);
  const total = plan.reduce((a, l) => a + (qtyOf(l.order.id) || 0), 0);

  const confirm = async () => {
    if (errors.length || total === 0) return;
    const ok = await act(
      'POST',
      '/allocations',
      { allocations: plan.map((l) => ({ orderId: l.order.id, qty: qtyOf(l.order.id) })) },
      `${total} units allocated · retailers notified`,
    );
    if (ok) setDone(true);
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Warehouse inventory</h3>
          <AddProduct />
        </div>
        <div className="inv-grid">
          {dist.inventory.map((i) => (
            <InventoryCard
              key={i.productId}
              item={i}
              demand={plan.filter((l) => l.order.productId === i.productId).reduce((a, l) => a + l.need, 0)}
            />
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3>Allocation recommendation</h3>
            <p className="muted small">
              Orders awaiting stock, ranked by retailer days of inventory (stock ÷ daily sales, lowest first). Stock is allocated in
              that order without exceeding what's in the warehouse.
            </p>
          </div>
          {isManual && <Badge tone="warning">Manually adjusted</Badge>}
        </div>
        {done && plan.length === 0 && <div className="callout callout-success">Allocation confirmed. All pending orders have stock.</div>}
        {done && plan.length > 0 && (
          <div className="callout callout-success">Allocation confirmed. Inventory and orders updated; remaining shortfalls are shown below.</div>
        )}
        {plan.length === 0 ? (
          <p className="muted">No orders are waiting for stock.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Priority</th>
                    <th>Order</th>
                    <th>Product</th>
                    <th>Days of stock</th>
                    <th>Still needed</th>
                    <th>Recommended</th>
                    <th>Allocate</th>
                    <th>Unmet</th>
                    <th>Alternative for unmet qty</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.map((l, idx) => {
                    const p = findProduct(state, l.order.productId);
                    const q = qtyOf(l.order.id) || 0;
                    const unmet = Math.max(0, l.need - q);
                    const alt = unmet > 0 ? rankSuppliers(state, { ...l.order, quantity: unmet, partial: undefined })[0] : undefined;
                    return (
                      <tr key={l.order.id}>
                        <td>
                          <Badge tone={idx === 0 ? 'danger' : 'neutral'}>P{idx + 1}</Badge>
                        </td>
                        <td>
                          <button className="btn btn-link strong" onClick={() => openOrder(l.order.id)}>
                            #{l.order.id}
                          </button>
                          <div className="muted small">{findRetailer(state, l.order.retailerId).name}</div>
                        </td>
                        <td className="small">{p.name}</td>
                        <td>
                          <Badge tone={stockoutRisk(l.order, state.now).high ? 'danger' : l.daysOfStock < 3 ? 'warning' : 'success'}>
                            {days(l.daysOfStock)} days
                          </Badge>
                        </td>
                        <td>{l.need}</td>
                        <td>
                          {l.suggested}
                          {l.suggested < l.need && <div className="muted small">{l.suggested === 0 ? 'unfulfilled' : 'partial'}</div>}
                        </td>
                        <td>
                          <input
                            className="qty"
                            type="number"
                            min={0}
                            max={l.need}
                            value={edits[l.order.id] ?? ''}
                            onChange={(e) => setEdits({ ...edits, [l.order.id]: e.target.value })}
                          />
                        </td>
                        <td className={unmet ? 'text-danger strong' : 'muted'}>{unmet}</td>
                        <td className="small">
                          {unmet === 0 ? (
                            '—'
                          ) : alt ? (
                            <>
                              <div className="strong">{alt.supplier.name}</div>
                              <div className="muted">
                                {alt.coverQty}/{unmet} @ {money(alt.price)} · {fmt(alt.eta)}
                                {!alt.beforeStockout && ' (after stockout)'}
                              </div>
                              <button
                                className="btn btn-sm"
                                disabled={l.order.suggestedSupplierId === alt.supplier.id}
                                onClick={() => act('POST', `/orders/${l.order.id}/suggest`, { supplierId: alt.supplier.id }, 'Suggestion sent to retailer')}
                              >
                                {l.order.suggestedSupplierId === alt.supplier.id ? 'Suggested' : 'Suggest to retailer'}
                              </button>
                            </>
                          ) : (
                            <span className="muted">No supplier stocks it</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {errors.length > 0 && (
              <ul className="errors">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            <div className="row-end">
              <button className="btn" onClick={() => setEdits(recommended())} disabled={!isManual}>
                Reset to recommendation
              </button>
              <button className="btn btn-primary" onClick={confirm} disabled={errors.length > 0 || total === 0}>
                {isManual ? 'Confirm manual allocation' : 'Approve recommended allocation'} ({total} units)
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Retailers({ openOrder }: { openOrder: (id: string) => void }) {
  const { view: state } = usePortal();
  const rows = state.retailers.map((r) => {
    const orders = state.orders.filter((o) => o.retailerId === r.id && isOpen(o));
    const stock = state.stock
      .filter((s) => s.retailerId === r.id)
      .map((s) => ({ ...s, cover: s.avgDailySales > 0 ? s.qty / s.avgDailySales : Infinity }))
      .sort((a, b) => a.cover - b.cover);
    const risky = orders.filter((o) => stockoutRisk(o, state.now).high);
    return { r, orders, stock, risky };
  });
  rows.sort((a, b) => b.risky.length - a.risky.length || (a.stock[0]?.cover ?? Infinity) - (b.stock[0]?.cover ?? Infinity));

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Retailer network</h3>
          <p className="muted small">Shelf stock shared by your retailers (last count minus estimated sales since). Lowest cover first.</p>
        </div>
      </div>
      <div className="retailer-grid">
        {rows.map(({ r, orders, stock, risky }) => (
          <div key={r.id} className={`card retailer-card ${risky.length ? 'order-delayed' : ''}`}>
            <div className="row-between">
              <div>
                <b>{r.name}</b>
                <div className="muted small">{r.area}</div>
              </div>
              {risky.length > 0 ? <Badge tone="danger">{risky.length} at risk</Badge> : <Badge tone="success">OK</Badge>}
            </div>
            <table className="table table-compact">
              <tbody>
                {stock.map((s) => (
                  <tr key={s.productId}>
                    <td className="small">{findProduct(state, s.productId).name}</td>
                    <td className="small right">
                      {s.qty} · {s.avgDailySales}/day
                    </td>
                    <td className="right">
                      <Badge tone={s.cover < 2 ? 'danger' : s.cover < 4 ? 'warning' : 'success'}>{days(s.cover)}d</Badge>
                    </td>
                  </tr>
                ))}
                {stock.length === 0 && (
                  <tr>
                    <td className="muted small">No shelf data shared.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="row">
              {orders.map((o) => (
                <button key={o.id} className="btn btn-sm" onClick={() => openOrder(o.id)}>
                  #{o.id}
                </button>
              ))}
              {orders.length === 0 && <span className="muted small">No open orders with you.</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
