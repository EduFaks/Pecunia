import { useEffect, useState } from "react";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import Button from "../../components/ui/Button";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { amountToMinor, minorToAmountInput } from "../../lib/amount";
import { cn } from "../../lib/cn";
import type { AccountOut } from "../accounts/useAccounts";
import CategoryPicker from "../categories/CategoryPicker";
import type { CategoryOut } from "../categories/useCategories";
import ContactPicker from "../contacts/ContactPicker";
import type { ContactOut } from "../contacts/useContacts";
import { cleanFilters } from "./useTransactions";
import type { TransactionFilters, TransactionType } from "./useTransactions";

export interface TransactionFiltersProps {
  /** The committed filter set — the single source of truth `TransactionsScreen`
   * owns and threads into the list query. Controls read from it and every
   * change flows back through `onChange`. */
  filters: TransactionFilters;
  onChange: (next: TransactionFilters) => void;
  /** Archived-inclusive lists, passed down so chip labels resolve a name even
   * for an account/category/contact that was later archived — the same
   * rationale the screen's own row rendering uses. */
  accounts: AccountOut[];
  categories: CategoryOut[];
  contacts: ContactOut[];
}

/** The `type` segmented control's choices; `undefined` is the "All" (no
 * `type` filter) end, matching `TransactionType | undefined`. */
const TYPE_OPTIONS: { value: TransactionType | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
  { value: "transfer", label: "Transfer" },
];

const TYPE_LABELS: Record<TransactionType, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
};

interface Chip {
  id: string;
  label: string;
  /** Names the *kind* of filter for assistive tech (the visible text carries
   * the value) so each remove control has a distinct accessible name. */
  ariaLabel: string;
  onRemove: () => void;
}

/**
 * The search + filter bar above the transactions list: a debounced-upstream
 * search box (the screen debounces `q` before it reaches the query — this
 * component just owns the input), an account `Select`, `CategoryPicker`,
 * `ContactPicker`, an income/expense/transfer segmented control, a from/to
 * date range, and a min/max amount range (typed decimals → integer minor
 * units, filtered on magnitude server-side). Below the controls, one chip per
 * active filter with an individual ✕, plus a "Clear all".
 *
 * Purely controlled: it holds no filter state of its own except the raw text
 * of the two amount fields (a decimal like "1." has no integer-minor mirror
 * to round-trip through), which it clears when the amount is dropped
 * externally (a chip ✕ or Clear all). The account/category/contact lists are
 * passed in rather than re-fetched — the screen already holds the
 * archived-inclusive versions needed to label chips.
 *
 * Responsive: the search box caps its width, the type toggle sits on its own
 * line, and the remaining controls flow in an `auto-fill` grid that collapses
 * to a single column on a phone, so the bar wraps instead of scrolling the
 * page sideways. Tokens only.
 */
