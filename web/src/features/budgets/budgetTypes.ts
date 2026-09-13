import type { SelectOption } from "../../components/ui/Select";

/** Mirrors backend `BudgetPeriod` (`api/src/pecunia/models/budget.py`). */
export const BUDGET_PERIOD_OPTIONS: SelectOption[] = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

export const BUDGET_PERIOD_LABELS: Record<string, string> = Object.fromEntries(
  BUDGET_PERIOD_OPTIONS.map((option) => [option.value, option.label]),
);
