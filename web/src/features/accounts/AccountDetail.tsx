import { useParams } from "react-router-dom";
import DataList from "../../components/data/DataList";
import EmptyState from "../../components/data/EmptyState";
import Callout from "../../components/ui/Callout";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { apiFetch } from "../../lib/api";
import { DateText, MoneyText } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import CategoryBadge from "../categories/CategoryBadge";
import { useCategories } from "../categories/useCategories";
import ContactBadge from "../contacts/ContactBadge";
import { useContacts } from "../contacts/useContacts";
import TransactionForm from "../transactions/TransactionForm";
import type { TransactionOut } from "../transactions/useTransactions";
import TransferBadge from "../transfers/TransferBadge";
import { useTransfers } from "../transfers/useTransfers";
import { ACCOUNT_TYPE_LABELS } from "./accountTypes";
import { useAccount, useAccounts } from "./useAccounts";

interface TransactionPage {
  items: TransactionOut[];
  next_cursor: string | null;
}

/** One walked page's size for this account's transactions `DataList`. */
const PAGE_LIMIT = 20;

/**
 * `/accounts/:id` — one account's detail: header (name, type, live
 * `MoneyText` balance — `useAccount` refetches whenever any transaction
 * mutation invalidates `qk.accounts`, per the balance-reactivity contract),
 * an inline "Add transaction" form locked to this account, and a
 * keyset-paginated `DataList` of its transactions. Editing/deleting a
 * transaction is `TransactionsScreen`'s job (it lists every account's
 * transactions, including this one) — this screen stays read-plus-add.
 */
function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const { showToast } = useToast();
  const accountQuery = useAccount(id);
  // Archived categories included — same rationale as `TransactionsScreen`'s
  // `useCategories(true)`.
  const categoriesQuery = useCategories(true);
  const categories = categoriesQuery.data?.items ?? [];
  const categoryFor = (categoryId: string | null) =>
    categories.find((category) => category.id === categoryId) ?? null;

  // Archived contacts included — same rationale as `categoriesQuery`.
  const contactsQuery = useContacts(true);
  const contacts = contactsQuery.data?.items ?? [];
  const contactFor = (contactId: string | null) =>
    contacts.find((contact) => contact.id === contactId) ?? null;

  // A transfer leg on this account is labeled by its *counterpart* account, so
  // we need every account (archived included, same rationale) to resolve that
  // name — not just this one — plus the id→transfer map to find the leg's
  // transfer. Editing/deleting a transfer is `TransactionsScreen`'s job (it
  // lists every account's transactions), so here a leg is read-only, labeled.
  const accountsQuery = useAccounts(true);
  const allAccounts = accountsQuery.data?.items ?? [];
  const accountName = (accountId: string): string =>
    allAccounts.find((a) => a.id === accountId)?.name ?? "Unknown account";

  const transfersQuery = useTransfers();
  const transfers = transfersQuery.data?.items ?? [];
  const transferFor = (transferId: string | null) =>
    transfers.find((transfer) => transfer.id === transferId) ?? null;

  function fetchPage(cursor: string | null) {
    const params = new URLSearchParams({ account_id: id ?? "", limit: String(PAGE_LIMIT) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return apiFetch<TransactionPage>(`/transactions?${params.toString()}`);
  }

  if (accountQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading account" />
      </div>
    );
  }

  if (accountQuery.isError || !accountQuery.data) {
    return <Callout variant="negative">Couldn't load this account.</Callout>;
  }

  const account = accountQuery.data;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
          {ACCOUNT_TYPE_LABELS[account.type] ?? account.type}
          {account.archived_at ? " · archived" : ""}
        </p>
        <h1 className="mt-1 font-display text-2xl text-ink">{account.name}</h1>
        <MoneyText
          minor={account.balance_minor}
          currency={account.currency}
          flagNegative
          variant="hero"
          className="mt-2 block text-3xl"
        />
      </div>

      <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
        <h2 className="font-display text-lg text-ink">Add transaction</h2>
        <div className="mt-4">
          <TransactionForm
            accounts={[account]}
            lockedAccountId={account.id}
            onSuccess={() => showToast("Transaction added.", { variant: "positive" })}
          />
        </div>
      </div>

      <div>
        <h2 className="font-display text-lg text-ink">Transactions</h2>
        <DataList<TransactionOut>
          className="mt-4"
          queryKey={qk.transactions(account.id)}
          fetchPage={fetchPage}
          empty={
            <EmptyState
              title="No transactions yet"
              body="Add this account's first transaction above."
            />
          }
          renderRow={(transaction) => (
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{transaction.description}</p>
                <DateText iso={transaction.occurred_on} className="text-xs text-ink-faint" />
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {transaction.transfer_id ? (
                    <TransferBadge
                      amountMinor={transaction.amount_minor}
                      transfer={transferFor(transaction.transfer_id)}
                      accountName={accountName}
                    />
                  ) : (
                    <>
                      <CategoryBadge category={categoryFor(transaction.category_id)} />
                      <ContactBadge contact={contactFor(transaction.contact_id)} />
                    </>
                  )}
                </div>
              </div>
              <MoneyText minor={transaction.amount_minor} currency={transaction.currency} colorBySign />
            </div>
          )}
        />
      </div>
    </div>
  );
}

export default AccountDetail;
