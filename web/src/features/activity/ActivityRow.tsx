import { renderActivity } from "../../lib/activity";
import type { ActivityEntry } from "../../lib/activity";
import { MoneyText, usePreferences } from "../../lib/preferences";

const MISSING = "—";

function str(params: Record<string, unknown>, key: string, fallback: string = MISSING): string {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface ActivityRowProps {
  entry: ActivityEntry;
}

/**
 * Renders one `/activity` feed entry. Every template key routes through
 * `renderActivity` (`lib/activity.ts`) for its plain sentence, EXCEPT
 * `activity.asset.valuation_changed`, which gets a bespoke, richer treatment
 * here: `MoneyText` for both the old and new value (locale-aware, tabular
 * figures) with the new value's wrapper colored emerald (`text-positive`, value
 * rose) or coral (`text-negative`, value fell) — CONVENTIONS §9.1 reserves
 * emerald/coral for genuine value movement, and a valuation change is exactly
 * that. `lib/activity.ts`'s own plain-string rendering of this key stays the
 * graceful, colorless fallback the Dashboard's compact preview uses.
 *
 * `renderActivity` never throws (an unrecognized key falls back to a
 * humanized sentence), so this row can never crash the feed either.
 */
function ActivityRow({ entry }: ActivityRowProps) {
  const preferences = usePreferences();

  if (entry.template_key === "activity.asset.valuation_changed") {
    const params = entry.params;
    const asset = str(params, "asset");
    const currency = str(params, "currency", preferences.base_currency);
    const from = num(params, "from");
    const to = num(params, "to");
    const directionClass = to > from ? "text-positive" : to < from ? "text-negative" : undefined;

    return (
      <p className="flex flex-wrap items-center gap-1 py-3 px-4 text-sm text-ink">
        <span>{asset} valuation changed ·</span>
        <MoneyText minor={from} currency={currency} />
        <span aria-hidden="true">→</span>
        <span className={directionClass}>
          <MoneyText minor={to} currency={currency} />
        </span>
      </p>
    );
  }

  return (
    <p className="py-3 px-4 text-sm text-ink">
      {renderActivity(entry.template_key, entry.params, preferences.locale)}
    </p>
  );
}

export default ActivityRow;
