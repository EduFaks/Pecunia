import { useState } from "react";
import DataList from "../../components/data/DataList";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Pill from "../../components/ui/Pill";
import { useToast } from "../../components/ui/Toast";
import { apiFetch } from "../../lib/api";
import { MoneyText } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import CategoryBadge from "../categories/CategoryBadge";
import { useCategories } from "../categories/useCategories";
import BudgetForm from "./BudgetForm";
import BudgetVsActualBar from "./BudgetVsActualBar";
import { BUDGET_PERIOD_LABELS } from "./budgetTypes";
import { useDeleteBudget } from "./useBudgets";
import type { BudgetOut, BudgetPage } from "./useBudgets";

/** One walked page's size for the budgets `DataList`. */
const PAGE_LIMIT = 20;

type FormState = { mode: "create" } | { mode: "edit"; budget: BudgetOut };

/**
 * `/budgets` — list + full create/edit/delete, inline — same shape as
 * `TransactionsScreen` (one `DataList`, a toggleable create/edit `Card`, and
 * per-row Edit/Delete). No detail route: a budget has no nested sub-resource
 * worth its own screen the way an asset's valuations or a project's items
 * do.
 */
function BudgetsScreen() {
  const { showToast } = useToast();
  const [formState, setFormState] = useState<FormState | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<BudgetOut | null>(null);
  const deleteBudget = useDeleteBudget();
  // Archived categories included: a budget assigned to a category that's
  // since been archived should still resolve a name/color for its badge,
  // same rationale as `TransactionsScreen`'s `useAccounts(true)`.
  const categoriesQuery = useCategories(true);
  const categories = categoriesQuery.data?.items ?? [];
  const categoryFor = (categoryId: string | null) =>
    categories.find((category) => category.id === categoryId) ?? null;

  function fetchPage(cursor: string | null) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return apiFetch<BudgetPage>(`/budgets?${params.toString()}`);
  }

  async function handleDelete(budget: BudgetOut) {
    try {
      await deleteBudget.mutateAsync(budget.id);
      showToast(`"${budget.name}" deleted.`);
    } catch {
      showToast("Couldn't delete that budget. Please try again.", { variant: "negative" });
    } finally {
      setConfirmTarget(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Budgets</h1>
        <Button onClick={() => setFormState({ mode: "create" })}>New budget</Button>
      </div>

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {formState.mode === "edit" ? "Edit budget" : "New budget"}
          </h2>
          <div className="mt-4">
            <BudgetForm
              budget={formState.mode === "edit" ? formState.budget : undefined}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Budget updated." : "Budget created.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      <DataList<BudgetOut>
        queryKey={qk.budgets}
        fetchPage={fetchPage}
        empty={
          <EmptyState
            title="No budgets yet"
            body="Add your first budget to start tracking spending against a plan."
            action={
              <Button onClick={() => setFormState({ mode: "create" })}>Add your first budget</Button>
            }
          />
        }
        renderRow={(budget) => (
          <div className="flex flex-col gap-3 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate font-sans text-sm text-ink">{budget.name}</p>
                <CategoryBadge category={categoryFor(budget.category_id)} className="mt-0.5" />
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <Pill>{BUDGET_PERIOD_LABELS[budget.period] ?? budget.period}</Pill>
                <MoneyText minor={budget.amount_minor} currency={budget.currency} />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFormState({ mode: "edit", budget })}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={deleteBudget.isPending && confirmTarget?.id === budget.id}
                  onClick={() => setConfirmTarget(budget)}
                >
                  Delete
                </Button>
              </div>
            </div>
            <BudgetVsActualBar
              actualMinor={budget.actual_minor}
              amountMinor={budget.amount_minor}
              currency={budget.currency}
            />
          </div>
        )}
      />

      {confirmTarget ? (
        <ConfirmDialog
          title={`Delete "${confirmTarget.name}"?`}
          description="This permanently deletes the budget. This can't be undone."
          confirmLabel="Delete budget"
          onConfirm={() => void handleDelete(confirmTarget)}
          onCancel={() => setConfirmTarget(null)}
          isConfirming={deleteBudget.isPending}
        />
      ) : null}
    </div>
  );
}

export default BudgetsScreen;
