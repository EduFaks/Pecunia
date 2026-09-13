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
import { useCreateSchedule, useUpdateSchedule } from "./usePlanned";
import type { ScheduleFrequency, ScheduledTransactionOut } from "./usePlanned";

/** Income = positive `amount_minor`, expense = negative — the same signed
 * convention as a transaction (`amount_minor < 0` is money out). */
type Direction = "income" | "expense";

const FREQUENCY_OPTIONS: SelectOption[] = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

export interface ScheduleFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields);
   * absence is create mode (POST). */
  schedule?: ScheduledTransactionOut;
  /** Every account this workspace has — populates the account `Select`. */
  accounts: AccountOut[];
  /** Preselected account for a fresh form (ignored once the user picks one). */
  defaultAccountId?: string;
  onSuccess: (schedule: ScheduledTransactionOut) => void;
  onCancel?: () => void;
}

/** Error → copy map (CONVENTIONS §9.6). `SCHEDULE_ZERO_AMOUNT`/
 * `CURRENCY_MISMATCH` concern the amount, so they surface inline under it;
 * the `*_NOT_FOUND` codes surface as a blocking `Callout`; anything else falls
 * back to a generic message. */
function amountFieldError(error: unknown): string | undefined {
  if (error instanceof ApiError) {
    if (error.detail === "SCHEDULE_ZERO_AMOUNT") {
      return "The amount can't be zero.";
    }
    if (error.detail === "CURRENCY_MISMATCH") {
      return "This amount's currency doesn't match the selected account.";
    }
  }
  return undefined;
}

