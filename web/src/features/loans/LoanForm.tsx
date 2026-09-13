import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { ApiError } from "../../lib/api";
import { amountToMinor, minorToAmountInput } from "../../lib/amount";
import { cn } from "../../lib/cn";
import ContactPicker from "../contacts/ContactPicker";
import { CURRENCY_CODES } from "../setup/CurrencySelect";
import { bpsToPctInput, pctToBps } from "./interest";
import { useCreateLoan, useUpdateLoan } from "./useLoans";
import type { LoanDirection, LoanOut, PaymentFrequency } from "./useLoans";

const CURRENCY_OPTIONS: SelectOption[] = CURRENCY_CODES.map((code) => ({ value: code, label: code }));

const DIRECTION_OPTIONS: { value: LoanDirection; label: string }[] = [
  { value: "borrowed", label: "Borrowed" },
  { value: "lent", label: "Lent" },
];

/** `""` is the "no set schedule" choice — `payment_frequency` is nullable, so
 * a loan need not have a recurring cadence. */
const FREQUENCY_OPTIONS: SelectOption[] = [
  { value: "", label: "No set schedule" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

export interface LoanFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  loan?: LoanOut;
  /** Create mode's currency default (the workspace base currency). Ignored in
   * edit mode (the loan's own currency wins). */
  defaultCurrency?: string;
  onSuccess: (loan: LoanOut) => void;
  onCancel?: () => void;
}

/** Error → copy map (CONVENTIONS §9.6): `LOAN_NOT_FOUND` can only come from a
 * stale edit form left open after the loan was deleted elsewhere; anything
 * else falls back to a generic message. */
function loanErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.detail === "LOAN_NOT_FOUND") {
    return "Couldn't find that loan. It may have been removed.";
  }
  return "Couldn't save this loan. Please try again.";
}

/**
 * Create/edit form for one loan: name, a Borrowed/Lent direction toggle,
 * currency + principal (`amountToMinor`, unsigned — a principal is a plain
 * positive figure), an optional interest rate typed as a percent (converted
 * to/from `interest_rate_bps` via `interest.ts`, DISPLAY only), an optional
 * planned payment + frequency + next-due date, an opened-on date, a
 * description, and an optional counterparty contact (`ContactPicker` →
 * `contact_id`). Used both as `LoansScreen`'s "New loan"/"Edit" panel and
 * `LoanDetail`'s inline edit panel.
 */
