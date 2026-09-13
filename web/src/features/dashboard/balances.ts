/**
 * Pure money-grouping logic for the Dashboard — no fetching, no rendering.
 * Kept framework-agnostic and trivially unit-testable (CONVENTIONS §8's TDD
 * loop). Every total is integer minor units (§4), grouped per currency —
 * never summed across currencies, since minor units aren't comparable
 * across ISO 4217 currencies without an exchange rate this app doesn't
 * have in V1.
 *
 * Local narrow types (not the full `AccountOut`/`AssetOut` backend
 * schemas) — only the fields this module actually reads, matching the
 * pattern `lib/preferences.tsx`'s `MeResponse` already established.
 */

export interface AccountSummary {
  id: string;
  name: string;
  type: string;
  currency: string;
  balance_minor: number;
  archived_at: string | null;
}

export interface AssetSummary {
  id: string;
  name: string;
  currency: string;
  /** `null` when the asset has no valuation yet — excluded from every sum
   * below rather than treated as zero (a missing valuation isn't "worth
   * nothing", it's "unknown"). */
  current_value_minor: number | null;
}

export interface PortfolioSummary {
  currency: string;
  /** A portfolio's current market value (Σ holdings, integer minor units) —
   * always a known number, never `null`: an empty or fully-unpriced portfolio
   * is a known 0 (the backend computes it that way), unlike an unvalued
   * asset's "unknown" `null`. */
  value_minor: number;
}

export interface LoanSummary {
  currency: string;
  /** `borrowed` is a liability (subtracts from net worth); `lent` is a
   * receivable (adds). */
  direction: "borrowed" | "lent";
  /** `max(principal − Σ payments, 0)`, integer minor units — always a known
   * number, never `null` (the backend floors it at 0). */
  remaining_minor: number;
}

function sumByCurrency<T>(items: T[], currency: (item: T) => string, minor: (item: T) => number): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of items) {
    const key = currency(item);
    totals[key] = (totals[key] ?? 0) + minor(item);
  }
  return totals;
}

/** Total non-archived account balance per currency. */
export function balancesByCurrency(accounts: AccountSummary[]): Record<string, number> {
  const active = accounts.filter((account) => account.archived_at === null);
  return sumByCurrency(active, (a) => a.currency, (a) => a.balance_minor);
}

/** Total latest asset valuation per currency — assets with no valuation yet
 * are skipped, not counted as zero. */
export function assetValuesByCurrency(assets: AssetSummary[]): Record<string, number> {
  const valued = assets.filter((asset) => asset.current_value_minor !== null);
  return sumByCurrency(valued, (a) => a.currency, (a) => a.current_value_minor as number);
}

/** Total portfolio market value per currency. Every portfolio's `value_minor`
 * is a known figure (Σ holdings, computed server-side), so — unlike an
 * unvalued asset — a portfolio is never skipped; a 0-value portfolio simply
 * establishes its currency bucket at 0. */
export function portfolioValuesByCurrency(portfolios: PortfolioSummary[]): Record<string, number> {
  return sumByCurrency(portfolios, (p) => p.currency, (p) => p.value_minor);
}

/** Each loan's SIGNED net-worth contribution per currency: a `borrowed` loan
 * subtracts its remaining balance (a liability), a `lent` loan adds it (a
 * receivable). Grouped by the loan's currency, never mixed across currencies.
 * Fully-paid loans (remaining_minor === 0) are skipped, mirroring the backend's
 * `SnapshotService.net_worth_as_of` so the tile and the over-time chart agree. */
export function loanContributionsByCurrency(loans: LoanSummary[]): Record<string, number> {
  const active = loans.filter((loan) => loan.remaining_minor !== 0);
  return sumByCurrency(
    active,
    (l) => l.currency,
    (l) => (l.direction === "borrowed" ? -l.remaining_minor : l.remaining_minor),
  );
}

/** Net worth per currency = that currency's account balances + that
 * currency's asset values + that currency's portfolio values + that
 * currency's SIGNED loan contribution (borrowed subtracts, lent adds). Never
 * mixes currencies — a USD net worth and a EUR net worth are two separate
 * figures, not one summed number. `portfolios` and `loans` each default to
 * `[]` so pre-domain callers/tests keep their exact behavior. */
export function netWorthByCurrency(
  accounts: AccountSummary[],
  assets: AssetSummary[],
  portfolios: PortfolioSummary[] = [],
  loans: LoanSummary[] = [],
): Record<string, number> {
  const balances = balancesByCurrency(accounts);
  const assetTotals = assetValuesByCurrency(assets);
  const portfolioTotals = portfolioValuesByCurrency(portfolios);
  const loanTotals = loanContributionsByCurrency(loans);
  const currencies = new Set([
    ...Object.keys(balances),
    ...Object.keys(assetTotals),
    ...Object.keys(portfolioTotals),
    ...Object.keys(loanTotals),
  ]);
  const result: Record<string, number> = {};
  for (const currency of currencies) {
    result[currency] =
      (balances[currency] ?? 0) +
      (assetTotals[currency] ?? 0) +
      (portfolioTotals[currency] ?? 0) +
      (loanTotals[currency] ?? 0);
  }
  return result;
}

/**
 * Picks the account the Dashboard's chart/sparkline charts as "the primary
 * account" — a UX heuristic, not a financial computation: prefers the
 * largest-balance non-archived account in the workspace's base currency,
 * falling back to the largest non-archived account overall (by raw
 * `balance_minor`, which is only a fair comparison within one currency —
 * acceptable for "pick one account to feature," unlike the currency-grouped
 * sums above, which never compare across currencies). `null` when there are
 * no active accounts at all.
 */
export function selectPrimaryAccount(
  accounts: AccountSummary[],
  baseCurrency: string,
): AccountSummary | null {
  const active = accounts.filter((account) => account.archived_at === null);
  if (active.length === 0) {
    return null;
  }
  const sameCurrency = active.filter((account) => account.currency === baseCurrency);
  const pool = sameCurrency.length > 0 ? sameCurrency : active;
  return pool.reduce((largest, account) =>
    account.balance_minor > largest.balance_minor ? account : largest,
  );
}
