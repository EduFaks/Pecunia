import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import DataList from "../../components/data/DataList";
import EmptyState from "../../components/data/EmptyState";
import Avatar from "../../components/ui/Avatar";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import Pill from "../../components/ui/Pill";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import type { DonutDatum } from "../../components/charts/chartMath";
import { apiFetch } from "../../lib/api";
import { DateText, MoneyText, usePreferences } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import { CategoryChart } from "../analytics/CategoryChart";
import { GraphCard } from "../analytics/GraphCard";
import { PeriodSelector } from "../analytics/PeriodSelector";
import { DEFAULT_PERIOD_MONTHS, computePeriodRange } from "../analytics/period";
import CategoryBadge from "../categories/CategoryBadge";
import { useCategories } from "../categories/useCategories";
import type { TransactionOut } from "../transactions/useTransactions";
import ContactForm from "./ContactForm";
import { useArchiveContact, useContact, useContactOverview } from "./useContacts";
import type { ContactOut, ContactOverviewCurrency } from "./useContacts";

interface TransactionPage {
  items: TransactionOut[];
  next_cursor: string | null;
}

/** One walked page's size for this contact's transactions `DataList`. */
const PAGE_LIMIT = 20;

const TYPE_LABEL: Record<ContactOut["type"], string> = {
  person: "Person",
  company: "Company",
};

/**
 * `/contacts/:id` — one contact's overview: a header (`Avatar`, name, person/
 * company, its default category, Edit + Archive), then a period-scoped read of
 * the money moving with this contact — money in / out / net and a transaction
 * count, a by-category breakdown, and a keyset-paginated list of this contact's
 * recent transactions.
 *
 * The shared Insights period selector (3 / 6 / 12 months) drives the
 * `{ from, to }` window `useContactOverview` reads (the range rides in the
 * query key, so switching refetches). Figures are per-currency and never summed
 * across currencies (§4): the base currency is shown when it has activity, else
 * the first currency that does. `ContactDetail` is read-plus-edit — editing a
 * transaction is `TransactionsScreen`'s job.
 */
