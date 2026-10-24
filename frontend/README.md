# RecoverRoute · Delivery Disruption & Recovery Assistant

Hackathon MVP that helps distributors and retailers minimise losses from delivery delays: report disruptions, estimate
retailer stockout risk, allocate limited inventory, and coordinate recovery (alternative suppliers, partial fulfilment,
wait, or cancellation/refund).

Everything runs in the browser on mock data — no backend, payments, GPS or external APIs. Refunds are a simulated
workflow only.

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173. Use the role switcher to move between the Distributor and Retailer dashboards; both share
the same order data (persisted in localStorage, synced across browser windows). "Reset demo data" restores the seed.

## Demo scenario

All estimates are measured from a fixed demo clock (Thu 29 Oct, 09:00).

1. Distributor A → **Report disruption** on #1042 → road closure, revised ETA Sat 31 Oct 4:00 PM.
2. Retailer (Sharma General Store) → #1042 now shows high stockout risk (8 cartons ÷ 5/day = 1.6 days) and recommends
   Distributor B (20 cartons, Friday evening).
3. Retailer chooses wait, alternative fulfilment, or cancellation/refund.
4. Distributor opens #1042, reviews the request and confirms or acknowledges it. Both dashboards update.

COD alternative-supplier flow: #1043 (Patel Kirana). Inventory allocation: Distributor → **Inventory & allocation**.

## Code map

- `src/data.ts` — types and seed data
- `src/logic.ts` — stockout risk, supplier ranking, allocation recommendation, status labels
- `src/store.tsx` — shared reducer (all state changes, notifications, timeline events)
- `src/Distributor.tsx`, `src/Retailer.tsx` — dashboards
- `src/OrderDetail.tsx` — order drawer with role-specific recovery actions and the disruption form
- `src/ui.tsx` — shared components (notifications, timeline, risk panel, supplier table)
