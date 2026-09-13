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
import CategoryPicker from "../categories/CategoryPicker";
import { CURRENCY_CODES } from "../setup/CurrencySelect";
import { BUDGET_PERIOD_OPTIONS } from "./budgetTypes";
import { useCreateBudget, useUpdateBudget } from "./useBudgets";
import type { BudgetOut, BudgetPeriod } from "./useBudgets";

const CURRENCY_OPTIONS: SelectOption[] = CURRENCY_CODES.map((code) => ({ value: code, label: code }));

export interface BudgetFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  budget?: BudgetOut;
  /** Create mode's currency default. Ignored in edit mode. */
  defaultCurrency?: string;
  onSuccess: (budget: BudgetOut) => void;
  onCancel?: () => void;
}

/** Error → copy map (CONVENTIONS §9.6): `CATEGORY_NOT_FOUND` can only come
 * from the chosen category (a deleted/cross-workspace id — shouldn't
 * normally happen since `CategoryPicker` only offers real ones, but a stale
 * form left open across an archive elsewhere is possible); anything else
 * falls back to a generic message. */
function budgetErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.detail === "CATEGORY_NOT_FOUND") {
    return "Couldn't find that category. It may have been removed.";
  }
  return "Couldn't save this budget. Please try again.";
}

/**
 * Create/edit form for one budget: name, category (`CategoryPicker`,
 * optional — "Uncategorized" is a valid choice), period (`Select`),
 * currency, and a currency-aware amount (`amountToMinor`, unsigned). Used
 * both as `BudgetsScreen`'s "New budget"/"Edit" panel.
 */
function BudgetForm({ budget, defaultCurrency, onSuccess, onCancel }: BudgetFormProps) {
  const isEdit = budget !== undefined;

  const [name, setName] = useState(budget?.name ?? "");
  const [categoryId, setCategoryId] = useState(budget?.category_id ?? "");
  const [period, setPeriod] = useState<BudgetPeriod>(budget?.period ?? "monthly");
  const [currency, setCurrency] = useState(
    budget?.currency ??
      (defaultCurrency && CURRENCY_CODES.includes(defaultCurrency) ? defaultCurrency : CURRENCY_CODES[0]),
  );
  const [amount, setAmount] = useState(
    budget ? minorToAmountInput(budget.amount_minor, budget.currency) : "",
  );
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createBudget = useCreateBudget();
  const updateBudget = useUpdateBudget(budget?.id ?? "");
  const isSubmitting = createBudget.isPending || updateBudget.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
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
        const updated = await updateBudget.mutateAsync({
          name: trimmedName,
          category_id: categoryId || null,
          period,
          currency,
          amount_minor: amountMinor,
        });
        onSuccess(updated);
        return;
      }
      const created = await createBudget.mutateAsync({
        name: trimmedName,
        category_id: categoryId || null,
        period,
        currency,
        amount_minor: amountMinor,
      });
      onSuccess(created);
    } catch (err) {
      setError(budgetErrorMessage(err));
    }
  }

  const canSubmit = name.trim() !== "" && amount.trim() !== "";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          placeholder="e.g. Groceries"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <CategoryPicker value={categoryId} onChange={setCategoryId} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Period"
          options={BUDGET_PERIOD_OPTIONS}
          value={period}
          onChange={(event) => setPeriod(event.target.value as BudgetPeriod)}
        />
        <Select
          label="Currency"
          options={CURRENCY_OPTIONS}
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="budget-form-amount">Amount</FieldLabel>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
            {currency}
          </span>
          <input
            id="budget-form-amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? "budget-form-amount-error" : undefined}
            className={cn(
              textFieldInputClasses,
              amountError ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
              focusRingClass,
            )}
          />
        </div>
        {amountError ? <FieldError id="budget-form-amount-error">{amountError}</FieldError> : null}
      </div>

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!canSubmit}>
          {isEdit ? "Save changes" : "Create budget"}
        </Button>
      </div>
    </form>
  );
}

export default BudgetForm;
