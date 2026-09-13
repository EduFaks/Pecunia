import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { ApiError } from "../../lib/api";
import { amountToMinor, minorToAmountInput } from "../../lib/amount";
import { useAccounts } from "../accounts/useAccounts";
import { usePortfolios } from "../portfolio/usePortfolios";
import { CURRENCY_CODES } from "../setup/CurrencySelect";
import { useCreateGoal, useUpdateGoal } from "./useGoals";
import type { GoalOut, GoalSourceKind } from "./useGoals";

const SOURCE_OPTIONS: SelectOption[] = [
  { value: "manual", label: "Manual" },
  { value: "account", label: "Account" },
  { value: "portfolio", label: "Portfolio" },
  { value: "net_worth", label: "Net worth" },
];

export interface GoalFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  goal?: GoalOut;
  /** Create mode's currency default (the workspace base currency) for the
   * `manual`/`net_worth` kinds. Ignored in edit mode and whenever an
   * account/portfolio source is picked (its own currency wins). */
  defaultCurrency?: string;
  onSuccess: (goal: GoalOut) => void;
  onCancel?: () => void;
}

/** Error → copy map (CONVENTIONS §9.6). */
function goalErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.detail === "GOAL_CURRENCY_MISMATCH") {
      return "This goal's currency must match its source's own currency.";
    }
    if (error.detail === "GOAL_SOURCE_REQUIRED") {
      return "Choose an account or portfolio for this goal.";
    }
    if (error.detail === "ACCOUNT_NOT_FOUND" || error.detail === "PORTFOLIO_NOT_FOUND") {
      return "Couldn't find that source. It may have been removed.";
    }
    if (error.detail === "GOAL_NOT_FOUND") {
      return "Couldn't find that goal. It may have been removed.";
    }
  }
  return "Couldn't save this goal. Please try again.";
}

/**
 * Create/edit form for one savings goal: a name, a **source selector**
 * (manual / account / portfolio / net worth) that swaps in the matching
 * picker, a target amount + optional target date, and — only for a
 * `manual` goal — the current-progress figure (`manual_current_minor`).
 *
 * The source selector drives currency: picking an account/portfolio locks
 * the goal's currency to that source's own (shown read-only — CONVENTIONS
 * §4, never cross-currency, enforced again server-side as
 * `GOAL_CURRENCY_MISMATCH`); `manual`/`net_worth` goals choose their own
 * currency freely. `GoalsScreen`'s "New goal"/"Edit" body.
 */
