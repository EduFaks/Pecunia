import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { minorToAmountInput } from "../../lib/amount";
import { cn } from "../../lib/cn";
import { DateText, MoneyText } from "../../lib/preferences";
import { useTransactionList } from "./useTransactions";
import type { TransactionOut } from "./useTransactions";

export interface TransactionPickerProps {
  label?: string;
  /** Fires with the transaction the user picks — the parent then attaches it
   * to the part (the mark-bought action). Unlike `ContactPicker`/`ProjectPicker`
   * this is a one-shot *action* picker, not a bound field, so there's no
   * persistent `value` or "clear" row: you open it, find a transaction, and
   * select it. */
  onSelect: (transaction: TransactionOut) => void;
  id?: string;
  className?: string;
}

/**
 * Type-to-filter transaction autocomplete for `ProjectDetail`'s
 * mark-a-part-bought flow — the same combobox+listbox shape as `ContactPicker`
 * (a text `<input role="combobox">` over a `<ul role="listbox">` of
 * `role="option"` rows), reused so attaching a transaction reads like picking
 * a contact. **Select existing only** — you can only pick a transaction that
 * already exists; there's no inline create. The filter matches a
 * transaction's description *or* its amount (both are how you'd recognise the
 * one you want), and each option shows the amount and date so near-duplicate
 * descriptions are still distinguishable.
 *
 * Fetches its own data (`useTransactionList`, a bounded recent page) — the
 * same self-contained-hook move `ContactPicker` makes — so no caller plumbs the
 * list down. The backend still guards the invariant (a transaction already
 * fulfilling another part is rejected 409), so this list doesn't have to
 * pre-exclude anything.
 */
function TransactionPicker({ label = "Transaction", onSelect, id, className }: TransactionPickerProps) {
  const autoId = useId();
  const inputId = id ?? `transaction-picker-${autoId}`;
  const listboxId = `${inputId}-listbox`;

  const transactionsQuery = useTransactionList();
  const transactions = transactionsQuery.data?.items ?? [];

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
    filter === ""
      ? transactions
      : transactions.filter((transaction) => {
          const amountText = minorToAmountInput(Math.abs(transaction.amount_minor), transaction.currency);
          return (
            transaction.description.toLowerCase().includes(filter) || amountText.includes(filter)
          );
        });
  const clampedActive = Math.min(activeIndex, Math.max(matches.length - 1, 0));

  function commit(transaction: TransactionOut | undefined) {
    if (!transaction) {
      return;
    }
    onSelect(transaction);
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
          placeholder="Search transactions…"
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
                No transactions match
              </li>
            ) : (
              matches.map((transaction, index) => {
                const isActive = index === clampedActive;
                const optionId = `${listboxId}-opt-${index}`;
                return (
                  <li
                    key={transaction.id}
                    id={optionId}
                    role="option"
                    aria-selected={isActive}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(transaction)}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-ink",
                      isActive && "bg-surface-2",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{transaction.description}</span>
                      <span className="font-mono text-xs text-ink-faint">
                        <DateText iso={transaction.occurred_on} />
                      </span>
                    </span>
                    <MoneyText
                      minor={transaction.amount_minor}
                      currency={transaction.currency}
                      colorBySign
                      className="shrink-0"
                    />
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

export default TransactionPicker;
