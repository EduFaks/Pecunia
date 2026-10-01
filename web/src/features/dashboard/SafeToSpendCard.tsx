import { useState } from "react";
import type { FormEvent } from "react";
import { Pencil } from "lucide-react";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import TextField from "../../components/ui/TextField";
import { amountToMinor, minorToAmountInput } from "../../lib/amount";
import { MoneyText, usePreferences } from "../../lib/preferences";
import { useSafeToSpend, useSetMonthlyBudget } from "./useDashboard";
import type { SafeToSpend } from "./useDashboard";

/**
 * The spend-progress bar's fill percent: `spent_mtd_minor` against the
 * ceiling `spent_mtd_minor + max(0, displayed_safe_minor)` — "how much of
 * this month's safe-to-spend room is already used." Clamped 0–100 so an
 * over-budget/over-income month (where `displayed_safe_minor` is negative,
 * collapsing the ceiling to `spent_mtd_minor` itself) still reads as a full
 * bar rather than an impossible percentage; a currency with nothing spent
 * and nothing safe reads as an empty bar rather than a division by zero.
 * Kept pure and exported so the math is unit-testable without rendering the
 * card — same rationale as `features/budgets/budgetProgress.ts` (kept here
 * rather than split into its own module, like that file, since this card is
 * its only consumer).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function safeToSpendPercent(spentMinor: number, displayedSafeMinor: number): number {
  const ceiling = spentMinor + Math.max(0, displayedSafeMinor);
  if (ceiling <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (spentMinor / ceiling) * 100));
}

/** Capitalizes a locale month name's first character (`Intl` returns
 * Portuguese month names lowercase, e.g. "outubro") — a cosmetic touch for
 * the card's heading, not a translation concern. */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

interface BudgetEditorProps {
  currentMinor: number | null;
  currency: string;
  onDone: () => void;
}

/** The inline "definir orçamento" affordance's open state: a compact form
 * (one `TextField` + Salvar/Cancelar) that calls `useSetMonthlyBudget` —
 * submitting a blank input clears the budget (sends `null`), matching
 * `MonthlyBudgetIn`'s nullable contract. */
function BudgetEditor({ currentMinor, currency, onDone }: BudgetEditorProps) {
  const [value, setValue] = useState(
    currentMinor !== null ? minorToAmountInput(currentMinor, currency) : "",
  );
  const [fieldError, setFieldError] = useState<string | null>(null);
  const setMonthlyBudget = useSetMonthlyBudget();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);

    const trimmed = value.trim();
    let minor: number | null = null;
    if (trimmed !== "") {
      minor = amountToMinor(trimmed, currency);
      if (minor === null) {
        setFieldError("Informe um valor válido.");
        return;
      }
    }

    try {
      await setMonthlyBudget.mutateAsync(minor);
      onDone();
    } catch {
      setFieldError("Não foi possível salvar. Tente de novo.");
    }
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      className="mt-3 flex flex-wrap items-end gap-2 min-w-0"
    >
      <TextField
        label="Orçamento mensal"
        description="Deixe em branco para remover o limite."
        placeholder="0.00"
        inputMode="decimal"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        error={fieldError ?? undefined}
        className="max-w-[10rem]"
      />
      <div className="flex gap-2 pb-0.5">
        <Button type="submit" size="sm" loading={setMonthlyBudget.isPending}>
          Salvar
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

interface SafeToSpendBodyProps {
  entry: SafeToSpend;
  currency: string;
}

