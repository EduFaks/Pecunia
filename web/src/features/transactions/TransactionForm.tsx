import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldError, FieldLabel } from "../../components/ui/Field";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { ApiError } from "../../lib/api";
import { amountToMinor, minorToAmountInput } from "../../lib/amount";
import { cn } from "../../lib/cn";
import type { AccountOut } from "../accounts/useAccounts";
import CategoryPicker from "../categories/CategoryPicker";
import ContactPicker from "../contacts/ContactPicker";
import type { ContactOut } from "../contacts/useContacts";
import ProjectPicker from "../projects/ProjectPicker";
import { useCreateTransaction, useUpdateTransaction } from "./useTransactions";
import type { TransactionOut } from "./useTransactions";

type Direction = "inflow" | "outflow";

export interface TransactionFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  transaction?: TransactionOut;
  /** Every account this workspace has — populates the account `Select`
   * (ignored, along with the account field itself, when `lockedAccountId`
   * is given). */
  accounts: AccountOut[];
  /** When set, the account field is hidden and fixed to this id —
   * `AccountDetail`'s inline "Add transaction" form is always scoped to the
   * account it's shown on, so there's nothing to pick. */
  lockedAccountId?: string;
  /** Preselected account for an unlocked form (`TransactionsScreen`'s
   * "New transaction", opened while a filter is active). Ignored once the
   * user picks a different one. */
  defaultAccountId?: string;
  onSuccess: (transaction: TransactionOut) => void;
  onCancel?: () => void;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Error → copy map (CONVENTIONS §9.6). `CURRENCY_MISMATCH` is surfaced as a
 * field-level error right under the amount (the field whose value it
 * concerns); `ACCOUNT_NOT_FOUND` (deleted/cross-workspace account — the
 * form's own account `Select` shouldn't normally offer one) as a blocking
 * `Callout`; anything else falls back to a generic message. */
function amountFieldError(error: unknown): string | undefined {
  if (error instanceof ApiError && error.detail === "CURRENCY_MISMATCH") {
    return "This amount's currency doesn't match the selected account.";
  }
  return undefined;
}

function calloutError(error: unknown): string | null {
  if (error instanceof ApiError) {
    if (error.detail === "CURRENCY_MISMATCH") {
      return null; // shown inline under the amount field instead
    }
    if (error.detail === "ACCOUNT_NOT_FOUND") {
      return "Couldn't find that account. It may have been removed.";
    }
    if (error.detail === "CATEGORY_NOT_FOUND") {
      return "Couldn't find that category. It may have been removed.";
    }
    if (error.detail === "CONTACT_NOT_FOUND") {
      return "Couldn't find that contact. It may have been removed.";
    }
    if (error.detail === "PROJECT_NOT_FOUND") {
      return "Couldn't find that project. It may have been removed.";
    }
  }
  return "Couldn't save this transaction. Please try again.";
}

/**
 * Create/edit form for one transaction: an account `Select` (or a locked,
 * read-only account label — see `lockedAccountId`), a `CategoryPicker`
 * (optional — "Uncategorized" is a valid choice), an inflow/outflow toggle
 * controlling sign, a currency-aware amount field (`amountToMinor`,
 * `lib/amount.ts` — the account's own currency, never separately chosen, so
 * the UI can't construct a mismatched payload on its own), a `ContactPicker`
 * (optional), description, and an occurred-on date. Shared by
 * `AccountDetail`'s inline "Add transaction" panel and `TransactionsScreen`'s
 * "New transaction"/edit flow.
 *
 * **Default-category fill:** selecting a contact that has a `default_category_id`
 * fills the category field *only when it's still empty* — never overwriting a
 * category the user already chose. This deliberately mirrors the server's
 * create-only apply rule (`api/src/pecunia/services/transactions.py`), so the
 * category a transaction ends up with is the same whether it was set here or
 * straight through the API.
 *
 * A transaction's contact is the first-class contact entity (`contact_id`), chosen
 * through the `ContactPicker`. The legacy free-text `contact` string has been
 * removed from the model and contract entirely.
 */
