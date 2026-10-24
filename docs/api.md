# API reference

Base URL: `http://localhost:8787/api`. Bodies are JSON. Times are local `YYYY-MM-DDTHH:mm` strings.

There is no authentication: the account is the `:id` in the path, and every order route checks that the order belongs to
that account (404 otherwise).

Commands return `{ "result": <value or null>, "view": PortalView }`, where `view` is the caller's refreshed portal data.
Errors return `{ "error": "message" }` with status 400 (invalid input), 404 (not found or not yours), 409 (wrong state),
413 (body too large) or 502 (AI provider failed).

## General

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ ok, ai: { enabled, model } }` |
| GET | `/accounts` | Distributors and retailers for the landing page |
| POST | `/reset` | Reseed the demo data (shifted to the current hour) |
| GET | `/events` | Server-Sent Events: `event: change` after every command |
| GET | `/distributor/:id/view`, `/retailer/:id/view` | `PortalView` for that account |

## Distributor (`/distributor/:id`)

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/orders/:orderId/disruption` | `reason`, `eta`, `description?`, `message?` | Order → `delayed`; retailer notified (custom `message` if given) |
| POST | `/orders/:orderId/eta` | `eta`, `note?` | Update the ETA and notify the retailer |
| POST | `/allocations` | `allocations: [{ orderId, qty }]` | Allocate warehouse stock; rejects over-allocation |
| POST | `/orders/:orderId/suggest` | `supplierId` | Suggest an alternative supplier to the retailer |
| POST | `/orders/:orderId/partial` | `qty`, `eta` | Propose a partial delivery (delayed orders; reserves stock) |
| POST | `/orders/:orderId/respond` | `decision`: `confirm` \| `decline` \| `acknowledge` | Answer the retailer's pending request |
| POST | `/orders/:orderId/advance` | `to`: `in_transit` \| `delivered` | Dispatch, or deliver (adds stock to the retailer's shelf) |
| POST | `/orders/:orderId/reject` | `reason` | Reject a not-yet-dispatched order; stock returned |
| PUT | `/inventory/:productId` | `qty?`, `price?` | Restock, reprice, or start stocking a product |

`reason` is one of `road_closure`, `weather`, `vehicle_breakdown`, `warehouse_delay`, `other`.

## Retailer (`/retailer/:id`)

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/orders` | `distributorId`, `productId`, `quantity`, `paymentType`: `COD` \| `Prepaid` | Place an order. `result` is the new order id. ETA = now + the distributor's lead time, rounded up to the hour |
| POST | `/orders/:orderId/request` | `request`: `wait` \| `alternative` \| `cancel`, `supplierId?`, `qty?` | Choose a recovery option (delayed orders only) |
| POST | `/orders/:orderId/partial-response` | `accept`: boolean | Answer a partial-delivery offer |
| POST | `/orders/:orderId/cancel` | `reason?` | Cancel before dispatch; allocated stock returned to the distributor |
| PUT | `/stock/:productId` | `qty`, `avgDailySales` | Record a shelf count (resets the estimate) |

## Both portals (`/distributor/:id` or `/retailer/:id`)

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/orders/:orderId/messages` | `body` | Post to the order chat; the other party is notified |
| POST | `/notifications/read` | — | Mark all of this account's notifications read |
| POST | `/ai/chat` | `messages: [{ role: "user" \| "assistant", content }]` | Assistant reply `{ reply, source }` (last 12 messages used) |

## AI helpers

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/distributor/:id/ai/parse-disruption` | `orderId`, `text` | `{ reason, eta \| null, description, retailerMessage, source, note? }` |
| POST | `/retailer/:id/ai/recovery-advice` | `orderId` (must be delayed) | `{ recommendation, supplierId?, qty?, headline, reasoning, source, note? }` |

`recommendation` is `wait`, `alternative`, `cancel` or `accept_partial`. These helpers never change data; the portal
calls the matching command when the user clicks the suggested action.

## Example

```sh
curl -X POST localhost:8787/api/distributor/distA/orders/1042/disruption \
  -H 'content-type: application/json' \
  -d '{"reason":"road_closure","eta":"2026-10-27T16:00","description":"NH-48 closed near Talegaon"}'
```
