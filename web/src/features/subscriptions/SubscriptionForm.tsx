import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import ImageUpload from "../../components/ui/ImageUpload";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { FieldError, FieldLabel } from "../../components/ui/Field";
import { focusRingClass } from "../../components/ui/a11y";
import { ApiError } from "../../lib/api";
import { amountToMinor, minorToAmountInput } from "../../lib/amount";
import { cn } from "../../lib/cn";
import { useAccounts } from "../accounts/useAccounts";
import CategoryPicker from "../categories/CategoryPicker";
import ContactPicker from "../contacts/ContactPicker";
import { CURRENCY_CODES } from "../setup/CurrencySelect";
import { useCreateSubscription, useUpdateSubscription } from "./useSubscriptions";
import type {
  BillingFrequency,
  SubscriptionOut,
  SubscriptionStatus,
} from "./useSubscriptions";

const CURRENCY_OPTIONS: SelectOption[] = CURRENCY_CODES.map((code) => ({ value: code, label: code }));

const FREQUENCY_OPTIONS: { value: BillingFrequency; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

const STATUS_OPTIONS: { value: SubscriptionStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "canceled", label: "Canceled" },
];

export interface SubscriptionFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  subscription?: SubscriptionOut;
  /** Create mode's currency default (the workspace base currency). Ignored in
   * edit mode (the subscription's own currency wins). */
  defaultCurrency?: string;
  onSuccess: (subscription: SubscriptionOut) => void;
  onCancel?: () => void;
}

/** Error → copy map (CONVENTIONS §9.6). `SUBSCRIPTION_NONPOSITIVE` is shown
 * inline under the amount field (the field it concerns); everything else here
 * is a blocking `Callout` — `LOGO_INVALID` gets its own actionable message,
 * the foreign-link 404s and a stale-edit `SUBSCRIPTION_NOT_FOUND` fall back to
 * generic copy. */
function amountFieldError(error: unknown): string | undefined {
  if (error instanceof ApiError && error.detail === "SUBSCRIPTION_NONPOSITIVE") {
    return "Enter an amount greater than zero.";
  }
  return undefined;
}

function calloutError(error: unknown): string | null {
  if (error instanceof ApiError) {
    if (error.detail === "SUBSCRIPTION_NONPOSITIVE") {
      return null; // shown inline under the amount field instead
    }
    if (error.detail === "LOGO_INVALID") {
      return "That image couldn't be saved. Please try a smaller one (PNG, JPEG, or WebP under 64KB).";
    }
    if (error.detail === "CONTACT_NOT_FOUND") {
      return "Couldn't find that contact. It may have been removed.";
    }
    if (error.detail === "ACCOUNT_NOT_FOUND") {
      return "Couldn't find that account. It may have been removed.";
    }
    if (error.detail === "CATEGORY_NOT_FOUND") {
      return "Couldn't find that category. It may have been removed.";
    }
    if (error.detail === "SUBSCRIPTION_NOT_FOUND") {
      return "Couldn't find that subscription. It may have been removed.";
    }
  }
  return "Couldn't save this subscription. Please try again.";
}

/**
 * Create/edit form for one subscription: name, a vendor logo (`ImageUpload`,
 * which downscales + caps the image to a `data:` URI — the same component and
 * capped-base64 rule as a contact's avatar), a currency-aware amount
 * (`amountToMinor`, `lib/amount.ts`) + currency, the billing frequency, a
 * next-renewal date and an optional started-on date, an optional vendor
 * `ContactPicker`, an optional account/category link, and the active/canceled
 * status. Shared by `SubscriptionsScreen`'s "New subscription"/edit panel.
 */
