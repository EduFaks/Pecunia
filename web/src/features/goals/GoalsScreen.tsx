import { useState } from "react";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import EmptyState from "../../components/data/EmptyState";
import { usePreferences } from "../../lib/preferences";
import GoalForm from "./GoalForm";
import GoalRing from "./GoalRing";
import { useDeleteGoal, useGoals } from "./useGoals";
import type { GoalOut } from "./useGoals";

type FormState = { mode: "create" } | { mode: "edit"; goal: GoalOut };

/**
 * `/goals` — the savings-goals management screen: create/edit/delete, each
 * row rendering `GoalRing` (progress + ETA line). No detail route — a goal
 * has no nested sub-resource worth its own screen (progress/eta are derived,
 * not a ledger to drill into), same shape as `BudgetsScreen`. Reads
 * `useGoals`'s bounded flat list (a workspace's goals are a small, user-
 * managed set, same rationale as contacts/loans/portfolios) rather than a
 * keyset-paginated `DataList`.
 */
function GoalsScreen() {
  const { showToast } = useToast();
  const { base_currency } = usePreferences();
  const [formState, setFormState] = useState<FormState | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<GoalOut | null>(null);
  const goalsQuery = useGoals();
  const deleteGoal = useDeleteGoal();

  const goals = goalsQuery.data?.items ?? [];

  async function handleDelete(goal: GoalOut) {
    try {
      await deleteGoal.mutateAsync(goal.id);
      showToast(`"${goal.name}" deleted.`);
    } catch {
      showToast("Couldn't delete that goal. Please try again.", { variant: "negative" });
    } finally {
      setConfirmTarget(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Goals</h1>
        <Button onClick={() => setFormState({ mode: "create" })}>New goal</Button>
      </div>

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {formState.mode === "edit" ? "Edit goal" : "New goal"}
          </h2>
          <div className="mt-4">
            <GoalForm
              goal={formState.mode === "edit" ? formState.goal : undefined}
              defaultCurrency={base_currency}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Goal updated." : "Goal created.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      {goalsQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner label="Loading goals" />
        </div>
      ) : goals.length === 0 ? (
        <EmptyState
          title="No goals yet"
          body="Set a savings goal — an emergency fund, a down payment, a trip — and track its progress from an account, a portfolio, your net worth, or a figure you update yourself."
          action={<Button onClick={() => setFormState({ mode: "create" })}>Add a goal</Button>}
        />
      ) : (
        <ul className="flex flex-col divide-y divide-hairline rounded-pc-lg border border-hairline">
          {goals.map((goal) => (
            <li key={goal.id} className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
              <GoalRing goal={goal} />
              <div className="flex shrink-0 items-center gap-3">
                <Button variant="ghost" size="sm" onClick={() => setFormState({ mode: "edit", goal })}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={deleteGoal.isPending && confirmTarget?.id === goal.id}
                  onClick={() => setConfirmTarget(goal)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {confirmTarget ? (
        <ConfirmDialog
          title={`Delete "${confirmTarget.name}"?`}
          description="This permanently deletes the goal. This can't be undone."
          confirmLabel="Delete goal"
          onConfirm={() => void handleDelete(confirmTarget)}
          onCancel={() => setConfirmTarget(null)}
          isConfirming={deleteGoal.isPending}
        />
      ) : null}
    </div>
  );
}

export default GoalsScreen;
