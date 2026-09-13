import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { ApiError } from "../../lib/api";
import { signedAmountToMinor } from "../../lib/amount";
import { CURRENCY_CODES } from "../setup/CurrencySelect";
import { ACCOUNT_TYPE_OPTIONS } from "./accountTypes";
import { useCreateAccount, useUpdateAccount } from "./useAccounts";
import type { AccountOut, AccountType } from "./useAccounts";

const CURRENCY_OPTIONS: SelectOption[] = CURRENCY_CODES.map((code) => ({ value: code, label: code }));

export interface AccountFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields, no
   * starting-balance field — `initial_balance_minor` isn't editable after
   * creation). Absence is create mode (POST). */
  account?: AccountOut;
  /** Create mode's currency default — typically the workspace's base
   * currency, or the currently-filtered account's currency when adding from
   * a scoped context. Ignored in edit mode (the account's own currency
   * wins). */
  defaultCurrency?: string;
  onSuccess: (account: AccountOut) => void;
  onCancel?: () => void;
}

/**
 * Error → copy map (CONVENTIONS §9.6): `ACCOUNT_HAS_TRANSACTIONS` is the one
 * named backend error this form can hit (changing an account's currency
 * once it has transactions, per the account service's invariant); anything
 * else — a generic 422, a network failure — gets a generic fallback rather
 * than a raw error string.
 */
function accountErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.detail === "ACCOUNT_HAS_TRANSACTIONS") {
      return "This account already has transactions — its currency can't be changed.";
    }
  }
  return "Couldn't save this account. Please try again.";
}

/**
 * Create/edit form for one account: name, type, currency, and (create only)
 * an optional starting balance — a signed amount (a credit card can
 * reasonably start owed) converted to minor units via `signedAmountToMinor`
 * (`lib/amount.ts`). Used both as `AccountsScreen`'s "New account"/"Edit"
 * panel and could be reused wherever an account needs creating inline.
 */
function AccountForm({ account, defaultCurrency, onSuccess, onCancel }: AccountFormProps) {
  const isEdit = account !== undefined;

  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "checking");
  const [currency, setCurrency] = useState(
    account?.currency ?? (defaultCurrency && CURRENCY_CODES.includes(defaultCurrency) ? defaultCurrency : CURRENCY_CODES[0]),
  );
  const [initialBalance, setInitialBalance] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createAccount = useCreateAccount();
  const updateAccount = useUpdateAccount(account?.id ?? "");
  const isSubmitting = createAccount.isPending || updateAccount.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setError(null);
    setAmountError(null);

    try {
      if (isEdit) {
        const updated = await updateAccount.mutateAsync({ name: trimmedName, type, currency });
        onSuccess(updated);
        return;
      }

      let initialBalanceMinor: number | undefined;
      if (initialBalance.trim() !== "") {
        const parsed = signedAmountToMinor(initialBalance, currency);
        if (parsed === null) {
          setAmountError("Enter a valid amount.");
          return;
        }
        initialBalanceMinor = parsed;
      }
      const created = await createAccount.mutateAsync({
        name: trimmedName,
        type,
        currency,
        ...(initialBalanceMinor !== undefined ? { initial_balance_minor: initialBalanceMinor } : {}),
      });
      onSuccess(created);
    } catch (err) {
      setError(accountErrorMessage(err));
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Name"
        placeholder="e.g. Everyday checking"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Type"
          options={ACCOUNT_TYPE_OPTIONS}
          value={type}
          onChange={(event) => setType(event.target.value as AccountType)}
        />
        <Select
          label="Currency"
          options={CURRENCY_OPTIONS}
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        />
      </div>

      {!isEdit ? (
        <TextField
          label="Starting balance"
          description="Optional — defaults to 0. A credit card may reasonably start negative (owed)."
          placeholder="0.00"
          inputMode="decimal"
          value={initialBalance}
          onChange={(event) => setInitialBalance(event.target.value)}
          error={amountError ?? undefined}
        />
      ) : null}

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!name.trim()}>
          {isEdit ? "Save changes" : "Create account"}
        </Button>
      </div>
    </form>
  );
}

export default AccountForm;
