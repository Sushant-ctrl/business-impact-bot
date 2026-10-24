// SQLite persistence (node:sqlite). The dataset is small, so commands load the whole world, apply domain rules in
// memory and write back only the rows they change.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { daysBetween, nowIso } from '../../shared/logic.ts';
import type {
  AgentDecision,
  AgentPlan,
  AgentRun,
  InventoryItem,
  Message,
  Notification,
  Order,
  Retailer,
  RetailerStock,
  Role,
  Supplier,
  TimelineEvent,
  World,
} from '../../shared/types.ts';

const path = process.env.DATABASE_PATH ?? new URL('../data/recoverroute.db', import.meta.url).pathname;
mkdirSync(dirname(path), { recursive: true });
export const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, category TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, city TEXT NOT NULL, delivery_hours REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
  supplier_id TEXT NOT NULL REFERENCES suppliers(id), product_id TEXT NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY (supplier_id, product_id)
);
CREATE TABLE IF NOT EXISTS retailers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, area TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS retailer_distributors (
  retailer_id TEXT NOT NULL REFERENCES retailers(id), distributor_id TEXT NOT NULL REFERENCES suppliers(id),
  PRIMARY KEY (retailer_id, distributor_id)
);
CREATE TABLE IF NOT EXISTS retailer_stock (
  retailer_id TEXT NOT NULL REFERENCES retailers(id), product_id TEXT NOT NULL REFERENCES products(id),
  qty REAL NOT NULL, avg_daily_sales REAL NOT NULL, counted_at TEXT NOT NULL, PRIMARY KEY (retailer_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, retailer_id TEXT NOT NULL REFERENCES retailers(id),
  distributor_id TEXT NOT NULL REFERENCES suppliers(id), product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL, allocated_qty INTEGER NOT NULL DEFAULT 0, unit_price REAL NOT NULL,
  payment_type TEXT NOT NULL, placed_at TEXT NOT NULL, original_eta TEXT NOT NULL, current_eta TEXT NOT NULL,
  status TEXT NOT NULL, disruption TEXT, request TEXT, partial TEXT, suggested_supplier_id TEXT, cancel_reason TEXT
);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), at TEXT NOT NULL,
  label TEXT NOT NULL, detail TEXT, actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, party_id TEXT NOT NULL, order_id INTEGER NOT NULL,
  message TEXT NOT NULL, at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, tone TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_party ON notifications(role, party_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), role TEXT NOT NULL,
  body TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, agent_id TEXT NOT NULL,
  distributor_id TEXT NOT NULL REFERENCES suppliers(id), order_id INTEGER REFERENCES orders(id), status TEXT NOT NULL,
  confidence REAL, output TEXT, plan TEXT, error TEXT, created_at TEXT NOT NULL, finished_at TEXT, sourcing_sent_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_distributor ON agent_runs(distributor_id);
`);

// Columns added after agent_runs first shipped; add them to existing databases.
for (const [col, type] of [
  ['platform_run_id', 'TEXT'],
  ['hitl_reason', 'TEXT'],
  ['latency_ms', 'INTEGER'],
  ['cost_usd', 'REAL'],
  ['decision', 'TEXT'],
  ['decided_at', 'TEXT'],
  ['decision_note', 'TEXT'],
  ['applied_allocations', 'TEXT'],
  ['applied_at', 'TEXT'],
]) {
  const cols = db.prepare('PRAGMA table_info(agent_runs)').all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE agent_runs ADD COLUMN ${col} ${type}`);
}

type Row = Record<string, SQLInputValue>;
const all = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as Row[];
export const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

const json = <T>(v: SQLInputValue): T | undefined => (v == null ? undefined : (JSON.parse(String(v)) as T));
const str = (v: SQLInputValue) => (v == null ? undefined : String(v));

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const isEmpty = () => all('SELECT 1 FROM suppliers LIMIT 1').length === 0;

export function clearAll() {
  db.exec(`
    DELETE FROM agent_runs; DELETE FROM messages; DELETE FROM notifications; DELETE FROM order_events; DELETE FROM orders;
    DELETE FROM retailer_stock; DELETE FROM retailer_distributors; DELETE FROM retailers;
    DELETE FROM inventory; DELETE FROM suppliers; DELETE FROM products;
    DELETE FROM sqlite_sequence;
  `);
}