function calloutError(error: unknown): string | null {
  if (error instanceof ApiError) {
    if (error.detail === "SCHEDULE_ZERO_AMOUNT" || error.detail === "CURRENCY_MISMATCH") {
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
  }
  return "Couldn't save this schedule. Please try again.";
}

/**
 * Create/edit form for one recurring schedule — the Planned domain's mirror of
 * `TransactionForm`: an account `Select` (the schedule's currency follows the
 * account, so the UI can't construct a mismatched payload on its own), an
 * income/expense direction toggle controlling the sign of `amount_minor`, a
 * currency-aware amount field (`amountToMinor`, `lib/amount.ts`), a
 * `CategoryPicker`, a `ContactPicker`, a frequency `Select`, a repeat interval,
 * a required `next_due` date, and an optional `end_date`.
 *
 * **Default-category fill** mirrors `TransactionForm` exactly: selecting a
 * contact with a `default_category_id` fills the category *only when it's still
 * empty*, never overwriting a category already chosen.
 */
function ScheduleForm({ schedule, accounts, defaultAccountId, onSuccess, onCancel }: ScheduleFormProps) {
  const isEdit = schedule !== undefined;

  const [accountId, setAccountId] = useState(
    schedule?.account_id ?? defaultAccountId ?? accounts[0]?.id ?? "",
  );
  const [direction, setDirection] = useState<Direction>(
    schedule && schedule.amount_minor < 0 ? "expense" : schedule ? "income" : "expense",
  );
  const account = accounts.find((a) => a.id === accountId);
  const currency = account?.currency ?? "USD";

  const [categoryId, setCategoryId] = useState(schedule?.category_id ?? "");
  const [contactId, setContactId] = useState(schedule?.contact_id ?? "");
  const [amount, setAmount] = useState(
    schedule ? minorToAmountInput(schedule.amount_minor, schedule.currency) : "",
  );
  const [description, setDescription] = useState(schedule?.description ?? "");
  const [frequency, setFrequency] = useState<ScheduleFrequency>(schedule?.frequency ?? "monthly");
  const [interval, setInterval] = useState(String(schedule?.interval_count ?? 1));
  const [nextDue, setNextDue] = useState(schedule?.next_due ?? "");
  const [endDate, setEndDate] = useState(schedule?.end_date ?? "");

  /** Selecting a contact fills an *empty* category with the contact's default —
   * the same create-only apply rule `TransactionForm` follows. */
  function handleContactChange(id: string, contact: ContactOut | null) {
    setContactId(id);
    if (contact?.default_category_id && categoryId === "") {
      setCategoryId(contact.default_category_id);
    }
  }

  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule(schedule?.id ?? "");
  const isSubmitting = createSchedule.isPending || updateSchedule.isPending;

  const accountOptions: SelectOption[] = accounts.map((a) => ({
    value: a.id,
    label: `${a.name} (${a.currency})`,
  }));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedDescription = description.trim();
    if (!accountId || !trimmedDescription || !nextDue) {
      return;
    }
    setError(null);
    setAmountError(null);

    const magnitude = amountToMinor(amount, currency);
    if (magnitude === null) {
      setAmountError("Enter a valid amount.");
      return;
    }
    const amountMinor = direction === "expense" ? -magnitude : magnitude;
    const intervalCount = Math.max(1, Number.parseInt(interval, 10) || 1);

    const payload = {
      account_id: accountId,
      category_id: categoryId || null,
      contact_id: contactId || null,
      amount_minor: amountMinor,
      currency,
      description: trimmedDescription,
      frequency,
      interval_count: intervalCount,
      next_due: nextDue,
      end_date: endDate || null,
    };

    try {
      const saved = isEdit
        ? await updateSchedule.mutateAsync(payload)
        : await createSchedule.mutateAsync(payload);
      onSuccess(saved);
    } catch (err) {
      const fieldError = amountFieldError(err);
      if (fieldError) {
        setAmountError(fieldError);
      } else {
        setError(calloutError(err));
      }
    }
  }

  const canSubmit = accountId !== "" && description.trim() !== "" && nextDue !== "";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <Select
        label="Account"
        options={accountOptions}
        value={accountId}
        onChange={(event) => setAccountId(event.target.value)}
      />

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="schedule-form-direction">Direction</FieldLabel>
        <div
          id="schedule-form-direction"
          role="group"
          aria-label="Direction"
          className="inline-flex w-fit rounded-pc border border-hairline p-0.5"
        >
          <button
            type="button"
            aria-pressed={direction === "expense"}
            onClick={() => setDirection("expense")}
            className={cn(
              "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
              direction === "expense" ? "bg-negative/10 text-negative" : "text-ink-2 hover:text-ink",
              focusRingClass,
            )}
          >
            Expense
          </button>
          <button
            type="button"
            aria-pressed={direction === "income"}
            onClick={() => setDirection("income")}
            className={cn(
              "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
              direction === "income" ? "bg-positive/10 text-positive" : "text-ink-2 hover:text-ink",
              focusRingClass,
            )}
          >
            Income
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="schedule-form-amount">Amount</FieldLabel>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
            {currency}
          </span>
          <input
            id="schedule-form-amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? "schedule-form-amount-error" : undefined}
            className={cn(
              textFieldInputClasses,
              amountError ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
              focusRingClass,
            )}
          />
        </div>
        {amountError ? <FieldError id="schedule-form-amount-error">{amountError}</FieldError> : null}
      </div>

      <TextField
        label="Description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        required
      />

      <CategoryPicker value={categoryId} onChange={setCategoryId} />

      <ContactPicker value={contactId} onChange={handleContactChange} />

      <Select
        label="Frequency"
        options={FREQUENCY_OPTIONS}
        value={frequency}
        onChange={(event) => setFrequency(event.target.value as ScheduleFrequency)}
      />

      <TextField
        label="Repeat every (N periods)"
        type="number"
        min={1}
        step={1}
        value={interval}
        onChange={(event) => setInterval(event.target.value)}
      />

      <TextField
        label="Next due"
        type="date"
        value={nextDue}
        onChange={(event) => setNextDue(event.target.value)}
        required
      />

      <TextField
        label="End date (optional)"
        type="date"
        value={endDate}
        onChange={(event) => setEndDate(event.target.value)}
      />

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!canSubmit}>
          {isEdit ? "Save changes" : "Create schedule"}
        </Button>
      </div>
    </form>
  );
}

export default ScheduleForm;
