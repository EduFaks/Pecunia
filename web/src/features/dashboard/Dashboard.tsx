import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Spinner from "../../components/ui/Spinner";
import { usePullToRefresh } from "../../components/layout/usePullToRefresh";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import AccountsCardsCard from "./AccountsCardsCard";
import type { AccountSummary } from "./balances";
import MonthResultCard from "./MonthResultCard";
import SafeToSpendCard from "./SafeToSpendCard";
import SpendingBreakdownCard from "./SpendingBreakdownCard";
import UpcomingCard from "./UpcomingCard";

interface KeysetResponse<T> {
  items: T[];
}

/**
 * The Dashboard reads a bounded snapshot of the accounts listing — a summary
 * guard, not a full paginated walk (that's `/accounts`, built on `DataList`).
 * This limit comfortably covers a typical workspace; `pecunia.pagination.
 * MAX_LIMIT` is 200 server-side. `AccountsCardsCard` below reads the exact
 * same `"dashboard"`-suffixed key + queryFn (see the comment on the query
 * itself), so the two reads collapse into one request.
 */
const ACCOUNTS_FETCH_LIMIT = 200;

/**
 * The Dashboard (Track U, v1.6) — Pecunia's daily-glance screen, mounted at
 * `/`. A lean vertical stack of five standalone cards (Tasks 3–5):
 * `SafeToSpendCard` ("how much can I still spend"), `MonthResultCard` (this
 * month's income/spend + projected close), `SpendingBreakdownCard` (this
 * month's category donut), `UpcomingCard` (what's due in the next 14 days),
 * and `AccountsCardsCard` (every account/card at a glance). Each card fetches
 * its own data and self-handles its own loading/error/empty state — this
 * screen keeps only the top-level guard that decides whether to show the
 * stack at all: a spinner while the accounts list is in flight, an error
 * callout if it fails, and a welcoming empty state for a fresh instance with
 * no accounts yet (the app is fully usable with nothing, the firm contract).
 * The richer, deeper-dive widgets this screen used to host (net worth over
 * time/composition, the savings/committed/net-worth-change KPI trio, income
 * vs spend, goals, recent activity, the accounts snapshot, and the 30-day
 * upcoming+over-budget panel) moved to `/insights` (`InsightsScreen`).
 */
function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // A phone-native pull-to-refresh for the card stack below: releasing a
  // pull past the threshold re-fetches everything the five cards read —
  // `["analytics"]` (SafeToSpendCard/MonthResultCard/SpendingBreakdownCard/
  // UpcomingCard all read `/analytics/*`), this screen's own `"dashboard"`-
  // suffixed accounts read (also `AccountsCardsCard`'s), and `qk.bankSync`
  // (the connections `AccountsCardsCard` joins balances against) — the same
  // three prefixes a bank-sync mutation invalidates (`useBankSync.ts`), just
  // triggered by a gesture instead of a mutation's `onSuccess`. Scoped to
  // this screen only — no other screen mounts `usePullToRefresh`.
  const { bind, refreshing } = usePullToRefresh({
    onRefresh: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["analytics"] }),
        queryClient.invalidateQueries({ queryKey: [...qk.accounts, "dashboard"] }),
        queryClient.invalidateQueries({ queryKey: qk.bankSync }),
      ]);
    },
  });

  // Suffixed `"dashboard"` — same move `AssetDetail`'s bounded chart fetch
  // already makes on `qk.assetValuations(id)` (see that file's docstring) —
  // to keep this bounded, flat `useQuery` read out of the exact cache slot
  // `AccountsScreen`'s `useInfiniteQuery` reads via plain `qk.accounts`.
  // Without the suffix, whichever screen mounts second finds this screen's
  // plain `{items, next_cursor}` payload already cached under its literal key
  // and hands it to `useInfiniteQuery` as if it were an already-paginated
  // `{pages, pageParams}` result — `getNextPageParam` then reads `.pages` off
  // a value that doesn't have it and throws, crashing the whole tree (no
  // error boundary catches it). The suffix is still a nested key, so
  // `qk.accounts` invalidation (a mutation, `financeQueryKeys` on demo
  // removal) still covers it via TanStack's prefix match. `AccountsCardsCard`
  // reads this exact key + queryFn, so mounting both costs one request.
  const accountsQuery = useQuery({
    queryKey: [...qk.accounts, "dashboard"],
    queryFn: () =>
      apiFetch<KeysetResponse<AccountSummary>>(`/accounts?limit=${ACCOUNTS_FETCH_LIMIT}`),
  });

  const accounts = accountsQuery.data?.items ?? [];
  const activeAccounts = accounts.filter((account) => account.archived_at === null);

  if (accountsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading your dashboard" />
      </div>
    );
  }

  if (accountsQuery.isError) {
    return <Callout variant="negative">Couldn't load your accounts. Try refreshing the page.</Callout>;
  }

  if (activeAccounts.length === 0) {
    return (
      <EmptyState
        title="Welcome to Pecunia"
        body="You don't have any accounts yet. Add your first one to start tracking balances, transactions, and net worth."
        action={<Button onClick={() => navigate("/accounts")}>Add your first account</Button>}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8" data-testid="dashboard-scroll" {...bind}>
      {refreshing ? (
        <div className="flex justify-center py-2">
          <Spinner label="Refreshing" size="sm" className="text-ink-2" />
        </div>
      ) : null}
      <div className="min-w-0">
        <SafeToSpendCard />
      </div>
      <div className="min-w-0">
        <MonthResultCard />
      </div>
      <div className="min-w-0">
        <SpendingBreakdownCard />
      </div>
      <div className="min-w-0">
        <UpcomingCard />
      </div>
      <div className="min-w-0">
        <AccountsCardsCard />
      </div>
    </div>
  );
}

export default Dashboard;
