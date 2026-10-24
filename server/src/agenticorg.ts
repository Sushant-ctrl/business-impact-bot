// Pine Labs AgenticOrg integration. RecoverRoute's two governed agents run on the platform:
//  - Stock Allocation & Alternate Sourcing Agent: plans who gets scarce stock and where to source the shortfall
//  - Delivery Disruption Assistant: writes a disruption card when a delay is reported
// Runs execute in the background (they can take minutes) and are stored in agent_runs; portals update over SSE.
// The agents only recommend: allocations are loaded into the distributor's allocation table for review, and supplier
// suggestions are sent only when the distributor clicks. Runs the platform holds for approval come back as
// `hitl_triggered` and are approved in the AgenticOrg UI.
import {
  allocationPlan,
  days,
  findProduct,
  findRetailer,
  findSupplier,
  fmt,
  isOpen,
  money,
  nowIso,
  rankSuppliers,
  remainingNeed,
  stockOf,
  stockoutRisk,
} from '../../shared/logic.ts';
import { REASON_LABELS } from '../../shared/types.ts';
import type { AgentKind, AgentPlan, AgentRunStatus, AgenticOrgStatus, Order, World } from '../../shared/types.ts';
import { HttpError, suggestSupplier } from './commands.ts';
import * as repo from './db.ts';

const DEFAULT_AGENTS: Record<AgentKind, { id: string; name: string; env: string }> = {
  allocation: {
    id: '60201cd3-74b3-4a53-a762-fbb7b1bce836',
    name: 'Stock Allocation & Alternate Sourcing Agent',
    env: 'AGENTICORG_ALLOCATION_AGENT_ID',
  },
  disruption: {
    id: '82c0d41d-ab8c-4d64-877c-4b5317b8ba21',
    name: 'Delivery Disruption Assistant',
    env: 'AGENTICORG_DISRUPTION_AGENT_ID',
  },
};

const baseUrl = () => (process.env.AGENTICORG_BASE_URL?.trim() || 'https://agenticorg.hackathon.pinelabs.com').replace(/\/+$/, '');
const apiKey = () => process.env.AGENTICORG_API_KEY?.trim() ?? '';
const agentId = (kind: AgentKind) => process.env[DEFAULT_AGENTS[kind].env]?.trim() || DEFAULT_AGENTS[kind].id;

export function agenticorgStatus(): AgenticOrgStatus {
  return {
    enabled: apiKey() !== '',
    dashboardUrl: `${baseUrl()}/dashboard`,
    agents: {
      allocation: { id: agentId('allocation'), name: DEFAULT_AGENTS.allocation.name },
      disruption: { id: agentId('disruption'), name: DEFAULT_AGENTS.disruption.name },
    },
  };
}

// ---------------------------------------------------------------- HTTP client

const STATUSES: AgentRunStatus[] = ['completed', 'failed', 'hitl_triggered', 'budget_exceeded'];

export interface RunResult {
  status: AgentRunStatus;
  confidence?: number;
  output: string;
  platformRunId?: string;
  hitlReason?: string;
  latencyMs?: number;
  costUsd?: number;
}

/** The run's output may be plain text or an object; pull out the text a person should read. */
function outputText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    // The live API returns {"raw_output": "...", "status": "completed"}.
    for (const k of ['raw_output', 'text', 'answer', 'response', 'result', 'content', 'message', 'output', 'summary']) {
      if (typeof o[k] === 'string' && o[k]) return o[k] as string;
    }
  }
  return '```json\n' + JSON.stringify(output, null, 2) + '\n```';
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * POST /api/v1/agents/{id}/run. Throws with a readable message on HTTP or network errors.
 * Response (observed): { run_id, status, confidence, output: { raw_output }, hitl_trigger, error,
 *   performance: { total_latency_ms, llm_cost_usd, llm_tokens_used }, reasoning_trace, runtime }
 */