/** Shelf stock right now: last count minus estimated sales since, never below zero. */
function estimateStock(r: Row, now: string): RetailerStock {
  const avg = Number(r.avg_daily_sales);
  const counted = String(r.counted_at);
  const sold = avg * Math.max(0, daysBetween(counted, now));
  return {
    retailerId: String(r.retailer_id),
    productId: String(r.product_id),
    qty: Math.max(0, Math.round((Number(r.qty) - sold) * 10) / 10),
    avgDailySales: avg,
    countedAt: counted,
  };
}

export function loadStock(now: string): RetailerStock[] {
  return all('SELECT * FROM retailer_stock ORDER BY retailer_id, product_id').map((r) => estimateStock(r, now));
}

export function loadWorld(now = nowIso()): World & { stock: RetailerStock[] } {
  const products = all('SELECT * FROM products ORDER BY rowid').map((r) => ({
    id: String(r.id),
    name: String(r.name),
    unit: String(r.unit),
    category: String(r.category),
  }));

  const inventory = all('SELECT * FROM inventory ORDER BY rowid');
  const suppliers: Supplier[] = all('SELECT * FROM suppliers ORDER BY rowid').map((r) => ({
    id: String(r.id),
    name: String(r.name),
    kind: String(r.kind) as Supplier['kind'],
    city: String(r.city),
    deliveryHours: Number(r.delivery_hours),
    inventory: inventory
      .filter((i) => i.supplier_id === r.id)
      .map((i) => ({ productId: String(i.product_id), qty: Number(i.qty), price: Number(i.price) })),
  }));

  const links = all('SELECT * FROM retailer_distributors');
  const retailers: Retailer[] = all('SELECT * FROM retailers ORDER BY rowid').map((r) => ({
    id: String(r.id),
    name: String(r.name),
    area: String(r.area),
    distributorIds: links.filter((l) => l.retailer_id === r.id).map((l) => String(l.distributor_id)),
  }));

  const stock = loadStock(now);
  const events = all('SELECT * FROM order_events ORDER BY at, id');
  const orders: Order[] = all('SELECT * FROM orders ORDER BY id DESC').map((r) => {
    const s = stock.find((x) => x.retailerId === r.retailer_id && x.productId === r.product_id);
    return {
      id: String(r.id),
      retailerId: String(r.retailer_id),
      distributorId: String(r.distributor_id),
      productId: String(r.product_id),
      quantity: Number(r.quantity),
      allocatedQty: Number(r.allocated_qty),
      unitPrice: Number(r.unit_price),
      paymentType: String(r.payment_type) as Order['paymentType'],
      placedAt: String(r.placed_at),
      originalEta: String(r.original_eta),
      currentEta: String(r.current_eta),
      status: String(r.status) as Order['status'],
      disruption: json(r.disruption),
      request: json(r.request),
      partial: json(r.partial),
      suggestedSupplierId: str(r.suggested_supplier_id),
      cancelReason: str(r.cancel_reason),
      retailerStock: s?.qty ?? 0,
      avgDailySales: s?.avgDailySales ?? 0,
      timeline: events
        .filter((e) => String(e.order_id) === String(r.id))
        .map(
          (e): TimelineEvent => ({
            id: String(e.id),
            at: String(e.at),
            label: String(e.label),
            detail: str(e.detail),
            actor: String(e.actor) as TimelineEvent['actor'],
          }),
        ),
    };
  });

  return { now, products, suppliers, retailers, orders, stock };
}

// ---- writes ----

export function insertProduct(p: { id: string; name: string; unit: string; category: string }) {
  run('INSERT INTO products (id, name, unit, category) VALUES (?, ?, ?, ?)', p.id, p.name, p.unit, p.category);
}

export function insertSupplier(s: Supplier) {
  run(
    'INSERT INTO suppliers (id, name, kind, city, delivery_hours) VALUES (?, ?, ?, ?, ?)',
    s.id,
    s.name,
    s.kind,
    s.city,
    s.deliveryHours,
  );
  s.inventory.forEach((i) => saveInventory(s.id, i));
}

export function insertRetailer(r: Retailer) {
  run('INSERT INTO retailers (id, name, area) VALUES (?, ?, ?)', r.id, r.name, r.area);
  r.distributorIds.forEach((d) => run('INSERT INTO retailer_distributors VALUES (?, ?)', r.id, d));
}

