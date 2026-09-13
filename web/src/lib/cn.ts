/**
 * Minimal `clsx`-style classname joiner — no dependency needed for the
 * handful of conditional classes the component kit composes. Accepts
 * strings/numbers (kept as-is), falsy values (dropped), and objects (keys
 * kept when their value is truthy).
 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | Record<string, boolean | null | undefined>;

export function cn(...values: ClassValue[]): string {
  const classes: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      classes.push(String(value));
      continue;
    }
    for (const [key, enabled] of Object.entries(value)) {
      if (enabled) {
        classes.push(key);
      }
    }
  }
  return classes.join(" ");
}
