import { useState } from "react";
import type { FormEvent } from "react";
import { Pencil } from "lucide-react";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import TextField from "../../components/ui/TextField";
import { amountToMinor, minorToAmountInput } from "../../lib/amount";
import { MoneyText, usePreferences } from "../../lib/preferences";
import { safeToSpendSegments } from "./safeToSpendBar";
import { useSafeToSpend, useSetMonthlyBudget } from "./useDashboard";
import type { SafeToSpend } from "./useDashboard";

/** Explicit sign glyphs for the breakdown's income/committed/spent figures
 * (CONVENTIONS §9.1's semantic-tone rule applies to the color, not the
 * glyph): "+" (U+002B) for income, "−" (U+2212, minus sign — distinct from a
 * hyphen) for the two outflows, matching the brief's own notation. */
const SIGN_POSITIVE = "+";
const SIGN_NEGATIVE = "−";

/** The segmented bar's "committed-to-come" hatch: a diagonal
 * `repeating-linear-gradient` over `--pc-accent-soft` (the accent already
 * mixed to a faint white tint, see `tokens.css`) alternating with
 * `transparent` — token-driven, no raw hex, and a texture rather than a
 * solid fill so it reads as "not yet real" next to the solid `bg-ink` spent
 * segment. */
const COMMITTED_HATCH_BACKGROUND =
  "repeating-linear-gradient(45deg, var(--pc-accent-soft) 0, var(--pc-accent-soft) 2px, transparent 2px, transparent 6px)";

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
  const isOver = entry.displayed_safe_minor < 0;
  const segments = safeToSpendSegments(entry);

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

      {/* Segmented month-total bar: spent (solid) + committed-to-come
          (hatched) + free (empty track), each a percent of
          `expected_income_minor`, plus an optional budget-marker line. The
          `role="progressbar"` lives on the spent segment specifically (not
          the outer track) — it's the one figure with a real "how much of
          the month is used" semantic; the committed segment and the marker
          are each just labeled, not roles of their own. */}
      <div className="relative mt-4 h-2 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="flex h-full w-full">
          <div
            data-safe-to-spend-segment="spent"
            role="progressbar"
            aria-valuenow={entry.spent_mtd_minor}
            aria-valuemin={0}
            aria-valuemax={entry.expected_income_minor}
            aria-label="Gasto do mês"
            className="h-full bg-ink transition-[width] duration-150 ease-pc"
            style={{ width: `${segments.spentPct}%` }}
          />
          <div
            data-safe-to-spend-segment="committed"
            aria-label="Comprometido a vir"
            className="h-full transition-[width] duration-150 ease-pc"
            style={{ width: `${segments.committedPct}%`, backgroundImage: COMMITTED_HATCH_BACKGROUND }}
          />
          <div
            data-safe-to-spend-segment="free"
            aria-hidden="true"
            className="h-full flex-1 bg-surface-2"
          />
        </div>
        {segments.budgetMarkerPct !== null ? (
          <div
            data-safe-to-spend-budget-marker
            aria-label="Marcador de orçamento"
            className="absolute inset-y-0 w-0.5 bg-ink"
            style={{ left: `${segments.budgetMarkerPct}%` }}
          />
        ) : null}
      </div>

      <p className="mt-2 flex items-center gap-1 text-xs text-ink-faint">
        <span>~</span>
        <MoneyText minor={entry.daily_allowance_minor} currency={currency} />
        <span>/dia</span>
      </p>

      <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs min-w-0">
        <span className="flex items-center gap-1">
          <span className="text-ink-faint">renda</span>
          <span className="text-positive">
            {SIGN_POSITIVE}
            <MoneyText minor={entry.expected_income_minor} currency={currency} />
          </span>
        </span>
        <span aria-hidden="true" className="text-ink-faint">
          ·
        </span>
        <span className="flex items-center gap-1">
          <span className="text-ink-faint">fixos a vir</span>
          <span className="text-negative">
            {SIGN_NEGATIVE}
            <MoneyText minor={entry.committed_remaining_minor} currency={currency} />
          </span>
        </span>
        <span aria-hidden="true" className="text-ink-faint">
          ·
        </span>
        <span className="flex items-center gap-1">
          <span className="text-ink-faint">gasto</span>
          <span className="text-negative">
            {SIGN_NEGATIVE}
            <MoneyText minor={entry.spent_mtd_minor} currency={currency} />
          </span>
        </span>
      </p>

      {entry.committed_cards_minor > 0 ? (
        <p className="mt-1 text-xs text-ink-faint">
          inclui fatura de cartão{" "}
          <MoneyText minor={entry.committed_cards_minor} currency={currency} />
        </p>
      ) : null}

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
 * The redesigned dashboard's hero card (Track U, v1.6; Track U2 reworked the
 * bar/breakdown): "how much can I still spend this month" for the
 * workspace's **base currency**. Renders the month name + `days_remaining`,
 * the `displayed_safe_minor` figure (`MoneyText variant="hero"`,
 * negative-flagged), a segmented month-total bar (spent/committed-to-come/
 * free, plus an optional budget marker — see `safeToSpendSegments`), the
 * daily allowance, a signed/colored income−committed−spent breakdown (with
 * a credit-card-bill sub-note when applicable), a subtle note when the
 * optional monthly budget is the binding limit, and an inline "definir
 * orçamento" editor. Loading/error/empty states mirror the sibling
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
