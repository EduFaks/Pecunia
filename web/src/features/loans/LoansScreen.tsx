import { useState } from "react";
import { Link } from "react-router-dom";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import Pill from "../../components/ui/Pill";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { MoneyText, usePreferences } from "../../lib/preferences";
import LoanForm from "./LoanForm";
import LoanPayoffBar from "./LoanPayoffBar";
import { useLoans } from "./useLoans";
import type { LoanDirection, LoanOut } from "./useLoans";

type FormState = { mode: "create" } | { mode: "edit"; loan: LoanOut };

const DIRECTION_LABELS: Record<LoanDirection, string> = {
  borrowed: "Borrowed",
  lent: "Lent",
};

/**
 * `/loans` — the loans list: each row shows the name, a Borrowed/Lent
 * `Pill`, the principal, the remaining balance (`MoneyText`), and a payoff
 * progress bar (`LoanPayoffBar`, white-accent fill — paid/principal). Loans
 * are a small, user-managed set (a handful of debts/receivables), so this
 * reads the flat `useLoans` list rather than a keyset `DataList` — same
 * rationale as `PortfolioScreen`.
 */
function LoansScreen() {
  const { showToast } = useToast();
  const preferences = usePreferences();
  const [formState, setFormState] = useState<FormState | null>(null);

  const loansQuery = useLoans();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Loans</h1>
        <Button onClick={() => setFormState({ mode: "create" })}>New loan</Button>
      </div>

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {formState.mode === "edit" ? "Edit loan" : "New loan"}
          </h2>
          <div className="mt-4">
            <LoanForm
              loan={formState.mode === "edit" ? formState.loan : undefined}
              defaultCurrency={preferences.base_currency}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Loan updated." : "Loan created.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      {loansQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner label="Loading loans" />
        </div>
      ) : loansQuery.isError ? (
        <Callout variant="negative">Couldn't load your loans. Try again.</Callout>
      ) : (loansQuery.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="No loans yet"
          body="Add a loan you owe or one you've lent out to track its balance and payoff progress."
          action={<Button onClick={() => setFormState({ mode: "create" })}>Add your first loan</Button>}
        />
      ) : (
        <ul className="divide-y divide-hairline rounded-pc-lg border border-hairline bg-surface-1">
          {loansQuery.data?.items.map((loan) => (
            <li key={loan.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <Link to={`/loans/${loan.id}`} className="min-w-0">
                  <p className="truncate font-sans text-sm text-ink hover:text-accent">{loan.name}</p>
                  <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
                    {loan.currency} · Principal{" "}
                    <MoneyText minor={loan.principal_minor} currency={loan.currency} />
                  </p>
                </Link>
                <Pill>{DIRECTION_LABELS[loan.direction]}</Pill>
              </div>
              <LoanPayoffBar
                paidTotalMinor={loan.paid_total_minor}
                principalMinor={loan.principal_minor}
                remainingMinor={loan.remaining_minor}
                currency={loan.currency}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default LoansScreen;
