# CLAUDE.md

Guidance for working in this repository. Read `docs/architecture.md` for the full design.

## Commands

```sh
npm run dev:server          # API on :8787 (node --watch, loads server/.env if present)
npm run dev:web             # Vite on :5173, proxies /api to :8787
npm start                   # build frontend, serve everything from :8787
npm test                    # server flow tests (node:test)

npx --prefix frontend tsc -b                # frontend + shared type-check
(cd frontend && npx eslint src)             # lint
(cd server && npx tsc -p .)                 # server + shared type-check
curl -X POST localhost:8787/api/reset       # reseed demo data
```

Run both type-checks and `npm test` before committing.

## Layout

- `shared/`: domain types (`types.ts`) and pure logic (`logic.ts`). Imported by both sides, so it must stay free of I/O,
  DOM and Node APIs.
- `server/src/`: `db.ts` (schema, load/save), `commands.ts` (all mutations), `views.ts` (per-portal scoping), `ai.ts`
  (OpenRouter + fallbacks), `agenticorg.ts` (Pine Labs AgenticOrg agents), `seed.ts`, `index.ts` (routes, SSE, static
  files).
- `frontend/src/`: `api.tsx` (portal state, `act`/`ask`), `App.tsx` (router, landing, shell), `Distributor.tsx`,
  `Retailer.tsx`, `OrderDetail.tsx`, `Assistant.tsx`, `Agents.tsx` (AgenticOrg UI), `Markdown.tsx`, `ui.tsx`.
- `backend/`: an unrelated earlier Python scaffold. Don't modify it unless asked.
- `docs/agents.md`: the two AgenticOrg platform agents and how the app calls them.

## Conventions and gotchas

- **The server runs TypeScript with Node's type stripping** (Node 24+, no build step). Only erasable syntax works: no
  `enum`, no `namespace`, no constructor parameter properties (`constructor(public x)`). Both tsconfigs set
  `erasableSyntaxOnly`.
- **Relative imports need the `.ts`/`.tsx` extension**, e.g. `import { fmt } from '../../shared/logic.ts'`. Use
  `import type` for type-only imports (`verbatimModuleSyntax`).
- `shared/package.json` (`"type": "module"`) must stay, or Node and `tsc` treat `shared/` as CommonJS.
- The server has **no runtime dependencies**. Prefer Node built-ins over adding packages.
- **Every state change goes through a function in `commands.ts`**, called from a route via `mutate()` so it runs in a
  transaction and broadcasts an SSE `change`. A command must: check ownership with `ownedOrder`, validate and throw
  `HttpError` (400 bad input, 404 not found or not yours, 409 wrong state), write timeline events with `c.event`, and
  notify the other party with `c.notify`.
- Keep stock consistent. Anything that cancels or rejects an order must return allocated stock (`releaseReservedStock`).
  Delivery adds to the retailer's shelf.
- Retailer shelf stock is an estimate computed on read (`loadStock`: last count minus sales since `counted_at`). Don't
  store derived quantities.
- Times are local `YYYY-MM-DDTHH:mm` strings. Use `nowIso`, `addHours`, `toMs` and `daysBetween` from `shared/logic.ts`.
  Domain logic takes `now` as a parameter (`stockoutRisk(order, now)`) instead of reading the clock.
- AI features must keep a deterministic fallback (`withFallback` in `ai.ts`) and return `source: 'ai' | 'rules'`.
  Validate model output before using it, because models return bad JSON, past dates and unknown IDs.
- In the frontend, call commands with `act(method, path, body, successToast)`. It returns `null` on failure and has
  already shown the error, so only close forms when the result is non-null. Use `ask()` for AI helpers that don't change
  data.
- Seed data in `seed.ts` uses fixed timestamps around `2026-10-29T09:00` that are shifted to the current hour. Add new
  seed records the same way.
- AgenticOrg agents only recommend. Never apply an agent's output directly: validate it against live data
  (`extractPlan`), then route it through the existing human steps (the allocation table, a click to send suggestions).
  Runs are asynchronous: insert an `agent_runs` row, do the HTTP call in the background, then `broadcast()`.
- Secrets: `OPENROUTER_API_KEY` and `AGENTICORG_API_KEY` live only in `server/.env`
  (git-ignored). Never put them in frontend code or commit them.

## Tests

`server/test/flows.test.ts` points `DATABASE_PATH` at a temp file, reseeds before each test, and calls commands
directly. `server/test/agenticorg.test.ts` runs the AgenticOrg integration against a local fake server. Add a test
when you add or change a command, especially for stock movements and validation.
