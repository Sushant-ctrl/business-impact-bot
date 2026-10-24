# RecoverRoute · Delivery Disruption & Recovery

RecoverRoute helps FMCG distributors and the kirana retailers they supply limit the losses from delivery delays. When a
truck breaks down or a road closes, it shows which retailers will run out before the goods arrive, who should get the
limited stock, and which other suppliers can deliver in time. Every costly decision stays with a person.

It has two portals on one live backend. Its planning and disruption handling are done by two governed agents on the
Pine Labs AgenticOrg platform, which the app calls directly.

## What's in it

**Distributor portal** (`/distributor/:id`)
- Orders with search and filters ("Needs action", Delayed, COD, Prepaid) and an active-disruptions strip
- Report a disruption in plain words; AI fills in the reason, revised ETA and a message to the retailer
- Allocate scarce stock, most urgent retailer (fewest days of stock left) first, with manual overrides
- Restock, reprice or start stocking products; reject orders; propose partial deliveries; suggest other suppliers
- Retailer network view: every retailer's shelf stock and days of cover
- **✦ Plan with AgenticOrg**: the allocation agent plans who gets scarce stock and which supplier covers each shortfall;
  load its quantities into the allocation table to review and confirm, and send its supplier picks to retailers
- **✦ Disruption cards**: every reported disruption is sent to the AgenticOrg Disruption Assistant; its card (impact,
  recovery actions, retailer message) appears in the order drawer
- **✦ Agents tab**: connection status and every agent run, with confidence, duration and approval holds
- Answer retailer requests (confirm an alternative supplier, acknowledge waiting or cancellation)

**Retailer portal** (`/retailer/:id`)
- Place orders, with both distributors compared on stock, price and delivery time, and a suggested quantity
- Track shelf stock: estimated from your last count minus daily sales; deliveries are added automatically
- Stockout risk on every open order
- On a delayed order: AI recommendation ("What should I do?"), wait, cancel (and refund, simulated), or order from a
  ranked alternative supplier; accept or decline partial deliveries
- Cancel orders that haven't been dispatched yet

**Both portals**: chat on each order, live notifications, a UPI QR code for paying an order, and an AI assistant that
answers questions about your own live data. Changes appear in the other portal immediately.

Payments and refunds are simulated. There is no login: pick an account on the landing page.

## Run it

Requires **Node 24+**. The server runs TypeScript directly and uses the built-in `node:sqlite`, so it has no runtime
dependencies.

```sh
cp server/.env.example server/.env      # add OPENROUTER_API_KEY (optional)
npm --prefix frontend install

# development: two terminals
npm run dev:server                      # API on http://localhost:8787
npm run dev:web                         # app on http://localhost:5173 (proxies /api)

# or one process serving the built app
npm start                               # http://localhost:8787

npm test                                # server flow tests
```

Data lives in `server/data/recoverroute.db` and is seeded on first start. **Reset demo data** on the landing page
reseeds it, with timestamps shifted so the scenario starts at the current hour.

### AI (OpenRouter)

Set `OPENROUTER_API_KEY` in `server/.env`. `OPENROUTER_MODEL` defaults to `anthropic/claude-sonnet-5.5`; any OpenRouter
model ID works. The key stays on the server.

Without a key, or if a call fails, disruption drafting and recovery advice fall back to built-in rules, and the UI says
which source answered. The assistant chat needs the key.

### AgenticOrg

Set `AGENTICORG_API_KEY` in `server/.env` (the key needs the `agents:run` scope). The agent IDs default to the two
agents described in [docs/agents.md](docs/agents.md) and can be overridden with `AGENTICORG_ALLOCATION_AGENT_ID` and
`AGENTICORG_DISRUPTION_AGENT_ID`. Without a key the agent panels say "not connected" and the rest of the app works as
before.

## Demo scenario

1. Open **Distributor A** and **Sharma General Store** in two windows.
2. Distributor → order #1042 → **Report disruption**. Type "landslide on Katraj ghat, truck reaches them Monday
   evening", click **✦ Draft report**, then send it.
   With AgenticOrg connected, the Disruption Assistant's card appears in the order drawer a little later.
3. Retailer → #1042 now shows high stockout risk (about 1.6 days of stock). Click **✦ Get a recommendation**, then
   request the recommended supplier.
4. Distributor → confirm the alternative. Both portals update and the order is rerouted.

Then try **Inventory & allocation** (three orders compete for 12 cartons of cola; click **Plan with AgenticOrg**), placing an order and reordering from
**My stock**, the order chat, and the assistant ("Brief me: what needs my attention today?").

## AgenticOrg agents

Two agents on <https://agenticorg.hackathon.pinelabs.com> do RecoverRoute's planning and disruption analysis. The server
calls them with live data (`POST /api/v1/agents/{id}/run`). They only recommend: allocations go through the distributor's
allocation table, supplier suggestions are sent on a click, and runs the platform holds for approval show as
"Awaiting approval" with a link to AgenticOrg.

- **Delivery Disruption Assistant**: disruption cards, stockout risk, recovery options and retailer messages.
- **Stock Allocation & Alternate Sourcing Agent** (Ananya Mehta): allocation by days of cover, supplier ranking,
  partial fulfilment and draft purchase orders. It uses the same rules as `shared/logic.ts`.

See [docs/agents.md](docs/agents.md) for their configuration, prompts and a verified test run.

## Repository layout

| Path | What |
|---|---|
| `frontend/` | React + Vite app: landing page and both portals |
| `server/` | Node API: SQLite storage, commands, per-portal views, SSE, OpenRouter, tests |
| `shared/` | Domain types and pure logic used by both |
| `docs/` | [Architecture](docs/architecture.md), [API reference](docs/api.md), [AgenticOrg agents](docs/agents.md) |
| `backend/` | Earlier Python (FastAPI) scaffold; not used by the prototype |
