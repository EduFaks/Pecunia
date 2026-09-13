import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { cn } from "../../lib/cn";
import { MoneyText } from "../../lib/preferences";
import { useLoans } from "./useLoans";
import type { LoanOut } from "./useLoans";

export interface LoanPickerProps {
  label?: string;
  /** Fires with the loan the user picks — the parent then applies the
   * transaction to it (the apply-to-loan action). Like `TransactionPicker`,
   * this is a one-shot *action* picker, not a bound field: you open it, find a
   * loan, and select it. */
  onSelect: (loan: LoanOut) => void;
  id?: string;
  className?: string;
}

/**
 * Type-to-filter loan autocomplete for the transactions "Apply to loan" flow —
 * the same combobox+listbox shape as `TransactionPicker`/`ContactPicker` (a
 * text `<input role="combobox">` over a `<ul role="listbox">` of
 * `role="option"` rows), reused so applying a transaction to a loan reads like
 * picking a transaction to attach.
 *
 * Only **active** loans are offered — those with a remaining balance
 * (`remaining_minor > 0`); a fully-paid loan has nothing left to apply a
 * payment to. Each option shows the loan's remaining so near-duplicate names
 * are still distinguishable. Fetches its own data (`useLoans`, a bounded flat
 * read) — the same self-contained-hook move `TransactionPicker` makes.
 */
function LoanPicker({ label = "Loan", onSelect, id, className }: LoanPickerProps) {
  const autoId = useId();
  const inputId = id ?? `loan-picker-${autoId}`;
  const listboxId = `${inputId}-listbox`;

  const loansQuery = useLoans();
  // Active = still has a balance to pay down; a settled loan (remaining 0) has
  // nothing to apply a payment to.
  const loans = (loansQuery.data?.items ?? []).filter((loan) => loan.remaining_minor > 0);

  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

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
  const matches =
    filter === "" ? loans : loans.filter((loan) => loan.name.toLowerCase().includes(filter));
  const clampedActive = Math.min(activeIndex, Math.max(matches.length - 1, 0));

  function commit(loan: LoanOut | undefined) {
    if (!loan) {
      return;
    }
    onSelect(loan);
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
      setActiveIndex((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      if (open && matches[clampedActive]) {
        event.preventDefault();
        commit(matches[clampedActive]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const activeOptionId = open && matches.length > 0 ? `${listboxId}-opt-${clampedActive}` : undefined;

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
          placeholder="Search loans…"
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
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
            {matches.length === 0 ? (
              <li role="option" aria-selected={false} aria-disabled className="px-3 py-2 text-sm text-ink-faint">
                No active loans
              </li>
            ) : (
              matches.map((loan, index) => {
                const isActive = index === clampedActive;
                const optionId = `${listboxId}-opt-${index}`;
                return (
                  <li
                    key={loan.id}
                    id={optionId}
                    role="option"
                    aria-selected={isActive}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(loan)}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-ink",
                      isActive && "bg-surface-2",
                    )}
                  >
                    <span className="min-w-0 truncate">{loan.name}</span>
                    <span className="shrink-0 font-mono text-xs text-ink-faint">
                      <MoneyText minor={loan.remaining_minor} currency={loan.currency} /> left
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export default LoanPicker;
