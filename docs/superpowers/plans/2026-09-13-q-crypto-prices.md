# Track Q (v1.4) — Crypto Price Sync (CoinGecko) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a portfolio holding be a crypto coin whose unit price refreshes from CoinGecko — via an on-demand button **and** a daily in-process job — recording each fetched price as a normal `HoldingPrice`.

**Architecture:** A holding gains a nullable `coingecko_id`. A provider abstraction (`CryptoPriceProvider`, real impl hits CoinGecko's keyless `simple/price`, tests use a fake) feeds a `PriceRefreshService` that batches one call per currency and records prices. An on-demand endpoint plus a guarded daily `asyncio` task on app startup (no extra container, no host cron). A cached `/coins/list` proxy powers a coin-search picker.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, httpx (async client — confirm it's already a dep), pytest+testcontainers; Vite/React/TS, TanStack Query, Vitest.

## Global Constraints
- `docs/CONVENTIONS.md`: money integer minor units, **never cross-currency** (a price is always in the parent portfolio's currency); services **flush**, routers **commit**; services **clock-free** (`today` passed in); workspace-scoped; StrEnum+CHECK; the SQLAlchemy naming convention drives migration names (verify `compare_metadata` clean). Conventional commits, **NO trailers**.
- **Baseline first:** `cd api && uv run pytest -q` (+ web) — record counts; stay green (0 new warnings).
- **No real network in tests** — the provider is injected; tests pass a fake. **Migration revision = `0003`, `down_revision="0002"`.**

---

### Task 1: Migration 0003 + `Holding.coingecko_id`

**Files:** Create `api/alembic/versions/0003_holding_coingecko_id.py`; Modify the `Holding` model; Test `api/tests/test_migration_0003.py` + model test.

- [ ] **Step 1:** Failing test: after `upgrade`, `holdings.coingecko_id` exists (nullable text) and round-trips; `compare_metadata` reports no diff between metadata and the migrated schema; `downgrade` drops it.
- [ ] **Step 2:** add the column to the model + hand-write the migration (`add_column`/`drop_column`, `revision="0003"`, `down_revision="0002"`). **Step 3–4:** run → green.
- [ ] **Step 5:** Commit `feat: holdings.coingecko_id column (migration 0003)`.

---

### Task 2: `CryptoPriceProvider` protocol + CoinGecko impl + fake

**Files:** Create `api/src/pecunia/services/prices/provider.py` (protocol + `CoinGeckoPriceProvider` + `FakePriceProvider`); Test `api/tests/test_price_provider.py`.

**Interfaces — Produces:** `class CryptoPriceProvider(Protocol): async def prices(self, ids: list[str], vs_currency: str) -> dict[str, int]` (coin id → unit price in **minor units** of `vs_currency`). `CoinGeckoPriceProvider` calls `GET https://api.coingecko.com/api/v3/simple/price?ids=<csv>&vs_currencies=<cur>`, converts the major-unit float to minor units by the currency's exponent, with a timeout; on HTTP/parse/timeout error raises `PriceProviderError`. `FakePriceProvider(mapping)` returns canned values / raises on demand.

- [ ] **Step 1:** Failing tests (mock the httpx transport, no live call): parses a sample `simple/price` body into minor units for the right ids; unknown id omitted; a timeout/HTTP error → `PriceProviderError`.
- [ ] **Step 2–4:** implement; green.
- [ ] **Step 5:** Commit `feat: crypto price provider (CoinGecko) + fake`.

---

### Task 3: `PriceRefreshService` + `POST /portfolios/refresh-prices`

**Files:** Create `api/src/pecunia/services/prices/refresh.py`; Modify `api/src/pecunia/api/portfolios.py` (endpoint); Test `api/tests/test_price_refresh.py`, `api/tests/test_portfolios.py`.

**Interfaces — Consumes:** Task 2 provider, the existing price-recording path. **Produces:** `PriceRefreshService(provider).refresh(workspace_id, *, today: date) -> {"updated": int, "skipped": int, "errors": list[str]}` — gather holdings with a non-null `coingecko_id`, group by portfolio currency, **one provider call per currency**, record a `HoldingPrice` (`source="coingecko"`, `as_of=today`) per resolved holding; a provider error for one currency is captured in `errors`, others still processed. Endpoint `POST /api/v1/portfolios/refresh-prices` (router injects the real provider + `today`, commits).

- [ ] **Step 1:** Failing tests with the fake: groups by currency and calls once per currency; records prices, never cross-currency; a holding without an id is skipped; an unknown coin is skipped; a provider error is captured without aborting the rest.
- [ ] **Step 2–4:** implement; green.
- [ ] **Step 5:** Commit `feat: price-refresh service + POST /portfolios/refresh-prices`.

---

### Task 4: Cached coin-list proxy `GET /portfolios/coins?q=`

**Files:** Modify `api/src/pecunia/services/prices/provider.py` (add `coins()` — fetch+memoize `/coins/list`) + `api/src/pecunia/api/portfolios.py`; Test alongside.

**Interfaces — Produces:** endpoint returns `[{id, symbol, name}]` filtered by `q` (case-insensitive, capped e.g. 20), served from an in-process cache populated on first call.

- [ ] **Step 1:** Failing tests (fake list source): filters by `q` on symbol/name, caps results, second call doesn't refetch (memoized).
- [ ] **Step 2–4:** implement; green.
- [ ] **Step 5:** Commit `feat: cached CoinGecko coin-list proxy for the picker`.

---

### Task 5: Daily in-process scheduler + `PECUNIA_ENABLE_PRICE_SYNC`

**Files:** Create `api/src/pecunia/scheduler.py` (a guarded daily task); Modify app startup (`main.py`/lifespan) + settings (`config.py`); Test `api/tests/test_scheduler.py`.

**Interfaces — Produces:** `async def run_daily_price_sync(session_factory, provider, *, today)` iterating workspaces and calling `PriceRefreshService.refresh`, each wrapped so one failure logs and continues; a lifespan task loops it every 24h **only when** `settings.enable_price_sync` (env `PECUNIA_ENABLE_PRICE_SYNC`, default `true`). Test the job function directly (invoke once), not the timing loop.

- [ ] **Step 1:** Failing tests: `run_daily_price_sync` refreshes each workspace via the fake; a raising workspace doesn't stop the others; with the flag false the lifespan doesn't start the task (assert on a small factory helper).
- [ ] **Step 2–4:** implement; green.
- [ ] **Step 5:** Commit `feat: daily in-process crypto price sync (PECUNIA_ENABLE_PRICE_SYNC)`.

---

### Task 6: Frontend — coin picker, update-prices button, source badge

**Files:** Modify `web/src/features/portfolio/usePortfolios.ts` (`coingecko_id` on holding types; `useRefreshPrices`, `useCoinSearch`), the holding form, `PortfolioDetail`/holdings view; `web/src/lib/queries.ts`; Tests alongside.

**Interfaces — Consumes:** Tasks 3–4 endpoints. Holding form: a coin-search autocomplete that sets `coingecko_id`. Holdings view: an "Update prices" button (calls refresh, toasts `{updated, skipped, errors}`); the latest-price badge shows `source` + relative `as_of`.

- [ ] **Step 1:** Failing vitest: picking a coin sends `coingecko_id`; the button calls the endpoint and surfaces the summary; the badge shows "via CoinGecko · <relative>".
- [ ] **Step 2–4:** `npm run build && lint && test` green (0 warnings).
- [ ] **Step 5:** Commit `feat(web): crypto coin picker + update-prices button`.

## Self-review notes
- **Coverage:** column (T1); provider+fake (T2); refresh+endpoint (T3); coin proxy (T4); daily job+flag (T5); UI (T6).
- **Consistency:** price always in the portfolio currency (never cross-currency); clock-free; injected provider (no live HTTP in tests); reuses the existing HoldingPrice recording + invalidation.
- **Egress:** first outbound call the app makes — README/deploy note added in the final docs pass.
- **Deferred:** stocks/ETF feeds, streaming/websocket prices.
