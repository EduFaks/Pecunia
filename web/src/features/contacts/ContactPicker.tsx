import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import Avatar from "../../components/ui/Avatar";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { cn } from "../../lib/cn";
import CategoryBadge from "../categories/CategoryBadge";
import { useCategories } from "../categories/useCategories";
import { useContacts } from "./useContacts";
import type { ContactOut } from "./useContacts";

export interface ContactPickerProps {
  label?: string;
  /** A contact id, or `""` for "no contact" — mirrors `CategoryPicker`'s
   * empty-string sentinel, since a real contact id (a UUID) is never `""`. */
  value: string;
  /** Fires with the chosen contact's id (or `""` when cleared) and the full
   * `ContactOut` (or `null`). The object is handed back so the caller can read
   * `default_category_id` without a second lookup — `TransactionForm` uses it
   * for the empty-category default-fill. */
  onChange: (contactId: string, contact: ContactOut | null) => void;
  id?: string;
  className?: string;
}

/** A synthetic listbox row for clearing the selection — always present,
 * never filtered out. */
type Option = { kind: "clear" } | { kind: "contact"; contact: ContactOut };

/**
 * Type-to-filter contact autocomplete for `TransactionForm`/`ScheduleForm`.
 * Unlike `CategoryPicker` (a native `<select>` grouped by kind), a contact
 * list is unbounded and wants substring search, so this is a custom
 * combobox+listbox: a text `<input role="combobox">` over a `<ul
 * role="listbox">` of `role="option"` rows. Going custom also lets each option
 * carry an `Avatar` and a `CategoryBadge` for the contact's default category —
 * a native `<option>` can only hold plain text.
 *
 * **Select existing only** — there is no inline "create contact"; the
 * `ContactsScreen` owns creation. Free text that matches no contact is
 * discarded on blur (the input snaps back to the selected contact's name), so
 * the field can only ever hold a real contact or nothing. A "No contact" row
 * at the top clears the selection.
 *
 * Fetches its own data (`useContacts(true)` including archived, plus
 * `useCategories(true)` to resolve the default-category hint) — the same
 * self-contained-hook move `CategoryPicker` makes — so no caller has to plumb
 * lists down. Archived contacts are hidden unless one is the current value (an
 * already-attached contact shouldn't vanish from its own field just because it
 * was later archived).
 *
 * Keyboard: ArrowUp/Down move the active row (`aria-activedescendant`), Enter
 * commits it, Escape closes. Focus opens the list.
 */
function ContactPicker({ label = "Contact", value, onChange, id, className }: ContactPickerProps) {
  const autoId = useId();
  const inputId = id ?? `contact-picker-${autoId}`;
  const listboxId = `${inputId}-listbox`;

  const contactsQuery = useContacts(true);
  const contacts = contactsQuery.data?.items ?? [];
  const categoriesQuery = useCategories(true);
  const categories = categoriesQuery.data?.items ?? [];
  const categoryFor = (categoryId: string | null) =>
    categories.find((category) => category.id === categoryId) ?? null;

  const selected = contacts.find((contact) => contact.id === value) ?? null;

  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the visible text in sync with the externally-selected contact — this
  // is what prefills the field in edit mode and reflects a fresh selection.
  // Keyed on the selected id/name (not `inputValue`), so plain typing (which
  // never changes `value`) is left untouched.
  useEffect(() => {
    setInputValue(selected?.name ?? "");
  }, [selected?.id, selected?.name]);

  // Close on an outside click (a real-usage nicety; tests drive selection
  // directly). Options `preventDefault` on mousedown so an option click never
  // blurs the input before its `onClick` runs.
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
  const active = contacts.filter((contact) => !contact.archived_at || contact.id === value);
  // While the input still shows the selected contact's name (the user hasn't
  // typed a new query), show the whole list — so reopening the field to
  // switch contacts isn't stuck showing only the current one.
  const showAll = filter === "" || (selected !== null && filter === selected.name.trim().toLowerCase());
  const matches = showAll ? active : active.filter((contact) => contact.name.toLowerCase().includes(filter));

  const options: Option[] = [{ kind: "clear" }, ...matches.map((contact) => ({ kind: "contact" as const, contact }))];
  const clampedActive = Math.min(activeIndex, options.length - 1);

  function commit(option: Option) {
    if (option.kind === "clear") {
      onChange("", null);
    } else {
      onChange(option.contact.id, option.contact);
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
    // Enforce select-existing-only: any free text that didn't resolve to a
    // contact is thrown away, snapping the field back to what's actually
    // selected. Runs on the next tick so an option's click lands first.
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
          placeholder="Search contacts…"
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
                    No contact
                  </li>
                );
              }
              const defaultCategory = categoryFor(option.contact.default_category_id);
              return (
                <li
                  key={option.contact.id}
                  id={optionId}
                  role="option"
                  aria-selected={option.contact.id === value}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(option)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-ink",
                    isActive && "bg-surface-2",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar
                      src={option.contact.avatar}
                      name={option.contact.name}
                      type={option.contact.type}
                      size="sm"
                    />
                    <span className="truncate">
                      {option.contact.name}
                      {option.contact.archived_at ? (
                        <span className="ml-1 text-ink-faint">(archived)</span>
                      ) : null}
                    </span>
                  </span>
                  {defaultCategory ? (
                    <CategoryBadge category={defaultCategory} className="shrink-0" />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export default ContactPicker;
