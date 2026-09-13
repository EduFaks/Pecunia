import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
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
import { useCreateTransfer, useDeleteTransfer, useUpdateTransfer } from "./useTransfers";
import type { TransferOut } from "./useTransfers";

export interface TransferFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields, plus
   * a "Delete transfer" action). Absence is create mode (POST). */
  transfer?: TransferOut;
  /** Every account this workspace has — populates both account `Select`s. A
   * transfer needs at least two, so callers gate the entry point on
   * `accounts.length >= 2`. */
  accounts: AccountOut[];
  /** Preselected source account for a create form (e.g. opened while an
   * account filter is active). Ignored once the user picks a different one. */
  defaultFromAccountId?: string;
  onSuccess: (transfer: TransferOut) => void;
  /** Fired after a successful delete (edit mode only). */
  onDeleted?: () => void;
  onCancel?: () => void;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Error → copy map (CONVENTIONS §9.6) — a screen owns turning `error.detail`
 * into words; `api.ts` stays a dumb transport. Every code the transfers
 * endpoints raise is mapped; anything else falls back to a generic message. */
function transferError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.detail === "TRANSFER_CURRENCY_MISMATCH") {
      return "Both accounts must use the same currency — Pecunia doesn't convert currencies.";
    }
    if (error.detail === "TRANSFER_SAME_ACCOUNT") {
      return "Choose two different accounts to transfer between.";
    }
    if (error.detail === "TRANSFER_NONPOSITIVE") {
      return "Enter an amount greater than zero.";
    }
    if (error.detail === "ACCOUNT_NOT_FOUND") {
      return "Couldn't find one of those accounts. It may have been removed.";
    }
  }
  return "Couldn't save this transfer. Please try again.";
}

/**
 * Create/edit form for one transfer: a **from-account** and a **to-account**
 * `Select` (each excludes the other side's chosen account, so the same
 * account can never be picked twice), a currency-aware amount field
 * (`amountToMinor` — the shared account currency, never separately chosen),
 * a description, and an occurred-on date. Opened from `TransactionsScreen`'s
 * "New transfer" action and from a transfer leg's "Edit" action.
 *
 * **Client guards mirror the server** (`api/src/pecunia/api/transfers.py`):
 * submit is disabled with an inline explanation when the two accounts are the
 * same (`TRANSFER_SAME_ACCOUNT`) or their currencies differ
 * (`TRANSFER_CURRENCY_MISMATCH` — V1 has no FX), and the amount must be
 * positive (`TRANSFER_NONPOSITIVE`). Should a guard be bypassed, the server's
 * 422/404 codes are surfaced through the same error map.
 */
function TransferForm({
  transfer,
  accounts,
  defaultFromAccountId,
  onSuccess,
  onDeleted,
  onCancel,
}: TransferFormProps) {
  const isEdit = transfer !== undefined;

  const defaultFrom = transfer?.from_account_id ?? defaultFromAccountId ?? accounts[0]?.id ?? "";
  const [fromId, setFromId] = useState(defaultFrom);
  const [toId, setToId] = useState(
    transfer?.to_account_id ?? accounts.find((a) => a.id !== defaultFrom)?.id ?? "",
  );

  const fromAccount = accounts.find((a) => a.id === fromId);
  const toAccount = accounts.find((a) => a.id === toId);
  const currency = fromAccount?.currency ?? "USD";

  const [amount, setAmount] = useState(
    transfer ? minorToAmountInput(transfer.amount_minor, transfer.currency) : "",
  );
  const [description, setDescription] = useState(transfer?.description ?? "");
  const [occurredOn, setOccurredOn] = useState(transfer?.occurred_on ?? todayIsoDate());

  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const createTransfer = useCreateTransfer();
  const updateTransfer = useUpdateTransfer(transfer?.id ?? "");
  const deleteTransfer = useDeleteTransfer();
  const isSubmitting = createTransfer.isPending || updateTransfer.isPending;

  // Each select excludes the other side's chosen account, so the same account
  // can't be picked on both sides (the plan's mutual-exclusion rule).
  const fromOptions: SelectOption[] = accounts
    .filter((a) => a.id !== toId)
    .map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }));
  const toOptions: SelectOption[] = accounts
    .filter((a) => a.id !== fromId)
    .map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }));

  const sameAccount = fromId !== "" && fromId === toId;
  const currencyMismatch =
    fromAccount !== undefined && toAccount !== undefined && fromAccount.currency !== toAccount.currency;

  const guard = sameAccount
    ? "Choose two different accounts to transfer between."
    : currencyMismatch
      ? "Both accounts must use the same currency — Pecunia doesn't convert currencies."
      : null;

  const canSubmit =
    fromId !== "" &&
    toId !== "" &&
    !sameAccount &&
    !currencyMismatch &&
    description.trim() !== "" &&
    occurredOn !== "";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedDescription = description.trim();
    if (!canSubmit) {
      return;
    }
    setError(null);
    setAmountError(null);

    const amountMinor = amountToMinor(amount, currency);
    if (amountMinor === null) {
      setAmountError("Enter a valid amount.");
      return;
    }
    if (amountMinor <= 0) {
      setAmountError("Enter an amount greater than zero.");
      return;
    }

    try {
      if (isEdit) {
        const updated = await updateTransfer.mutateAsync({
          from_account_id: fromId,
          to_account_id: toId,
          amount_minor: amountMinor,
          description: trimmedDescription,
          occurred_on: occurredOn,
        });
        onSuccess(updated);
        return;
      }
      const created = await createTransfer.mutateAsync({
        from_account_id: fromId,
        to_account_id: toId,
        amount_minor: amountMinor,
        currency,
        description: trimmedDescription,
        occurred_on: occurredOn,
      });
      onSuccess(created);
    } catch (err) {
      setError(transferError(err));
    }
  }

  async function handleDelete() {
    if (!transfer) {
      return;
    }
    setError(null);
    try {
      await deleteTransfer.mutateAsync(transfer.id);
      onDeleted?.();
    } catch {
      setError("Couldn't delete this transfer. Please try again.");
    }
  }

  return (
    <>
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <Select
        label="From account"
        options={fromOptions}
        value={fromId}
        onChange={(event) => setFromId(event.target.value)}
      />
      <Select
        label="To account"
        options={toOptions}
        value={toId}
        onChange={(event) => setToId(event.target.value)}
      />

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="transfer-form-amount">Amount</FieldLabel>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
            {currency}
          </span>
          <input
            id="transfer-form-amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? "transfer-form-amount-error" : undefined}
            className={cn(
              textFieldInputClasses,
              amountError ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
              focusRingClass,
            )}
          />
        </div>
        {amountError ? <FieldError id="transfer-form-amount-error">{amountError}</FieldError> : null}
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

      {guard ? <Callout variant="info">{guard}</Callout> : null}
      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex items-center justify-end gap-2">
        {isEdit ? (
          <Button
            type="button"
            variant="destructive"
            onClick={() => setConfirmingDelete(true)}
            className="mr-auto"
          >
            Delete transfer
          </Button>
        ) : null}
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!canSubmit}>
          {isEdit ? "Save changes" : "Add transfer"}
        </Button>
      </div>
    </form>

    {confirmingDelete ? (
      <ConfirmDialog
        title="Delete this transfer?"
        description="This permanently deletes the transfer and both of its legs, and reverts both account balances. This can't be undone."
        confirmLabel="Delete transfer"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmingDelete(false)}
        isConfirming={deleteTransfer.isPending}
      />
    ) : null}
  </>
);
}

export default TransferForm;
