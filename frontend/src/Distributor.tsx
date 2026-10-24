import { useMemo, useState } from 'react';
import { REASON_LABELS } from './data';
import type { Order } from './data';
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
} from './logic';
import { DisruptionForm } from './OrderDetail';
import { useStore } from './store';
import { Badge, Metric, Notifications } from './ui';

type Filter = 'all' | 'delayed' | 'COD' | 'Prepaid';

export function DistributorDashboard({
  distributorId,
  tab,
  setTab,
  openOrder,
}: {
  distributorId: string;
  tab: 'overview' | 'allocation';
  setTab: (t: 'overview' | 'allocation') => void;
  openOrder: (id: string) => void;
}) {
  const { state, dispatch } = useStore();
  const dist = findSupplier(state, distributorId);
  const orders = state.orders.filter((o) => o.distributorId === distributorId);
  const notes = state.notifications.filter((n) => n.role === 'distributor' && n.partyId === distributorId);
  const plan = allocationPlan(state, distributorId);

  const delayed = orders.filter((o) => o.status === 'delayed');
  const atRisk = new Set(orders.filter((o) => stockoutRisk(o).high).map((o) => o.retailerId));
  const awaiting = orders.filter(awaitingResolution);
  const totalUnits = dist.inventory.reduce((a, i) => a + i.qty, 0);

  return (
    <div className="layout">
      <div className="main">
        <div className="page-head">
          <div>
            <h1>{dist.name}</h1>
            <p className="muted">Distributor dashboard · {dist.city}</p>
          </div>
          <div className="tabs">
            <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
              Overview
            </button>
            <button className={tab === 'allocation' ? 'active' : ''} onClick={() => setTab('allocation')}>
              Inventory & allocation {plan.length > 0 && <span className="count">{plan.length}</span>}
            </button>
          </div>
        </div>

        <div className="metrics">
          <Metric label="Total orders" value={orders.length} hint={`${orders.filter(isOpen).length} open`} />
          <Metric label="Delayed orders" value={delayed.length} tone={delayed.length ? 'danger' : undefined} />
          <Metric label="Available inventory" value={totalUnits} hint={`units across ${dist.inventory.length} SKUs`} />
          <Metric label="Retailers at stockout risk" value={atRisk.size} tone={atRisk.size ? 'warning' : undefined} />
          <Metric label="Awaiting resolution" value={awaiting.length} tone={awaiting.length ? 'warning' : undefined} />
        </div>

        {tab === 'overview' ? (
          <Overview orders={orders} openOrder={openOrder} />
        ) : (
          <Allocation key={distributorId} distributorId={distributorId} openOrder={openOrder} />
        )}
      </div>

      <div className="side">
        <Notifications items={notes} onOpen={openOrder} onMarkRead={() => dispatch({ type: 'MARK_READ', role: 'distributor', partyId: distributorId })} />
      </div>
    </div>
  );
}

function Overview({ orders, openOrder }: { orders: Order[]; openOrder: (id: string) => void }) {
  const { state } = useStore();
  const [filter, setFilter] = useState<Filter>('all');
  const [reporting, setReporting] = useState<Order | null>(null);
  const disrupted = orders.filter((o) => o.disruption && isOpen(o));
  const shown = orders.filter((o) => (filter === 'all' ? true : filter === 'delayed' ? o.status === 'delayed' : o.paymentType === filter));

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
              const risk = stockoutRisk(o);
              return (
                <button key={o.id} className="disruption" onClick={() => openOrder(o.id)}>
                  <div className="row-between">
                    <b>#{o.id} · {findRetailer(state, o.retailerId).name}</b>
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
          <div className="filters">
            {(['all', 'delayed', 'COD', 'Prepaid'] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'delayed' ? 'Delayed' : f}
              </button>
            ))}
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
                const risk = stockoutRisk(o);
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
                    <td>
                      {isOpen(o) ? <Badge tone={risk.high ? 'danger' : 'success'}>{days(risk.daysOfStock)} days</Badge> : '—'}
                    </td>
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
                    No orders match this filter.
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

function Allocation({ distributorId, openOrder }: { distributorId: string; openOrder: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const dist = findSupplier(state, distributorId);
  const plan = useMemo(() => allocationPlan(state, distributorId), [state, distributorId]);
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

  const confirm = () => {
    if (errors.length || total === 0) return;
    dispatch({
      type: 'CONFIRM_ALLOCATION',
      distributorId,
      allocations: plan.map((l) => ({ orderId: l.order.id, qty: qtyOf(l.order.id) })),
    });
    setDone(true);
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Warehouse inventory</h3>
        </div>
        <div className="inv-grid">
          {dist.inventory.map((i) => {
            const p = findProduct(state, i.productId);
            const demand = plan.filter((l) => l.order.productId === i.productId).reduce((a, l) => a + l.need, 0);
            return (
              <div key={i.productId} className={`inv ${demand > i.qty ? 'inv-short' : ''}`}>
                <div className="muted small">{p.category}</div>
                <b>{p.name}</b>
                <div className="inv-qty">
                  {i.qty} <span className="muted small">{p.unit}</span>
                </div>
                <div className="small">
                  {money(i.price)} / {p.unit.replace(/s$/, '')}
                  {demand > 0 && (
                    <span className={demand > i.qty ? 'text-danger' : 'muted'}> · demand {demand}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3>Allocation recommendation</h3>
            <p className="muted small">
              Orders awaiting stock, ranked by retailer days of inventory (stock ÷ daily sales, lowest first). Stock is allocated
              in that order without exceeding what's in the warehouse.
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
                          <Badge tone={stockoutRisk(l.order).high ? 'danger' : l.daysOfStock < 3 ? 'warning' : 'success'}>
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
                                onClick={() => dispatch({ type: 'SUGGEST_SUPPLIER', orderId: l.order.id, supplierId: alt.supplier.id })}
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
