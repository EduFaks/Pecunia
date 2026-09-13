import type { SelectOption } from "../../components/ui/Select";

/** Mirrors backend `AccountType` (`api/src/pecunia/models/account.py`).
 * Shared between `AccountForm`'s type `Select` and `AccountsScreen`/
 * `AccountDetail`'s row/header type label — kept in its own module (not
 * exported from a component file) so both stay Fast-Refresh-friendly. */
export const ACCOUNT_TYPE_OPTIONS: SelectOption[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit card" },
  { value: "cash", label: "Cash" },
  { value: "brokerage", label: "Brokerage" },
  { value: "wallet", label: "Wallet" },
];

export const ACCOUNT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  ACCOUNT_TYPE_OPTIONS.map((option) => [option.value, option.label]),
);