function LoanForm({ loan, defaultCurrency, onSuccess, onCancel }: LoanFormProps) {
  const isEdit = loan !== undefined;

  const [name, setName] = useState(loan?.name ?? "");
  const [direction, setDirection] = useState<LoanDirection>(loan?.direction ?? "borrowed");
  const [currency, setCurrency] = useState(
    loan?.currency ??
      (defaultCurrency && CURRENCY_CODES.includes(defaultCurrency) ? defaultCurrency : CURRENCY_CODES[0]),
  );
  const [principal, setPrincipal] = useState(
    loan ? minorToAmountInput(loan.principal_minor, loan.currency) : "",
  );
  const [interestPct, setInterestPct] = useState(bpsToPctInput(loan?.interest_rate_bps ?? null));
  const [plannedPayment, setPlannedPayment] = useState(
    loan?.planned_payment_minor != null
      ? minorToAmountInput(loan.planned_payment_minor, loan.currency)
      : "",
  );
  const [frequency, setFrequency] = useState<string>(loan?.payment_frequency ?? "");
  const [nextDue, setNextDue] = useState(loan?.next_due ?? "");
  const [openedOn, setOpenedOn] = useState(loan?.opened_on ?? "");
  const [description, setDescription] = useState(loan?.description ?? "");
  // `""` is `ContactPicker`'s "no contact" sentinel (a real id is a UUID).
  const [contactId, setContactId] = useState(loan?.contact_id ?? "");

  const [principalError, setPrincipalError] = useState<string | null>(null);
  const [plannedError, setPlannedError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createLoan = useCreateLoan();
  const updateLoan = useUpdateLoan(loan?.id ?? "");
  const isSubmitting = createLoan.isPending || updateLoan.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setError(null);
    setPrincipalError(null);
    setPlannedError(null);

    const principalMinor = amountToMinor(principal, currency);
    if (principalMinor === null) {
      setPrincipalError("Enter a valid amount.");
      return;
    }

    let plannedPaymentMinor: number | null = null;
    if (plannedPayment.trim() !== "") {
      const parsed = amountToMinor(plannedPayment, currency);
      if (parsed === null) {
        setPlannedError("Enter a valid amount.");
        return;
      }
      plannedPaymentMinor = parsed;
    }

    const interestBps = pctToBps(interestPct);
    const freq = (frequency || null) as PaymentFrequency | null;

    try {
      if (isEdit) {
        // Edit sends every optional field explicitly (value or null) so
        // clearing one in the UI actually clears it server-side (the backend
        // treats a present null as "clear", an absent key as "unchanged").
        const updated = await updateLoan.mutateAsync({
          name: trimmedName,
          direction,
          currency,
          principal_minor: principalMinor,
          interest_rate_bps: interestBps,
          planned_payment_minor: plannedPaymentMinor,
          payment_frequency: freq,
          next_due: nextDue || null,
          opened_on: openedOn || null,
          description: description.trim() || null,
          contact_id: contactId || null,
        });
        onSuccess(updated);
        return;
      }
      // Create omits unset optionals for a clean POST payload.
      const created = await createLoan.mutateAsync({
        name: trimmedName,
        direction,
        currency,
        principal_minor: principalMinor,
        ...(interestBps !== null ? { interest_rate_bps: interestBps } : {}),
        ...(plannedPaymentMinor !== null ? { planned_payment_minor: plannedPaymentMinor } : {}),
        ...(freq !== null ? { payment_frequency: freq } : {}),
        ...(nextDue ? { next_due: nextDue } : {}),
        ...(openedOn ? { opened_on: openedOn } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(contactId ? { contact_id: contactId } : {}),
      });
      onSuccess(created);
    } catch (err) {
      setError(loanErrorMessage(err));
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Name"
        placeholder="e.g. Car loan"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="loan-form-direction">Direction</FieldLabel>
        <div
          id="loan-form-direction"
          role="group"
          aria-label="Direction"
          className="inline-flex w-fit rounded-pc border border-hairline p-0.5"
        >
          {DIRECTION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={direction === option.value}
              onClick={() => setDirection(option.value)}
              className={cn(
                "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
                direction === option.value ? "bg-accent-soft text-ink" : "text-ink-2 hover:text-ink",
                focusRingClass,
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* The counterparty — who you borrowed from / lent to. Optional; the
          picker's clear row ("No contact") maps back to a null contact_id. */}
      <ContactPicker label="Contact" value={contactId} onChange={(id) => setContactId(id)} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Currency"
          options={CURRENCY_OPTIONS}
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        />
        <TextField
          label="Principal"
          placeholder="0.00"
          inputMode="decimal"
          value={principal}
          onChange={(event) => setPrincipal(event.target.value)}
          error={principalError ?? undefined}
          required
        />
      </div>

      <TextField
        label="Interest rate"
        description="Optional — annual rate as a percent, for reference only."
        placeholder="e.g. 4.25"
        inputMode="decimal"
        value={interestPct}
        onChange={(event) => setInterestPct(event.target.value)}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Planned payment"
          description="Optional."
          placeholder="0.00"
          inputMode="decimal"
          value={plannedPayment}
          onChange={(event) => setPlannedPayment(event.target.value)}
          error={plannedError ?? undefined}
        />
        <Select
          label="Frequency"
          options={FREQUENCY_OPTIONS}
          value={frequency}
          onChange={(event) => setFrequency(event.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Next due"
          description="Optional."
          type="date"
          value={nextDue}
          onChange={(event) => setNextDue(event.target.value)}
        />
        <TextField
          label="Opened on"
          description="Optional."
          type="date"
          value={openedOn}
          onChange={(event) => setOpenedOn(event.target.value)}
        />
      </div>

      <TextField
        label="Description"
        description="Optional — a note about this loan."
        placeholder="e.g. 5-year auto loan"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!name.trim() || !principal.trim()}>
          {isEdit ? "Save changes" : "Create loan"}
        </Button>
      </div>
    </form>
  );
}

export default LoanForm;
