import { useState } from "react";
import DataList from "../../components/data/DataList";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import SummaryHeader from "../../components/ui/SummaryHeader";
import type { SummaryStat } from "../../components/ui/SummaryHeader";
import { useToast } from "../../components/ui/Toast";
import { ApiError, apiFetch } from "../../lib/api";
import { DateText, MoneyText } from "../../lib/preferences";
import { useDebouncedValue } from "../../lib/useDebounced";
import { useAccounts } from "../accounts/useAccounts";
import CategoryBadge from "../categories/CategoryBadge";
import { useCategories } from "../categories/useCategories";
import ContactBadge from "../contacts/ContactBadge";
import { useContacts } from "../contacts/useContacts";
import LoanPicker from "../loans/LoanPicker";
import type { LoanOut } from "../loans/useLoans";
import { useProjectList } from "../projects/useProjects";
import TransferBadge from "../transfers/TransferBadge";
import TransferForm from "../transfers/TransferForm";
import { useTransfers } from "../transfers/useTransfers";
import type { TransferOut } from "../transfers/useTransfers";
import { sumByCurrency } from "../_shared/totals";
import TransactionFiltersBar from "./TransactionFilters";
import TransactionForm from "./TransactionForm";
import {
  hasActiveFilters,
  transactionsQueryKey,
  transactionsQueryString,
  useApplyTransactionToLoan,
  useDeleteTransaction,
  useRestoreTransaction,
} from "./useTransactions";
import type { TransactionFilters, TransactionOut } from "./useTransactions";

interface TransactionPage {
  items: TransactionOut[];
  next_cursor: string | null;
}

/** One walked page's size for the transactions `DataList`. */
const PAGE_LIMIT = 20;

/** How long typing must pause before the search term reaches the query — long
 * enough that a burst of keystrokes fires one request, short enough to feel
 * live. */
const SEARCH_DEBOUNCE_MS = 250;

type FormState =
  | { mode: "create" }
  | { mode: "edit"; transaction: TransactionOut }
  | { mode: "transfer-create" }
  | { mode: "transfer-edit"; transfer: TransferOut };

const FORM_TITLES: Record<FormState["mode"], string> = {
  create: "New transaction",
  edit: "Edit transaction",
  "transfer-create": "New transfer",
  "transfer-edit": "Edit transfer",
};

/**
 * `/transactions` — every transaction across the workspace, with an account
 * filter and full create/edit/delete. Includes archived accounts in its own
 * account list (`useAccounts(true)`) so a transaction on an already-archived
 * account still resolves a name instead of "Unknown account" — deleting an
 * account isn't possible in V1 (only archive), so every `account_id` a
 * transaction can carry is still resolvable here.
 *
 * Delete is soft (`DELETE /transactions/{id}` → 204): the row disappears
 * from the list (the next `GET /transactions` excludes it server-side) and
 * a toast offers "Undo", which calls `POST /transactions/{id}/restore`.
 */