function TransactionFiltersBar({ filters, onChange, accounts, categories, contacts }: TransactionFiltersProps) {
  // The amount range converts to minor units against this currency's minor-
  // unit digits. A workspace is effectively single-currency in V1; when an
  // account filter is set we honor that account's currency, else the first
  // account's, else USD.
  const currency =
    accounts.find((a) => a.id === filters.accountId)?.currency ?? accounts[0]?.currency ?? "USD";

  const [minText, setMinText] = useState("");
  const [maxText, setMaxText] = useState("");

  // Resync the amount fields' raw text when their value is cleared from
  // outside (a chip ✕ / Clear all). These fire only when the numeric prop
  // actually transitions to `undefined`, so normal typing — which keeps the
  // prop defined — is never disturbed.
  useEffect(() => {
    if (filters.minAmountMinor === undefined) setMinText("");
  }, [filters.minAmountMinor]);
  useEffect(() => {
    if (filters.maxAmountMinor === undefined) setMaxText("");
  }, [filters.maxAmountMinor]);

  const accountOptions: SelectOption[] = [
    { value: "", label: "All accounts" },
    ...accounts.map((a) => ({ value: a.id, label: a.name })),
  ];

  function handleAmountChange(kind: "min" | "max", text: string) {
    if (kind === "min") setMinText(text);
    else setMaxText(text);
    const minor = amountToMinor(text, currency);
    onChange({
      ...filters,
      [kind === "min" ? "minAmountMinor" : "maxAmountMinor"]: minor ?? undefined,
    });
  }

  const active = cleanFilters(filters);
  const nameOf = <T extends { id: string; name: string }>(list: T[], id: string): string =>
    list.find((item) => item.id === id)?.name ?? "Unknown";

  const chips: Chip[] = [];
  if (active.q) {
    chips.push({
      id: "q",
      label: `“${active.q}”`,
      ariaLabel: "Remove search filter",
      onRemove: () => onChange({ ...filters, q: undefined }),
    });
  }
  if (active.accountId) {
    chips.push({
      id: "account",
      label: nameOf(accounts, active.accountId),
      ariaLabel: "Remove account filter",
      onRemove: () => onChange({ ...filters, accountId: undefined }),
    });
  }
  if (active.categoryId) {
    chips.push({
      id: "category",
      label: nameOf(categories, active.categoryId),
      ariaLabel: "Remove category filter",
      onRemove: () => onChange({ ...filters, categoryId: undefined }),
    });
  }
  if (active.contactId) {
    chips.push({
      id: "contact",
      label: nameOf(contacts, active.contactId),
      ariaLabel: "Remove contact filter",
      onRemove: () => onChange({ ...filters, contactId: undefined }),
    });
  }
  if (active.type) {
    chips.push({
      id: "type",
      label: TYPE_LABELS[active.type],
      ariaLabel: "Remove type filter",
      onRemove: () => onChange({ ...filters, type: undefined }),
    });
  }
  if (active.dateFrom || active.dateTo) {
    const label =
      active.dateFrom && active.dateTo
        ? `${active.dateFrom} → ${active.dateTo}`
        : active.dateFrom
          ? `From ${active.dateFrom}`
          : `Until ${active.dateTo}`;
    chips.push({
      id: "date",
      label,
      ariaLabel: "Remove date filter",
      onRemove: () => onChange({ ...filters, dateFrom: undefined, dateTo: undefined }),
    });
  }
  if (active.minAmountMinor !== undefined || active.maxAmountMinor !== undefined) {
    const min = active.minAmountMinor;
    const max = active.maxAmountMinor;
    const label =
      min !== undefined && max !== undefined
        ? `${currency} ${minorToAmountInput(min, currency)} – ${minorToAmountInput(max, currency)}`
        : min !== undefined
          ? `${currency} ≥ ${minorToAmountInput(min, currency)}`
          : `${currency} ≤ ${minorToAmountInput(max as number, currency)}`;
    chips.push({
      id: "amount",
      label,
      ariaLabel: "Remove amount filter",
      onRemove: () => onChange({ ...filters, minAmountMinor: undefined, maxAmountMinor: undefined }),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="w-full sm:max-w-md">
        <TextField
          label="Search"
          type="search"
          placeholder="Search descriptions…"
          value={filters.q ?? ""}
          onChange={(event) => onChange({ ...filters, q: event.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="tx-filter-type">Type</FieldLabel>
        <div
          id="tx-filter-type"
          role="group"
          aria-label="Type"
          className="inline-flex w-fit flex-wrap rounded-pc border border-hairline p-0.5"
        >
          {TYPE_OPTIONS.map((option) => {
            const selected = (filters.type ?? undefined) === option.value;
            return (
              <button
                key={option.label}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange({ ...filters, type: option.value })}
                className={cn(
                  "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
                  selected ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                  focusRingClass,
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
        <Select
          label="Account"
          options={accountOptions}
          value={filters.accountId ?? ""}
          onChange={(event) => onChange({ ...filters, accountId: event.target.value || undefined })}
        />
        {/* As a filter, no selection means "don't filter by category" — so the
            empty option reads "All categories" (mirroring the account Select's
            "All accounts"), not the form's "Uncategorized". */}
        <CategoryPicker
          emptyLabel="All categories"
          value={filters.categoryId ?? ""}
          onChange={(id) => onChange({ ...filters, categoryId: id || undefined })}
        />
        <ContactPicker
          value={filters.contactId ?? ""}
          onChange={(id) => onChange({ ...filters, contactId: id || undefined })}
        />
        <TextField
          label="From"
          type="date"
          value={filters.dateFrom ?? ""}
          onChange={(event) => onChange({ ...filters, dateFrom: event.target.value || undefined })}
        />
        <TextField
          label="To"
          type="date"
          value={filters.dateTo ?? ""}
          onChange={(event) => onChange({ ...filters, dateTo: event.target.value || undefined })}
        />
        <TextField
          label="Min amount"
          inputMode="decimal"
          placeholder="0.00"
          value={minText}
          onChange={(event) => handleAmountChange("min", event.target.value)}
        />
        <TextField
          label="Max amount"
          inputMode="decimal"
          placeholder="0.00"
          value={maxText}
          onChange={(event) => handleAmountChange("max", event.target.value)}
        />
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex items-center gap-1.5 rounded-pc border border-hairline bg-surface-2 py-1 pl-2.5 pr-1 text-xs text-ink-2"
            >
              {chip.label}
              <button
                type="button"
                aria-label={chip.ariaLabel}
                onClick={chip.onRemove}
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded-full text-ink-faint transition-colors duration-150 ease-pc hover:text-ink",
                  focusRingClass,
                )}
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          ))}
          <Button variant="ghost" size="sm" onClick={() => onChange({})}>
            Clear all
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default TransactionFiltersBar;
