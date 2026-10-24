# Unexpected Delay Response

When a stockist's deliveries are hit by something nobody saw coming (heavy rain, a road closure, a landslide), this app:

1. Lets the **stockist report the disruption** in a few taps (cause, affected pincodes, extra days if known).
2. Finds every open order to those pincodes and works out a **revised delivery date** from **how long deliveries to that location usually take**.
3. **Notifies the stockist and every affected retailer.**
4. For **cash-on-delivery** orders, shows the retailer **other trusted stockists** who serve their pincode, have the stock, and can deliver **before the retailer runs out** (their days of stock left). The retailer can switch with one tap.

Phase 1 covers the stockist → retailer leg.

## How the numbers are worked out

| Question | Answer |
|---|---|
| How long does stockist S normally take to deliver to pincode A? | Median / 80th percentile of `delivered − ordered` days over the last 180 days. Orders hit by past disruptions are left out. If S has fewer than 3 deliveries to A, it falls back to all stockists → A, then S → all areas, then 2 days. |
| How late will an affected order be? | If the stockist gave extra days: `max(current ETA, today) + extra`. If they gave a clear date: `max(current ETA, clear date + normal transit)`. If unknown: the **average real slip for past disruptions of the same cause** (same pincodes first, then the whole network), falling back to a per-cause default. |
| Who can a COD retailer switch to? | Trusted stockists serving the pincode, with ETA = `today + their 80th-percentile lane days` (pushed back if they are disrupted too), counting only stock not already promised to other orders. Only those arriving **by the needed-by date** are shown, sorted by full coverage first, then ETA, then on-time rate. |
| How do estimates improve? | When an affected order is delivered, its real arrival is stored against the disruption. Future "unknown delay" estimates for that cause use it. |

## Layout

```
backend/   FastAPI + SQLAlchemy + Alembic (SQLite locally, Postgres in Docker)
  app/services/lanes.py         delivery-time history per stockist → pincode
  app/services/disruptions.py   affected orders + revised ETAs
  app/services/alternatives.py  trusted stockists who can deliver in time
  app/services/workflows.py     report / switch / order lifecycle
  app/services/messages.py      notification text + buttons
  app/notifications/            channel interface, Telegram sender
  scripts/seed.py               synthetic hill-region network with history
  scripts/demo_disruption.py    run the whole flow and print every message
bot/       Telegram bot (talks to the backend API only)
```

## Run locally

```bash
cd backend
uv sync
uv run pytest                          # 26 tests
uv run alembic upgrade head
uv run python -m scripts.seed          # prints stockists/retailers with their phone numbers
uv run python -m scripts.demo_disruption   # landslide on 248179 + 248003 for stockist #2
uv run uvicorn app.main:app --reload   # API docs at http://localhost:8000/docs
```

The demo changes the database. Re-run the seed to reset.

## Telegram bot

1. Create a bot with [@BotFather](https://t.me/BotFather), copy `.env.example` to `.env` and paste the token. Export it for the backend too, because the backend sends the push notifications.
2. Run the backend (above) with `TELEGRAM_BOT_TOKEN` set, then:
   ```bash
   cd bot && uv sync && TELEGRAM_BOT_TOKEN=... BACKEND_URL=http://localhost:8000 uv run python bot.py
   ```
3. In Telegram, send `/start` and share your phone number. To try both sides, first change a seeded stockist's and retailer's `phone` to your own numbers (two Telegram accounts).

- **Stockist:** `/disrupt` (cause → areas → extra days or "don't know" → preview → confirm), `/disruptions` (mark resolved), `/orders`
- **Retailer:** the delay alert comes with buttons for days of stock left, *Switch to …*, or *Keep my order*. `/myorders` lists open orders.

## Docker

```bash
docker compose up --build                 # postgres + backend on :8000
docker compose exec backend python -m scripts.seed
docker compose --profile bot up --build   # also runs the bot (needs TELEGRAM_BOT_TOKEN in .env)
```

## Main API endpoints (`/api`)

- `POST /disruptions?dry_run=true|false` reports a disruption (or previews its impact)
- `GET /disruptions?stockist_id=&active=true`, `POST /disruptions/{id}/resolve`
- `GET /orders/{id}/alternatives`, `PATCH /orders/{id}/needed-by` (`{"days_left": 3}`), `POST /orders/{id}/switch`
- `POST /orders`, `POST /orders/{id}/events` (confirmed / dispatched / delivered / cancelled)
- `GET /lanes/estimate?stockist_id=&area=`, `GET /notifications?party_id=`
- `POST /parties`, `POST /parties/link-chat`, service areas and inventory under `/parties/{id}`

## Next phases

- Distributor → stockist leg, and passing a distributor-side disruption down to retailers
- Auto-flagging orders that quietly pass their usual delivery window
- Weather / road-closure feeds to suggest disruptions to stockists
- WhatsApp channel (implement `NotificationChannel`)