function TransactionsScreen() {
  const { showToast } = useToast();
  const accountsQuery = useAccounts(true);
  // Archived categories included: an already-categorized transaction should
  // still resolve its badge even if that category was later archived — same
  // rationale as `accountsQuery` above.
  const categoriesQuery = useCategories(true);
  // The whole search/filter set lives here — the one source of truth threaded
  // into the list's query key and querystring. `q` is debounced before it
  // reaches the query (below) so typing doesn't fire a request per keystroke;
  // every other filter takes effect immediately.
  const [filters, setFilters] = useState<TransactionFilters>({});
  const [formState, setFormState] = useState<FormState | null>(null);
  // The transaction whose "Apply to loan" loan picker is currently open (one at
  // a time). Cleared on a successful apply or when toggled off.
  const [applyingTransaction, setApplyingTransaction] = useState<TransactionOut | null>(null);
  // Mirrors `DataList`'s own `useInfiniteQuery` result (Track P) — the rows
  // currently on screen for the active filter, plus whether more exist
  // beyond them. Populated via `DataList`'s `onItemsChange`, never a second
  // fetch: this is exactly what the list below is already showing.
  const [loadedPage, setLoadedPage] = useState<{ items: TransactionOut[]; hasNextPage: boolean }>({
    items: [],
    hasNextPage: false,
  });
  const deleteTransaction = useDeleteTransaction();
  const restoreTransaction = useRestoreTransaction();
  const applyToLoan = useApplyTransactionToLoan();

  const accounts = accountsQuery.data?.items ?? [];
  const accountName = (accountId: string): string =>
    accounts.find((a) => a.id === accountId)?.name ?? "Unknown account";

  const categories = categoriesQuery.data?.items ?? [];
  const categoryFor = (categoryId: string | null) =>
    categories.find((category) => category.id === categoryId) ?? null;

  // Archived contacts included — same rationale as `categoriesQuery`: a
  // transaction should still resolve its contact's name even if that contact was
  // later archived.
  const contactsQuery = useContacts(true);
  const contacts = contactsQuery.data?.items ?? [];
  const contactFor = (contactId: string | null) =>
    contacts.find((contact) => contact.id === contactId) ?? null;

  // Resolve a transaction's linked project to its name for the row's metadata
  // line — the read-side mirror of the `ProjectPicker` in the form.
  const projectsQuery = useProjectList();
  const projects = projectsQuery.data?.items ?? [];
  const projectNameFor = (projectId: string | null): string | null =>
    projects.find((project) => project.id === projectId)?.name ?? null;

  // Transfers power leg labeling: a transaction with `transfer_id` set is one
  // of a transfer's two legs, and its row is rendered as "Transfer to/from
  // {counterpart}" (resolved through this id→transfer map) with its edit
  // routed to the transfer editor — never the normal transaction edit/delete,
  // which the API refuses on a leg (409 MANAGED_BY_TRANSFER).
  const transfersQuery = useTransfers();
  const transfers = transfersQuery.data?.items ?? [];
  const transferFor = (transferId: string | null): TransferOut | null =>
    transfers.find((transfer) => transfer.id === transferId) ?? null;

  // Only the debounced `q` reaches the query; the rest of `filters` passes
  // through untouched. `queryFilters` is what both the cache key and the
  // request are built from, so each distinct filter combo is its own cache
  // entry (`transactionsQueryKey`) fetched with the matching params.
  const debouncedQ = useDebouncedValue(filters.q ?? "", SEARCH_DEBOUNCE_MS);
  const queryFilters: TransactionFilters = { ...filters, q: debouncedQ };
  const filtersActive = hasActiveFilters(queryFilters);

  function fetchPage(cursor: string | null) {
    return apiFetch<TransactionPage>(
      `/transactions?${transactionsQueryString(queryFilters, cursor, PAGE_LIMIT)}`,
    );
  }

  // In / out / net over exactly `loadedPage.items` — the rows currently on
  // screen for the active filter, never a second fetch. Transactions is the
  // one keyset-paginated screen (CONVENTIONS §6), so more rows can exist
  // beyond what's loaded; `note` says so honestly rather than implying these
  // are the filter's full totals.
  const signedStat = (label: string, items: TransactionOut[]): SummaryStat => ({
    label,
    entries: sumByCurrency(
      items,
      (transaction) => transaction.amount_minor,
      (transaction) => transaction.currency,
    ).map(({ currency, total_minor }) => ({
      currency,
      value_minor: total_minor,
      tone: total_minor > 0 ? "pos" : total_minor < 0 ? "neg" : undefined,
    })),
  });
  const inOutNetStats: SummaryStat[] = [
    signedStat("In", loadedPage.items.filter((transaction) => transaction.amount_minor > 0)),
    signedStat("Out", loadedPage.items.filter((transaction) => transaction.amount_minor < 0)),
    signedStat("Net", loadedPage.items),
  ];

  async function handleDelete(transaction: TransactionOut) {
    try {
      await deleteTransaction.mutateAsync(transaction.id);
      showToast("Transaction deleted.", {
        action: {
          label: "Undo",
          onClick: () => restoreTransaction.mutate(transaction.id),
        },
      });
    } catch {
      showToast("Couldn't delete that transaction. Please try again.", { variant: "negative" });
    }
  }

  async function handleApplyToLoan(transaction: TransactionOut, loan: LoanOut) {
    try {
      await applyToLoan.mutateAsync({ transactionId: transaction.id, loanId: loan.id });
      setApplyingTransaction(null);
      showToast(`Applied to ${loan.name}.`, { variant: "positive" });
    } catch (error) {
      // We don't cross-reference every loan's payments to pre-detect linkage;
      // the backend guards it (a transaction funds at most one loan payment)
      // and a 409 becomes this friendly message.
      if (error instanceof ApiError && error.detail === "TRANSACTION_ALREADY_LINKED") {
        showToast("This transaction is already linked to a loan.", { variant: "negative" });
      } else {
        showToast("Couldn't apply this transaction to a loan. Please try again.", {
          variant: "negative",
        });
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl text-ink">Transactions</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="quiet"
            onClick={() => setFormState({ mode: "transfer-create" })}
            disabled={accounts.length < 2}
          >
            New transfer
          </Button>
          <Button onClick={() => setFormState({ mode: "create" })} disabled={accounts.length === 0}>
            New transaction
          </Button>
        </div>
      </div>

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">{FORM_TITLES[formState.mode]}</h2>
          <div className="mt-4">
            {formState.mode === "transfer-create" || formState.mode === "transfer-edit" ? (
              <TransferForm
                accounts={accounts}
                transfer={formState.mode === "transfer-edit" ? formState.transfer : undefined}
                defaultFromAccountId={filters.accountId || undefined}
                onCancel={() => setFormState(null)}
                onDeleted={() => {
                  setFormState(null);
                  showToast("Transfer deleted.", { variant: "positive" });
                }}
                onSuccess={() => {
                  const wasEdit = formState.mode === "transfer-edit";
                  setFormState(null);
                  showToast(wasEdit ? "Transfer updated." : "Transfer added.", {
                    variant: "positive",
                  });
                }}
              />
            ) : (
              <TransactionForm
                accounts={accounts}
                transaction={formState.mode === "edit" ? formState.transaction : undefined}
                defaultAccountId={filters.accountId || undefined}
                onCancel={() => setFormState(null)}
                onSuccess={() => {
                  const wasEdit = formState.mode === "edit";
                  setFormState(null);
                  showToast(wasEdit ? "Transaction updated." : "Transaction added.", {
                    variant: "positive",
                  });
                }}
              />
            )}
          </div>
        </Card>
      ) : null}

      <TransactionFiltersBar
        filters={filters}
        onChange={setFilters}
        accounts={accounts}
        categories={categories}
        contacts={contacts}
      />

      {loadedPage.items.length > 0 ? (
        <SummaryHeader
          stats={inOutNetStats}
          note={loadedPage.hasNextPage ? "loaded rows" : undefined}
        />
      ) : null}

      <DataList<TransactionOut>
        queryKey={transactionsQueryKey(queryFilters)}
        fetchPage={fetchPage}
        onItemsChange={(items, hasNextPage) => setLoadedPage({ items, hasNextPage })}
        empty={
          filtersActive ? (
            // Distinct from the first-run state below: here there ARE
            // transactions, just none matching the active filters — so guide
            // toward loosening them, not toward adding a first transaction.
            <EmptyState
              title="No transactions match these filters"
              body="Try widening or clearing your search and filters."
              action={<Button onClick={() => setFilters({})}>Clear all filters</Button>}
            />
          ) : (
            <EmptyState
              title="No transactions yet"
              body="Add your first transaction to start tracking activity."
              action={
                accounts.length > 0 ? (
                  <Button onClick={() => setFormState({ mode: "create" })}>Add a transaction</Button>
                ) : undefined
              }
            />
          )
        }
        renderRow={(transaction) => {
          const transfer = transaction.transfer_id
            ? transferFor(transaction.transfer_id)
            : null;
          const isLeg = transaction.transfer_id !== null;
          const isApplying = applyingTransaction?.id === transaction.id;
          return (
            <div className="flex flex-col gap-3 py-3">
            {/* Stacks on mobile (metadata, then amount+actions on their own
                full-width line) so the action cluster never has to squeeze
                into whatever sliver of width is left beside the
                description; reverts to the original single-line layout at
                `sm:` and up. */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{transaction.description}</p>
                <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
                  {accountName(transaction.account_id)} · <DateText iso={transaction.occurred_on} />
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {isLeg ? (
                    // A leg carries no category/contact/project — it's labeled by
                    // its transfer's counterpart account instead.
                    <TransferBadge
                      amountMinor={transaction.amount_minor}
                      transfer={transfer}
                      accountName={accountName}
                    />
                  ) : (
                    <>
                      <CategoryBadge category={categoryFor(transaction.category_id)} />
                      <ContactBadge contact={contactFor(transaction.contact_id)} />
                      {projectNameFor(transaction.project_id) ? (
                        <span className="inline-flex items-center gap-1 font-mono text-xs text-ink-2">
                          <span className="text-ink-faint">Project:</span>
                          {projectNameFor(transaction.project_id)}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
              {/* `w-full`+`justify-between` keeps the amount pinned left and
                  the action cluster free to wrap to its right (or its own
                  line) on mobile; `sm:w-auto sm:justify-end sm:flex-nowrap`
                  restores the original fixed, non-wrapping desktop row. */}
              <div className="flex w-full flex-wrap items-center justify-between gap-3 sm:w-auto sm:flex-nowrap sm:justify-end sm:gap-4">
                <MoneyText minor={transaction.amount_minor} currency={transaction.currency} colorBySign />
                <div className="flex flex-wrap items-center gap-2">
                  {isLeg ? (
                    // Edit routes to the transfer editor (delete lives inside it);
                    // the normal transaction edit/delete would 409 on a leg. The
                    // button waits for the transfer to resolve so it can prefill.
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={transfer === null}
                      onClick={() => transfer && setFormState({ mode: "transfer-edit", transfer })}
                    >
                      Edit
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setApplyingTransaction((current) =>
                            current?.id === transaction.id ? null : transaction,
                          )
                        }
                      >
                        {isApplying ? "Cancel" : "Apply to loan"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setFormState({ mode: "edit", transaction })}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={deleteTransaction.isPending}
                        onClick={() => void handleDelete(transaction)}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {isApplying ? (
              <LoanPicker onSelect={(loan) => void handleApplyToLoan(transaction, loan)} />
            ) : null}
            </div>
          );
        }}
      />
    </div>
  );
}

export default TransactionsScreen;
