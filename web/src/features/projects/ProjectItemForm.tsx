import { useId, useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldError, FieldLabel } from "../../components/ui/Field";
import TextField from "../../components/ui/TextField";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { amountToMinor, minorToAmountInput } from "../../lib/amount";
import { cn } from "../../lib/cn";
import { useAddProjectItem, useUpdateProjectItem } from "./useProjects";
import type { ProjectItemOut } from "./useProjects";

export interface ProjectItemFormProps {
  projectId: string;
  /** The project's own currency — an item carries no currency of its own
   * (`ProjectItemIn` has none), so its amount always converts against the
   * project it belongs to. */
  currency: string;
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is add mode (POST). There is no delete-item endpoint on the
   * backend, so this form only ever adds or edits. */
  item?: ProjectItemOut;
  onSuccess: (item: ProjectItemOut) => void;
  onCancel?: () => void;
}

/**
 * Add/edit form for one project line item: a name and a currency-aware
 * amount (`amountToMinor`, unsigned). Used both as `ProjectDetail`'s "Add
 * item" panel and its per-row inline edit.
 */
function ProjectItemForm({ projectId, currency, item, onSuccess, onCancel }: ProjectItemFormProps) {
  const isEdit = item !== undefined;
  // Unique per instance (`useId`, not a static string): unlike `AssetDetail`'s
  // single `ValuationForm`/`TransactionForm`'s single instance-at-a-time
  // usage, `ProjectDetail` can render several `ProjectItemForm`s at once —
  // the "Add item" panel plus one per row being edited — so a hardcoded id
  // would collide and break label association for every instance past the
  // first.
  const amountId = `project-item-form-amount-${useId()}`;
  const amountErrorId = `${amountId}-error`;

  const [name, setName] = useState(item?.name ?? "");
  const [amount, setAmount] = useState(
    item ? minorToAmountInput(item.amount_minor, currency) : "",
  );
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addItem = useAddProjectItem(projectId);
  const updateItem = useUpdateProjectItem(projectId, item?.id ?? "");
  const isSubmitting = addItem.isPending || updateItem.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setError(null);
    setAmountError(null);

    const amountMinor = amountToMinor(amount, currency);
    if (amountMinor === null) {
      setAmountError("Enter a valid amount.");
      return;
    }

    try {
      if (isEdit) {
        const updated = await updateItem.mutateAsync({ name: trimmedName, amount_minor: amountMinor });
        onSuccess(updated);
        return;
      }
      const created = await addItem.mutateAsync({ name: trimmedName, amount_minor: amountMinor });
      setName("");
      setAmount("");
      onSuccess(created);
    } catch {
      setError("Couldn't save this part. Please try again.");
    }
  }

  const canSubmit = name.trim() !== "" && amount.trim() !== "";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[10rem] flex-1">
          <TextField
            label="Part"
            placeholder="e.g. Shingles"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={amountId}>Amount</FieldLabel>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
              {currency}
            </span>
            <input
              id={amountId}
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-invalid={amountError ? true : undefined}
              aria-describedby={amountError ? amountErrorId : undefined}
              className={cn(
                textFieldInputClasses,
                "w-28",
                amountError ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
                focusRingClass,
              )}
            />
          </div>
        </div>

        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!canSubmit}>
          {isEdit ? "Save changes" : "Add part"}
        </Button>
      </div>

      {amountError ? <FieldError id={amountErrorId}>{amountError}</FieldError> : null}
      {error ? <Callout variant="negative">{error}</Callout> : null}
    </form>
  );
}

export default ProjectItemForm;
