import { cn } from "../../lib/cn";
import type { TransferOut } from "./useTransfers";

export interface TransferBadgeProps {
  /** The leg's signed amount — its sign is the direction: negative is the
   * outflow leg (money leaving this account → "Transfer to {destination}"),
   * positive is the inflow leg ("Transfer from {source}"). */
  amountMinor: number;
  /** The `TransferOut` this leg belongs to, resolved from its `transfer_id`
   * via the id→transfer map the screen builds. `null` while the transfers
   * list is still loading (or otherwise unresolvable) — the badge then falls
   * back to a plain directional label without a counterpart name. */
  transfer: TransferOut | null;
  /** Resolves an account id to its display name (same resolver the row's
   * other metadata uses). */
  accountName: (id: string) => string;
  className?: string;
}

/**
 * Row label for a transfer leg — the transfers analogue of `CategoryBadge`/
 * `ContactBadge`, rendered *instead of* a category/contact on a leg (a leg carries
 * neither). Reads the counterpart account off the transfer by the leg's sign:
 * the outflow leg (negative) names the transfer's `to_account_id`, the inflow
 * leg (positive) names its `from_account_id`. Text stays token-driven
 * (`text-ink-2`), never colored by direction — CONVENTIONS §9.1 reserves the
 * semantic colors for the amount itself, which the row already colors by sign.
 */
function TransferBadge({ amountMinor, transfer, accountName, className }: TransferBadgeProps) {
  const outflow = amountMinor < 0;

  let label: string;
  if (!transfer) {
    // Counterpart unknown until the transfers list resolves — still convey
    // direction (CONVENTIONS §9.6: never a raw/blank placeholder).
    label = outflow ? "Transfer out" : "Transfer in";
  } else {
    const counterpartId = outflow ? transfer.to_account_id : transfer.from_account_id;
    label = outflow
      ? `Transfer to ${accountName(counterpartId)}`
      : `Transfer from ${accountName(counterpartId)}`;
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-xs text-ink-2", className)}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full border border-hairline-strong bg-surface-2" />
      {label}
    </span>
  );
}

export default TransferBadge;