export async function runAgent(id: string, task: string, context: Record<string, unknown>): Promise<RunResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/api/v1/agents/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'process', inputs: { task }, context }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new Error(`Could not reach AgenticOrg (${(e as Error).message})`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = data.detail ?? data.error ?? data.message;
    const why = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : res.statusText;
    const hint =
      res.status === 401 || res.status === 403
        ? ' Check AGENTICORG_API_KEY and that it has the agents:run scope.'
        : res.status === 429
          ? ' The tenant is rate-limited; try again shortly.'
          : '';
    throw new Error(`AgenticOrg ${res.status}: ${why}.${hint}`);
  }
  const status = STATUSES.includes(data.status as AgentRunStatus) ? (data.status as AgentRunStatus) : 'completed';
  let confidence = typeof data.confidence === 'number' ? data.confidence : undefined;
  if (confidence !== undefined && confidence > 1) confidence /= 100; // some responses report a percentage
  const perf = (data.performance ?? {}) as Record<string, unknown>;
  return {
    status,
    confidence,
    output: outputText(data.output) || (text(data.error) ? `Agent error: ${data.error}` : ''),
    platformRunId: text(data.run_id),
    hitlReason: text(data.hitl_trigger),
    latencyMs: num(perf.total_latency_ms),
    costUsd: num(perf.llm_cost_usd),
  };
}

// ---------------------------------------------------------------- tasks

const PLAN_INSTRUCTIONS = `After your tables and approval summary, end your answer with ONE fenced \`\`\`json block containing the machine-readable plan, exactly in this shape:
{"allocations": [{"orderId": "1046", "qty": 12}], "sourcing": [{"orderId": "1046", "supplierId": "quickstock", "qty": 6}]}
Use only the order IDs and supplier IDs listed above. "allocations" is warehouse stock per order awaiting stock (qty may be 0). "sourcing" is the alternative supplier you recommend for each shortfall. These are recommendations for the distributor to approve; do not claim anything has been committed.`;

function orderLine(w: World, o: Order) {
  const p = findProduct(w, o.productId);
  const risk = stockoutRisk(o, w.now);
  return `#${o.id} · ${findRetailer(w, o.retailerId).name} · ${p.name} · ordered ${o.quantity} ${p.unit} @ ${money(o.unitPrice)} (${o.paymentType}) · retailer shelf ${o.retailerStock} ${p.unit}, sells ${o.avgDailySales}/day → ${days(risk.daysOfStock)} days of cover${risk.stockoutAt ? `, stockout ≈ ${fmt(risk.stockoutAt)}` : ''}`;
}

function supplierLines(w: World, o: Order, qty: number) {
  const opts = rankSuppliers(w, { ...o, quantity: qty, partial: undefined });
  if (opts.length === 0) return ['    (no other supplier stocks this product)'];
  return opts.map(
    (x) =>
      `    - supplierId=${x.supplier.id} ${x.supplier.name} (${x.supplier.kind}): ${x.available} available @ ${money(x.price)}, delivers ≈ ${fmt(x.eta)} (${x.supplier.deliveryHours}h), ${x.beforeStockout ? 'before' : 'AFTER'} stockout`,
  );
}

function allocationTask(w: World, distributorId: string) {
  const dist = findSupplier(w, distributorId);
  const plan = allocationPlan(w, distributorId);
  const atRisk = w.orders.filter(
    (o) => o.distributorId === distributorId && o.status === 'delayed' && stockoutRisk(o, w.now).high && !o.request,
  );
  if (plan.length === 0 && atRisk.length === 0)
    throw new HttpError(409, 'Nothing to plan: no orders are waiting for stock and no delayed retailer is about to run out.');

  const lines = [
    `Distributor: ${dist.name} (${dist.city}). Current time: ${fmt(w.now)}. Data below is live from RecoverRoute.`,
    '',
    'WAREHOUSE STOCK',
    ...dist.inventory.map((i) => `- ${findProduct(w, i.productId).name}: ${i.qty} @ ${money(i.price)}`),
    '',
    'ORDERS AWAITING STOCK',
  ];
  for (const l of plan) {
    lines.push(`- ${orderLine(w, l.order)} · still needed ${l.need}`);
    lines.push(`  Alternatives if short (for up to ${l.need}):`, ...supplierLines(w, l.order, l.need));
  }
  if (plan.length === 0) lines.push('- none');
  if (atRisk.length) {
    lines.push('', 'DELAYED ORDERS WHERE THE RETAILER RUNS OUT BEFORE THE REVISED ETA');
    for (const o of atRisk) {
      lines.push(`- ${orderLine(w, o)} · revised ETA ${fmt(o.currentEta)} · still needed ${remainingNeed(o)}`);
      lines.push('  Alternatives:', ...supplierLines(w, o, remainingNeed(o)));
    }
  }
  lines.push('', 'Produce the allocation plan, alternate sourcing for every shortfall, and the approval summary.', '', PLAN_INSTRUCTIONS);
  return { task: lines.join('\n'), context: { source: 'recoverroute', distributorId, orderIds: [...plan.map((l) => l.order.id), ...atRisk.map((o) => o.id)] } };
}

