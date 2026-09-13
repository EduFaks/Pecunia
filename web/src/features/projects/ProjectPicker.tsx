import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import Pill from "../../components/ui/Pill";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { cn } from "../../lib/cn";
import { PROJECT_STATUS_LABELS } from "./projectTypes";
import { useProjectList } from "./useProjects";
import type { ProjectOut } from "./useProjects";

export interface ProjectPickerProps {
  label?: string;
  /** A project id, or `""` for "no project" — the same empty-string sentinel
   * `ContactPicker`/`CategoryPicker` use, since a real project id (a UUID) is
   * never `""`. */
  value: string;
  /** Fires with the chosen project's id (or `""` when cleared) and the full
   * `ProjectOut` (or `null`). */
  onChange: (projectId: string, project: ProjectOut | null) => void;
  id?: string;
  className?: string;
}

/** A synthetic listbox row for clearing the selection — always present,
 * never filtered out. */
type Option = { kind: "clear" } | { kind: "project"; project: ProjectOut };

/**
 * Type-to-filter project autocomplete for `TransactionForm` — the exact
 * combobox+listbox shape as `ContactPicker` (a text `<input role="combobox">`
 * over a `<ul role="listbox">`), so linking a transaction to a project reads
 * like picking its contact. **Select existing only:** the Projects screen owns
 * creation; free text that matches no project snaps back on blur. A "No
 * project" row at the top clears the link. Each option carries the project's
 * status as a `Pill`, the way `ContactPicker`'s options carry a category badge.
 *
 * Fetches its own data (`useProjectList`) — the same self-contained-hook move
 * `ContactPicker` makes — so no caller has to plumb the list down.
 */
function ProjectPicker({ label = "Project", value, onChange, id, className }: ProjectPickerProps) {
  const autoId = useId();
  const inputId = id ?? `project-picker-${autoId}`;
  const listboxId = `${inputId}-listbox`;

  const projectsQuery = useProjectList();
  const projects = projectsQuery.data?.items ?? [];

  const selected = projects.find((project) => project.id === value) ?? null;

  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the visible text in sync with the externally-selected project — what
  // prefills the field in edit mode and reflects a fresh selection. Keyed on
  // the selected id/name (not `inputValue`) so plain typing is left alone.
  useEffect(() => {
    setInputValue(selected?.name ?? "");
  }, [selected?.id, selected?.name]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const filter = inputValue.trim().toLowerCase();
  // While the input still shows the selected project's name (no new query
  // typed), show the whole list so reopening to switch isn't stuck on one.
  const showAll = filter === "" || (selected !== null && filter === selected.name.trim().toLowerCase());
  const matches = showAll
    ? projects
    : projects.filter((project) => project.name.toLowerCase().includes(filter));

  const options: Option[] = [
    { kind: "clear" },
    ...matches.map((project) => ({ kind: "project" as const, project })),
  ];
  const clampedActive = Math.min(activeIndex, options.length - 1);

  function commit(option: Option) {
    if (option.kind === "clear") {
      onChange("", null);
    } else {
      onChange(option.project.id, option.project);
    }
    setOpen(false);
    setActiveIndex(0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      if (open && options[clampedActive]) {
        event.preventDefault();
        commit(options[clampedActive]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  function handleBlur() {
    // Enforce select-existing-only: any free text that didn't resolve is
    // thrown away, snapping back to what's actually selected. Next tick so an
    // option's click lands first.
    window.setTimeout(() => {
      if (containerRef.current?.contains(document.activeElement)) {
        return;
      }
      setOpen(false);
      setInputValue(selected?.name ?? "");
    }, 0);
  }

  const activeOptionId = open ? `${listboxId}-opt-${clampedActive}` : undefined;

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          placeholder="Search projects…"
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className={cn(
            textFieldInputClasses,
            "border-hairline focus:border-hairline-strong",
            focusRingClass,
            className,
          )}
        />
        {open ? (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-pc border border-hairline bg-surface-1 py-1 shadow-pc-2"
          >
            {options.map((option, index) => {
              const isActive = index === clampedActive;
              const optionId = `${listboxId}-opt-${index}`;
              if (option.kind === "clear") {
                return (
                  <li
                    key="__clear"
                    id={optionId}
                    role="option"
                    aria-selected={value === ""}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(option)}
                    className={cn(
                      "cursor-pointer px-3 py-2 text-sm text-ink-faint",
                      isActive && "bg-surface-2",
                    )}
                  >
                    No project
                  </li>
                );
              }
              return (
                <li
                  key={option.project.id}
                  id={optionId}
                  role="option"
                  aria-selected={option.project.id === value}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(option)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-ink",
                    isActive && "bg-surface-2",
                  )}
                >
                  <span className="truncate">{option.project.name}</span>
                  <Pill className="shrink-0">
                    {PROJECT_STATUS_LABELS[option.project.status] ?? option.project.status}
                  </Pill>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export default ProjectPicker;