function TransactionForm({
  transaction,
  accounts,
  lockedAccountId,
  defaultAccountId,
  onSuccess,
  onCancel,
}: TransactionFormProps) {
  const isEdit = transaction !== undefined;

  const [accountId, setAccountId] = useState(
    transaction?.account_id ?? lockedAccountId ?? defaultAccountId ?? accounts[0]?.id ?? "",
  );
  const [direction, setDirection] = useState<Direction>(
    transaction && transaction.amount_minor < 0 ? "outflow" : transaction ? "inflow" : "outflow",
  );
  const account = accounts.find((a) => a.id === accountId);
  const currency = account?.currency ?? "USD";

  const [categoryId, setCategoryId] = useState(transaction?.category_id ?? "");
  const [contactId, setContactId] = useState(transaction?.contact_id ?? "");
  const [projectId, setProjectId] = useState(transaction?.project_id ?? "");
  const [amount, setAmount] = useState(
    transaction ? minorToAmountInput(transaction.amount_minor, transaction.currency) : "",
  );
  const [description, setDescription] = useState(transaction?.description ?? "");
  const [occurredOn, setOccurredOn] = useState(transaction?.occurred_on ?? todayIsoDate());

  /** Selecting a contact fills an *empty* category with the contact's default —
   * the client half of the server's create-only apply rule (see the
   * component docstring). Never overwrites a category already chosen. */
  function handleContactChange(id: string, contact: ContactOut | null) {
    setContactId(id);
    if (contact?.default_category_id && categoryId === "") {
      setCategoryId(contact.default_category_id);
    }
  }

  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction(transaction?.id ?? "");
  const isSubmitting = createTransaction.isPending || updateTransaction.isPending;

  const accountOptions: SelectOption[] = accounts.map((a) => ({
    value: a.id,
    label: `${a.name} (${a.currency})`,
  }));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedDescription = description.trim();
    if (!accountId || !trimmedDescription || !occurredOn) {
      return;
    }
    setError(null);
    setAmountError(null);

    const magnitude = amountToMinor(amount, currency);
    if (magnitude === null) {
      setAmountError("Enter a valid amount.");
      return;
    }
    const amountMinor = direction === "outflow" ? -magnitude : magnitude;

    try {
      if (isEdit) {
        const updated = await updateTransaction.mutateAsync({
          account_id: accountId,
          category_id: categoryId || null,
          contact_id: contactId || null,
          project_id: projectId || null,
          amount_minor: amountMinor,
          currency,
          description: trimmedDescription,
          occurred_on: occurredOn,
        });
        onSuccess(updated);
        return;
      }
      const created = await createTransaction.mutateAsync({
        account_id: accountId,
        category_id: categoryId || null,
        contact_id: contactId || null,
        project_id: projectId || null,
        amount_minor: amountMinor,
        currency,
        description: trimmedDescription,
        occurred_on: occurredOn,
      });
      onSuccess(created);
    } catch (err) {
      const fieldError = amountFieldError(err);
      if (fieldError) {
        setAmountError(fieldError);
      } else {
        setError(calloutError(err));
      }
    }
  }

  const canSubmit = accountId !== "" && description.trim() !== "" && occurredOn !== "";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      {lockedAccountId ? (
        <div>
          <FieldLabel htmlFor="transaction-form-account">Account</FieldLabel>
          <p id="transaction-form-account" className="mt-1.5 text-sm text-ink-2">
            {account?.name ?? "—"} <span className="text-ink-faint">({currency})</span>
          </p>
        </div>
      ) : (
        <Select
          label="Account"
          options={accountOptions}
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        />
      )}

      <CategoryPicker value={categoryId} onChange={setCategoryId} />

      <ContactPicker value={contactId} onChange={handleContactChange} />

      <ProjectPicker value={projectId} onChange={setProjectId} />

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="transaction-form-direction">Direction</FieldLabel>
        <div
          id="transaction-form-direction"
          role="group"
          aria-label="Direction"
          className="inline-flex w-fit rounded-pc border border-hairline p-0.5"
        >
          <button
            type="button"
            aria-pressed={direction === "outflow"}
            onClick={() => setDirection("outflow")}
            className={cn(
              "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
              direction === "outflow" ? "bg-negative/10 text-negative" : "text-ink-2 hover:text-ink",
              focusRingClass,
            )}
          >
            Outflow
          </button>
          <button
            type="button"
            aria-pressed={direction === "inflow"}
            onClick={() => setDirection("inflow")}
            className={cn(
              "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
              direction === "inflow" ? "bg-positive/10 text-positive" : "text-ink-2 hover:text-ink",
              focusRingClass,
            )}
          >
            Inflow
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="transaction-form-amount">Amount</FieldLabel>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
            {currency}
          </span>
          <input
            id="transaction-form-amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? "transaction-form-amount-error" : undefined}
            className={cn(
              textFieldInputClasses,
              amountError ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
              focusRingClass,
            )}
          />
        </div>
        {amountError ? <FieldError id="transaction-form-amount-error">{amountError}</FieldError> : null}
      </div>

      <TextField
        label="Description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        required
      />
      <TextField
        label="Date"
        type="date"
        value={occurredOn}
        onChange={(event) => setOccurredOn(event.target.value)}
        required
      />

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!canSubmit}>
          {isEdit ? "Save changes" : "Add transaction"}
        </Button>
      </div>
    </form>
  );
}

export default TransactionForm;