function SubscriptionForm({
  subscription,
  defaultCurrency,
  onSuccess,
  onCancel,
}: SubscriptionFormProps) {
  const isEdit = subscription !== undefined;

  const [name, setName] = useState(subscription?.name ?? "");
  const [logo, setLogo] = useState<string | null>(subscription?.logo ?? null);
  const [currency, setCurrency] = useState(
    subscription?.currency ??
      (defaultCurrency && CURRENCY_CODES.includes(defaultCurrency) ? defaultCurrency : CURRENCY_CODES[0]),
  );
  const [amount, setAmount] = useState(
    subscription ? minorToAmountInput(subscription.amount_minor, subscription.currency) : "",
  );
  const [frequency, setFrequency] = useState<BillingFrequency>(
    subscription?.billing_frequency ?? "monthly",
  );
  const [nextRenewal, setNextRenewal] = useState(subscription?.next_renewal ?? "");
  const [startedOn, setStartedOn] = useState(subscription?.started_on ?? "");
  const [contactId, setContactId] = useState(subscription?.contact_id ?? "");
  const [accountId, setAccountId] = useState(subscription?.account_id ?? "");
  const [categoryId, setCategoryId] = useState(subscription?.category_id ?? "");
  const [status, setStatus] = useState<SubscriptionStatus>(subscription?.status ?? "active");

  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountsQuery = useAccounts();
  const accountOptions: SelectOption[] = [
    { value: "", label: "No account" },
    ...(accountsQuery.data?.items ?? []).map((account) => ({
      value: account.id,
      label: `${account.name} (${account.currency})`,
    })),
  ];

  const createSubscription = useCreateSubscription();
  const updateSubscription = useUpdateSubscription(subscription?.id ?? "");
  const isSubmitting = createSubscription.isPending || updateSubscription.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || !nextRenewal) {
      return;
    }
    setError(null);
    setAmountError(null);

    const amountMinor = amountToMinor(amount, currency);
    if (amountMinor === null) {
      setAmountError("Enter a valid amount.");
      return;
    }

    try {
      if (isEdit) {
        // Edit sends every optional field explicitly (value or null) so
        // clearing one in the UI actually clears it server-side (the backend
        // treats a present null as "clear", an absent key as "unchanged").
        const updated = await updateSubscription.mutateAsync({
          name: trimmedName,
          amount_minor: amountMinor,
          currency,
          billing_frequency: frequency,
          next_renewal: nextRenewal,
          status,
          logo,
          started_on: startedOn || null,
          contact_id: contactId || null,
          account_id: accountId || null,
          category_id: categoryId || null,
        });
        onSuccess(updated);
        return;
      }
      // Create omits unset optionals for a clean POST payload.
      const created = await createSubscription.mutateAsync({
        name: trimmedName,
        amount_minor: amountMinor,
        currency,
        billing_frequency: frequency,
        next_renewal: nextRenewal,
        status,
        ...(logo ? { logo } : {}),
        ...(startedOn ? { started_on: startedOn } : {}),
        ...(contactId ? { contact_id: contactId } : {}),
        ...(accountId ? { account_id: accountId } : {}),
        ...(categoryId ? { category_id: categoryId } : {}),
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

  const canSubmit = name.trim() !== "" && amount.trim() !== "" && nextRenewal !== "";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Name"
        placeholder="e.g. Netflix"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <ImageUpload label="Logo" value={logo} onChange={setLogo} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Currency"
          options={CURRENCY_OPTIONS}
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        />
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="subscription-form-amount" required>
            Amount
          </FieldLabel>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
              {currency}
            </span>
            <input
              id="subscription-form-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-invalid={amountError ? true : undefined}
              aria-describedby={amountError ? "subscription-form-amount-error" : undefined}
              className={cn(
                textFieldInputClasses,
                amountError ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
                focusRingClass,
              )}
            />
          </div>
          {amountError ? (
            <FieldError id="subscription-form-amount-error">{amountError}</FieldError>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Billing frequency"
          options={FREQUENCY_OPTIONS}
          value={frequency}
          onChange={(event) => setFrequency(event.target.value as BillingFrequency)}
        />
        <Select
          label="Status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(event) => setStatus(event.target.value as SubscriptionStatus)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Next renewal"
          type="date"
          value={nextRenewal}
          onChange={(event) => setNextRenewal(event.target.value)}
          required
        />
        <TextField
          label="Started on"
          description="Optional."
          type="date"
          value={startedOn}
          onChange={(event) => setStartedOn(event.target.value)}
        />
      </div>

      <ContactPicker
        label="Contact"
        value={contactId}
        onChange={(id) => setContactId(id)}
      />

      <Select
        label="Account"
        options={accountOptions}
        value={accountId}
        onChange={(event) => setAccountId(event.target.value)}
      />

      <CategoryPicker value={categoryId} onChange={setCategoryId} />

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!canSubmit}>
          {isEdit ? "Save changes" : "Create subscription"}
        </Button>
      </div>
    </form>
  );
}

export default SubscriptionForm;
