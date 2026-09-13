import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { cn } from "./cn";
import { formatDate } from "./format";
import { formatMoney } from "./money";
import { qk } from "./queries";

/**
 * Shape of `GET /auth/me`'s `preferences` field — the same `PreferencesIn`
 * body `POST /setup/initialize` accepts (`api/src/pecunia/api/setup.py`),
 * persisted as `instance_state.settings` and echoed back by `/auth/me`.
 */
export interface Preferences {
  base_currency: string;
  locale: string;
  date_format: string;
  number_format: string;
  timezone: string;
  first_day_of_week: "monday" | "sunday" | "saturday";
}

interface MeResponse {
  user: unknown;
  preferences: Preferences | null;
}

/** Used before `/auth/me` has resolved (or on error) — a locale-neutral
 * default so every caller of `usePreferences`/`MoneyText`/`DateText` can
 * render immediately instead of null-checking or waiting on a spinner. */
const FALLBACK_PREFERENCES: Preferences = {
  base_currency: "USD",
  locale: "en-US",
  date_format: "MM/DD/YYYY",
  number_format: "1,234.56",
  timezone: "UTC",
  first_day_of_week: "monday",
};

/**
 * The signed-in workspace's preferences. Fetches `GET /auth/me` under the
 * shared `qk.me` query key (see `lib/queries.ts`'s docstring for why this is
 * a second fetch rather than reaching into `AuthProvider`'s internal state)
 * — cached like any other query, so once one caller has loaded it, every
 * other `usePreferences()`/`MoneyText`/`DateText` in the tree reads the same
 * cached value with no extra request. Never `undefined`: falls back to
 * `FALLBACK_PREFERENCES` while loading or if the query errors.
 *
 * This file deliberately colocates the hook with the display components
 * that consume it (`MoneyText`, `DateText`) per the plan's firm contract;
 * Fast Refresh still works for those components, this only means editing
 * `usePreferences` itself forces a full reload.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePreferences(): Preferences {
  const { data } = useQuery({
    queryKey: qk.me,
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });
  return data?.preferences ?? FALLBACK_PREFERENCES;
}

export type MoneyTextVariant = "mono" | "hero";

const VARIANT_FONT_CLASSES: Record<MoneyTextVariant, string> = {
  mono: "font-mono",
  hero: "font-display",
};

export interface MoneyTextProps {
  /** Integer minor units (cents) — never a float (CONVENTIONS §4). */
  minor: number;
  currency: string;
  /**
   * Opt-in only. Per CONVENTIONS §9.1, emerald/coral (`text-positive`/
   * `text-negative`) are reserved for real value movement, never decoration
   * — a plain balance display must not color itself just because it's
   * negative. When set: positive amounts get `text-positive`, negative get
   * `text-negative`, and exactly zero stays plain ink (no movement either
   * way). Reserve this for a genuine delta (a transaction amount, a
   * gain/loss figure) — see `flagNegative` for a plain balance/total.
   */
  colorBySign?: boolean;
  /**
   * Opt-in, asymmetric alternative to `colorBySign` for a plain total that
   * may go negative (an overdrawn account, a currency's summed balance):
   * colors ONLY a negative amount `text-negative` (coral); zero and positive
   * stay plain ink. Money is never green-by-default — a total being
   * positive is the ordinary case, not a delta worth celebrating in emerald.
   */
  flagNegative?: boolean;
  /**
   * `"mono"` (default) — the system monospace, for any scanned/tabular
   * money display (CONVENTIONS §9.8). `"hero"` — the system sans at display
   * weight/size, still tabular-nums, reserved for the one showpiece figure
   * per screen (e.g. the Dashboard's net-worth headline) — hierarchy comes
   * from weight/size, not a second typeface.
   */
  variant?: MoneyTextVariant;
  className?: string;
}

/**
 * Renders a minor-units amount via `formatMoney`, in the user's locale,
 * always tabular-figures and, by default, mono (CONVENTIONS §9.2/§9.8 —
 * money is scanned data, its digits must align). `variant="hero"` swaps the
 * font to the display stack for the one showpiece figure per screen;
 * tabular-figures still applies via the global `font-variant-numeric` rule.
 */
export function MoneyText({
  minor,
  currency,
  colorBySign = false,
  flagNegative = false,
  variant = "mono",
  className,
}: MoneyTextProps) {
  const preferences = usePreferences();
  const signClass = colorBySign
    ? minor > 0
      ? "text-positive"
      : minor < 0
        ? "text-negative"
        : "text-ink"
    : flagNegative && minor < 0
      ? "text-negative"
      : undefined;

  return (
    <span className={cn(VARIANT_FONT_CLASSES[variant], "tabular-figures", signClass, className)}>
      {formatMoney(minor, currency, preferences.locale)}
    </span>
  );
}

export interface DateTextProps {
  /** An ISO date or date-time string. */
  iso: string;
  className?: string;
}

/** Renders an ISO date via `formatDate`, using the user's preferred
 * `date_format`/`locale`. Mono + tabular-figures — a date is scanned data
 * too (CONVENTIONS §9.2: "money, ids, timestamps"). */
export function DateText({ iso, className }: DateTextProps) {
  const preferences = usePreferences();
  return (
    <span className={cn("font-mono tabular-figures", className)}>
      {formatDate(iso, { dateFormat: preferences.date_format, locale: preferences.locale })}
    </span>
  );
}
