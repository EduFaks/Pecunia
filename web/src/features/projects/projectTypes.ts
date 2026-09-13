import type { SelectOption } from "../../components/ui/Select";

/** Mirrors backend `ProjectStatus` (`api/src/pecunia/models/project.py`). */
export const PROJECT_STATUS_OPTIONS: SelectOption[] = [
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];

export const PROJECT_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  PROJECT_STATUS_OPTIONS.map((option) => [option.value, option.label]),
);

/** Mirrors backend `ProjectType` (`api/src/pecunia/models/project.py`). A
 * **saving** project funds toward a goal (a rainy-day fund); a **spending**
 * project spends against an expected budget (a kitchen remodel). Both track
 * *actual* (Σ linked transaction magnitude) vs *target*, but read
 * differently — see `PROJECT_TYPE_LABELS`. */
export type ProjectType = "saving" | "spending";

export const PROJECT_TYPE_OPTIONS: { value: ProjectType; label: string }[] = [
  { value: "spending", label: "Spending" },
  { value: "saving", label: "Saving" },
];

/** Type-aware vocabulary for a project's target and realized figures, shared
 * verbatim by `ProjectForm`, `FundingBar`, and `ProjectDetail` so the whole
 * feature agrees on what to call each number:
 *   - **saving** funds toward a *Goal* and the money in is *Saved*;
 *   - **spending** works against a *Budget* and the money out is *Spent*.
 * Keeping this one map is why the segmented toggle in the form and the labels
 * on the bar can never drift apart. */
export const PROJECT_TYPE_LABELS: Record<ProjectType, { target: string; actual: string }> = {
  saving: { target: "Goal", actual: "Saved" },
  spending: { target: "Budget", actual: "Spent" },
};

/** The label set for a project's type, tolerant of an unknown/absent value
 * (falls back to spending's vocabulary) so a caller never has to guard. */
export function projectTypeLabels(type: string | null | undefined): { target: string; actual: string } {
  return PROJECT_TYPE_LABELS[(type as ProjectType) ?? "spending"] ?? PROJECT_TYPE_LABELS.spending;
}
