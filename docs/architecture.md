# Architecture

RecoverRoute is three pieces that share one domain model:

```
frontend/ (React + Vite)  ──HTTP /api──▶  server/ (Node, no runtime deps)  ──▶  SQLite (server/data/)
        ▲                                   │   │
        └──────── SSE /api/events ──────────┘   ├──▶ OpenRouter (AI features, optional)
                                                └──▶ Pine Labs AgenticOrg (governed agents, optional)

shared/ — types + pure domain logic, imported by both frontend and server
```

## shared/

- `types.ts`: domain types (`Order`, `Supplier`, `Retailer`, `RetailerStock`, `Notification`, `Message`), `World`
  (everything the logic needs) and `PortalView` (a `World` scoped to one account, plus notifications, messages and AI
  status).
- `logic.ts`: pure functions with no I/O. The server uses them to validate and to write notification text; the frontend
  uses them for display.
  - `stockoutRisk(order, now)`: days of stock = shelf stock ÷ average daily sales. High risk when that is less than or
    equal to the days until the current ETA.
  - `rankSuppliers(world, order)`: every supplier except the order's own distributor that stocks the product, ordered by
    1) enough stock for the remaining need, 2) delivery (now + lead time) before the estimated stockout, 3) lowest price.
  - `allocationPlan(world, distributorId)`: orders awaiting stock, sorted by retailer days of stock (lowest first),
    allocated greedily without exceeding warehouse stock.
  - `resolutionLabel`, `awaitingResolution`, `needsRetailerDecision`: status labels and "needs action" rules.

## server/

| File | Responsibility |
|---|---|
| `src/db.ts` | SQLite schema (`node:sqlite`), `loadWorld()`, targeted write helpers, `tx()` |
| `src/seed.ts` | Demo scenario. Timestamps are anchored to `2026-10-29T09:00` and shifted to the current hour on each seed |
| `src/commands.ts` | Every state change. Validates input and ownership, applies domain rules, writes timeline events and notifications |
| `src/views.ts` | `portalView(role, id)`: what each portal may see; `accounts()` for the landing page |
| `src/ai.ts` | OpenRouter client and the three AI features, each with a rule-based fallback |
| `src/agenticorg.ts` | AgenticOrg run client, task builders, plan parsing/validation, background runs (see [agents.md](agents.md)) |
| `src/index.ts` | Router, JSON body parsing, SSE, static hosting of `frontend/dist` |

### Request flow for a change

1. A portal calls e.g. `POST /api/retailer/sharma/orders/1042/request`.
2. `mutate()` runs the command inside a SQLite transaction. The command loads the world, checks that the order belongs
   to the caller (`ownedOrder`), validates, then writes the order, timeline events and a notification for the other party.
3. `broadcast()` sends an SSE `change` event to every connected portal.
4. The response carries the caller's refreshed `view`. Other portals refetch their view when they receive the event.

Errors are thrown as `HttpError(status, message)`; 400 means invalid input, 404 means not found or not yours, and 409
means the order is in the wrong state.

### Data model (SQLite)

`products`, `suppliers` (distributors and alternative wholesalers, with `delivery_hours`), `inventory` (supplier ×
product: qty, price), `retailers`, `retailer_distributors`, `retailer_stock` (qty at last count, average daily sales,
`counted_at`), `orders` (`disruption`, `request` and `partial` are JSON columns), `order_events`, `notifications`,
`messages`, `agent_runs` (AgenticOrg calls: kind, status, confidence, output, validated plan, error).

**Shelf stock is estimated, not stored live.** `loadStock()` returns
`max(0, qty − avg_daily_sales × days since counted_at)`. A retailer's "Update count" resets the count; a delivery adds the
order quantity on top of the current estimate.

### Stock movements

| Event | Effect |
|---|---|
| Allocation confirmed | distributor inventory −qty, order `allocatedQty` +qty |
| Partial fulfilment proposed | distributor inventory −qty (reserved). Declined: returned |
| Alternative confirmed | alternative supplier inventory −qty; order becomes `rerouted` if it covers the remaining need |
| Order rejected (distributor) or cancelled before dispatch (retailer) | allocated qty (and any reserved partial) returned |
| Delivered | retailer shelf stock +order quantity |

### Order statuses

`awaiting_allocation → partially_allocated → allocated → in_transit → delivered`, with `delayed` (after a reported
disruption), `rerouted` (alternative confirmed) and `cancelled` as side branches. Recovery requests (`wait`,
`alternative`, `cancel`) are only accepted on `delayed` orders.

## AI (server/src/ai.ts)

| Feature | Endpoint | Fallback without a key or on error |
|---|---|---|
| Disruption drafting: free text → reason, ETA, description, retailer message | `POST /api/distributor/:id/ai/parse-disruption` | Keyword matching for the reason; "N hours/days" added to the current ETA |
| Recovery advice: one recommended option with reasoning | `POST /api/retailer/:id/ai/recovery-advice` | The same decision rules in code |
| Assistant chat over the portal's live data | `POST /api/:role/:id/ai/chat` | Returns a "not configured" message |

The model gets JSON-only instructions; replies are parsed defensively (`extractJson`) and validated: unknown reasons
become `other`, past ETAs are dropped, and supplier IDs must come from the ranked list. Every response includes
`source: "ai" | "rules"`, which the UI shows.

The assistant gets a plain-text snapshot of the portal's view (`describeView`). It is told it cannot change data and
should point the user at the right screen instead.

## frontend/

- `api.tsx`: `PortalProvider` loads `/api/:role/:id/view`, subscribes to SSE, and exposes `act()` (commands; shows a
  toast on error and returns `null`) and `ask()` (AI calls; throws). Out-of-order responses are dropped with a sequence
  counter.
- `App.tsx`: a small path router (`/`, `/distributor/:id`, `/retailer/:id`), the landing page and the portal shell.
- `Distributor.tsx`: Orders / Inventory & allocation / Retailers tabs.
- `Retailer.tsx`: Orders / Place order / My stock tabs.
- `OrderDetail.tsx`: the order drawer, with role-specific actions, AI disruption drafting, AI recovery advice, the UPI QR
  popup, order chat and the timeline.
- `Assistant.tsx`: the floating chat panel.
- `Agents.tsx`: AgenticOrg run cards, the allocation-plan panel, the disruption card in the drawer, the Agents tab.
- `Markdown.tsx`: renders agent output (tables, lists, headings) as React elements, never as HTML.

In development Vite proxies `/api` to `localhost:8787` and is allowed to serve `../shared` (`vite.config.ts`).

## backend/

An earlier, separate Python (FastAPI + SQLAlchemy) scaffold for stockist delay prediction. The prototype does not use it.
