import { Link } from "react-router-dom";
import { Line, LineChart, YAxis } from "recharts";
import { describeTrend } from "../../components/charts/chartMath";
import type { ChartPoint } from "../../components/charts/chartMath";
import { ChartContainer } from "../../components/ui/chart";
import type { ChartConfig } from "../../components/ui/chart";
import { MoneyText, usePreferences } from "../../lib/preferences";
import type { AccountSummary } from "./balances";

/** Snapshot rows are capped so the panel stays a glanceable preview, not a
 * second copy of the full `/accounts` list. */
const SNAPSHOT_LIMIT = 6;

/** A trend needs at least two points to mean anything — a lone point can't
 * draw a line, so the sparkline quietly omits itself. */
const MIN_SPARKLINE_POINTS = 2;

/** The inline sparkline is a single neutral (balance) series — never colored
 * by direction (emerald/coral are reserved for real value movement, §9.1). */
const sparklineConfig = {
  valueMinor: { label: "Balance", color: "var(--pc-text)" },
} satisfies ChartConfig;

function humanizeType(type: string): string {
  return type.split("_").join(" ");
}

/**
 * A minimal Recharts line — no axes, grid, or tooltip, just a neutral
 * white/`--pc-text` trend line compact enough to sit inline beside a balance
 * figure (the y domain hugs the data so the shape fills the box). Wrapped in a
 * labeled `ChartContainer` (`role="img"` + a trend `aria-label`) so screen
 * readers get the summary the bare line can't convey. `isAnimationActive`
 * is off so nothing depends on motion (reduced-motion-safe) and the render is
 * deterministic in tests. Renders nothing for fewer than two points.
 */
function AccountSparkline({
  points,
  currency,
  label,
  locale,
}: {
  points: ChartPoint[];
  currency: string;
  label: string;
  locale?: string;
}) {
  if (points.length < MIN_SPARKLINE_POINTS) {
    return null;
  }
  return (
    <ChartContainer
      config={sparklineConfig}
      className="shrink-0"
      style={{ width: 96, height: 28, aspectRatio: "auto" }}
      role="img"
      aria-label={describeTrend(label, points, currency, locale)}
    >
      <LineChart data={points} margin={{ top: 4, right: 2, bottom: 4, left: 2 }}>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Line
          dataKey="valueMinor"
          type="monotone"
          stroke="var(--color-valueMinor)"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

export interface AccountsSnapshotProps {
  accounts: AccountSummary[];
  /** The account the net-worth series was reconstructed for — its series is
   * reused here (no extra fetch, "if cheap" per the brief) to show a small
   * inline trend next to that one row. */
  primaryAccountId?: string;
  primarySeries?: ChartPoint[];
}

/**
 * A Surface panel previewing the largest accounts (by balance, capped at
 * `SNAPSHOT_LIMIT`) with name, type, and balance — links to the full
 * `/accounts` screen. The primary account (the one the dashboard already
 * reconstructed a balance series for) gets a small inline sparkline next to
 * its balance at no extra fetch cost; every other row stays a plain figure.
 */
function AccountsSnapshot({ accounts, primaryAccountId, primarySeries }: AccountsSnapshotProps) {
  const { locale } = usePreferences();
  const sorted = [...accounts].sort((a, b) => b.balance_minor - a.balance_minor);
  const visible = sorted.slice(0, SNAPSHOT_LIMIT);
  const remaining = accounts.length - visible.length;

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg text-ink">Accounts</h2>
        <Link
          to="/accounts"
          className="font-sans text-sm text-accent transition-colors duration-150 ease-pc hover:text-accent-hover"
        >
          View all{accounts.length > 0 ? ` (${accounts.length})` : ""}
        </Link>
      </div>

      <ul className="mt-4 divide-y divide-hairline">
        {visible.map((account) => (
          <li key={account.id} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-sans text-sm text-ink">{account.name}</p>
              <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
                {humanizeType(account.type)}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {account.id === primaryAccountId &&
              primarySeries &&
              primarySeries.length >= MIN_SPARKLINE_POINTS ? (
                <AccountSparkline
                  points={primarySeries}
                  currency={account.currency}
                  label={account.name}
                  locale={locale}
                />
              ) : null}
              <MoneyText minor={account.balance_minor} currency={account.currency} flagNegative />
            </div>
          </li>
        ))}
      </ul>

      {remaining > 0 ? (
        <p className="mt-3 font-sans text-xs text-ink-faint">
          +{remaining} more account{remaining === 1 ? "" : "s"} — see the full list.
        </p>
      ) : null}
    </div>
  );
}

export default AccountsSnapshot;
