import { useEffect, useState } from "react";

/**
 * Returns a copy of `value` that only updates after it has stopped changing
 * for `delayMs` — the standard "settle before acting" debounce. The app's
 * first consumer is `TransactionsScreen`'s search box: binding the input
 * straight to state gives instant typing feedback, while the query reads this
 * debounced mirror so a burst of keystrokes fires one request, not one per
 * character. Each change resets the timer (cleanup clears the pending one),
 * so only a `delayMs` pause commits the latest value.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
