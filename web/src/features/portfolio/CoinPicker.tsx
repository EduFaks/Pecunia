import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { cn } from "../../lib/cn";
import { useDebouncedValue } from "../../lib/useDebounced";
import { useCoinSearch } from "./usePortfolios";
import type { CoinOut } from "./usePortfolios";

export interface CoinPickerProps {
  label?: string;
  /** A CoinGecko coin id, or `""` for "no automatic pricing" — a real coin
   * id is never `""`. */
  value: string;
  /** Fires with the chosen coin's id (or `""` when cleared) and the full
   * `CoinOut` (or `null`). */
  onChange: (coinId: string, coin: CoinOut | null) => void;
  id?: string;
  className?: string;
}

/** A synthetic listbox row for clearing the selection — always present,
 * never filtered out (mirrors `ContactPicker`'s "No contact" row). */
type Option = { kind: "clear" } | { kind: "coin"; coin: CoinOut };

function displayLabel(coin: CoinOut): string {
  return `${coin.name} (${coin.symbol.toUpperCase()})`;
}

/**
 * Type-to-search crypto-coin autocomplete for `HoldingForm`'s "auto-price
 * with CoinGecko" field. Unlike `ContactPicker` (which filters an already-
 * fetched full list client-side), the coin catalog is server-searched —
 * `useCoinSearch` hits `GET /portfolios/coins?q=`, debounced (300ms, same
 * window as the transactions search box) so typing doesn't fire a request
 * per keystroke, and only while the dropdown is open (closed = no fetch at
 * all).
 *
 * There is no "get coin by id" endpoint, so an already-set `value` (edit
 * mode) is shown as its raw CoinGecko id until the user searches and picks a
 * coin, at which point the field switches to that coin's friendly
 * "Name (SYMBOL)" label. A "No automatic pricing" row at the top clears the
 * selection, mirroring `ContactPicker`'s "No contact" row.
 */
function CoinPicker({
  label = "Auto-price with CoinGecko",
  value,
  onChange,
  id,
  className,
}: CoinPickerProps) {
  const autoId = useId();
  const inputId = id ?? `coin-picker-${autoId}`;
  const listboxId = `${inputId}-listbox`;

  const [inputValue, setInputValue] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedCoin, setSelectedCoin] = useState<CoinOut | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // The externally-selected value changed (a fresh holding loaded into edit
  // mode, or a programmatic clear) — resync the visible text. Plain typing
  // never changes `value`, so this never fights the user's keystrokes.
  useEffect(() => {
    setInputValue(value);
    if (value === "") {
      setSelectedCoin(null);
    }
  }, [value]);

  const debouncedQuery = useDebouncedValue(inputValue, 300);
  const coinsQuery = useCoinSearch(debouncedQuery, open);
  const matches = coinsQuery.data ?? [];

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

  const options: Option[] = [
    { kind: "clear" },
    ...matches.map((coin) => ({ kind: "coin" as const, coin })),
  ];
  const clampedActive = Math.min(activeIndex, options.length - 1);

  function commit(option: Option) {
    if (option.kind === "clear") {
      setSelectedCoin(null);
      setInputValue("");
      onChange("", null);
    } else {
      setSelectedCoin(option.coin);
      setInputValue(displayLabel(option.coin));
      onChange(option.coin.id, option.coin);
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
    // Runs on the next tick so an option's click (which preventDefaults its
    // mousedown) lands first.
    window.setTimeout(() => {
      if (containerRef.current?.contains(document.activeElement)) {
        return;
      }
      setOpen(false);
      setInputValue(selectedCoin ? displayLabel(selectedCoin) : value);
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
          placeholder="Search coins (e.g. Bitcoin)…"
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
            setSelectedCoin(null);
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
                    No automatic pricing
                  </li>
                );
              }
              return (
                <li
                  key={option.coin.id}
                  id={optionId}
                  role="option"
                  aria-selected={option.coin.id === value}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(option)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-ink",
                    isActive && "bg-surface-2",
                  )}
                >
                  <span className="truncate">{option.coin.name}</span>
                  <span className="shrink-0 font-mono text-xs uppercase text-ink-faint">
                    {option.coin.symbol}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export default CoinPicker;
