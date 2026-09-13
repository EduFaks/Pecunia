import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { amountToMinor, minorToAmountInput } from "../../lib/amount";
import { cn } from "../../lib/cn";
import { CURRENCY_CODES } from "../setup/CurrencySelect";
import { PROJECT_STATUS_OPTIONS, PROJECT_TYPE_OPTIONS, projectTypeLabels } from "./projectTypes";
import type { ProjectType } from "./projectTypes";
import { useCreateProject, useUpdateProject } from "./useProjects";
import type { ProjectOut, ProjectStatus } from "./useProjects";

const CURRENCY_OPTIONS: SelectOption[] = CURRENCY_CODES.map((code) => ({ value: code, label: code }));

export interface ProjectFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  project?: ProjectOut;
  /** Create mode's currency default. Ignored in edit mode. */
  defaultCurrency?: string;
  onSuccess: (project: ProjectOut) => void;
  onCancel?: () => void;
}

/** Error → copy map (CONVENTIONS §9.6) — no named backend error is specific
 * to projects today. */
function projectErrorMessage(): string {
  return "Couldn't save this project. Please try again.";
}

/**
 * Create/edit form for one project: name, currency, status, and an
 * optional target amount (`amountToMinor`, unsigned — a funding goal is
 * always a plain positive figure). Used both as `ProjectsScreen`'s
 * "New project"/"Edit" panel and `ProjectDetail`'s inline edit panel.
 */
function ProjectForm({ project, defaultCurrency, onSuccess, onCancel }: ProjectFormProps) {
  const isEdit = project !== undefined;

  const [name, setName] = useState(project?.name ?? "");
  const [currency, setCurrency] = useState(
    project?.currency ??
      (defaultCurrency && CURRENCY_CODES.includes(defaultCurrency) ? defaultCurrency : CURRENCY_CODES[0]),
  );
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "active");
  const [type, setType] = useState<ProjectType>(project?.type ?? "spending");
  const [targetAmount, setTargetAmount] = useState(
    project?.target_amount_minor != null
      ? minorToAmountInput(project.target_amount_minor, project.currency)
      : "",
  );
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createProject = useCreateProject();
  const updateProject = useUpdateProject(project?.id ?? "");
  const isSubmitting = createProject.isPending || updateProject.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setError(null);
    setAmountError(null);

    let targetAmountMinor: number | undefined;
    if (targetAmount.trim() !== "") {
      const parsed = amountToMinor(targetAmount, currency);
      if (parsed === null) {
        setAmountError("Enter a valid amount.");
        return;
      }
      targetAmountMinor = parsed;
    }

    try {
      if (isEdit) {
        const updated = await updateProject.mutateAsync({
          name: trimmedName,
          currency,
          status,
          type,
          ...(targetAmountMinor !== undefined ? { target_amount_minor: targetAmountMinor } : {}),
        });
        onSuccess(updated);
        return;
      }
      const created = await createProject.mutateAsync({
        name: trimmedName,
        currency,
        status,
        type,
        ...(targetAmountMinor !== undefined ? { target_amount_minor: targetAmountMinor } : {}),
      });
      onSuccess(created);
    } catch {
      setError(projectErrorMessage());
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Name"
        placeholder="e.g. New roof"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="project-form-type">Type</FieldLabel>
        <div
          id="project-form-type"
          role="group"
          aria-label="Type"
          className="inline-flex w-fit rounded-pc border border-hairline p-0.5"
        >
          {PROJECT_TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={type === option.value}
              onClick={() => setType(option.value)}
              className={cn(
                "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
                type === option.value ? "bg-accent-soft text-ink" : "text-ink-2 hover:text-ink",
                focusRingClass,
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Currency"
          options={CURRENCY_OPTIONS}
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        />
        <Select
          label="Status"
          options={PROJECT_STATUS_OPTIONS}
          value={status}
          onChange={(event) => setStatus(event.target.value as ProjectStatus)}
        />
      </div>

      <TextField
        label={`${projectTypeLabels(type).target} amount`}
        description="Optional — leave blank for an open-ended project."
        placeholder="0.00"
        inputMode="decimal"
        value={targetAmount}
        onChange={(event) => setTargetAmount(event.target.value)}
        error={amountError ?? undefined}
      />

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!name.trim()}>
          {isEdit ? "Save changes" : "Create project"}
        </Button>
      </div>
    </form>
  );
}

export default ProjectForm;
