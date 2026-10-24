// RecoverRoute API: a small dependency-free HTTP server. Portals subscribe to /api/events (SSE) and refetch their view
// whenever any command changes data, so the distributor and retailer portals stay in sync live.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { Role } from '../../shared/types.ts';
import { aiStatus, assistantChat, parseDisruption, recoveryAdvice } from './ai.ts';
import { agenticorgStatus, decideAgentRun, sendSourcingSuggestions, startAllocationRun, startDisruptionRun } from './agenticorg.ts';
import * as cmd from './commands.ts';
import { HttpError } from './commands.ts';
import { failInterruptedRuns, isEmpty, tx } from './db.ts';
import { nowIso } from '../../shared/logic.ts';
import { seed } from './seed.ts';
import { accounts, portalView } from './views.ts';

type Params = Record<string, string>;
type Handler = (p: Params, body: Record<string, unknown>) => unknown;
const routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, pattern: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, handler });
}

// ---- live updates
const clients = new Set<ServerResponse>();
function broadcast() {
  const msg = `event: change\ndata: ${Date.now()}\n\n`;
  clients.forEach((res) => res.write(msg));
}
setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 25_000).unref();

/** Runs a command atomically, notifies subscribers and returns the caller's refreshed view. */
function mutate(role: Role, partyId: string, fn: () => unknown) {
  const result = tx(fn);
  broadcast();
  return { result, view: portalView(role, partyId) };
}

const D = '/api/distributor/:id';
const R = '/api/retailer/:id';

route('GET', '/api/health', () => ({ ok: true, ai: aiStatus(), agenticorg: agenticorgStatus() }));
route('GET', '/api/accounts', () => accounts());
route('POST', '/api/reset', () => {
  seed();
  broadcast();
  return { ok: true };
});
route('GET', `${D}/view`, (p) => portalView('distributor', p.id));
route('GET', `${R}/view`, (p) => portalView('retailer', p.id));

// Distributor commands
route('POST', `${D}/orders/:orderId/disruption`, (p, b) => {
  mutate('distributor', p.id, () => cmd.reportDisruption(p.id, p.orderId, b));
  // Hand the new disruption to the AgenticOrg Disruption Assistant; its card arrives later over SSE.
  if (agenticorgStatus().enabled) {
    try {
      startDisruptionRun(p.id, p.orderId, broadcast);
    } catch (e) {
      console.warn('[agenticorg] could not start disruption run:', (e as Error).message);
    }
  }
  return { result: null, view: portalView('distributor', p.id) };
});
route('POST', `${D}/orders/:orderId/eta`, (p, b) => mutate('distributor', p.id, () => cmd.updateEta(p.id, p.orderId, b)));
route('POST', `${D}/allocations`, (p, b) => mutate('distributor', p.id, () => cmd.confirmAllocation(p.id, b)));
route('POST', `${D}/orders/:orderId/suggest`, (p, b) => mutate('distributor', p.id, () => cmd.suggestSupplier(p.id, p.orderId, b)));
route('POST', `${D}/orders/:orderId/partial`, (p, b) => mutate('distributor', p.id, () => cmd.proposePartial(p.id, p.orderId, b)));
route('POST', `${D}/orders/:orderId/respond`, (p, b) => mutate('distributor', p.id, () => cmd.respondToRequest(p.id, p.orderId, b)));
route('POST', `${D}/orders/:orderId/advance`, (p, b) => mutate('distributor', p.id, () => cmd.advanceOrder(p.id, p.orderId, b)));
route('POST', `${D}/orders/:orderId/reject`, (p, b) => mutate('distributor', p.id, () => cmd.rejectOrder(p.id, p.orderId, b)));
route('PUT', `${D}/inventory/:productId`, (p, b) => mutate('distributor', p.id, () => cmd.updateInventory(p.id, p.productId, b)));

// AgenticOrg agents (distributor)
function startRun(id: string, start: () => string) {
  const runId = start();
  broadcast();
  return { result: runId, view: portalView('distributor', id) };
}
route('POST', `${D}/agent-runs/allocation`, (p) => startRun(p.id, () => startAllocationRun(p.id, broadcast)));
route('POST', `${D}/orders/:orderId/agent-runs/disruption`, (p) => startRun(p.id, () => startDisruptionRun(p.id, p.orderId, broadcast)));
route('POST', `${D}/agent-runs/:runId/decision`, (p, b) => mutate('distributor', p.id, () => decideAgentRun(p.id, p.runId, b)));
route('POST', `${D}/agent-runs/:runId/send-sourcing`, (p) => mutate('distributor', p.id, () => sendSourcingSuggestions(p.id, p.runId)));

// Retailer commands
route('POST', `${R}/orders`, (p, b) => mutate('retailer', p.id, () => cmd.placeOrder(p.id, b)));
route('POST', `${R}/orders/:orderId/request`, (p, b) => mutate('retailer', p.id, () => cmd.retailerRequest(p.id, p.orderId, b)));
route('POST', `${R}/orders/:orderId/partial-response`, (p, b) => mutate('retailer', p.id, () => cmd.respondToPartial(p.id, p.orderId, b)));
route('POST', `${R}/orders/:orderId/cancel`, (p, b) => mutate('retailer', p.id, () => cmd.cancelOrder(p.id, p.orderId, b)));
route('PUT', `${R}/stock/:productId`, (p, b) => mutate('retailer', p.id, () => cmd.updateShelfStock(p.id, p.productId, b)));

// Shared by both portals
for (const role of ['distributor', 'retailer'] as const) {
  const base = role === 'distributor' ? D : R;
  route('POST', `${base}/orders/:orderId/messages`, (p, b) => mutate(role, p.id, () => cmd.postMessage(role, p.id, p.orderId, b)));
  route('POST', `${base}/notifications/read`, (p) => mutate(role, p.id, () => cmd.markNotificationsRead(role, p.id)));
  route('POST', `${base}/ai/chat`, (p, b) => assistantChat(portalView(role, p.id), b.messages));
}
route('POST', `${D}/ai/parse-disruption`, (p, b) => parseDisruption(portalView('distributor', p.id), String(b.orderId), b.text));
route('POST', `${R}/ai/recovery-advice`, (p, b) => recoveryAdvice(portalView('retailer', p.id), String(b.orderId)));

// ---- HTTP plumbing
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const DIST = new URL('../../frontend/dist/', import.meta.url).pathname;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/** Serves the built frontend (production); unknown paths fall back to index.html for client-side routing. */
function serveStatic(pathname: string, res: ServerResponse) {
  const index = join(DIST, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Frontend not built. Run `npm run build` in frontend/, or use the Vite dev server on :5173.');
    return;
  }
  let file = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = index;
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(url.pathname, res);
    }
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = await readBody(req);
      return send(res, 200, (await r.handler(params, body)) ?? { ok: true });
    }
    throw new HttpError(404, `No route for ${req.method} ${url.pathname}`);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Internal server error' });
  }
});

failInterruptedRuns(nowIso());
if (isEmpty()) {
  console.log('Seeding demo data…');
  seed();
}

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => {
  const ai = aiStatus();
  console.log(`RecoverRoute API on http://localhost:${port}`);
  console.log(ai.enabled ? `AI: OpenRouter · ${ai.model}` : 'AI: disabled (set OPENROUTER_API_KEY in server/.env) — using rule-based fallbacks');
  console.log(agenticorgStatus().enabled ? 'AgenticOrg: connected' : 'AgenticOrg: disabled (set AGENTICORG_API_KEY in server/.env)');
});
