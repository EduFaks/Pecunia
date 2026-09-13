/**
 * Query/mutation hooks for the `/portfolios` resource and its nested
 * `/portfolios/{id}/holdings` (+ `/holdings/{hid}/prices`) sub-resources
 * (the Portfolio domain, v1.1). A single bounded flat read per collection
 * (`usePortfolios`, `useHoldings`) plus create/update/delete mutations for
 * both, and `useRecordPrice` for a manual price update — the same shape
 * `features/contacts/useContacts.ts` and `features/assets/useAssets.ts` use.
 *
 * A workspace's portfolios (a handful of investment accounts) and a
 * portfolio's holdings are small, user-managed sets — like contacts/planned,
 * not an unbounded/append-only log — so both hooks read a generous first
 * page rather than walking a keyset `DataList`. The endpoints are still
 * keyset-paginated server-side (CONVENTIONS §6); this bounded fetch just
 * consumes the first page, exactly `useContacts`'s rationale.
 *
 * **Invalidation contract:** every mutation here calls `invalidatePortfolios`,
 * which invalidates the single top-level `qk.portfolios` key — a prefix of
 * `qk.portfolio(id)`, `qk.holdings(id)`, and both hooks' `"flat"` variants,
 * so one call refreshes the list, every open detail, and every open holdings
 * list (TanStack's partial-match invalidation, same as `qk.assets` covering
 * `qk.assetValuations`). It ALSO invalidates `["analytics"]` — the
 * net-worth-over-time series includes portfolio value per currency via backend
 * snapshots — since any portfolio/holding/price change moves net worth. It does
 * NOT touch `qk.accounts`: a portfolio change never moves an account balance,
 * and the dashboard's net-worth tile reads portfolios through this very
 * `qk.portfolios` prefix (so the tile still updates), keeping the invalidation
 * to exactly the keys a portfolio change affects. It also invalidates
 * `qk.goals`: a portfolio- or net-worth-sourced goal's server-computed
 * `progress`/`eta` (`features/goals/useGoals.ts`) can move with any
 * portfolio/holding/price change, including a CoinGecko price refresh.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";

/** Mirrors `PortfolioOut` (`api/src/pecunia/api/portfolios.py`). `value_minor`
 * is the current market value (Σ holdings, integer minor units); a portfolio
 * with no holdings/prices reports `0`, never `null`. */
export interface PortfolioOut {
  id: string;
  name: string;
  currency: string;
  description: string | null;
  is_demo: boolean;
  created_at: string;
  value_minor: number;
  holding_count: number;
}

export interface PortfolioPage {
  items: PortfolioOut[];
  next_cursor: string | null;
}

/** Mirrors `HoldingOut`. `quantity` is a STRING (a `Numeric(28,8)` share/unit
 * count serialized exactly — never a float, never money); `value_minor` and
 * `latest_unit_price_minor` are integer minor units, the latter `null` until
 * the holding has had a price recorded. `coingecko_id` non-null makes the
 * holding auto-priceable (Track Q); `latest_price_source`/`latest_price_as_of`
 * describe that same latest price's provenance (`"coingecko"` for an
 * automated refresh, whatever the user typed — or `null` — for a manual
 * record), both `null` until a price has ever been recorded. */
export interface HoldingOut {
  id: string;
  portfolio_id: string;
  name: string;
  symbol: string | null;
  quantity: string;
  coingecko_id: string | null;
  latest_unit_price_minor: number | null;
  latest_price_source: string | null;
  latest_price_as_of: string | null;
  value_minor: number;
  is_demo: boolean;
  created_at: string;
}

/** Mirrors `CoinOut` — one CoinGecko coin as returned by the coin-search
 * proxy (`GET /portfolios/coins?q=`). */
export interface CoinOut {
  id: string;
  symbol: string;
  name: string;
}

/** Mirrors `RefreshPricesOut` — the summary `POST /portfolios/refresh-prices`
 * returns after refreshing every auto-priceable holding in the workspace. */
export interface RefreshPricesResult {
  updated: number;
  skipped: number;
  errors: string[];
}

export interface HoldingPage {
  items: HoldingOut[];
  next_cursor: string | null;
}

/** Mirrors `HoldingPriceOut`. */
export interface HoldingPriceOut {
  id: string;
  holding_id: string;
  unit_price_minor: number;
  as_of: string;
  source: string | null;
  is_demo: boolean;
  created_at: string;
}

/** Mirrors `PortfolioIn`. */
export interface CreatePortfolioPayload {
  name: string;
  currency: string;
  description?: string | null;
}

/** Mirrors `PortfolioUpdate` — every field optional, only what changed is sent. */
export interface UpdatePortfolioPayload {
  name?: string;
  currency?: string;
  description?: string | null;
}

/** Mirrors `HoldingIn`. `quantity` is sent as a STRING so the exact typed
 * value reaches the backend's `Decimal` column without a float round-trip
 * (CONVENTIONS §4 — quantity is not money, but the same never-float
 * discipline protects fractional-share precision). `coingecko_id` non-null
 * makes the holding auto-priceable — set via `CoinPicker`. */
export interface CreateHoldingPayload {
  name: string;
  quantity: string;
  symbol?: string | null;
  coingecko_id?: string | null;
}

/** Mirrors `HoldingUpdate`. */
export interface UpdateHoldingPayload {
  name?: string;
  quantity?: string;
  symbol?: string | null;
  coingecko_id?: string | null;
}

/** Mirrors `HoldingPriceIn`. A price carries no currency of its own — it is
 * always in the parent portfolio's currency. */
export interface RecordPricePayload {
  unit_price_minor: number;
  as_of: string;
  source?: string | null;
}

/** Comfortably covers a personal workspace's full portfolio/holdings list in
 * one request — same rationale/limit as `useContacts`'s bounded read. */
