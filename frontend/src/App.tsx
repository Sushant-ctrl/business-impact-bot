import { useState } from 'react';
import type { Role } from './data';
import { DEMO_NOW } from './data';
import { DistributorDashboard } from './Distributor';
import { fmt } from './logic';
import { OrderDetail } from './OrderDetail';
import { RetailerDashboard } from './Retailer';
import { StoreProvider, useStore } from './store';

function Shell() {
  const { state, dispatch } = useStore();
  const [role, setRole] = useState<Role>('distributor');
  const [distributorId, setDistributorId] = useState('distA');
  const [retailerId, setRetailerId] = useState('sharma');
  const [tab, setTab] = useState<'overview' | 'allocation'>('overview');
  const [orderId, setOrderId] = useState<string | null>(null);

  const distributors = state.suppliers.filter((s) => s.kind === 'distributor');
  const unread = (r: Role, id: string) => state.notifications.filter((n) => n.role === r && n.partyId === id && !n.read).length;

  // Opening an order from the other party's view switches the selected entity so the drawer is relevant.
  const openOrder = (id: string) => {
    const o = state.orders.find((x) => x.id === id);
    if (!o) return;
    if (role === 'distributor') setDistributorId(o.distributorId);
    else setRetailerId(o.retailerId);
    setOrderId(id);
  };

  const reset = () => {
    dispatch({ type: 'RESET' });
    setOrderId(null);
    setTab('overview');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⟲</span>
          <div>
            <b>RecoverRoute</b>
            <div className="muted small">Delivery disruption & recovery</div>
          </div>
        </div>
        <div className="switcher" role="tablist" aria-label="Role">
          <button className={role === 'distributor' ? 'active' : ''} onClick={() => { setRole('distributor'); setOrderId(null); }}>
            Distributor
          </button>
          <button className={role === 'retailer' ? 'active' : ''} onClick={() => { setRole('retailer'); setOrderId(null); }}>
            Retailer
          </button>
        </div>
        {role === 'distributor' ? (
          <select value={distributorId} onChange={(e) => { setDistributorId(e.target.value); setOrderId(null); }} aria-label="Distributor">
            {distributors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {unread('distributor', d.id) ? ` (${unread('distributor', d.id)} new)` : ''}
              </option>
            ))}
          </select>
        ) : (
          <select value={retailerId} onChange={(e) => { setRetailerId(e.target.value); setOrderId(null); }} aria-label="Retailer">
            {state.retailers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {unread('retailer', r.id) ? ` (${unread('retailer', r.id)} new)` : ''}
              </option>
            ))}
          </select>
        )}
        <div className="spacer" />
        <span className="clock" title="All stockout and delivery estimates are calculated from this fixed demo time">
          Demo clock · {fmt(DEMO_NOW)}
        </span>
        <button className="btn" onClick={reset}>
          Reset demo data
        </button>
      </header>

      {role === 'distributor' ? (
        <DistributorDashboard distributorId={distributorId} tab={tab} setTab={setTab} openOrder={openOrder} />
      ) : (
        <RetailerDashboard retailerId={retailerId} openOrder={openOrder} />
      )}

      {orderId && (
        <OrderDetail
          key={orderId + role}
          orderId={orderId}
          role={role}
          onClose={() => setOrderId(null)}
          onGoToAllocation={() => {
            setTab('allocation');
            setOrderId(null);
          }}
        />
      )}

      <footer className="footer muted small">
        Demo prototype · mock data stored in this browser · no real payments, refunds, GPS or external integrations. Open a
        second window to watch both roles update live.
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
