// AI features via OpenRouter. Every feature has a deterministic fallback so the portals keep working without a key
// or when the model call fails; responses say which source produced them.
import {
  allocationPlan,
  days,
  findProduct,
  findRetailer,
  findSupplier,
  fmt,
  isOpen,
  money,
  rankSuppliers,
  remainingNeed,
  resolutionLabel,
  STATUS_LABELS,
  stockoutRisk,
  toMs,
  addHours,
} from '../../shared/logic.ts';
import { REASON_LABELS } from '../../shared/types.ts';
import type { DisruptionReason, Order, PortalView } from '../../shared/types.ts';
import { HttpError } from './commands.ts';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const apiKey = () => process.env.OPENROUTER_API_KEY?.trim() ?? '';
const model = () => process.env.OPENROUTER_MODEL?.trim() || 'anthropic/claude-sonnet-5.5';

export const aiStatus = () => ({ enabled: apiKey() !== '', model: model() });

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

async function complete(messages: ChatMessage[], maxTokens: number): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.PUBLIC_URL ?? 'http://localhost:5173',
      'X-Title': 'RecoverRoute',
    },
    body: JSON.stringify({ model: model(), messages, max_tokens: maxTokens, temperature: 0.2 }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${data.error?.message ?? res.statusText}`);
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenRouter returned an empty response');
  return text;
}

function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v);
const longDate = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function findOrder(view: PortalView, orderId: string): Order {
  const o = view.orders.find((x) => x.id === orderId);
  if (!o) throw new HttpError(404, `Order #${orderId} not found`);
  return o;
}

async function withFallback<T>(label: string, ai: () => Promise<T>, rules: () => T): Promise<T & { source: string; note?: string }> {
  if (!aiStatus().enabled) return { ...rules(), source: 'rules', note: 'Set OPENROUTER_API_KEY to enable AI.' };
  try {
    return { ...(await ai()), source: 'ai' };
  } catch (e) {
    console.warn(`[ai] ${label} failed, using rules:`, (e as Error).message);
    return { ...rules(), source: 'rules', note: 'AI was unavailable, so this came from built-in rules.' };
  }
}

// ---------------------------------------------------------------- disruption parsing

export interface DisruptionDraft {
  reason: DisruptionReason;
  eta: string | null;
  description: string;
  retailerMessage: string;
}

const REASON_KEYWORDS: [DisruptionReason, RegExp][] = [
  ['weather', /rain|flood|storm|cyclone|fog|snow|landslide|weather|monsoon/i],
  ['road_closure', /road|closure|closed|block|traffic|jam|diversion|protest|bandh|highway|nh-?\d+/i],
  ['vehicle_breakdown', /break ?down|broke|tyre|tire|puncture|engine|vehicle|truck|accident|driver/i],
  ['warehouse_delay', /warehouse|loading|picking|packing|stock|godown|inventory|dispatch/i],
];

function disruptionRules(view: PortalView, o: Order, text: string): DisruptionDraft {
  const reason = REASON_KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? 'other';
  const m = text.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|days?|d)\b/i);
  let eta: string | null = null;
  if (m) {
    const hours = Number(m[1]) * (/^d/i.test(m[2]) ? 24 : 1);
    eta = addHours(o.currentEta, hours);
  }
  const product = findProduct(view, o.productId);
  return {
    reason,
    eta,
    description: text.trim().slice(0, 200),
    retailerMessage: `Your order #${o.id} (${product.name}) is delayed due to ${REASON_LABELS[reason].toLowerCase()}.${
      eta ? ` Revised ETA: ${fmt(eta)}.` : ''
    } Please check your recovery options in the portal.`,
  };
}

