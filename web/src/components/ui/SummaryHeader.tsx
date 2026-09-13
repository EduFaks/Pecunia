import { cn } from "../../lib/cn";
import { MoneyText } from "../../lib/preferences";

/**
 * A stat's per-entry emphasis. `undefined` (the common case — a plain
 * total/balance figure) stays plain ink, matching `MoneyText`'s own "money
 * is never colored just because it's a total" default (CONVENTIONS §9.1).
 * `"pos"`/`"neg"` are for a genuine value movement (Transactions' in/out/net,
 * Planned's signed upcoming total) — the same emerald/coral `MoneyText`'s
 * `colorBySign` uses. `"muted"` de-emphasizes a secondary figure (e.g. a
 * computed "remaining" alongside a more prominent total) without implying
 * gain/loss.
 */
export type SummaryTone = "pos" | "neg" | "muted";

const TONE_CLASS: Record<SummaryTone, string> = {
  pos: "text-positive",
  neg: "text-negative",
  muted: "text-ink-faint",
};

export interface SummaryEntry {
  currency: string;
  /** Integer minor units (CONVENTIONS §4) — never a float. */
  value_minor: number;
  tone?: SummaryTone;
}

export interface SummaryStat {
  label: string;
  /** One entry per currency this stat has a figure for — never summed
   * across currencies (§4). An empty array is valid (a stat with nothing to
   * show yet); the whole header falls back to its empty state only when
   * *every* stat's entries are empty. */
  entries: SummaryEntry[];
}

export interface SummaryHeaderProps {
  stats: SummaryStat[];
  /** An honesty caveat shown once for the whole header — e.g. Transactions'
   * "this page" label when the list is still keyset-paginating and more rows
   * exist beyond what's summed. Omit when the totals are exhaustive. */
  note?: string;
  className?: string;
}

/**
 * Shared presentational summary bar for every list screen (Track P, v1.4):
 * one block per stat (a label + its per-currency figures), laid out in a
 * `flex-wrap` row so it never overflows at 360px (CONVENTIONS' mobile
 * rules) — degrading to a stacked column on narrow viewports. Purely
 * presentational: callers compute `stats` (typically via `sumByCurrency`,
 * `features/_shared/totals.ts`) from the list they've already loaded; this
 * component fetches nothing.
 */
function SummaryHeader({ stats, note, className }: SummaryHeaderProps) {
  const visibleStats = stats.filter((stat) => stat.entries.length > 0);

  if (visibleStats.length === 0) {
    return (
      <div
        className={cn(
          "rounded-pc-lg border border-hairline bg-surface-1 p-4 text-sm text-ink-faint",
          className,
        )}
      >
        Nothing to summarize yet.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-pc-lg border border-hairline bg-surface-1 p-4 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-8 sm:gap-y-4",
        className,
      )}
    >
      {visibleStats.map((stat) => (
        <div key={stat.label} className="flex min-w-0 flex-col gap-1">
          <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">{stat.label}</p>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {stat.entries.map((entry) => (
              <span key={entry.currency} className="inline-flex items-baseline gap-1">
                <span className="font-mono text-[10px] uppercase text-ink-faint">{entry.currency}</span>
                <MoneyText
                  minor={entry.value_minor}
                  currency={entry.currency}
                  className={cn("text-sm", entry.tone ? TONE_CLASS[entry.tone] : "text-ink")}
                />
              </span>
            ))}
          </div>
        </div>
      ))}
      {note ? (
        <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint sm:ml-auto sm:self-end">
          {note}
        </p>
      ) : null}
    </div>
  );
}

export default SummaryHeader;
