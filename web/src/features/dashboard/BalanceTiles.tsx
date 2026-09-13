import { MoneyText } from "../../lib/preferences";
import {
  assetValuesByCurrency,
  balancesByCurrency,
  loanContributionsByCurrency,
  netWorthByCurrency,
  portfolioValuesByCurrency,
} from "./balances";
import type { AccountSummary, AssetSummary, LoanSummary, PortfolioSummary } from "./balances";

export interface BalanceTilesProps {
  accounts: AccountSummary[];
  assets: AssetSummary[];
  /** Investment portfolios contributing to net worth (Portfolio domain).
   * Defaults to `[]` so a caller with no portfolios (or a test predating the
   * domain) renders exactly as before. */
  portfolios?: PortfolioSummary[];
  /** Loans contributing (as a signed term) to net worth (Loans domain) — a
   * borrowed loan subtracts its remaining, a lent one adds it. Defaults to
   * `[]` so a caller with no loans (or a test predating the domain) renders
   * exactly as before. */
  loans?: LoanSummary[];
  /** The workspace's base/primary currency (`usePreferences().base_currency`)
   * — its net worth becomes the display-weight hero figure. */
  baseCurrency: string;
}

interface BreakdownPart {
  label: string;
  minor: number;
  /** Only a plain balance can go negative and deserve a coral flag; asset and
   * investment values don't (they're never negative). */
  flagNegative?: boolean;
}

/**
 * The Dashboard's money-summary header: a display-weight hero net-worth
 * figure for the base currency (accounts + latest asset valuations + current
 * portfolio values, CONVENTIONS' "never sum across currencies"), plus a small
 * breakdown caption of its components, plus one secondary tile per additional
 * currency the workspace holds value in — each showing that currency's own
 * balance and net worth, never mixed with any other currency's.
 */
function BalanceTiles({
  accounts,
  assets,
  portfolios = [],
  loans = [],
  baseCurrency,
}: BalanceTilesProps) {
  const balances = balancesByCurrency(accounts);
  const assetTotals = assetValuesByCurrency(assets);
  const portfolioTotals = portfolioValuesByCurrency(portfolios);
  const loanTotals = loanContributionsByCurrency(loans);
  const netWorth = netWorthByCurrency(accounts, assets, portfolios, loans);

  const heroNetWorth = netWorth[baseCurrency] ?? 0;

  // The base currency's signed loan contribution: negative when net borrowed
  // (a debt), positive when net lent (a receivable). Labeled accordingly so a
  // mixed workspace never reads a positive figure as "Debts".
  const loanContribution = loanTotals[baseCurrency] ?? 0;

  // The hero's components, in order — each shown only when it actually
  // contributes, and the caption shown only when more than one does (a single
  // component is already the hero figure, so a breakdown would just repeat it).
  const parts: BreakdownPart[] = [
    { label: "Balance", minor: balances[baseCurrency] ?? 0, flagNegative: true },
    { label: "Assets", minor: assetTotals[baseCurrency] ?? 0 },
    { label: "Investments", minor: portfolioTotals[baseCurrency] ?? 0 },
    { label: loanContribution < 0 ? "Debts" : "Loans", minor: loanContribution, flagNegative: true },
  ].filter((part) => part.minor !== 0);
  const showBreakdown = parts.length >= 2;

  const otherCurrencies = Object.keys(netWorth)
    .filter((currency) => currency !== baseCurrency)
    .sort();

  return (
    <section className="flex flex-col gap-6">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">Net worth</p>
        <p className="mt-2">
          <MoneyText
            minor={heroNetWorth}
            currency={baseCurrency}
            variant="hero"
            flagNegative
            className="text-4xl sm:text-5xl"
          />
        </p>
        {showBreakdown ? (
          <p className="mt-2 flex flex-wrap gap-x-2 text-sm text-ink-2">
            {parts.map((part, index) => (
              <span key={part.label}>
                {index > 0 ? <span className="mr-2 text-ink-faint">·</span> : null}
                {part.label}{" "}
                <MoneyText
                  minor={part.minor}
                  currency={baseCurrency}
                  flagNegative={part.flagNegative}
                />
              </span>
            ))}
          </p>
        ) : null}
      </div>

      {otherCurrencies.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {otherCurrencies.map((currency) => (
            <div key={currency} className="rounded-pc-lg border border-hairline bg-surface-1 p-4">
              <p className="font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">{currency}</p>
              <p className="mt-2 text-sm text-ink-2">
                Balance <MoneyText minor={balances[currency] ?? 0} currency={currency} flagNegative />
              </p>
              <p className="text-sm text-ink-2">
                Net worth <MoneyText minor={netWorth[currency]} currency={currency} flagNegative />
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default BalanceTiles;
