import { useCallback, useEffect, useState } from 'react';
import type { Accounts, Role } from '../../shared/types.ts';
import { api, PortalProvider, useLiveUpdates, usePortal } from './api.tsx';
import type { Toast } from './api.tsx';
import { Assistant } from './Assistant.tsx';
import { DistributorDashboard } from './Distributor.tsx';
import type { DistributorTab } from './Distributor.tsx';
import { OrderDetail } from './OrderDetail.tsx';
import { RetailerDashboard } from './Retailer.tsx';
import type { RetailerTab } from './Retailer.tsx';
import { Toasts } from './ui.tsx';

// ---- minimal path router: /, /distributor/:id, /retailer/:id
function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, '', to);
    setPath(to);
  }, []);
  return [path, navigate];
}

function useAccounts() {
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(
    () =>
      api<Accounts>('GET', '/api/accounts')
        .then((a) => {
          setAccounts(a);
          setError('');
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  useLiveUpdates(load);
  return { accounts, error };
}

export default function App() {
  const [path, navigate] = usePath();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'danger' ? 6000 : 3500);
  }, []);
  const { accounts, error } = useAccounts();

  const m = path.match(/^\/(distributor|retailer)\/([^/]+)\/?$/);
  let page;
  if (!accounts) page = <div className="center-page muted">{error ? `Cannot reach the server: ${error}` : 'Loading…'}</div>;
  else if (m)
    page = (
      <PortalProvider key={path} role={m[1] as Role} partyId={decodeURIComponent(m[2])} onToast={toast}>
        <Portal accounts={accounts} navigate={navigate} />
      </PortalProvider>
    );
  else page = <Landing accounts={accounts} navigate={navigate} toast={toast} />;

  return (
    <>
      {page}
      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </>
  );
}

function Brand({ onClick }: { onClick: () => void }) {
  return (
    <button className="brand" onClick={onClick}>
      <span className="logo">⟲</span>
      <div>
        <b>RecoverRoute</b>
        <div className="muted small">Delivery disruption & recovery</div>
      </div>
    </button>
  );
}

function Landing({ accounts, navigate, toast }: { accounts: Accounts; navigate: (to: string) => void; toast: (m: string, t?: Toast['tone']) => void }) {
  const reset = async () => {
    if (!window.confirm('Reset all data to the demo scenario? This clears every order, message and change.')) return;
    try {
      await api('POST', '/api/reset');
      toast('Demo data restored', 'success');
    } catch (e) {
      toast((e as Error).message, 'danger');
    }
  };
  return (
    <div className="app">
      <header className="topbar">
        <Brand onClick={() => navigate('/')} />
        <div className="spacer" />
        <button className="btn" onClick={reset}>
          Reset demo data
        </button>
      </header>
      <main className="landing">
        <h1>Choose your portal</h1>
        <p className="muted">
          Distributors and retailers each get their own workspace. Changes appear live in the other portal — open both side by side to
          watch a disruption get resolved.
        </p>
        <div className="portal-grid">
          <section className="card portal-card">
            <div className="portal-icon">🚚</div>
            <h2>Distributor portal</h2>
            <p className="muted small">
              Report disruptions (AI drafts the notice), allocate scarce stock by retailer urgency, manage your warehouse, and resolve
              retailer recovery requests.
            </p>
            <div className="account-list">
              {accounts.distributors.map((d) => (
                <button key={d.id} className="account" onClick={() => navigate(`/distributor/${d.id}`)}>
                  <b>{d.name}</b>
                  <span className="muted small">{d.city}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="card portal-card">
            <div className="portal-icon">🏪</div>
            <h2>Retailer portal</h2>
            <p className="muted small">
              Place orders, track shelf stock and stockout risk, get AI recovery advice when a delivery slips, and source from alternative
              suppliers.
            </p>
            <div className="account-list">
              {accounts.retailers.map((r) => (
                <button key={r.id} className="account" onClick={() => navigate(`/retailer/${r.id}`)}>
                  <b>{r.name}</b>
                  <span className="muted small">{r.area}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function Portal({ accounts, navigate }: { accounts: Accounts; navigate: (to: string) => void }) {
  const { view, role, partyId } = usePortal();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [dTab, setDTab] = useState<DistributorTab>('overview');
  const [rTab, setRTab] = useState<RetailerTab>('orders');
  const list = role === 'distributor' ? accounts.distributors : accounts.retailers;
  const unread = view.notifications.filter((n) => !n.read).length;

  return (
    <div className="app">
      <header className="topbar">
        <Brand onClick={() => navigate('/')} />
        <span className={`portal-tag portal-${role}`}>{role === 'distributor' ? 'Distributor portal' : 'Retailer portal'}</span>
        <select value={partyId} onChange={(e) => navigate(`/${role}/${e.target.value}`)} aria-label="Account">
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {unread > 0 && <span className="badge badge-danger">{unread} new</span>}
        <div className="spacer" />
        <span className="clock" title={view.ai.enabled ? `AI features use ${view.ai.model} via OpenRouter` : "Set OPENROUTER_API_KEY on the server to enable AI"}>
          {view.ai.enabled ? '✦ AI on' : 'AI off'}
        </span>
        <button className="btn" onClick={() => navigate(role === 'distributor' ? `/retailer/${accounts.retailers[0].id}` : `/distributor/${accounts.distributors[0].id}`)}>
          Switch to {role === 'distributor' ? 'retailer' : 'distributor'} portal
        </button>
      </header>

      {role === 'distributor' ? (
        <DistributorDashboard tab={dTab} setTab={setDTab} openOrder={setOrderId} />
      ) : (
        <RetailerDashboard tab={rTab} setTab={setRTab} openOrder={setOrderId} />
      )}

      {orderId && (
        <OrderDetail
          key={orderId}
          orderId={orderId}
          onClose={() => setOrderId(null)}
          onGoToAllocation={() => {
            setDTab('allocation');
            setOrderId(null);
          }}
        />
      )}

      <Assistant />

      <footer className="footer muted small">
        Prototype · data is stored on the RecoverRoute server and shared live between portals · payments and refunds are simulated.
      </footer>
    </div>
  );
}
