import { useState } from "react";
import { Link } from "react-router-dom";
import DataList from "../../components/data/DataList";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import Checkbox from "../../components/ui/Checkbox";
import SummaryHeader from "../../components/ui/SummaryHeader";
import type { SummaryStat } from "../../components/ui/SummaryHeader";
import { useToast } from "../../components/ui/Toast";
import { apiFetch } from "../../lib/api";
import { MoneyText } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import { sumByCurrency } from "../_shared/totals";
import AccountForm from "./AccountForm";
import { ACCOUNT_TYPE_LABELS } from "./accountTypes";
import { useAccounts, useArchiveAccount } from "./useAccounts";
import type { AccountOut, AccountPage } from "./useAccounts";

/** One walked page's size for the accounts `DataList` — small enough that
 * "Load more" is meaningful, generous enough that most workspaces never
 * see it. */
const PAGE_LIMIT = 20;

type FormState = { mode: "create" } | { mode: "edit"; account: AccountOut };

/**
 * `/accounts` — the accounts list: name, type, `MoneyText` balance, an
 * include-archived toggle, and inline create/edit via `AccountForm`.
 * `DataList` owns the keyset walk (`GET /accounts?include_archived=&cursor=
 * &limit=`); `includeArchived` is part of the list's `queryKey` so flipping
 * the toggle starts a fresh walk rather than filtering already-loaded pages
 * client-side. This bare `[...qk.accounts, {includeArchived}]` key is
 * deliberately the canonical one for this filter — `useAccounts.ts`'s flat
 * (non-paginated) hook suffixes its own key with `"flat"` precisely so it
 * never collides with this `useInfiniteQuery` (see that hook's docstring
 * for the crash this key split fixes).
 */
function AccountsScreen() {
  const { showToast } = useToast();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [formState, setFormState] = useState<FormState | null>(null);
  const archiveAccount = useArchiveAccount();

  // The summary header's own bounded flat read (Track P) — independent of
  // `DataList`'s keyset walk below, which only surfaces whatever page(s) the
  // user has scrolled through. Reuses the same "flat" hook every account
  // picker already reads, so the total always reflects every account
  // matching the current `includeArchived` toggle, not just the loaded page.
  const accountsForTotals = useAccounts(includeArchived).data?.items ?? [];
  const balanceStats: SummaryStat[] = [
    {
      label: "Total balance",
      entries: sumByCurrency(
        accountsForTotals,
        (account) => account.balance_minor,
        (account) => account.currency,
      ).map(({ currency, total_minor }) => ({
        currency,
        value_minor: total_minor,
        tone: total_minor < 0 ? "neg" : undefined,
      })),
    },
  ];

  function fetchPage(cursor: string | null) {
    const params = new URLSearchParams({
      include_archived: String(includeArchived),
      limit: String(PAGE_LIMIT),
    });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return apiFetch<AccountPage>(`/accounts?${params.toString()}`);
  }

  async function handleArchive(account: AccountOut) {
    try {
      await archiveAccount.mutateAsync(account.id);
      showToast(`"${account.name}" archived.`);
    } catch {
      showToast("Couldn't archive that account. Please try again.", { variant: "negative" });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Accounts</h1>
        <Button onClick={() => setFormState({ mode: "create" })}>New account</Button>
      </div>

      {accountsForTotals.length > 0 ? <SummaryHeader stats={balanceStats} /> : null}

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {formState.mode === "edit" ? "Edit account" : "New account"}
          </h2>
          <div className="mt-4">
            <AccountForm
              account={formState.mode === "edit" ? formState.account : undefined}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Account updated." : "Account created.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      <Checkbox
        label="Show archived accounts"
        checked={includeArchived}
        onChange={(event) => setIncludeArchived(event.target.checked)}
      />

      <DataList<AccountOut>
        queryKey={[...qk.accounts, { includeArchived }]}
        fetchPage={fetchPage}
        empty={
          <EmptyState
            title="No accounts yet"
            body="Add your first account to start tracking balances and transactions."
            action={
              <Button onClick={() => setFormState({ mode: "create" })}>Add your first account</Button>
            }
          />
        }
        renderRow={(account) => (
          <div className="flex items-center justify-between gap-4 py-3">
            <Link to={`/accounts/${account.id}`} className="min-w-0">
              <p className="truncate font-sans text-sm text-ink hover:text-accent">{account.name}</p>
              <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
                {ACCOUNT_TYPE_LABELS[account.type] ?? account.type}
                {account.archived_at ? " · archived" : ""}
              </p>
            </Link>
            <div className="flex shrink-0 items-center gap-4">
              <MoneyText minor={account.balance_minor} currency={account.currency} flagNegative />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFormState({ mode: "edit", account })}
              >
                Edit
              </Button>
              {!account.archived_at ? (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={archiveAccount.isPending}
                  onClick={() => void handleArchive(account)}
                >
                  Archive
                </Button>
              ) : null}
            </div>
          </div>
        )}
      />
    </div>
  );
}

export default AccountsScreen;
