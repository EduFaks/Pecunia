/**
 * Date/number formatting driven by user preferences (a `dateFormat` string
 * such as `"DD/MM/YYYY"` plus a BCP-47 `locale`). Kept pragmatic: a small,
 * explicit map for the handful of date patterns the preferences UI offers,
 * falling back to `Intl.DateTimeFormat`'s locale-driven medium style when no
 * preference is set (or it's a pattern we don't recognize).
 */

export interface DateFormatOptions {
  dateFormat?: string;
  locale?: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDate(iso: string, options: DateFormatOptions = {}): string {
  const { dateFormat, locale } = options;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${iso}`);
  }

  // UTC getters: an ISO date/date-time string is an absolute instant, and
  // formatting from local getters would shift the displayed day depending on
  // the machine's timezone. Using UTC keeps this deterministic.
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());

  switch (dateFormat) {
    case "DD/MM/YYYY":
      return `${day}/${month}/${year}`;
    case "MM/DD/YYYY":
      return `${month}/${day}/${year}`;
    case "YYYY-MM-DD":
      return `${year}-${month}-${day}`;
    case "DD.MM.YYYY":
      return `${day}.${month}.${year}`;
    default:
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
        date,
      );
  }
}

export function formatNumber(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A short "today"/"3d ago"/"2mo ago"/"2y ago" label for a plain (no-time)
 * ISO date string — the shape `HoldingPriceOut.as_of` carries. Compared at
 * UTC day granularity (same rationale as `formatDate`: an ISO date-only
 * string is an absolute instant, and comparing via local getters would shift
 * the day depending on the machine's timezone). A same-day or future date
 * (clock skew, or `as_of` backfilled ahead of `now` by mistake) reads as
 * "today" rather than a confusing negative count.
 */
export function formatRelativeDate(isoDate: string, now: Date = new Date()): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${isoDate}`);
  }
  const nowUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dateUtcDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const days = Math.round((nowUtcDay - dateUtcDay) / MS_PER_DAY);

  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(days / 365);
  return `${years}y ago`;
}
