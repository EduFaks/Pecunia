/**
 * Groups a keyset-paginated, newest-first list of timestamped items into
 * calendar-day buckets for the "Today / Yesterday / explicit date" feed
 * shape both `features/activity/ActivityScreen` and
 * `features/settings/AuditLogPanel` use (Plan 07 Task 5's firm contract:
 * both screens are day-grouped). Deliberately pure and dependency-free
 * (no hooks) so it's trivial to unit test with a fixed `now` — the
 * component using it supplies `locale`/`dateFormat` from `usePreferences()`.
 *
 * Trusts the input's existing order (the backend's keyset pages are already
 * `occurred_at desc`) — this only buckets by calendar day, it never sorts.
 */

import { formatDate } from "./format";

export interface DayGroup<T> {
  label: string;
  items: T[];
}

export interface GroupByDayOptions {
  /** Injectable "now" for deterministic tests; defaults to `new Date()`. */
  now?: Date;
  dateFormat?: string;
  locale?: string;
}

/** UTC calendar-day key (`"2026-09-11"`) — matches `formatDate`'s own use of
 * UTC getters (CONVENTIONS §9.8) so grouping and display never disagree
 * about which day an instant falls on. */
function dayKey(iso: string): string {
  const date = new Date(iso);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function groupByDay<T extends { occurred_at: string }>(
  items: T[],
  options: GroupByDayOptions = {},
): DayGroup<T>[] {
  const now = options.now ?? new Date();
  const todayKey = dayKey(now.toISOString());
  const yesterdayKey = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());

  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = dayKey(item.occurred_at);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const groupItems = buckets.get(key)!;
    const label =
      key === todayKey
        ? "Today"
        : key === yesterdayKey
          ? "Yesterday"
          : formatDate(groupItems[0].occurred_at, { dateFormat: options.dateFormat, locale: options.locale });
    return { label, items: groupItems };
  });
}
