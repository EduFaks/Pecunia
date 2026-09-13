import { useInfiniteQuery } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import Spinner from "../ui/Spinner";
import { groupByDay } from "../../lib/dayGroups";
import type { KeysetPage } from "./DataList";

export interface DayGroupedListProps<T extends { id: string | number; occurred_at: string }> {
  /** Cache key for this list — pass a `qk.*` value from `lib/queries.ts`. */
  queryKey: QueryKey;
  /** Fetches one page. `cursor` is `null` for the first page, then whatever
   * the previous page's `next_cursor` was. */
  fetchPage: (cursor: string | null) => Promise<KeysetPage<T>>;
  renderRow: (item: T) => ReactNode;
  /** Shown once loading has finished and no page returned any items. */
  empty: ReactNode;
  /** Overrides the default "Couldn't load this list" callout — e.g. a
   * friendly "Only the instance owner can view the audit log" message when
   * the failure is a known, expected permission refusal rather than a
   * generic fetch error. Given the raw thrown value (typically an
   * `ApiError`); the caller narrows it. */
  renderError?: (error: unknown) => ReactNode;
  dateFormat?: string;
  locale?: string;
  /** Injectable "now" for deterministic Today/Yesterday tests — see
   * `lib/dayGroups.ts`. */
  now?: Date;
  className?: string;
}

/**
 * `DataList`'s sibling for a feed that reads as "Today / Yesterday / an
 * explicit date" rather than a flat table — `features/activity/ActivityScreen`
 * and `features/settings/AuditLogPanel` (Plan 07 Task 5's firm contract: both
 * screens are day-grouped). Shares `DataList`'s keyset-pagination mechanics
 * (`useInfiniteQuery`, `KeysetPage<T>`, a "Load more" `Button` that appends
 * rather than replaces) and its `{items, next_cursor}` contract; the
 * difference is purely presentational — items are bucketed via
 * `groupByDay` (`lib/dayGroups.ts`) and rendered under a heading per
 * calendar day instead of one flat `<ul>`.
 */
function DayGroupedList<T extends { id: string | number; occurred_at: string }>({
  queryKey,
  fetchPage,
  renderRow,
  empty,
  renderError,
  dateFormat,
  locale,
  now,
  className,
}: DayGroupedListProps<T>) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
  });

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner label="Loading" />
      </div>
    );
  }

  if (query.isError) {
    return renderError ? (
      <>{renderError(query.error)}</>
    ) : (
      <Callout variant="negative">Couldn't load this list. Try again.</Callout>
    );
  }

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (items.length === 0) {
    return <>{empty}</>;
  }

  const groups = groupByDay(items, { now, dateFormat, locale });

  return (
    <div className={className}>
      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <section key={group.label}>
            <h3 className="mb-2 font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">
              {group.label}
            </h3>
            <ul className="divide-y divide-hairline rounded-pc-lg border border-hairline bg-surface-1">
              {group.items.map((item) => (
                <li key={item.id}>{renderRow(item)}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {query.hasNextPage ? (
        <div className="flex justify-center border-t border-hairline py-4">
          <Button
            variant="ghost"
            size="sm"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default DayGroupedList;
