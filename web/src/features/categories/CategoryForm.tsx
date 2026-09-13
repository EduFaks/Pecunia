import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import Select from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { cn } from "../../lib/cn";
import { CATEGORY_KIND_OPTIONS, CATEGORY_PALETTE } from "./categoryTypes";
import type { CategoryKind } from "./categoryTypes";
import { useCreateCategory, useUpdateCategory } from "./useCategories";
import type { CategoryOut } from "./useCategories";

export interface CategoryFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  category?: CategoryOut;
  onSuccess: (category: CategoryOut) => void;
  onCancel?: () => void;
}

/** Error → copy map (CONVENTIONS §9.6) — no named backend error is specific
 * to categories today (color is pre-validated client-side against the same
 * palette the backend enforces, so a 422 shouldn't normally happen). */
function categoryErrorMessage(): string {
  return "Couldn't save this category. Please try again.";
}

/**
 * Create/edit form for one category: name, kind (`Select`), a color chosen
 * from the backend's fixed palette (swatch buttons — `role="group"` +
 * `aria-pressed`, the same toggle pattern `TransactionForm`'s inflow/
 * outflow control uses), and an icon field (a stored icon string mapped to a
 * lucide glyph by `CategoryIcon` wherever the category is shown; an
 * unrecognized string falls back to a neutral `Tag`). Used as
 * `CategoriesPanel`'s "New category"/"Edit" panel.
 */
function CategoryForm({ category, onSuccess, onCancel }: CategoryFormProps) {
  const isEdit = category !== undefined;

  const [name, setName] = useState(category?.name ?? "");
  const [kind, setKind] = useState<CategoryKind>(category?.kind ?? "expense");
  const [color, setColor] = useState(category?.color ?? CATEGORY_PALETTE[0].value);
  const [icon, setIcon] = useState(category?.icon ?? "");
  const [error, setError] = useState<string | null>(null);

  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory(category?.id ?? "");
  const isSubmitting = createCategory.isPending || updateCategory.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setError(null);

    try {
      if (isEdit) {
        const updated = await updateCategory.mutateAsync({
          name: trimmedName,
          kind,
          color,
          icon: icon.trim() || null,
        });
        onSuccess(updated);
        return;
      }
      const created = await createCategory.mutateAsync({
        name: trimmedName,
        kind,
        color,
        ...(icon.trim() ? { icon: icon.trim() } : {}),
      });
      onSuccess(created);
    } catch {
      setError(categoryErrorMessage());
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          placeholder="e.g. Groceries"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <Select
          label="Kind"
          options={CATEGORY_KIND_OPTIONS}
          value={kind}
          onChange={(event) => setKind(event.target.value as CategoryKind)}
        />
      </div>

      <TextField
        label="Icon"
        description="A lucide icon name shown beside the category (e.g. shopping-bag, car, home). Unknown names fall back to a neutral tag."
        placeholder="e.g. shopping-bag"
        value={icon}
        onChange={(event) => setIcon(event.target.value)}
      />

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="category-form-color">Color</FieldLabel>
        <div id="category-form-color" role="group" aria-label="Color" className="flex flex-wrap gap-2">
          {CATEGORY_PALETTE.map((swatch) => (
            <button
              key={swatch.value}
              type="button"
              aria-pressed={color === swatch.value}
              aria-label={swatch.label}
              onClick={() => setColor(swatch.value)}
              className={cn(
                "h-7 w-7 rounded-full border-2 transition-colors duration-150 ease-pc",
                color === swatch.value ? "border-accent" : "border-transparent",
                focusRingClass,
              )}
              style={{ backgroundColor: swatch.value }}
            />
          ))}
        </div>
      </div>

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!name.trim()}>
          {isEdit ? "Save changes" : "Create category"}
        </Button>
      </div>
    </form>
  );
}

export default CategoryForm;
