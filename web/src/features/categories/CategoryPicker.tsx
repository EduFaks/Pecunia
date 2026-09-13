import { useId } from "react";
import CategoryIcon from "../../components/icons/categoryIcon";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { cn } from "../../lib/cn";
import { useCategories } from "./useCategories";

export interface CategoryPickerProps {
  label?: string;
  /** A category id, or `""` for "Uncategorized" — mirrors
   * `TransactionsScreen`'s `ALL_ACCOUNTS = ""` sentinel, since a real
   * category id (a UUID) is never the empty string. */
  value: string;
  onChange: (categoryId: string) => void;
  /** Text for the empty (`""`) option. Defaults to "Uncategorized" — right for
   * the transaction/budget FORMS, where no category genuinely means the record
   * is uncategorized. Filter callers override it (`TransactionFiltersBar`
   * passes "All categories") because there the empty state means "don't filter
   * by category", not "show uncategorized". */
  emptyLabel?: string;
  id?: string;
  className?: string;
}

/**
 * A category `Select`, grouped by kind (`<optgroup>`), for `TransactionForm`
 * and `BudgetForm` — both treat a category as optional (the empty option —
 * "Uncategorized" by default, `emptyLabel` to override — is always first).
 * A native `<select>` rather than a custom
 * listbox, same rationale as `components/ui/Select`: full keyboard/screen-
 * reader behavior for free.
 *
 * Fetches its own data via `useCategories(true)` (including archived) so it
 * never needs a caller to plumb a list down — the same self-contained-hook
 * move `lib/preferences.tsx`'s `MoneyText`/`DateText` make with
 * `usePreferences()`. Archived categories are hidden from the option list
 * *unless* they're the currently selected `value` — an already-categorized
 * transaction/budget shouldn't silently lose its label just because that
 * category was later archived (labeled "(archived)" so it's clear it can't
 * be picked again once deselected).
 *
 * A native `<option>` can only hold plain text, so neither the color swatch
 * nor the icon glyph can live inside the dropdown's own rows — instead the
 * *selected* category's color dot and its `CategoryIcon` glyph render overlaid
 * on the closed control, and each option's text is just the category name
 * ("(archived)" appended where relevant). (Track F swapped the old raw
 * "Groceries — shopping-bag" option text for this glyph.)
 */
function CategoryPicker({
  label = "Category",
  value,
  onChange,
  emptyLabel = "Uncategorized",
  id,
  className,
}: CategoryPickerProps) {
  const autoId = useId();
  const selectId = id ?? `category-picker-${autoId}`;

  const categoriesQuery = useCategories(true);
  const categories = categoriesQuery.data?.items ?? [];
  const selectable = categories.filter((category) => !category.archived_at || category.id === value);
  const income = selectable.filter((category) => category.kind === "income");
  const expense = selectable.filter((category) => category.kind === "expense");
  const selected = categories.find((category) => category.id === value);

  function optionLabel(category: (typeof categories)[number]): string {
    return category.archived_at ? `${category.name} (archived)` : category.name;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={selectId}>{label}</FieldLabel>
      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-ink-faint"
        >
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full border border-hairline-strong",
              !selected && "bg-surface-2",
            )}
            style={selected ? { backgroundColor: selected.color } : undefined}
          />
          {selected ? <CategoryIcon name={selected.icon} /> : null}
        </span>
        <select
          id={selectId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            textFieldInputClasses,
            selected ? "pl-10" : "pl-8",
            "border-hairline focus:border-hairline-strong",
            focusRingClass,
            className,
          )}
        >
          <option value="">{emptyLabel}</option>
          {income.length > 0 ? (
            <optgroup label="Income">
              {income.map((category) => (
                <option key={category.id} value={category.id}>
                  {optionLabel(category)}
                </option>
              ))}
            </optgroup>
          ) : null}
          {expense.length > 0 ? (
            <optgroup label="Expense">
              {expense.map((category) => (
                <option key={category.id} value={category.id}>
                  {optionLabel(category)}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </div>
    </div>
  );
}

export default CategoryPicker;