const LIST_LIMIT = 200;

/**
 * The workspace's portfolios, each carrying its current `value_minor` and
 * `holding_count`. Keyed with a `"flat"` suffix (`[...qk.portfolios,
 * "flat"]`) — same collision-avoidance move as `useContacts` — so a future
 * keyset read of `qk.portfolios` never collides with this shape, while every
 * mutation below still invalidates the bare prefix. Shared by
 * `PortfolioScreen` and the Dashboard's net-worth tile.
 */
export function usePortfolios() {
  return useQuery({
    queryKey: [...qk.portfolios, "flat"],
    queryFn: () => apiFetch<PortfolioPage>(`/portfolios?limit=${LIST_LIMIT}`),
  });
}

/** A single portfolio by id, including its live `value_minor` — disabled
 * while `id` is undefined, same pattern as `useAsset`. */
export function usePortfolio(id: string | undefined) {
  return useQuery({
    queryKey: qk.portfolio(id ?? ""),
    queryFn: () => apiFetch<PortfolioOut>(`/portfolios/${id}`),
    enabled: id !== undefined,
  });
}

/** One portfolio's holdings (flat bounded read, `"flat"`-suffixed under
 * `qk.holdings(id)`). Disabled while `portfolioId` is undefined. */
export function useHoldings(portfolioId: string | undefined) {
  return useQuery({
    queryKey: [...qk.holdings(portfolioId ?? ""), "flat"],
    queryFn: () =>
      apiFetch<HoldingPage>(`/portfolios/${portfolioId}/holdings?limit=${LIST_LIMIT}`),
    enabled: portfolioId !== undefined,
  });
}

/** Refreshes the portfolios prefix (list, every detail, every holdings list —
 * all nest under `qk.portfolios`) plus `["analytics"]` (the shared analytics
 * prefix documented in `lib/queries.ts`) for the net-worth-over-time series. A
 * portfolio change does NOT move account balances, so `qk.accounts` is
 * deliberately left out — the net-worth tile reads portfolios via
 * `qk.portfolios` and still updates. */
function invalidatePortfolios(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.portfolios });
  void queryClient.invalidateQueries({ queryKey: ["analytics"] });
  void queryClient.invalidateQueries({ queryKey: qk.goals });
}

export function useCreatePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePortfolioPayload) =>
      apiFetch<PortfolioOut>("/portfolios", { method: "POST", json: payload }),
    onSuccess: () => invalidatePortfolios(queryClient),
  });
}

export function useUpdatePortfolio(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdatePortfolioPayload) =>
      apiFetch<PortfolioOut>(`/portfolios/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => invalidatePortfolios(queryClient),
  });
}

/** Hard delete (`DELETE /portfolios/{id}` → 204, cascades to holdings and
 * their prices). Takes the portfolio id as the mutation argument. */
export function useDeletePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/portfolios/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidatePortfolios(queryClient),
  });
}

export function useAddHolding(portfolioId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateHoldingPayload) =>
      apiFetch<HoldingOut>(`/portfolios/${portfolioId}/holdings`, {
        method: "POST",
        json: payload,
      }),
    onSuccess: () => invalidatePortfolios(queryClient),
  });
}

export function useUpdateHolding(portfolioId: string, holdingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateHoldingPayload) =>
      apiFetch<HoldingOut>(`/portfolios/${portfolioId}/holdings/${holdingId}`, {
        method: "PATCH",
        json: payload,
      }),
    onSuccess: () => invalidatePortfolios(queryClient),
  });
}

/** Hard delete (`DELETE /portfolios/{id}/holdings/{hid}` → 204, cascades to
 * the holding's price history). Takes the holding id as the mutation
 * argument. */
export function useDeleteHolding(portfolioId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (holdingId: string) =>
      apiFetch<void>(`/portfolios/${portfolioId}/holdings/${holdingId}`, { method: "DELETE" }),
    onSuccess: () => invalidatePortfolios(queryClient),
  });
}

/** `POST /portfolios/{id}/holdings/{hid}/prices` — recording a new price is
 * what moves a holding's `latest_unit_price_minor`/`value_minor` and the
 * portfolio's total, so this invalidates the same portfolios + net-worth keys
 * as every other mutation here. */
export function useRecordPrice(portfolioId: string, holdingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RecordPricePayload) =>
      apiFetch<HoldingPriceOut>(`/portfolios/${portfolioId}/holdings/${holdingId}/prices`, {
        method: "POST",
        json: payload,
      }),
    onSuccess: () => invalidatePortfolios(queryClient),
  });
}

/** `POST /portfolios/refresh-prices` — refreshes every auto-priceable
 * (`coingecko_id` set) holding in the workspace and returns the
 * `{updated, skipped, errors}` summary. Same invalidation as every other
 * price-moving mutation here (it's what a recorded price does, just for
 * many holdings at once). */
export function useRefreshPrices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<RefreshPricesResult>("/portfolios/refresh-prices", { method: "POST" }),
    onSuccess: () => invalidatePortfolios(queryClient),
  });
}

/** `GET /portfolios/coins?q=` — the cached CoinGecko coin-list proxy backing
 * `CoinPicker`'s search. Its own top-level `qk.coins(q)` prefix (see
 * `lib/queries.ts`) — a static coin catalog, not portfolio data, so it's
 * never touched by `invalidatePortfolios`. `enabled` lets a caller (the
 * picker, while its dropdown is closed) skip fetching entirely rather than
 * querying with an empty/stale string. */
export function useCoinSearch(q: string, enabled = true) {
  return useQuery({
    queryKey: qk.coins(q),
    queryFn: () => apiFetch<CoinOut[]>(`/portfolios/coins?q=${encodeURIComponent(q)}`),
    enabled,
  });
}