export function saveInventory(supplierId: string, i: InventoryItem) {
  run(
    `INSERT INTO inventory (supplier_id, product_id, qty, price) VALUES (?, ?, ?, ?)
     ON CONFLICT (supplier_id, product_id) DO UPDATE SET qty = excluded.qty, price = excluded.price`,
    supplierId,
    i.productId,
    i.qty,
    i.price,
  );
}

export function saveRetailerStock(s: RetailerStock) {
  run(
    `INSERT INTO retailer_stock (retailer_id, product_id, qty, avg_daily_sales, counted_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (retailer_id, product_id) DO UPDATE SET
       qty = excluded.qty, avg_daily_sales = excluded.avg_daily_sales, counted_at = excluded.counted_at`,
    s.retailerId,
    s.productId,
    s.qty,
    s.avgDailySales,
    s.countedAt,
  );
}

const orderColumns = (o: Order): SQLInputValue[] => [
  o.retailerId,
  o.distributorId,
  o.productId,
  o.quantity,
  o.allocatedQty,
  o.unitPrice,
  o.paymentType,
  o.placedAt,
  o.originalEta,
  o.currentEta,
  o.status,
  o.disruption ? JSON.stringify(o.disruption) : null,
  o.request ? JSON.stringify(o.request) : null,
  o.partial ? JSON.stringify(o.partial) : null,
  o.suggestedSupplierId ?? null,
  o.cancelReason ?? null,
];

