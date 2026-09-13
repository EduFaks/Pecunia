import type { ReactNode } from "react";

/** A titled surface panel wrapping one analytics graph — the card treatment
 * shared by the dashboard's headline graphs and the Insights screen, factored
 * out so both read the same. */
export function GraphCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
      <h2 className="font-display text-lg text-ink">{title}</h2>
      <div className="mt-4">{children}</div>
    </div>
  );
}

/** A calm, chart-sized empty/loading placeholder — never a fake chart (the
 * dataviz constraint), just a muted line inside the card. */
export function ChartEmpty({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-sm text-ink-2">{children}</p>;
}

/** A muted per-chart error line — a page-level error callout covers a total
 * failure; this keeps one failed graph from blanking the rest. */
export function ChartError() {
  return (
    <p className="py-10 text-center text-sm text-ink-faint">
      Couldn't load this chart. Try refreshing.
    </p>
  );
}
