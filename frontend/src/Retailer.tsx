import { REASON_LABELS } from './data';
import {
  awaitingResolution,
  days,
  findProduct,
  findRetailer,
  findSupplier,
  fmt,
  isOpen,
  money,
  resolutionLabel,
  STATUS_LABELS,
  STATUS_TONE,
  stockoutRisk,
} from './logic';
import { useStore } from './store';
import { Badge, Metric, Notifications } from './ui';

export function RetailerDashboard({ retailerId, openOrder }: { retailerId: string; openOrder: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const retailer = findRetailer(state, retailerId);
  const orders = state.orders.filter((o) => o.retailerId === retailerId);
  const notes = state.notifications.filter((n) => n.role === 'retailer' && n.partyId === retailerId);
  const open = orders.filter(isOpen);
  const delayed = orders.filter((o) => o.status === 'delayed');
  const highRisk = open.filter((o) => stockoutRisk(o).high);
  const needsDecision = orders.filter(
    (o) => (o.status === 'delayed' && (!o.request || o.request.status === 'declined')) || o.partial?.status === 'proposed',
  );

  return (
    <div className="layout">
      <div className="main">
        <div className="page-head">
          <div>
            <h1>{retailer.name}</h1>
            <p className="muted">Retailer dashboard · {retailer.area}</p>
          </div>
        </div>

        <div className="metrics">
          <Metric label="Open orders" value={open.length} hint={`${orders.length} total`} />
          <Metric label="Delayed orders" value={delayed.length} tone={delayed.length ? 'danger' : undefined} />
          <Metric label="High stockout risk" value={highRisk.length} tone={highRisk.length ? 'danger' : undefined} hint="products running out before delivery" />
          <Metric label="Decisions needed" value={needsDecision.length} tone={needsDecision.length ? 'warning' : undefined} />
        </div>

        {needsDecision.length > 0 && (
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

        <div className="order-cards">
          {orders.map((o) => {
            const p = findProduct(state, o.productId);
            const risk = stockoutRisk(o);
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
                    <b className={o.currentEta !== o.originalEta ? 'text-danger' : ''}>
                      {o.currentEta !== o.originalEta ? fmt(o.currentEta) : 'On schedule'}
                    </b>
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
                    Stock {o.retailerStock} ÷ {o.avgDailySales}/day = <b>{days(risk.daysOfStock)} days</b> vs{' '}
                    {days(risk.daysUntilDelivery)} days to delivery
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
          {orders.length === 0 && <p className="muted">No orders for this retailer.</p>}
        </div>
      </div>
      <div className="side">
        <Notifications items={notes} onOpen={openOrder} onMarkRead={() => dispatch({ type: 'MARK_READ', role: 'retailer', partyId: retailerId })} />
      </div>
    </div>
  );
}