export function parseDisruption(view: PortalView, orderId: string, text: unknown) {
  const o = findOrder(view, orderId);
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Describe what happened.');
  if (text.length > 1000) throw new HttpError(400, 'Keep the description under 1000 characters.');
  const product = findProduct(view, o.productId);
  const retailer = findRetailer(view, o.retailerId);

  return withFallback(
    'parseDisruption',
    async (): Promise<DisruptionDraft> => {
      const reply = await complete(
        [
          {
            role: 'system',
            content: `You turn a distributor's free-text note about a delivery problem into a structured disruption report.
Current local time: ${longDate(view.now)} (ISO ${view.now}).
Order #${o.id}: ${o.quantity} ${product.unit} of ${product.name} for ${retailer.name}. Current ETA: ${longDate(o.currentEta)} (ISO ${o.currentEta}).

Reply with ONLY a JSON object:
{"reason": one of ${JSON.stringify(Object.keys(REASON_LABELS))},
 "eta": revised delivery as "YYYY-MM-DDTHH:mm" local time, resolved from relative phrases like "tomorrow evening" (evening = 18:00, morning = 09:00, noon = 12:00, night = 21:00), or null if the note gives no timing,
 "description": factual summary for the order log, max 200 characters,
 "retailerMessage": a short, courteous message to the retailer (max 400 characters) naming the order number, the cause, the revised ETA in plain words, and inviting them to check recovery options in the portal}`,
          },
          { role: 'user', content: text },
        ],
        500,
      );
      const j = extractJson(reply);
      const reason = (typeof j.reason === 'string' && j.reason in REASON_LABELS ? j.reason : 'other') as DisruptionReason;
      const eta = isIso(j.eta) && toMs(j.eta) > toMs(view.now) ? j.eta : null;
      return { reason, eta, description: clip(j.description, 200), retailerMessage: clip(j.retailerMessage, 500) };
    },
    () => disruptionRules(view, o, text),
  );
}

// ---------------------------------------------------------------- recovery advice

export interface RecoveryAdvice {
  recommendation: 'wait' | 'alternative' | 'cancel' | 'accept_partial';
  supplierId?: string;
  qty?: number;
  headline: string;
  reasoning: string;
}

function adviceRules(view: PortalView, o: Order): RecoveryAdvice {
  const risk = stockoutRisk(o, view.now);
  const best = rankSuppliers(view, o)[0];
  const product = findProduct(view, o.productId);
  if (o.partial?.status === 'proposed' && risk.high)
    return {
      recommendation: 'accept_partial',
      headline: `Accept the partial delivery of ${o.partial.qty} ${product.unit}`,
      reasoning: `You run out in about ${days(risk.daysOfStock)} days but the full shipment is ${days(risk.daysUntilDelivery)} days away. The partial delivery arrives ${fmt(o.partial.eta)} and bridges the gap at no extra cost.`,
    };
  if (!risk.high)
    return {
      recommendation: 'wait',
      headline: 'Wait for the revised delivery',
      reasoning: `Your ${o.retailerStock} ${product.unit} last about ${days(risk.daysOfStock)} days, longer than the ${days(risk.daysUntilDelivery)} days until the revised ETA, so you should not run out.`,
    };
  if (best?.beforeStockout)
    return {
      recommendation: 'alternative',
      supplierId: best.supplier.id,
      qty: best.coverQty,
      headline: `Source ${best.coverQty} ${product.unit} from ${best.supplier.name}`,
      reasoning: `You run out in about ${days(risk.daysOfStock)} days, before the revised ETA. ${best.supplier.name} can deliver by ${fmt(best.eta)} at ${money(best.price)} per unit (vs ${money(o.unitPrice)} originally)${best.enoughStock ? '' : `, covering ${best.coverQty} of ${remainingNeed(o)}`}.`,
    };
  return {
    recommendation: o.paymentType === 'Prepaid' ? 'cancel' : 'wait',
    headline: o.paymentType === 'Prepaid' ? 'Consider cancelling for a refund' : 'Wait — no faster supplier is available',
    reasoning: `No alternative supplier can deliver before your estimated stockout (${risk.stockoutAt ? fmt(risk.stockoutAt) : 'n/a'}). Ask your distributor about a partial delivery from their warehouse.`,
  };
}