function ContactDetail() {
  const { id } = useParams<{ id: string }>();
  const { showToast } = useToast();
  const preferences = usePreferences();
  const baseCurrency = preferences.base_currency;
  const locale = preferences.locale;

  // "Today" is fixed for the life of the screen so the window is stable across
  // re-renders; only changing the month count recomputes the range (matching
  // InsightsScreen).
  const [today] = useState(() => new Date());
  const [months, setMonths] = useState(DEFAULT_PERIOD_MONTHS);
  const range = useMemo(() => computePeriodRange(months, today), [months, today]);

  const [isEditing, setIsEditing] = useState(false);

  const contactQuery = useContact(id);
  const overviewQuery = useContactOverview(id, range);
  const archiveContact = useArchiveContact();

  // Archived categories included so a contact whose default category (or a
  // transaction's category) was later archived still resolves its badge — same
  // rationale as the other finance screens.
  const categoriesQuery = useCategories(true);
  const categories = categoriesQuery.data?.items ?? [];
  const categoryFor = (categoryId: string | null) =>
    categories.find((category) => category.id === categoryId) ?? null;

  function fetchPage(cursor: string | null) {
    const params = new URLSearchParams({ contact_id: id ?? "", limit: String(PAGE_LIMIT) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return apiFetch<TransactionPage>(`/transactions?${params.toString()}`);
  }

  async function handleArchive(contact: ContactOut) {
    try {
      await archiveContact.mutateAsync(contact.id);
      showToast(`"${contact.name}" archived.`);
    } catch {
      showToast("Couldn't archive that contact. Please try again.", { variant: "negative" });
    }
  }

  if (contactQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading contact" />
      </div>
    );
  }

  if (contactQuery.isError || !contactQuery.data) {
    return <Callout variant="negative">Couldn't load this contact.</Callout>;
  }

  const contact = contactQuery.data;
  const defaultCategory = categoryFor(contact.default_category_id);

  // Per-currency figures are never summed (§4): prefer the base currency when it
  // has activity with this contact, else the first currency that does.
  const overview = overviewQuery.data ?? {};
  const currencies = Object.keys(overview);
  const activeCurrency = currencies.includes(baseCurrency) ? baseCurrency : currencies[0];
  const figures: ContactOverviewCurrency | undefined = activeCurrency
    ? overview[activeCurrency]
    : undefined;

  // Positive-only spend wedges for the donut (mirrors the dashboard/Insights
  // geometry — a zero-spend category has no slice).
  const spendData: DonutDatum[] = (figures?.by_category ?? [])
    .filter((row) => row.out_minor > 0)
    .map((row) => ({
      key: row.category_id ?? "uncategorized",
      label: row.name,
      valueMinor: row.out_minor,
      color: row.color,
    }));
  const receivedRows = (figures?.by_category ?? []).filter((row) => row.in_minor > 0);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar src={contact.avatar} name={contact.name} type={contact.type} size="lg" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="truncate font-display text-2xl text-ink">{contact.name}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <Pill>{TYPE_LABEL[contact.type]}</Pill>
              {defaultCategory ? <CategoryBadge category={defaultCategory} /> : null}
              {contact.archived_at ? <Pill>Archived</Pill> : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setIsEditing((v) => !v)}>
            Edit
          </Button>
          {!contact.archived_at ? (
            <Button
              variant="ghost"
              size="sm"
              loading={archiveContact.isPending}
              onClick={() => void handleArchive(contact)}
            >
              Archive
            </Button>
          ) : null}
        </div>
      </div>

      {isEditing ? (
        <Card>
          <h2 className="font-display text-lg text-ink">Edit contact</h2>
          <div className="mt-4">
            <ContactForm
              contact={contact}
              onCancel={() => setIsEditing(false)}
              onSuccess={() => {
                setIsEditing(false);
                showToast("Contact updated.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      <div className="flex items-center justify-between gap-4">
        <h2 className="font-display text-lg text-ink">Overview</h2>
        <PeriodSelector months={months} onChange={setMonths} />
      </div>

      {overviewQuery.isError ? (
        <Callout variant="negative">Couldn't load this contact's overview.</Callout>
      ) : !figures ? (
        <EmptyState
          title="No activity with this contact yet"
          body="Once a transaction in this period names this contact, its money in, out, and net will show here."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Money in">
              <MoneyText minor={figures.money_in_minor} currency={activeCurrency!} className="text-lg text-positive" />
            </Stat>
            <Stat label="Money out">
              <MoneyText minor={figures.money_out_minor} currency={activeCurrency!} className="text-lg text-negative" />
            </Stat>
            <Stat label="Net">
              <MoneyText minor={figures.net_minor} currency={activeCurrency!} colorBySign className="text-lg" />
            </Stat>
            <Stat label="Transactions">
              <span className="font-mono text-lg tabular-figures text-ink">{figures.transaction_count}</span>
            </Stat>
          </div>

          {currencies.length > 1 ? (
            <p className="text-xs text-ink-faint">
              Showing {activeCurrency} — this contact also has activity in{" "}
              {currencies.filter((c) => c !== activeCurrency).join(", ")}.
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <GraphCard title="Spending by category">
              {spendData.length === 0 ? (
                <p className="py-10 text-center text-sm text-ink-2">No spending in this period.</p>
              ) : (
                <CategoryChart data={spendData} currency={activeCurrency!} locale={locale} />
              )}
            </GraphCard>

            {receivedRows.length > 0 ? (
              <GraphCard title="Received by category">
                <ul aria-label="Received by category" className="flex flex-col gap-2 text-sm">
                  {receivedRows.map((row) => (
                    <li key={row.category_id ?? "uncategorized"} className="flex items-center justify-between gap-3">
                      <span className="inline-flex min-w-0 items-center gap-2 text-ink-2">
                        <span
                          aria-hidden="true"
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: row.color ?? "var(--pc-text-faint)" }}
                        />
                        <span className="truncate">{row.name}</span>
                      </span>
                      <MoneyText minor={row.in_minor} currency={activeCurrency!} className="text-positive" />
                    </li>
                  ))}
                </ul>
              </GraphCard>
            ) : null}
          </div>
        </>
      )}

      <div>
        <h2 className="font-display text-lg text-ink">Recent transactions</h2>
        <DataList<TransactionOut>
          className="mt-4"
          queryKey={[...qk.transactions(), { contactId: id }]}
          fetchPage={fetchPage}
          empty={
            <EmptyState
              title="No transactions with this contact yet"
              body="Transactions that name this contact will appear here."
            />
          }
          renderRow={(transaction) => (
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{transaction.description}</p>
                <DateText iso={transaction.occurred_on} className="text-xs text-ink-faint" />
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <CategoryBadge category={categoryFor(transaction.category_id)} />
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

/** A single labeled figure in the overview stat row — a muted caption over the
 * value, both in one container so a caller (and its test) can scope to it. */
function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-4">
      <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export default ContactDetail;