function disruptionTask(w: World, o: Order) {
  const p = findProduct(w, o.productId);
  const dist = findSupplier(w, o.distributorId);
  const risk = stockoutRisk(o, w.now);
  const lines = [
    `Current time: ${fmt(w.now)}. A disruption was just reported in RecoverRoute. Data below is live.`,
    '',
    `Order ${orderLine(w, o)}`,
    `Distributor: ${dist.name}. Allocated ${o.allocatedQty}/${o.quantity}. Status: ${o.status}.`,
    `Disruption: ${o.disruption ? REASON_LABELS[o.disruption.reason] : 'unknown'}${o.disruption?.description ? ` — ${o.disruption.description}` : ''}.`,
    `Original ETA ${fmt(o.originalEta)} → revised ETA ${fmt(o.currentEta)} (${days(risk.daysUntilDelivery)} days away). ${risk.high ? 'The retailer WILL run out before delivery.' : 'Retailer stock should last until delivery.'}`,
    `Distributor warehouse stock of ${p.name}: ${stockOf(dist, o.productId)?.qty ?? 0} ${p.unit} (usable for an emergency partial delivery).`,
    'Alternative suppliers for the remaining need:',
    ...supplierLines(w, o, remainingNeed(o)),
    '',
    'Produce the disruption card (impact level, business impact including estimated lost sales, suggested recovery actions) and a short WhatsApp-style message to the retailer.',
  ];
  return { task: lines.join('\n'), context: { source: 'recoverroute', orderId: o.id, distributorId: o.distributorId } };
}

// ---------------------------------------------------------------- plan parsing

/** Splits the trailing JSON plan off the agent's write-up and validates it against live data. */
export function extractPlan(w: World, distributorId: string, output: string): { text: string; plan?: AgentPlan } {
  const fence = [...output.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].filter((m) => m[1].includes('"allocations"') || m[1].includes('"sourcing"')).at(-1);
  if (!fence) return { text: output };
  let raw: Partial<AgentPlan>;
  try {
    raw = JSON.parse(fence[1]);
  } catch {
    return { text: output };
  }
  const text = (output.slice(0, fence.index) + output.slice(fence.index! + fence[0].length)).trim();

  const pending = new Map(allocationPlan(w, distributorId).map((l) => [l.order.id, l]));
  const dist = findSupplier(w, distributorId);
  const left = new Map(dist.inventory.map((i) => [i.productId, i.qty]));
  const allocations: AgentPlan['allocations'] = [];
  for (const a of Array.isArray(raw.allocations) ? raw.allocations : []) {
    const line = pending.get(String(a?.orderId));
    if (!line || !Number.isInteger(a.qty) || a.qty < 0) continue;
    const qty = Math.min(a.qty, line.need, left.get(line.order.productId) ?? 0);
    left.set(line.order.productId, (left.get(line.order.productId) ?? 0) - qty);
    allocations.push({ orderId: line.order.id, qty });
  }

  const sourcing: AgentPlan['sourcing'] = [];
  for (const s of Array.isArray(raw.sourcing) ? raw.sourcing : []) {
    const o = w.orders.find((x) => x.id === String(s?.orderId) && x.distributorId === distributorId && isOpen(x));
    const sup = w.suppliers.find((x) => x.id === s?.supplierId && x.id !== distributorId);
    const item = o && sup && stockOf(sup, o.productId);
    if (!o || !item || !Number.isInteger(s.qty) || s.qty < 1) continue;
    sourcing.push({ orderId: o.id, supplierId: sup!.id, qty: Math.min(s.qty, item.qty) });
  }
  return { text, plan: { allocations, sourcing } };
}

// ---------------------------------------------------------------- orchestration