export function recoveryAdvice(view: PortalView, orderId: string) {
  const o = findOrder(view, orderId);
  if (o.status !== 'delayed') throw new HttpError(409, 'Advice is available for delayed orders.');
  const options = rankSuppliers(view, o).slice(0, 5);

  return withFallback(
    'recoveryAdvice',
    async (): Promise<RecoveryAdvice> => {
      const reply = await complete(
        [
          {
            role: 'system',
            content: `You advise a small retailer in India on recovering from a delayed wholesale delivery. Be practical and money-aware.
Options: "wait" for the delayed delivery; "alternative" = buy from another supplier (pick supplierId and qty from the list); "cancel" = cancel and request a refund (prepaid orders); "accept_partial" = accept the distributor's partial delivery offer (only if one is offered).
Prefer avoiding a stockout (lost sales) over a small price premium, but do not recommend paying more when stock will last.

Reply with ONLY a JSON object: {"recommendation": "...", "supplierId": "..." or null, "qty": number or null, "headline": max 80 chars, "reasoning": 2-3 sentences, max 450 chars, citing the numbers}`,
          },
          { role: 'user', content: describeOrderForAdvice(view, o, options) },
        ],
        400,
      );
      const j = extractJson(reply);
      const allowed = ['wait', 'alternative', 'cancel', ...(o.partial?.status === 'proposed' ? ['accept_partial'] : [])];
      const recommendation = (allowed.includes(String(j.recommendation)) ? j.recommendation : 'wait') as RecoveryAdvice['recommendation'];
      const advice: RecoveryAdvice = { recommendation, headline: clip(j.headline, 100), reasoning: clip(j.reasoning, 600) };
      if (recommendation === 'alternative') {
        const opt = options.find((x) => x.supplier.id === j.supplierId) ?? options[0];
        if (!opt) return adviceRules(view, o);
        advice.supplierId = opt.supplier.id;
        advice.qty = Number.isInteger(j.qty) && (j.qty as number) >= 1 ? Math.min(j.qty as number, opt.coverQty) : opt.coverQty;
      }
      return advice;
    },
    () => adviceRules(view, o),
  );
}

function describeOrderForAdvice(view: PortalView, o: Order, options: ReturnType<typeof rankSuppliers>) {
  const risk = stockoutRisk(o, view.now);
  const product = findProduct(view, o.productId);
  const lines = [
    `Now: ${longDate(view.now)}`,
    `Order #${o.id}: ${o.quantity} ${product.unit} of ${product.name} from ${findSupplier(view, o.distributorId).name}, ${o.paymentType}, ${money(o.unitPrice)}/unit.`,
    `Disruption: ${o.disruption ? REASON_LABELS[o.disruption.reason] + (o.disruption.description ? ` — ${o.disruption.description}` : '') : 'none'}`,
    `ETA: originally ${fmt(o.originalEta)}, now ${fmt(o.currentEta)} (${days(risk.daysUntilDelivery)} days away).`,
    `Shelf stock: ${o.retailerStock} ${product.unit}, selling ${o.avgDailySales}/day → ${days(risk.daysOfStock)} days of cover${risk.stockoutAt ? `, stockout around ${fmt(risk.stockoutAt)}` : ''}. ${risk.high ? 'WILL run out before delivery.' : 'Will last until delivery.'}`,
    `Still needed: ${remainingNeed(o)} ${product.unit}.`,
  ];
  if (o.partial?.status === 'proposed') lines.push(`Distributor offers a partial delivery: ${o.partial.qty} ${product.unit} by ${fmt(o.partial.eta)}.`);
  if (o.suggestedSupplierId) lines.push(`Distributor suggests supplier: ${findSupplier(view, o.suggestedSupplierId).name}.`);
  lines.push('Alternative suppliers:');
  options.forEach((x) =>
    lines.push(
      `- supplierId=${x.supplier.id} ${x.supplier.name}: ${x.available} available, ${money(x.price)}/unit, delivers ${fmt(x.eta)}, ${x.beforeStockout ? 'before' : 'after'} stockout, ${x.enoughStock ? 'full quantity' : `partial (${x.coverQty})`}`,
    ),
  );
  if (options.length === 0) lines.push('- none stock this product');
  return lines.join('\n');
}

// ---------------------------------------------------------------- assistant chat