/** Inserts an order; uses `o.id` when numeric (seed data), otherwise lets SQLite assign one. Returns the id. */
export function insertOrder(o: Order): string {
  const id = /^\d+$/.test(o.id) ? Number(o.id) : null;
  const res = run(
    `INSERT INTO orders (id, retailer_id, distributor_id, product_id, quantity, allocated_qty, unit_price, payment_type,
       placed_at, original_eta, current_eta, status, disruption, request, partial, suggested_supplier_id, cancel_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ...orderColumns(o),
  );
  return String(res.lastInsertRowid);
}

export function saveOrder(o: Order) {
  run(
    `UPDATE orders SET retailer_id = ?, distributor_id = ?, product_id = ?, quantity = ?, allocated_qty = ?,
       unit_price = ?, payment_type = ?, placed_at = ?, original_eta = ?, current_eta = ?, status = ?, disruption = ?,
       request = ?, partial = ?, suggested_supplier_id = ?, cancel_reason = ?
     WHERE id = ?`,
    ...orderColumns(o),
    Number(o.id),
  );
}

export function addEvent(orderId: string, at: string, label: string, actor: TimelineEvent['actor'], detail?: string) {
  run(
    'INSERT INTO order_events (order_id, at, label, detail, actor) VALUES (?, ?, ?, ?, ?)',
    Number(orderId),
    at,
    label,
    detail ?? null,
    actor,
  );
}

export function addNotification(n: Omit<Notification, 'id' | 'read'>) {
  run(
    'INSERT INTO notifications (role, party_id, order_id, message, at, tone) VALUES (?, ?, ?, ?, ?, ?)',
    n.role,
    n.partyId,
    Number(n.orderId),
    n.message,
    n.at,
    n.tone,
  );
}

export function markRead(role: Role, partyId: string) {
  run('UPDATE notifications SET read = 1 WHERE role = ? AND party_id = ?', role, partyId);
}

export function loadNotifications(role: Role, partyId: string): Notification[] {
  return all('SELECT * FROM notifications WHERE role = ? AND party_id = ? ORDER BY at DESC, id DESC LIMIT 100', role, partyId).map(
    (r) => ({
      id: String(r.id),
      role: String(r.role) as Role,
      partyId: String(r.party_id),
      orderId: String(r.order_id),
      message: String(r.message),
      at: String(r.at),
      read: Boolean(r.read),
      tone: String(r.tone) as Notification['tone'],
    }),
  );
}

export function addMessage(m: Omit<Message, 'id'>) {
  run('INSERT INTO messages (order_id, role, body, at) VALUES (?, ?, ?, ?)', Number(m.orderId), m.role, m.body, m.at);
}

export function loadMessages(orderIds: string[]): Message[] {
  if (orderIds.length === 0) return [];
  const marks = orderIds.map(() => '?').join(',');
  return all(`SELECT * FROM messages WHERE order_id IN (${marks}) ORDER BY at, id`, ...orderIds.map(Number)).map((r) => ({
    id: String(r.id),
    orderId: String(r.order_id),
    role: String(r.role) as Role,
    body: String(r.body),
    at: String(r.at),
  }));
}

// ---- AgenticOrg agent runs

export function insertAgentRun(r: Pick<AgentRun, 'kind' | 'agentId' | 'distributorId' | 'orderId' | 'createdAt'>): string {
  const res = run(
    `INSERT INTO agent_runs (kind, agent_id, distributor_id, order_id, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)`,
    r.kind,
    r.agentId,
    r.distributorId,
    r.orderId ? Number(r.orderId) : null,
    r.createdAt,
  );
  return String(res.lastInsertRowid);
}

export function finishAgentRun(
  id: string,
  r: Pick<AgentRun, 'status' | 'confidence' | 'output' | 'plan' | 'error' | 'finishedAt' | 'platformRunId' | 'hitlReason' | 'latencyMs' | 'costUsd'>,
) {
  run(
    `UPDATE agent_runs SET status = ?, confidence = ?, output = ?, plan = ?, error = ?, finished_at = ?, platform_run_id = ?,
       hitl_reason = ?, latency_ms = ?, cost_usd = ? WHERE id = ?`,
    r.status,
    r.confidence ?? null,
    r.output ?? null,
    r.plan ? JSON.stringify(r.plan) : null,
    r.error ?? null,
    r.finishedAt ?? null,
    r.platformRunId ?? null,
    r.hitlReason ?? null,
    r.latencyMs ?? null,
    r.costUsd ?? null,
    Number(id),
  );
}

export function markSourcingSent(id: string, at: string) {
  run('UPDATE agent_runs SET sourcing_sent_at = ? WHERE id = ?', at, Number(id));
}

export function recordAgentDecision(id: string, decision: AgentDecision, at: string, note?: string) {
  run('UPDATE agent_runs SET decision = ?, decided_at = ?, decision_note = ? WHERE id = ?', decision, at, note ?? null, Number(id));
}

export function recordAppliedPlan(id: string, allocations: AgentPlan['allocations'], at: string) {
  run('UPDATE agent_runs SET applied_allocations = ?, applied_at = ? WHERE id = ?', JSON.stringify(allocations), at, Number(id));
}

/** Runs left in `running` by a server restart can never finish. */
export function failInterruptedRuns(at: string) {
  run(`UPDATE agent_runs SET status = 'failed', error = 'Interrupted by a server restart', finished_at = ? WHERE status = 'running'`, at);
}

export function loadAgentRuns(distributorId: string): AgentRun[] {
  return all('SELECT * FROM agent_runs WHERE distributor_id = ? ORDER BY id DESC LIMIT 50', distributorId).map(toAgentRun);
}

export function loadAgentRun(distributorId: string, id: string): AgentRun | undefined {
  const [r] = all('SELECT * FROM agent_runs WHERE distributor_id = ? AND id = ?', distributorId, Number(id));
  return r && toAgentRun(r);
}

function toAgentRun(r: Row): AgentRun {
  return {
    id: String(r.id),
    kind: String(r.kind) as AgentRun['kind'],
    agentId: String(r.agent_id),
    distributorId: String(r.distributor_id),
    orderId: str(r.order_id),
    status: String(r.status) as AgentRun['status'],
    confidence: r.confidence == null ? undefined : Number(r.confidence),
    output: str(r.output),
    plan: json(r.plan),
    error: str(r.error),
    createdAt: String(r.created_at),
    finishedAt: str(r.finished_at),
    sourcingSentAt: str(r.sourcing_sent_at),
    platformRunId: str(r.platform_run_id),
    hitlReason: str(r.hitl_reason),
    latencyMs: r.latency_ms == null ? undefined : Number(r.latency_ms),
    costUsd: r.cost_usd == null ? undefined : Number(r.cost_usd),
    decision: str(r.decision) as AgentDecision | undefined,
    decidedAt: str(r.decided_at),
    decisionNote: str(r.decision_note),
    appliedAllocations: json(r.applied_allocations),
    appliedAt: str(r.applied_at),
  };
}
