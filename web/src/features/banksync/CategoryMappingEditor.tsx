import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Button from "../../components/ui/Button";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import { useCategoryMappings, useReplaceMappings } from "./useBankSync";
import type { CategoryMappingOut } from "./useBankSync";

interface CategoryOut {
  id: string;
  name: string;
}

/**
 * Category mapping editor (Track T). Displays Pluggy transaction categories
 * and their mappings to Pecunia categories. Allows add/remove/save.
 */
function CategoryMappingEditor() {
  const { showToast } = useToast();
  const [confirmRemoveIndex, setConfirmRemoveIndex] = useState<number | null>(null);
  const [mappings, setMappings] = useState<CategoryMappingOut[]>([]);
  const [initialized, setInitialized] = useState(false);

  const categoriesQuery = useQuery({
    queryKey: [...qk.categories, "flat"],
    queryFn: () => apiFetch<{ items: CategoryOut[] }>("/categories?limit=1000"),
  });

  const mappingsQuery = useCategoryMappings();
  const replaceMappings = useReplaceMappings();

  // Initialize mappings from query
  useMemo(() => {
    if (mappingsQuery.data && !initialized) {
      setMappings(mappingsQuery.data);
      setInitialized(true);
    }
  }, [mappingsQuery.data, initialized]);

  const allPluggyCategories = [
    "TRANSFERS",
    "UTILITIES",
    "FOOD_AND_DINING",
    "ENTERTAINMENT",
    "SHOPPING",
    "HEALTH",
    "TRAVEL",
    "PERSONAL_SERVICES",
    "FEES",
    "OTHER",
  ];

  const usedPluggyCategories = new Set(mappings.map((m) => m.pluggy_category));
  const availablePluggyCategories = allPluggyCategories.filter((cat) => !usedPluggyCategories.has(cat));

  function handleAddMapping() {
    setMappings([
      ...mappings,
      {
        pluggy_category: availablePluggyCategories[0] || "",
        category_id: "",
      },
    ]);
  }

  function handleRemoveMapping(index: number) {
    setConfirmRemoveIndex(index);
  }

  function confirmRemoveMapping(index: number) {
    setMappings(mappings.filter((_, i) => i !== index));
    setConfirmRemoveIndex(null);
  }

  function handleUpdateMapping(
    index: number,
    field: "pluggy_category" | "category_id",
    value: string,
  ) {
    const updated = [...mappings];
    updated[index] = { ...updated[index], [field]: value };
    setMappings(updated);
  }

  async function handleSave() {
    try {
      await replaceMappings.mutateAsync(mappings);
      showToast("Category mappings saved.");
    } catch {
      showToast("Couldn't save mappings. Please try again.", { variant: "negative" });
    }
  }

  if (mappingsQuery.isLoading || categoriesQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner label="Loading category mappings" />
      </div>
    );
  }

  const categories = categoriesQuery.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-display text-lg text-ink">Category Mappings</h2>
        <Button variant="ghost" size="sm" onClick={handleAddMapping} disabled={availablePluggyCategories.length === 0}>
          Add mapping
        </Button>
      </div>

      {mappings.length === 0 ? (
        <p className="text-sm text-ink-faint">No category mappings configured.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {mappings.map((mapping, index) => {
            const usedAtOtherIndices = mappings
              .map((m, i) => (i !== index ? m.pluggy_category : null))
              .filter(Boolean);

            return (
              <div
                key={index}
                className="flex flex-wrap items-center gap-3 rounded-pc bg-surface-1 p-3"
              >
                <select
                  className="rounded-pc border border-hairline bg-surface-0 px-3 py-2 text-sm text-ink"
                  value={mapping.pluggy_category}
                  onChange={(e) => handleUpdateMapping(index, "pluggy_category", e.target.value)}
                  aria-label="Pluggy category"
                >
                  <option value="">Select Pluggy category...</option>
                  {allPluggyCategories.map((cat) => (
                    <option
                      key={cat}
                      value={cat}
                      disabled={usedAtOtherIndices.includes(cat)}
                    >
                      {cat}
                    </option>
                  ))}
                </select>

                <span className="text-xs text-ink-faint">→</span>

                <select
                  className="rounded-pc border border-hairline bg-surface-0 px-3 py-2 text-sm text-ink"
                  value={mapping.category_id}
                  onChange={(e) => handleUpdateMapping(index, "category_id", e.target.value)}
                  aria-label="Category"
                >
                  <option value="">Select category...</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveMapping(index)}
                  aria-label="Remove mapping"
                >
                  Remove
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-3 pt-4">
        <Button variant="primary" loading={replaceMappings.isPending} onClick={() => void handleSave()}>
          Save mappings
        </Button>
      </div>

      {confirmRemoveIndex !== null ? (
        <ConfirmDialog
          title="Remove mapping?"
          description="This will delete the mapping between this Pluggy category and Pecunia category."
          confirmLabel="Remove"
          onConfirm={() => confirmRemoveMapping(confirmRemoveIndex)}
          onCancel={() => setConfirmRemoveIndex(null)}
          isConfirming={false}
        />
      ) : null}
    </div>
  );
}

export default CategoryMappingEditor;
