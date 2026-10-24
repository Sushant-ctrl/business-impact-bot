# RecoverRoute · Delivery Disruption & Recovery

Working prototype that helps distributors and retailers limit losses from delivery delays. There are two separate portals
that share one live backend:

- **Distributor portal** (`/distributor/:id`): orders with search and filters, disruption reporting (AI turns a plain-language
  note into a structured report and a retailer message), ETA updates, inventory allocation ranked by retailer urgency,
  warehouse restock and pricing, partial fulfilment, alternative-supplier suggestions, rejecting orders, a retailer-network
  stock view, and responses to recovery requests.
- **Retailer portal** (`/retailer/:id`): placing orders (with a distributor comparison and a suggested quantity), shelf stock
  tracking (estimated from the last count minus daily sales; deliveries are added automatically), stockout risk, AI recovery
  advice on delayed orders, alternative suppliers, partial-delivery offers, and cancellation or refund (simulated).
- **Both portals**: a chat thread per order, live notifications, and an AI assistant that answers questions about the account's
  live data.

Changes made in one portal show up in the other immediately (Server-Sent Events). Payments and refunds are simulated.
There is no login: pick an account on the landing page.

## Run

Requires Node 24+ (the server runs TypeScript directly and uses the built-in `node:sqlite`; it has no runtime dependencies).

```sh
cp server/.env.example server/.env      # add your OPENROUTER_API_KEY
npm --prefix frontend install

# development: two terminals
npm run dev:server                      # API on http://localhost:8787
npm run dev:web                         # app on http://localhost:5173 (proxies /api)

# or a single process serving the built app
npm start                               # http://localhost:8787
```

Data is stored in `server/data/recoverroute.db` and seeded on first start. **Reset demo data** on the landing page reseeds
it, with timestamps shifted so the scenario starts at the current hour.

### AI (OpenRouter)

Set `OPENROUTER_API_KEY` in `server/.env`. `OPENROUTER_MODEL` defaults to `anthropic/claude-sonnet-5.5`; any OpenRouter
model id works. The key stays on the server. Without a key, or if a call fails, disruption drafting and recovery advice
fall back to built-in rules, and the response says which source was used. The assistant chat needs the key.

## Demo scenario

1. Open **Distributor A** and **Sharma General Store** side by side.
2. Distributor → order #1042 → **Report disruption**. Type e.g. "landslide on Katraj ghat, truck reaches them Monday
   evening" and click **✦ Draft report**, then send it.
3. Retailer → #1042 now shows high stockout risk. Click **✦ Get a recommendation**, then request FreshLink (or whichever
   supplier is recommended).
4. Distributor → confirm the alternative. Both portals update, and the order is rerouted.

Also try allocating stock (Distributor → Inventory & allocation), placing an order and then reordering from **My stock**,
order chat, and the assistant ("Brief me: what needs my attention today?").

## Code map

- `shared/`: domain types and pure logic (stockout risk, supplier ranking, allocation plan), used by both the server and
  the frontend
- `server/src/db.ts`: SQLite schema and persistence · `seed.ts`: demo data
- `server/src/commands.ts`: every state change, with validation, ownership checks, timeline events and notifications
- `server/src/views.ts`: per-portal data scoping · `ai.ts`: OpenRouter features and their fallbacks · `index.ts`: HTTP
  routes and SSE
- `server/test/`: flow tests (`npm test`)
- `frontend/src/`: `App.tsx` (routing, landing page, portal shell), `Distributor.tsx`, `Retailer.tsx`, `OrderDetail.tsx`,
  `Assistant.tsx`, `api.tsx` (API client and live-updating portal state)

`backend/` is an earlier, separate scaffold and is not used by the prototype.
