import { useId, useMemo, useState } from "react";
import type { FocusEvent } from "react";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { cn } from "../../lib/cn";

export interface Currency {
  code: string;
  name: string;
}

/** Shown first, in this exact order, before the alphabetized remainder —
 * per the Plan 06 spec's "common currencies first" requirement. */
const COMMON_CURRENCY_CODES = ["USD", "EUR", "BRL", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR"];

// A pragmatic, non-exhaustive set of world currencies — enough for a
// personal-finance instance's owner to find their own without shipping the
// full ISO 4217 list. Extending this list later is additive and safe: it's
// display-only, the backend's `base_currency` validation is just a 3-letter
// pattern.
const CURRENCIES: Currency[] = [
  { code: "USD", name: "US Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "GBP", name: "British Pound" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "INR", name: "Indian Rupee" },
  { code: "MXN", name: "Mexican Peso" },
  { code: "ZAR", name: "South African Rand" },
  { code: "SEK", name: "Swedish Krona" },
  { code: "NOK", name: "Norwegian Krone" },
  { code: "DKK", name: "Danish Krone" },
  { code: "PLN", name: "Polish Zloty" },
  { code: "NZD", name: "New Zealand Dollar" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "KRW", name: "South Korean Won" },
  { code: "TRY", name: "Turkish Lira" },
  { code: "RUB", name: "Russian Ruble" },
  { code: "AED", name: "UAE Dirham" },
  { code: "SAR", name: "Saudi Riyal" },
  { code: "ILS", name: "Israeli New Shekel" },
  { code: "THB", name: "Thai Baht" },
  { code: "IDR", name: "Indonesian Rupiah" },
  { code: "MYR", name: "Malaysian Ringgit" },
  { code: "PHP", name: "Philippine Peso" },
  { code: "VND", name: "Vietnamese Dong" },
  { code: "CZK", name: "Czech Koruna" },
  { code: "HUF", name: "Hungarian Forint" },
  { code: "RON", name: "Romanian Leu" },
  { code: "CLP", name: "Chilean Peso" },
  { code: "COP", name: "Colombian Peso" },
  { code: "ARS", name: "Argentine Peso" },
  { code: "PEN", name: "Peruvian Sol" },
  { code: "EGP", name: "Egyptian Pound" },
  { code: "NGN", name: "Nigerian Naira" },
  { code: "PKR", name: "Pakistani Rupee" },
  { code: "BDT", name: "Bangladeshi Taka" },
];

const CURRENCY_BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

const ORDERED_CURRENCIES: Currency[] = [
  ...COMMON_CURRENCY_CODES.map((code) => CURRENCY_BY_CODE.get(code)!),
  ...CURRENCIES.filter((c) => !COMMON_CURRENCY_CODES.includes(c.code)).sort((a, b) =>
    a.name.localeCompare(b.name),
  ),
];

/** Exported so `StepStartingPoint`'s per-account currency picker (a plain
 * `Select`, not this file's searchable combobox) can offer the same
 * common-currencies-first list without duplicating `CURRENCIES` — one
 * source of truth for "which currencies does this wizard know about." */
export const CURRENCY_CODES: string[] = ORDERED_CURRENCIES.map((c) => c.code);

export interface CurrencySelectProps {
  /** The chosen ISO 4217 code (e.g. `"USD"`), or `""` when nothing is
   * chosen yet. */
  value: string;
  onChange: (code: string) => void;
  label?: string;
}

/**
 * The Preferences step's hero control: a searchable currency picker (common
 * currencies first, per `ORDERED_CURRENCIES` above) with a large code
 * display that gets a clean accent ring once a currency is chosen — a
 * quiet "you picked this" marker for the one field in the step the wizard
 * doesn't guess on the user's behalf (unlike locale/timezone/date format,
 * which prefill from `Intl`).
 */
function CurrencySelect({ value, onChange, label = "Base currency" }: CurrencySelectProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return ORDERED_CURRENCIES;
    }
    return ORDERED_CURRENCIES.filter(
      (c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    );
  }, [query]);

  const selected = value ? CURRENCY_BY_CODE.get(value) : undefined;

  function select(code: string) {
    onChange(code);
    setQuery("");
    setOpen(false);
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" onBlur={handleBlur}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>

      <div className="flex items-center gap-4">
        <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
          <span className="font-mono text-xl font-medium tabular-figures text-ink">
            {value || "—"}
          </span>
          {value ? (
            <span
              data-testid="currency-select-circle"
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-accent"
            />
          ) : null}
        </div>
        <div className="flex flex-col">
          <span className="text-sm text-ink">{selected?.name ?? "Choose your primary currency"}</span>
          <span className="text-xs text-ink-faint">Used for reports and totals across the app.</span>
        </div>
      </div>

      <div className="relative">
        <input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          autoComplete="off"
          className={cn(
            textFieldInputClasses,
            "border-hairline focus:border-hairline-strong",
            focusRingClass,
          )}
          placeholder="Search currencies…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
        {open ? (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-pc border border-hairline bg-surface-2 py-1 shadow-pc-2"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-ink-faint">No matches.</li>
            ) : (
              filtered.map((currency) => (
                <li key={currency.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={currency.code === value}
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-3",
                      currency.code === value ? "text-accent" : "text-ink",
                    )}
                    onClick={() => select(currency.code)}
                  >
                    <span className="font-mono tabular-figures">{currency.code}</span>
                    <span className="text-ink-2">{currency.name}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export default CurrencySelect;
