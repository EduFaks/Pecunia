import { useState } from "react";
import { Link } from "react-router-dom";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import Spinner from "../../components/ui/Spinner";
import SummaryHeader from "../../components/ui/SummaryHeader";
import type { SummaryStat } from "../../components/ui/SummaryHeader";
import { useToast } from "../../components/ui/Toast";
import { MoneyText, usePreferences } from "../../lib/preferences";
import { sumByCurrency } from "../_shared/totals";
import PortfolioForm from "./PortfolioForm";
import { usePortfolios } from "./usePortfolios";
import type { PortfolioOut } from "./usePortfolios";

type FormState = { mode: "create" } | { mode: "edit"; portfolio: PortfolioOut };

/** "3 holdings" / "1 holding" / "No holdings" — a small, self-contained
 * count caption for a portfolio row. */
function holdingCountLabel(count: number): string {
  if (count === 0) {
    return "No holdings";
  }
  return `${count} ${count === 1 ? "holding" : "holdings"}`;
}

/**
 * `/portfolio` — the investment portfolios list: name, currency, holding
 * count, and each portfolio's current `MoneyText` market value, with inline
 * create/edit via `PortfolioForm`. Portfolios are a small, user-managed set
 * (a handful of investment accounts), so this reads the flat `usePortfolios`
 * list rather than a keyset `DataList` — same rationale as `ContactsPanel`.
 */
function PortfolioScreen() {
  const { showToast } = useToast();
  const preferences = usePreferences();
  const [formState, setFormState] = useState<FormState | null>(null);

  const portfoliosQuery = usePortfolios();
  const portfolios = portfoliosQuery.data?.items ?? [];
  const grandTotalStats: SummaryStat[] = [
    {
      label: "Grand total",
      entries: sumByCurrency(
        portfolios,
        (portfolio) => portfolio.value_minor,
        (portfolio) => portfolio.currency,
      ).map(({ currency, total_minor }) => ({ currency, value_minor: total_minor })),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Portfolio</h1>
        <Button onClick={() => setFormState({ mode: "create" })}>New portfolio</Button>
      </div>

      {portfolios.length > 0 ? <SummaryHeader stats={grandTotalStats} /> : null}

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {formState.mode === "edit" ? "Edit portfolio" : "New portfolio"}
          </h2>
          <div className="mt-4">
            <PortfolioForm
              portfolio={formState.mode === "edit" ? formState.portfolio : undefined}
              defaultCurrency={preferences.base_currency}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Portfolio updated." : "Portfolio created.", {
                  variant: "positive",
                });
              }}
            />
          </div>
        </Card>
      ) : null}

      {portfoliosQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner label="Loading portfolios" />
        </div>
      ) : portfoliosQuery.isError ? (
        <Callout variant="negative">Couldn't load your portfolios. Try again.</Callout>
      ) : (portfoliosQuery.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="No portfolios yet"
          body="Add your first investment portfolio to track its holdings and value over time."
          action={
            <Button onClick={() => setFormState({ mode: "create" })}>
              Add your first portfolio
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-hairline rounded-pc-lg border border-hairline bg-surface-1">
          {portfoliosQuery.data?.items.map((portfolio) => (
            <li key={portfolio.id}>
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <Link to={`/portfolio/${portfolio.id}`} className="min-w-0">
                  <p className="truncate font-sans text-sm text-ink hover:text-accent">
                    {portfolio.name}
                  </p>
                  <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
                    {portfolio.currency} · {holdingCountLabel(portfolio.holding_count)}
                  </p>
                </Link>
                <MoneyText minor={portfolio.value_minor} currency={portfolio.currency} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default PortfolioScreen;