export async function assistantChat(view: PortalView, history: unknown) {
  if (!Array.isArray(history) || history.length === 0) throw new HttpError(400, 'messages must be a non-empty list.');
  const messages: ChatMessage[] = history
    .slice(-12)
    .filter((m): m is { role: 'user' | 'assistant'; content: string } =>
      (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string',
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (messages.at(-1)?.role !== 'user') throw new HttpError(400, 'The last message must be from the user.');

  if (!aiStatus().enabled)
    return {
      reply: 'The AI assistant is not configured yet. Add OPENROUTER_API_KEY to server/.env and restart the server.',
      source: 'rules',
    };

  const me = view.role === 'distributor' ? findSupplier(view, view.partyId).name : findRetailer(view, view.partyId).name;
  try {
    const reply = await complete(
      [
        {
          role: 'system',
          content: `You are the RecoverRoute operations assistant inside the ${view.role} portal of ${me}. RecoverRoute helps distributors and retailers handle delivery disruptions: stockout risk, inventory allocation, alternative suppliers, partial fulfilment, and refunds (refunds are simulated).
Answer using ONLY the live data below; if it is not there, say so. Be concise and specific (order numbers, quantities, ₹ amounts, dates). Use plain text with short "-" bullet lists, no tables or headings.
You cannot change data. When the user should act, tell them exactly where in the portal (e.g. "open order #1043 → Recovery options").

LIVE DATA
${describeView(view)}`,
        },
        ...messages,
      ],
      700,
    );
    return { reply, source: 'ai' };
  } catch (e) {
    console.warn('[ai] chat failed:', (e as Error).message);
    throw new HttpError(502, `The AI assistant is unavailable right now (${(e as Error).message}).`);
  }
}

function describeView(view: PortalView): string {
  const out: string[] = [`Now: ${longDate(view.now)}`];
  const name = (id: string) => view.products.find((p) => p.id === id)?.name ?? id;

  out.push('', 'ORDERS');
  for (const o of view.orders) {
    const p = findProduct(view, o.productId);
    const risk = stockoutRisk(o, view.now);
    const parts = [
      `#${o.id}`,
      view.role === 'distributor' ? findRetailer(view, o.retailerId).name : findSupplier(view, o.distributorId).name,
      `${o.quantity} ${p.unit} ${p.name}`,
      `${money(o.quantity * o.unitPrice)} ${o.paymentType}`,
      STATUS_LABELS[o.status],
      `allocated ${o.allocatedQty}/${o.quantity}`,
      `ETA ${fmt(o.originalEta)}${o.currentEta !== o.originalEta ? ` → ${fmt(o.currentEta)}` : ''}`,
    ];
    if (o.disruption && isOpen(o)) parts.push(`disruption: ${REASON_LABELS[o.disruption.reason]}${o.disruption.description ? ` (${o.disruption.description})` : ''}`);
    if (isOpen(o)) parts.push(`retailer stock ${o.retailerStock} (${o.avgDailySales}/day = ${days(risk.daysOfStock)}d) ${risk.high ? 'HIGH stockout risk' : 'low risk'}`);
    parts.push(`resolution: ${resolutionLabel(view, o).label}`);
    if (o.partial) parts.push(`partial offer ${o.partial.qty} by ${fmt(o.partial.eta)} (${o.partial.status})`);
    out.push('- ' + parts.join(' | '));
  }
  if (view.orders.length === 0) out.push('- none');

  if (view.role === 'distributor') {
    const dist = findSupplier(view, view.partyId);
    out.push('', 'MY WAREHOUSE');
    dist.inventory.forEach((i) => out.push(`- ${name(i.productId)}: ${i.qty} @ ${money(i.price)}`));
    out.push('', 'ALLOCATION PLAN (orders waiting for stock, most urgent first)');
    const plan = allocationPlan(view, view.partyId);
    plan.forEach((l) => out.push(`- #${l.order.id}: needs ${l.need}, recommended ${l.suggested}, retailer has ${days(l.daysOfStock)} days of stock`));
    if (plan.length === 0) out.push('- nothing waiting');
  }

  out.push('', view.role === 'distributor' ? 'RETAILER SHELF STOCK' : 'MY SHELF STOCK');
  for (const s of view.stock) {
    const cover = s.avgDailySales > 0 ? s.qty / s.avgDailySales : Infinity;
    out.push(`- ${view.role === 'distributor' ? findRetailer(view, s.retailerId).name + ' · ' : ''}${name(s.productId)}: ${s.qty} on shelf, ${s.avgDailySales}/day → ${days(cover)} days`);
  }

  out.push('', 'SUPPLIERS (lead time, stock @ price)');
  for (const s of view.suppliers) {
    if (s.id === view.partyId) continue;
    out.push(`- ${s.name} [${s.kind}, ${s.city}, ~${s.deliveryHours}h]: ${s.inventory.map((i) => `${name(i.productId)} ${i.qty}@${money(i.price)}`).join(', ')}`);
  }

  out.push('', 'RECENT NOTIFICATIONS');
  view.notifications.slice(0, 10).forEach((n) => out.push(`- ${fmt(n.at)}: ${n.message}`));
  return out.join('\n');
}

