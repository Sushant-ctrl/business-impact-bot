// AgenticOrg agents in the distributor portal: run cards, the allocation-plan panel, the disruption card in the order
// drawer and the run history tab.
import { useEffect, useState } from 'react';
import { daysBetween, findRetailer, findSupplier, fmt, isOpen, toMs } from '../../shared/logic.ts';
import type { AgentKind, AgentRun } from '../../shared/types.ts';
import { usePortal } from './api.tsx';
import { Markdown } from './Markdown.tsx';
import { Badge } from './ui.tsx';

const STATUS: Record<AgentRun['status'], { label: string; tone: string }> = {
  running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  hitl_triggered: { label: 'Awaiting approval', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  budget_exceeded: { label: 'Budget exceeded', tone: 'danger' },
};

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function duration(run: AgentRun, now: number) {
  const end = run.finishedAt ? toMs(run.finishedAt) : now;
  const s = Math.max(0, Math.round((end - toMs(run.createdAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function NotConfigured() {
  return (
    <p className="muted small">
      AgenticOrg is not connected. Add <code>AGENTICORG_API_KEY</code> to <code>server/.env</code> and restart the server.
    </p>
  );
}

export function AgentRunCard({ run, collapsible = false }: { run: AgentRun; collapsible?: boolean }) {
  const { view } = usePortal();
  const now = useNow(run.status === 'running');
  const [open, setOpen] = useState(!collapsible);
  const s = STATUS[run.status];
  const name = view.agenticorg.agents[run.kind].name;

  return (
    <div className={`agent-run agent-run-${run.status}`}>
      <div className="row-between">
        <div className="row">
          <Badge tone={s.tone}>{s.label}</Badge>
          {run.confidence !== undefined && <Badge tone={run.confidence >= 0.9 ? 'success' : 'warning'}>{Math.round(run.confidence * 100)}% confidence</Badge>}
          <span className="muted small">
            {name} · {fmt(run.createdAt)} · {duration(run, now)}
            {run.costUsd !== undefined && ` · $${run.costUsd.toFixed(4)}`}
          </span>
        </div>
        {collapsible && run.output && (
          <button className="btn btn-link" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'} output
          </button>
        )}
      </div>
      {run.status === 'running' && <p className="muted small">Working on live RecoverRoute data… runs can take up to two minutes.</p>}
      {run.status === 'hitl_triggered' && (
        <div className="callout callout-warning small">
          AgenticOrg is holding this run for human approval{run.hitlReason ? ` (${run.hitlReason})` : ''}. You can load the plan as a draft;
          supplier suggestions are sent only after approval.{' '}
          <a href={`${view.agenticorg.dashboardUrl}/approvals`} target="_blank" rel="noreferrer">
            Review it in AgenticOrg →
          </a>
        </div>
      )}
      {run.error && <p className="text-danger small">{run.error}</p>}
      {open && run.output && <Markdown text={run.output} />}
      {open && run.platformRunId && <span className="muted small">AgenticOrg run {run.platformRunId}</span>}
    </div>
  );
}

const latest = (runs: AgentRun[], kind: AgentKind, orderId?: string) =>
  runs.find((r) => r.kind === kind && (orderId === undefined || r.orderId === orderId));

/** Inventory & allocation tab: ask the allocation agent for a plan, load it into the table, send supplier suggestions. */
export function AllocationAgentPanel({ onLoad, hasWork }: { onLoad: (allocations: Record<string, number>) => void; hasWork: boolean }) {
  const { view, act } = usePortal();
  const run = latest(view.agentRuns, 'allocation');
  const busy = run?.status === 'running';
  const agent = view.agenticorg.agents.allocation;
  // A held run's allocations can still be loaded as a draft (the distributor confirms them in the table);
  // sending supplier suggestions to retailers waits for AgenticOrg approval.
  const plan = run?.status === 'completed' || run?.status === 'hitl_triggered' ? run.plan : undefined;
  const approved = run?.status === 'completed';
  // Mirrors suggestionsToSend on the server: one suggestion per open order, the agent's first pick.
  const pendingSourcing = (plan?.sourcing ?? []).filter(
    (s, i, all) => all.findIndex((x) => x.orderId === s.orderId) === i && view.orders.some((o) => o.id === s.orderId && isOpen(o)),
  );

  return (
    <div className="card agent-panel">
      <div className="card-head">
        <div>
          <h3>✦ {agent.name}</h3>
          <p className="muted small">
            Pine Labs AgenticOrg agent. Sends your live orders, retailer stock and supplier offers; returns an allocation and sourcing
            plan. Nothing is committed until you confirm it below.
          </p>
        </div>
        {view.agenticorg.enabled && (
          <button
            className="btn btn-ai"
            disabled={busy || !hasWork}
            title={hasWork ? '' : 'No orders are waiting for stock'}
            onClick={() => act('POST', '/agent-runs/allocation', undefined, 'Plan requested from AgenticOrg')}
          >
            {busy ? 'Planning…' : run ? 'Re-plan with AgenticOrg' : 'Plan with AgenticOrg'}
          </button>
        )}
      </div>
      {!view.agenticorg.enabled && <NotConfigured />}
      {view.agenticorg.enabled && !run && <p className="muted small">No plan yet.</p>}
      {run && <AgentRunCard run={run} collapsible={run.status !== 'running'} />}
      {plan && (plan.allocations.length > 0 || pendingSourcing.length > 0) && (
        <div className="row-end">
          {plan.allocations.length > 0 && (
            <button className="btn" onClick={() => onLoad(Object.fromEntries(plan.allocations.map((a) => [a.orderId, a.qty])))}>
              Load {plan.allocations.length} allocation{plan.allocations.length === 1 ? '' : 's'} into the table
            </button>
          )}
          {pendingSourcing.length > 0 && (
            <button
              className="btn btn-primary"
              disabled={Boolean(run!.sourcingSentAt) || !approved}
              title={!approved ? 'Approve this run in AgenticOrg first' : pendingSourcing.map((s) => `#${s.orderId} → ${findSupplier(view, s.supplierId).name} (${s.qty})`).join('\n')}
              onClick={() => act('POST', `/agent-runs/${run!.id}/send-sourcing`, undefined, 'Supplier suggestions sent to retailers')}
            >
              {run!.sourcingSentAt
                ? 'Supplier suggestions sent'
                : `Send ${pendingSourcing.length} supplier suggestion${pendingSourcing.length === 1 ? '' : 's'} to retailers`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Order drawer (distributor): the Disruption Assistant's card for this order. */
export function DisruptionAgentSection({ orderId, hasDisruption }: { orderId: string; hasDisruption: boolean }) {
  const { view, act } = usePortal();
  const run = latest(view.agentRuns, 'disruption', orderId);
  if (!hasDisruption && !run) return null;
  const busy = run?.status === 'running';
  return (
    <section>
      <div className="row-between">
        <h3>✦ {view.agenticorg.agents.disruption.name}</h3>
        {view.agenticorg.enabled && hasDisruption && (
          <button className="btn btn-ai btn-sm" disabled={busy} onClick={() => act('POST', `/orders/${orderId}/agent-runs/disruption`, undefined, 'Disruption card requested')}>
            {busy ? 'Running…' : run ? 'Run again' : 'Run now'}
          </button>
        )}
      </div>
      {!view.agenticorg.enabled ? (
        <NotConfigured />
      ) : run ? (
        <AgentRunCard run={run} />
      ) : (
        <p className="muted small">Runs automatically when a disruption is reported.</p>
      )}
    </section>
  );
}

/** Distributor "Agents" tab: connection status and run history. */
export function AgentsTab({ openOrder }: { openOrder: (id: string) => void }) {
  const { view } = usePortal();
  const ao = view.agenticorg;
  const runs = view.agentRuns;
  const done = runs.filter((r) => r.finishedAt);
  const avgSecs = done.length ? done.reduce((a, r) => a + daysBetween(r.createdAt, r.finishedAt!) * 86400, 0) / done.length : 0;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <h3>Pine Labs AgenticOrg</h3>
            <p className="muted small">Governed agents that plan allocation and handle disruptions. They recommend; you approve.</p>
          </div>
          <Badge tone={ao.enabled ? 'success' : 'neutral'}>{ao.enabled ? 'Connected' : 'Not connected'}</Badge>
        </div>
        {!ao.enabled && <NotConfigured />}
        <div className="agent-grid">
          {(Object.keys(ao.agents) as AgentKind[]).map((k) => {
            const mine = runs.filter((r) => r.kind === k);
            return (
              <div key={k} className="action-card">
                <h4>{ao.agents[k].name}</h4>
                <p className="muted small">
                  {k === 'allocation'
                    ? 'Allocates scarce stock by retailer days of cover and ranks alternate suppliers. Trigger: Inventory & allocation tab.'
                    : 'Writes a disruption card with impact, recovery actions and a retailer message. Trigger: every reported disruption.'}
                </p>
                <div className="small">
                  {mine.length} run{mine.length === 1 ? '' : 's'} · {mine.filter((r) => r.status === 'hitl_triggered').length} awaiting approval
                </div>
                <a className="small" href={`${ao.dashboardUrl}/agents/${ao.agents[k].id}`} target="_blank" rel="noreferrer">
                  Open in AgenticOrg →
                </a>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Run history</h3>
          {done.length > 0 && <span className="muted small">Average run time {Math.round(avgSecs)}s</span>}
        </div>
        {runs.length === 0 ? (
          <p className="muted">No agent runs yet.</p>
        ) : (
          <div className="agent-history">
            {runs.map((r) => (
              <div key={r.id} className="agent-history-item">
                {r.orderId && (
                  <button className="btn btn-link strong" onClick={() => openOrder(r.orderId!)}>
                    Order #{r.orderId} · {findRetailer(view, view.orders.find((o) => o.id === r.orderId)?.retailerId ?? '')?.name ?? ''}
                  </button>
                )}
                <AgentRunCard run={r} collapsible />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