function requireEnabled() {
  if (!agenticorgStatus().enabled)
    throw new HttpError(503, 'AgenticOrg is not configured. Add AGENTICORG_API_KEY to server/.env and restart the server.');
}

function launch(
  kind: AgentKind,
  distributorId: string,
  orderId: string | undefined,
  build: () => { task: string; context: Record<string, unknown> },
  onChange: () => void,
): string {
  const { task, context } = build();
  const id = agentId(kind);
  const runId = repo.insertAgentRun({ kind, agentId: id, distributorId, orderId, createdAt: nowIso() });

  void (async () => {
    try {
      const r = await runAgent(id, task, { ...context, runId });
      const parsed = kind === 'allocation' ? extractPlan(repo.loadWorld(), distributorId, r.output) : { text: r.output };
      repo.finishAgentRun(runId, { ...r, output: parsed.text, plan: parsed.plan, finishedAt: nowIso() });
      if (orderId) {
        const name = DEFAULT_AGENTS[kind].name;
        repo.addNotification({
          role: 'distributor',
          partyId: distributorId,
          orderId,
          message:
            r.status === 'hitl_triggered'
              ? `${name} needs your approval in AgenticOrg for order #${orderId}.`
              : r.status === 'completed'
                ? `${name}: disruption card ready for order #${orderId}.`
                : `${name} run for order #${orderId} ended with status “${r.status}”.`,
          at: nowIso(),
          tone: r.status === 'completed' ? 'info' : 'warning',
        });
      }
    } catch (e) {
      console.warn(`[agenticorg] ${kind} run ${runId} failed:`, (e as Error).message);
      repo.finishAgentRun(runId, { status: 'failed', error: (e as Error).message, finishedAt: nowIso() });
    }
    onChange();
  })();

  return runId;
}

export function startAllocationRun(distributorId: string, onChange: () => void): string {
  requireEnabled();
  const w = repo.loadWorld();
  if (!w.suppliers.some((s) => s.id === distributorId && s.kind === 'distributor')) throw new HttpError(404, 'Distributor not found');
  return launch('allocation', distributorId, undefined, () => allocationTask(w, distributorId), onChange);
}

export function startDisruptionRun(distributorId: string, orderId: string, onChange: () => void): string {
  requireEnabled();
  const w = repo.loadWorld();
  const o = w.orders.find((x) => x.id === orderId && x.distributorId === distributorId);
  if (!o) throw new HttpError(404, `Order #${orderId} not found`);
  if (!o.disruption || !isOpen(o)) throw new HttpError(409, 'The Disruption Assistant runs on orders with an active disruption.');
  return launch('disruption', distributorId, orderId, () => disruptionTask(w, o), onChange);
}

/**
 * One suggestion per open order: an order holds a single suggested supplier, so when the agent splits a shortfall
 * across suppliers, the first one it lists (its top pick) is sent.
 */
export function suggestionsToSend(plan: AgentPlan | undefined, w: World): AgentPlan['sourcing'] {
  const seen = new Set<string>();
  return (plan?.sourcing ?? []).filter((s) => {
    if (seen.has(s.orderId) || !w.orders.some((o) => o.id === s.orderId && isOpen(o))) return false;
    seen.add(s.orderId);
    return true;
  });
}

/** Sends the allocation agent's supplier recommendations to the retailers as suggestions (distributor-approved). */
export function sendSourcingSuggestions(distributorId: string, runId: string): number {
  const r = repo.loadAgentRuns(distributorId).find((x) => x.id === runId);
  if (!r || r.kind !== 'allocation') throw new HttpError(404, 'Agent run not found');
  if (r.sourcingSentAt) throw new HttpError(409, 'These suggestions were already sent.');
  if (r.status !== 'completed')
    throw new HttpError(409, 'AgenticOrg is holding this run for approval. Approve it in AgenticOrg before sending suggestions to retailers.');
  const w = repo.loadWorld();
  const items = suggestionsToSend(r.plan, w);
  if (items.length === 0) throw new HttpError(409, 'This plan has no supplier suggestions for open orders.');
  for (const s of items) suggestSupplier(distributorId, s.orderId, { supplierId: s.supplierId });
  repo.markSourcingSent(runId, nowIso());
  return items.length;
}
