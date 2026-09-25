# Orderflow Terminal

Live Binance Futures order-flow terminal for tracking price action, liquidity, execution pressure, and strict multi-indicator trade alerts.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/orderflow-terminal/src/App.tsx` — terminal shell, pair/timeframe selector, chart modules, and live market wiring.
- `artifacts/orderflow-terminal/src/hooks/use-binance-market.ts` — public Binance Futures REST and WebSocket market data.
- `artifacts/orderflow-terminal/src/utils/orderflow.ts` — pressure, divergence, liquidity, and absorption analysis.
- `artifacts/orderflow-terminal/src/utils/trade-alert-engine.ts` — strict all-gates trade-alert evaluator.
- `artifacts/orderflow-terminal/src/components/trade-alert-modal.tsx` — alert readiness monitor and animated modal.
- `artifacts/orderflow-terminal/src/index.css` — terminal theme and alert animations.

## Architecture decisions

- Trade alerts are evaluated client-side from the same live public market streams already powering the terminal; no private account or execution API is used.
- A signal is emitted only when every required gate passes for the current selected pair and timeframe. Partial confluence is rendered as scanning, never as an alert.
- The execute button stages the alert price into the existing risk calculator and explicitly reports that live execution is not connected.
- The selected pair is resolved from the live Binance perpetual-symbol list instead of using a fixed asset in the alert system.

## Product

The terminal shows live candlesticks, cumulative price pressure, candle-direction balance, DOM/liquidity heatmaps, trade tape, absorption zones, iceberg radar, and a strict animated buy/sell alert modal.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Public Binance streams can be delayed or disconnect; the UI reports feed state and alerts remain blocked until the required live data window is available.
- The alert system intentionally has a high bar and may remain in scanning mode for long periods.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
