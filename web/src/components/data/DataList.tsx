import { useInfiniteQuery } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect } from "react";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import Spinner from "../ui/Spinner";

/** The shape every keyset-paginated list endpoint returns (CONVENTIONS §6:
 * `{items, next_cursor}`, an opaque cursor string, `null` once exhausted). */
export interface KeysetPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface DataListProps<T> {
  /** Cache key for this list — pass a `qk.*` value from `lib/queries.ts`. */
  queryKey: QueryKey;
  /** Fetches one page. `cursor` is `null` for the first page, then whatever
   * the previous page's `next_cursor` was. */
  fetchPage: (cursor: string | null) => Promise<KeysetPage<T>>;
  renderRow: (item: T) => ReactNode;
  /** Shown once loading has finished and no page returned any items. */
  empty: ReactNode;
  /** Optional content rendered above the rows — a table header row, a
   * caption — inside the same horizontally-scrolling container as the rows. */
  header?: ReactNode;
  /** Fired after every successful fetch (first page and every "Load more")
   * with the full accumulated `items` and whether more pages remain — lets a
   * caller aggregate over exactly what's currently on screen (e.g. a
   * per-currency summary total) without a second fetch: this list's own
   * `useInfiniteQuery` stays the only network call, the callback just
   * mirrors its result. Never fired while loading or on error. */
  onItemsChange?: (items: T[], hasNextPage: boolean) => void;
  className?: string;
}

/**
 * Generic keyset-paginated list/table body. Wraps `useInfiniteQuery`
 * (`getNextPageParam` reads each page's `next_cursor`, per CONVENTIONS §6's
 * keyset-pagination contract) so accumulated pages live in one cache entry
 * under `queryKey` — a "Load more" click calls `fetchNextPage`, which
 * appends a new page rather than replacing the list, and TanStack Query
 * itself guards against firing a second fetch while one is already in
 * flight. `next_cursor: null` on the latest page hides the button.
 *
 * Wide row content scrolls independently (`overflow-x-auto`) rather than
 * letting the page itself scroll horizontally. "Load more" is a native
 * `Button`, so it's keyboard-operable (Tab + Enter/Space) with no extra
 * wiring.
 *
 * `T` is constrained to carry an `id` (every domain resource does — see
 * CONVENTIONS §4/§6) so each row gets a stable React key from the data
 * itself, with no separate `getKey` prop for callers to supply.
 */
function DataList<T extends { id: string | number }>({
  queryKey,
  fetchPage,
  renderRow,
  empty,
  header,
  onItemsChange,
  className,
}: DataListProps<T>) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
  });

  useEffect(() => {
    if (query.data) {
      onItemsChange?.(query.data.pages.flatMap((page) => page.items), query.hasNextPage);
    }
    // `onItemsChange` is intentionally excluded: callers typically pass an
    // inline closure that isn't memoized, and re-invoking it with the same
    // items on every render would be noise, not a real data change — same
    // rationale as `PasswordStrength`'s `onScoreChange` effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, query.hasNextPage]);

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner label="Loading" />
      </div>
    );
  }

  if (query.isError) {
    return <Callout variant="negative">Couldn't load this list. Try again.</Callout>;
  }

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (items.length === 0) {
    return <>{empty}</>;
  }

  return (
    <div className={className}>
      <div className="overflow-x-auto">
        {header}
        <ul className="divide-y divide-hairline">
          {items.map((item) => (
            <li key={item.id}>{renderRow(item)}</li>
          ))}
        </ul>
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

export default DataList;
