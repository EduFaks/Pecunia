import { useState } from "react";
import CategoryIcon from "../../components/icons/categoryIcon";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import Checkbox from "../../components/ui/Checkbox";
import Pill from "../../components/ui/Pill";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import CategoryForm from "./CategoryForm";
import { CATEGORY_KIND_LABELS } from "./categoryTypes";
import type { CategoryKind } from "./categoryTypes";
import { useArchiveCategory, useCategories } from "./useCategories";
import type { CategoryOut } from "./useCategories";

type FormState = { mode: "create" } | { mode: "edit"; category: CategoryOut };

const KINDS: CategoryKind[] = ["income", "expense"];

/**
 * Settings → Categories: create/edit/archive, grouped by kind. Reads
 * `useCategories`'s bounded flat list (see that hook's docstring for why
 * this isn't a keyset-paginated `DataList` like `AccountsScreen`/
 * `BudgetsScreen` — grouping by kind needs the whole set in hand, and a
 * workspace's categories are inherently a small, bounded collection, not an
 * unbounded one) rather than walking pages. Otherwise mirrors
 * `AccountsScreen`'s shape: a toggleable create/edit `Card`, a "Show
 * archived" `Checkbox`, and per-row Edit/Archive actions (no delete — same
 * as accounts, archiving is the only removal a category with existing
 * transactions/budgets referencing it can safely support; `ON DELETE SET
 * NULL` protects those on the backend, but archiving is still the front-
 * door action here).
 */
function CategoriesPanel() {
  const { showToast } = useToast();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [formState, setFormState] = useState<FormState | null>(null);
  const categoriesQuery = useCategories(includeArchived);
  const archiveCategory = useArchiveCategory();

  const categories = categoriesQuery.data?.items ?? [];

  async function handleArchive(category: CategoryOut) {
    try {
      await archiveCategory.mutateAsync(category.id);
      showToast(`"${category.name}" archived.`);
    } catch {
      showToast("Couldn't archive that category. Please try again.", { variant: "negative" });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg text-ink">Categories</h2>
        <Button size="sm" onClick={() => setFormState({ mode: "create" })}>
          New category
        </Button>
      </div>

      {formState ? (
        <Card>
          <h3 className="font-display text-base text-ink">
            {formState.mode === "edit" ? "Edit category" : "New category"}
          </h3>
          <div className="mt-4">
            <CategoryForm
              category={formState.mode === "edit" ? formState.category : undefined}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Category updated." : "Category created.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      <Checkbox
        label="Show archived categories"
        checked={includeArchived}
        onChange={(event) => setIncludeArchived(event.target.checked)}
      />

      {categoriesQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner label="Loading categories" />
        </div>
      ) : categories.length === 0 ? (
        <p className="text-sm text-ink-2">No categories yet.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {KINDS.map((kind) => {
            const items = categories.filter((category) => category.kind === kind);
            if (items.length === 0) {
              return null;
            }
            return (
              <div key={kind}>
                <p className="mb-2 font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">
                  {CATEGORY_KIND_LABELS[kind] ?? kind}
                </p>
                <ul className="divide-y divide-hairline rounded-pc-lg border border-hairline">
                  {items.map((category) => (
                    <li key={category.id} className="flex items-center justify-between gap-4 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: category.color }}
                        />
                        <CategoryIcon name={category.icon} className="text-ink-faint" />
                        <span className="truncate text-sm text-ink">{category.name}</span>
                        {category.archived_at ? <Pill>Archived</Pill> : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setFormState({ mode: "edit", category })}
                        >
                          Edit
                        </Button>
                        {!category.archived_at ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={archiveCategory.isPending}
                            onClick={() => void handleArchive(category)}
                          >
                            Archive
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default CategoriesPanel;