function SafeToSpendBody({ entry, currency }: SafeToSpendBodyProps) {
  const [isEditingBudget, setIsEditingBudget] = useState(false);
  const percent = safeToSpendPercent(entry.spent_mtd_minor, entry.displayed_safe_minor);
  const isOver = entry.displayed_safe_minor < 0;

  return (
    <div className="mt-5 min-w-0">
      <p className="text-xs text-ink-faint">livre pra gastar</p>
      <MoneyText
        minor={entry.displayed_safe_minor}
        currency={currency}
        variant="hero"
        flagNegative
        className="mt-1 block text-4xl"
      />
      {isOver ? <p className="mt-1 text-xs text-negative">você passou do limite</p> : null}

      <div
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Gasto do mês"
        className="mt-4 h-2 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div
          data-safe-to-spend-fill
          className="h-full rounded-full bg-accent transition-[width] duration-150 ease-pc"
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="mt-2 flex items-center gap-1 text-xs text-ink-faint">
        <span>~</span>
        <MoneyText minor={entry.daily_allowance_minor} currency={currency} />
        <span>/dia</span>
      </p>

      <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-faint min-w-0">
        <span className="flex items-center gap-1">
          <span>renda</span>
          <MoneyText minor={entry.expected_income_minor} currency={currency} />
        </span>
        <span aria-hidden="true">·</span>
        <span className="flex items-center gap-1">
          <span>fixos a vir</span>
          <MoneyText minor={entry.committed_remaining_minor} currency={currency} />
        </span>
        <span aria-hidden="true">·</span>
        <span className="flex items-center gap-1">
          <span>gasto</span>
          <MoneyText minor={entry.spent_mtd_minor} currency={currency} />
        </span>
      </p>

      {entry.limited_by === "budget" ? (
        <p className="mt-2 text-xs text-ink-faint">limitado pelo orçamento</p>
      ) : null}

      <div className="mt-4">
        {isEditingBudget ? (
          <BudgetEditor
            currentMinor={entry.monthly_budget_minor}
            currency={currency}
            onDone={() => setIsEditingBudget(false)}
          />
        ) : (
          <Button
            type="button"
            variant="quiet"
            size="sm"
            onClick={() => setIsEditingBudget(true)}
            className="gap-1.5 px-0"
          >
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
            definir orçamento
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The redesigned dashboard's hero card (Track U, v1.6): "how much can I
 * still spend this month" for the workspace's **base currency**. Renders
 * the month name + `days_remaining`, the `displayed_safe_minor` figure
 * (`MoneyText variant="hero"`, negative-flagged), a spend-progress bar, the
 * daily allowance, a one-line income/committed/spent breakdown, a subtle
 * note when the optional monthly budget is the binding limit, and an inline
 * "definir orçamento" editor. Loading/error/empty states mirror the sibling
 * dashboard cards (`SavingsRateCard`/`CommittedMonthlyCard`). Rendered via
 * the shared `Card` primitive with `shadow="glow"` (Track U, Task 8) — the
 * one surface app-wide that carries the subtle white ambient elevation, so
 * it reads as the screen's single showpiece the instant it mounts.
 */
function SafeToSpendCard() {
  const { base_currency, locale } = usePreferences();
  const safeToSpendQuery = useSafeToSpend();
  const entry = safeToSpendQuery.data?.[base_currency];

  const monthLabel = capitalize(new Intl.DateTimeFormat(locale, { month: "long" }).format(new Date()));

  return (
    <Card shadow="glow">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 min-w-0">
        <h2 className="font-display text-lg font-semibold text-ink">{monthLabel}</h2>
        {entry ? (
          <span className="text-xs text-ink-faint">
            faltam {entry.days_remaining} {entry.days_remaining === 1 ? "dia" : "dias"}
          </span>
        ) : null}
      </div>

      {safeToSpendQuery.isError ? (
        <p className="mt-5 text-sm text-ink-faint">
          Não foi possível carregar seu saldo livre. Tente atualizar.
        </p>
      ) : safeToSpendQuery.isLoading ? (
        <p className="mt-5 text-sm text-ink-2">Carregando…</p>
      ) : !entry ? (
        <p className="mt-5 text-sm text-ink-2">Sem dados para este mês ainda.</p>
      ) : (
        <SafeToSpendBody entry={entry} currency={base_currency} />
      )}
    </Card>
  );
}

export default SafeToSpendCard;
