# AgenticOrg agents

RecoverRoute's two core jobs run as governed agents on the Pine Labs AgenticOrg platform, and the app calls them directly
(<https://agenticorg.hackathon.pinelabs.com/dashboard>, workspace **AirTribe**). Both run on LangGraph, are registered
on Grantex with their own DID, and start in **shadow mode**: they observe and produce recommendations, and do nothing
on their own until someone clicks **Promote**.

| | Delivery Disruption Assistant | Stock Allocation & Alternate Sourcing Agent |
|---|---|---|
| Job in RecoverRoute | Spot delays, estimate stockout risk, recommend recovery, draft the retailer message | Decide who gets scarce stock and where to source the shortfall |
| App equivalent | Report disruption, stockout risk panel, recovery advice | Inventory & allocation tab, supplier ranking, partial fulfilment |
| Persona | — | Ananya Mehta |
| Agent ID | `82c0d41d-ab8c-4d64-877c-4b5317b8ba21` | `60201cd3-74b3-4a53-a762-fbb7b1bce836` |
| Domain / type | Ops / Vendor Manager | Ops / Vendor Manager |
| Status | Shadow | Shadow |
| Confidence floor | 90% | 90% |
| Human approval (HITL) | `confidence < 0.9` | `confidence < 0.9 OR amount > 10000` |
| Model | openai — gpt-5.6-luna (auto routing) | openai — gpt-5.6-luna (auto routing) |
| Tools | Platform defaults (`search_issues`, `create_issue`, `add_comment`, `create_page`, `get_project_metrics`) | Same defaults |
| Reports to | Escalates to a human | Escalates to a human |

Both agents only **recommend and draft**. Neither may commit inventory, place orders, book transport, spend money or
send retailer messages without a distributor's approval, and both are told never to invent stock, sales, price or ETA
figures.

## Delivery Disruption Assistant

Already in the workspace before the allocation agent was added (created 24 Oct 2026, 15:24).

For each disrupted shipment it produces a **disruption card**: order ID, retailer, products and quantities, original and
revised ETA, issue, impact level (High/Medium/Low), business impact (stockout risk and lost sales from shelf stock and
sales velocity), suggested recovery actions, and a WhatsApp-style retailer message. Recovery options include checking
another warehouse or nearby distributor, an emergency partial delivery, re-sequencing the route, alternative transport,
and telling the retailer before they run out.

## Stock Allocation & Alternate Sourcing Agent

Created 24 Oct 2026, 16:59, from a plain-English description using AgenticOrg's "Create Virtual Employee" generator,
then adjusted: domain Ops (Procurement isn't offered), type Vendor Manager, designation set, and the HITL rule extended
with `amount > 10000`.

**Specialization:** FMCG warehouse allocation, retailer stockout prioritization, alternate supplier comparison, partial
fulfilment planning, and approval-ready procurement drafts.

### System prompt

> You are a Stock Allocation and Alternate Sourcing Analyst supporting an FMCG distributor serving kirana retailers. Work
> alongside the Delivery Disruption Assistant to recommend responses when warehouse inventory is insufficient or
> shipments are delayed. Your role is analytical and advisory: you may prepare allocation plans, sourcing comparisons,
> draft purchase orders, and approval summaries, but you must not commit inventory, confirm allocations, place purchase
> orders, or spend money without explicit distributor approval through the required human-in-the-loop process.
>
> For each product, identify orders awaiting stock and rank them by retailer days of cover, calculated as current shelf
> stock divided by average daily sales, with the lowest coverage first. Allocate only the available warehouse quantity,
> never exceeding stock on hand or the quantity still needed. Report priority, order ID, retailer, product, days of
> cover, needed quantity, recommended quantity, and unmet quantity.
>
> For every unmet quantity or delayed order, compare alternative suppliers and nearby distributors. Rank candidates by
> whether they can cover the full quantity, whether estimated delivery is before the retailer's stockout time, and lowest
> unit price. Show supplier, available quantity, price, estimated delivery, before-stockout status, fit, and price
> premium versus the original order. When a delayed retailer may stock out before the revised ETA, propose partial
> fulfilment from warehouse stock now and the balance on the delayed shipment.
>
> Never invent stock levels, sales velocity, prices, delivery times, retailer data, or supplier information. If required
> data is missing, state that the estimate is unavailable; clearly label any illustrative calculation. Explain the
> rationale for each recommendation and flag assumptions, conflicts, and data-quality issues. Draft purchase orders and
> allocation plans only for review. End with a concise approval summary showing total cost impact, incremental premium,
> quantities affected, and the specific decisions requiring distributor approval.

The platform also appends the original description as "User-provided requirements (authoritative)". It restates the
same rules and fixes the output format: an allocation table (priority, order id, retailer, product, days of cover,
needed, recommended qty, unmet), a sourcing table (rank, supplier, available, price, ETA, before stockout yes/no, fit),
and an approval summary with total cost impact.

The ranking rules deliberately match `allocationPlan` and `rankSuppliers` in `shared/logic.ts`, so the agent and the
app agree.

### Test run (Chat with Agent, 24 Oct 2026)

Input, taken from the RecoverRoute seed data: Apex Distribution has 12 cartons of Fizz Cola at ₹500. Order #1046 (Patel
Kirana) needs 18 with 4 on the shelf selling 3/day; #1047 (City Mart Express) needs 15 with 25 on the shelf selling
4/day. Alternatives: FreshLink 40 @ ₹565 in 20h, MetroMart 50 @ ₹485 in 60h, QuickStock 8 @ ₹505 in 18h, Horizon 20 @
₹520 in 34h.

| Check | Agent output | Correct? |
|---|---|---|
| Days of cover | Patel 1.33, City Mart 6.25 | Yes |
| Allocation | All 12 cartons → #1046, 0 → #1047 (matches the app's recommendation) | Yes |
| Patel's 6-carton shortfall | QuickStock @ ₹505, 18h, before the ~32h stockout | Yes: enough stock, in time, cheapest of those |
| City Mart's 15 cartons | MetroMart @ ₹485, 60h, before the ~150h stockout | Yes |
| Cost | ₹16,305 total; net premium −₹195 vs the original price | Yes (6×505 + 15×485 = 10,305; +6,000 warehouse) |
| Governance | Self-reported 70% confidence → routed to human approval; nothing committed | As configured |

## How the app uses them

The server calls AgenticOrg's run API (`server/src/agenticorg.ts`):

```
POST {AGENTICORG_BASE_URL}/api/v1/agents/{agent-uuid}/run
Authorization: Bearer {AGENTICORG_API_KEY}
{"action": "process", "inputs": {"task": "<live data + instructions>"}, "context": {"source": "recoverroute", ...}}
→ {"run_id": "msg_…", "status": "completed" | "failed" | "hitl_triggered" | "budget_exceeded", "confidence": 0.7,
   "output": {"raw_output": "<markdown>", "status": "completed"}, "hitl_trigger": "confidence 0.700 < floor 0.9",
   "performance": {"total_latency_ms": 3248, "llm_tokens_used": 2883, "llm_cost_usd": 0.001081}, "error": null, ...}
```

The app stores `run_id`, `hitl_trigger`, latency and cost on each run and shows them in the UI.

| Trigger | Agent | Task contents | What the app does with the result |
|---|---|---|---|
| Distributor clicks **Plan with AgenticOrg** (Inventory & allocation tab) | Stock Allocation & Alternate Sourcing | Warehouse stock; every order awaiting stock with retailer shelf, sales rate, days of cover and stockout time; ranked alternative suppliers with IDs; delayed orders that will run out. Asks for a trailing JSON plan | Shows the write-up. Parses and validates the JSON plan (known orders only, never more than needed or in stock, real supplier IDs). **Load into the table** puts the quantities in the allocation form for review; **Send supplier suggestions** sends them to retailers |
| A disruption is reported (automatic), or **Run now** in the order drawer | Delivery Disruption Assistant | The order, disruption, original and revised ETA, stockout risk, warehouse stock, ranked alternatives | Shows the disruption card in the order drawer and notifies the distributor |

- Runs execute in the background (`agent_runs` table) because they can take minutes; portals update over SSE.
- `hitl_triggered` runs show as **Awaiting approval** with the platform's reason, a link to the AgenticOrg Approvals
  page, and **Approve** / **Reject** buttons. The decision is recorded on the run in RecoverRoute (`decision`,
  `decided_at`, `decision_note`; a rejection needs a reason), because the API key can't read the platform's approvals
  back. Allocations from a held run can still be loaded into the table as a draft, but supplier suggestions can't be
  sent until the run is approved (or completed), and a rejected plan can't be loaded or applied.
- When the distributor confirms an allocation loaded from a plan, the confirmed quantities are stored on the run
  (`applied_allocations`, `applied_at`), so the UI can show where the human changed the agent's numbers. The Agents tab
  has a **Human in the loop** summary: runs held, awaiting decision, approved, rejected, and plans edited before applying.
- The seed includes this history: an approved plan the distributor overrode (#1042, agent 16 → 20), an approved
  disruption card (#1043), a rejected one with the reason (#1045, Distributor B), a plan cleared by policy and applied
  as proposed (#1049, Distributor B), and Distributor A's current plan still awaiting a decision.
- An order holds one suggested supplier, so when the agent splits a shortfall across suppliers, its first pick is sent.
- Errors (bad key, missing `agents:run` scope, rate limits, network) are stored on the run and shown in the UI.
- Runs still in progress when the server restarts are marked failed on startup.
- `server/test/agenticorg.test.ts` checks the integration against a fake AgenticOrg server.

### Live check (24 Oct 2026)

Run through the app against the real platform with the seed data:

| Agent | Result | Time | Cost |
|---|---|---|---|
| Delivery Disruption Assistant (#1042, road closure) | Correct card: impact High, 7.9 cartons at 5/day ≈ 1.6 days of cover vs ≈ 2.3 days to delivery | 9.6 s | $0.0014 |
| Stock Allocation & Alternate Sourcing | #1046 ← 12 cola, #1048 ← 10 detergent, #1047 ← 0 (same as the app's own plan); QuickStock for #1046, MetroMart for #1047, a split for delayed #1043. JSON plan parsed | 13.4 s | $0.0021 |

Both runs came back `hitl_triggered`: the agents report 0.7 confidence against the 0.9 floor. Lower the confidence floor
in AgenticOrg (agent → Config) if runs should complete without approval.

Not yet done: syncing approvals made in the AgenticOrg UI back into RecoverRoute (the run endpoint is the only one the `agents:run` key can call; run, task and approval lookups return 401, so decisions are recorded in RecoverRoute instead),
and giving the agents a connector so they can query RecoverRoute themselves instead of receiving data in the task.