function GoalForm({ goal, defaultCurrency, onSuccess, onCancel }: GoalFormProps) {
  const isEdit = goal !== undefined;
  const accountsQuery = useAccounts();
  const portfoliosQuery = usePortfolios();
  const accounts = accountsQuery.data?.items ?? [];
  const portfolios = portfoliosQuery.data?.items ?? [];

  const [name, setName] = useState(goal?.name ?? "");
  const [sourceKind, setSourceKind] = useState<GoalSourceKind>(goal?.source_kind ?? "manual");
  const [accountId, setAccountId] = useState(
    goal?.source_kind === "account" ? (goal.source_id ?? "") : "",
  );
  const [portfolioId, setPortfolioId] = useState(
    goal?.source_kind === "portfolio" ? (goal.source_id ?? "") : "",
  );
  const [freeCurrency, setFreeCurrency] = useState(
    goal?.currency ??
      (defaultCurrency && CURRENCY_CODES.includes(defaultCurrency)
        ? defaultCurrency
        : CURRENCY_CODES[0]),
  );
  const [target, setTarget] = useState(
    goal ? minorToAmountInput(goal.target_minor, goal.currency) : "",
  );
  const [targetDate, setTargetDate] = useState(goal?.target_date ?? "");
  const [manualCurrent, setManualCurrent] = useState(
    goal?.manual_current_minor != null
      ? minorToAmountInput(goal.manual_current_minor, goal.currency)
      : "",
  );

  const [targetError, setTargetError] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createGoal = useCreateGoal();
  const updateGoal = useUpdateGoal(goal?.id ?? "");
  const isSubmitting = createGoal.isPending || updateGoal.isPending;

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const selectedPortfolio = portfolios.find((p) => p.id === portfolioId);
  // The currency actually submitted: locked to the picked source's own for
  // account/portfolio, freely chosen otherwise.
  const effectiveCurrency =
    sourceKind === "account"
      ? (selectedAccount?.currency ?? freeCurrency)
      : sourceKind === "portfolio"
        ? (selectedPortfolio?.currency ?? freeCurrency)
        : freeCurrency;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setError(null);
    setTargetError(null);
    setManualError(null);

    const targetMinor = amountToMinor(target, effectiveCurrency);
    if (targetMinor === null) {
      setTargetError("Enter a valid amount.");
      return;
    }

    let manualCurrentMinor: number | null = null;
    if (sourceKind === "manual" && manualCurrent.trim() !== "") {
      const parsed = amountToMinor(manualCurrent, effectiveCurrency);
      if (parsed === null) {
        setManualError("Enter a valid amount.");
        return;
      }
      manualCurrentMinor = parsed;
    }

    const sourceId =
      sourceKind === "account"
        ? accountId || null
        : sourceKind === "portfolio"
          ? portfolioId || null
          : null;

    try {
      if (isEdit) {
        // Edit sends every optional field explicitly (value or null) so
        // clearing/switching one in the UI actually takes server-side (the
        // backend treats a present null as "clear", an absent key as
        // "unchanged") — mirrors LoanForm.
        const updated = await updateGoal.mutateAsync({
          name: trimmedName,
          target_minor: targetMinor,
          currency: effectiveCurrency,
          source_kind: sourceKind,
          source_id: sourceId,
          manual_current_minor: manualCurrentMinor,
          target_date: targetDate || null,
        });
        onSuccess(updated);
        return;
      }
      // Create omits unset optionals for a clean POST payload.
      const created = await createGoal.mutateAsync({
        name: trimmedName,
        target_minor: targetMinor,
        currency: effectiveCurrency,
        source_kind: sourceKind,
        ...(sourceId ? { source_id: sourceId } : {}),
        ...(manualCurrentMinor !== null ? { manual_current_minor: manualCurrentMinor } : {}),
        ...(targetDate ? { target_date: targetDate } : {}),
      });
      onSuccess(created);
    } catch (err) {
      setError(goalErrorMessage(err));
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Name"
        placeholder="e.g. Emergency fund"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <Select
        label="Source"
        options={SOURCE_OPTIONS}
        value={sourceKind}
        onChange={(event) => setSourceKind(event.target.value as GoalSourceKind)}
      />

      {sourceKind === "account" ? (
        <Select
          label="Account"
          options={accounts.map((account) => ({
            value: account.id,
            label: `${account.name} (${account.currency})`,
          }))}
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        />
      ) : null}

      {sourceKind === "portfolio" ? (
        <Select
          label="Portfolio"
          options={portfolios.map((portfolio) => ({
            value: portfolio.id,
            label: `${portfolio.name} (${portfolio.currency})`,
          }))}
          value={portfolioId}
          onChange={(event) => setPortfolioId(event.target.value)}
        />
      ) : null}

      {sourceKind === "manual" || sourceKind === "net_worth" ? (
        <Select
          label="Currency"
          options={CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
          value={freeCurrency}
          onChange={(event) => setFreeCurrency(event.target.value)}
        />
      ) : (
        <p className="text-xs text-ink-faint">
          Currency: {effectiveCurrency || "—"} (matches the selected source)
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Target amount"
          placeholder="0.00"
          inputMode="decimal"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          error={targetError ?? undefined}
          required
        />
        <TextField
          label="Target date"
          description="Optional."
          type="date"
          value={targetDate}
          onChange={(event) => setTargetDate(event.target.value)}
        />
      </div>

      {sourceKind === "manual" ? (
        <TextField
          label="Current amount"
          description="Optional — how much you've saved toward this goal so far."
          placeholder="0.00"
          inputMode="decimal"
          value={manualCurrent}
          onChange={(event) => setManualCurrent(event.target.value)}
          error={manualError ?? undefined}
        />
      ) : null}

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!name.trim() || !target.trim()}>
          {isEdit ? "Save changes" : "Create goal"}
        </Button>
      </div>
    </form>
  );
}

export default GoalForm;
