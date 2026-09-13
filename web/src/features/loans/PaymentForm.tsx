import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldError, FieldLabel } from "../../components/ui/Field";
import TextField from "../../components/ui/TextField";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { ApiError } from "../../lib/api";
import { amountToMinor } from "../../lib/amount";
import { cn } from "../../lib/cn";
import { DateText, MoneyText } from "../../lib/preferences";
import TransactionPicker from "../transactions/TransactionPicker";
import type { TransactionOut } from "../transactions/useTransactions";
import { useRecordPayment } from "./useLoans";
import type { LoanPaymentOut, RecordPaymentPayload } from "./useLoans";

export interface PaymentFormProps {
  loanId: string;
  /** The parent loan's currency — a payment carries no currency of its own
   * (`LoanPaymentIn` has none), so the amount field always converts against
   * the loan the payment belongs to. */
  currency: string;
  onSuccess: (payment: LoanPaymentOut) => void;
  onCancel?: () => void;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Error → copy map (CONVENTIONS §9.6): the backend rejects a zero/negative
 * payment with `LOAN_PAYMENT_NONPOSITIVE`; anything else is generic. */
function paymentErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.detail === "LOAN_PAYMENT_NONPOSITIVE") {
    return "Enter a payment amount greater than zero.";
  }
  return "Couldn't record this payment. Please try again.";
}

/**
 * "Record payment" panel: a currency-aware amount (`amountToMinor`, unsigned
 * — a payment is always a plain positive magnitude), a paid-on date (defaults
 * to today, mirroring `PriceUpdateForm`/`ValuationForm`), and an optional
 * free-text note. On success the loan's `paid_total_minor`/`remaining_minor`
 * (and net worth) update via `useRecordPayment`'s `qk.loans` invalidation.
 */
function PaymentForm({ loanId, currency, onSuccess, onCancel }: PaymentFormProps) {
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayIsoDate());
  const [note, setNote] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The optional account transaction that funded this payment. `showPicker`
  // reveals the `TransactionPicker`; once a transaction is chosen we show a
  // summary with a Remove affordance instead.
  const [linkedTransaction, setLinkedTransaction] = useState<TransactionOut | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  const recordPayment = useRecordPayment(loanId);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!paidOn) {
      return;
    }
    setError(null);
    setAmountError(null);

    const amountMinor = amountToMinor(amount, currency);
    if (amountMinor === null || amountMinor <= 0) {
      setAmountError("Enter an amount greater than zero.");
      return;
    }

    const payload: RecordPaymentPayload = {
      amount_minor: amountMinor,
      paid_on: paidOn,
      note: note.trim() || null,
    };
    // Only send `transaction_id` when a transaction is actually linked, so an
    // unlinked payment's payload stays minimal.
    if (linkedTransaction) {
      payload.transaction_id = linkedTransaction.id;
    }

    try {
      const created = await recordPayment.mutateAsync(payload);
      setAmount("");
      setNote("");
      setLinkedTransaction(null);
      setShowPicker(false);
      onSuccess(created);
    } catch (err) {
      setError(paymentErrorMessage(err));
    }
  }

  const canSubmit = amount.trim() !== "" && paidOn !== "";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="payment-form-amount">Amount</FieldLabel>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
            {currency}
          </span>
          <input
            id="payment-form-amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? "payment-form-amount-error" : undefined}
            className={cn(
              textFieldInputClasses,
              amountError ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
              focusRingClass,
            )}
          />
        </div>
        {amountError ? (
          <FieldError id="payment-form-amount-error">{amountError}</FieldError>
        ) : null}
      </div>

      <TextField
        label="Date"
        type="date"
        value={paidOn}
        onChange={(event) => setPaidOn(event.target.value)}
        required
      />
      <TextField
        label="Note"
        description="Optional."
        placeholder="e.g. Extra principal payment"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />

      <div className="flex flex-col gap-1.5">
        {linkedTransaction ? (
          <div className="flex items-center justify-between gap-3 rounded-pc border border-hairline bg-surface-1 px-3 py-2">
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm text-ink">{linkedTransaction.description}</span>
              <span className="font-mono text-xs text-ink-faint">
                <DateText iso={linkedTransaction.occurred_on} />
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <MoneyText
                minor={linkedTransaction.amount_minor}
                currency={linkedTransaction.currency}
                colorBySign
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setLinkedTransaction(null)}
              >
                Remove
              </Button>
            </span>
          </div>
        ) : showPicker ? (
          <TransactionPicker
            label="Link a transaction"
            onSelect={(transaction) => {
              setLinkedTransaction(transaction);
              setShowPicker(false);
            }}
          />
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setShowPicker(true)}
          >
            Link a transaction
          </Button>
        )}
      </div>

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={recordPayment.isPending} disabled={!canSubmit}>
          Record payment
        </Button>
      </div>
    </form>
  );
}

export default PaymentForm;
