import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldError, FieldLabel } from "../../components/ui/Field";
import TextField from "../../components/ui/TextField";
import { textFieldInputClasses } from "../../components/ui/TextField";
import { amountToMinor } from "../../lib/amount";
import { cn } from "../../lib/cn";
import { useRecordPrice } from "./usePortfolios";
import type { HoldingPriceOut } from "./usePortfolios";

export interface PriceUpdateFormProps {
  portfolioId: string;
  holdingId: string;
  /** The parent portfolio's currency — a price carries no currency of its own
   * (`HoldingPriceIn` has none), so the unit-price field always converts
   * against the portfolio the holding belongs to. */
  currency: string;
  onSuccess: (price: HoldingPriceOut) => void;
  onCancel?: () => void;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * "Record price" panel: a currency-aware unit-price amount
 * (`amountToMinor`, unsigned — a price is always a plain per-unit value), an
 * as-of date (defaults to today, mirroring `ValuationForm`), and an optional
 * free-text source. On success the holding's `latest_unit_price_minor`, its
 * `value_minor`, and the portfolio's total all update via `useRecordPrice`'s
 * `qk.portfolios` invalidation.
 */
function PriceUpdateForm({
  portfolioId,
  holdingId,
  currency,
  onSuccess,
  onCancel,
}: PriceUpdateFormProps) {
  const [price, setPrice] = useState("");
  const [asOf, setAsOf] = useState(todayIsoDate());
  const [source, setSource] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recordPrice = useRecordPrice(portfolioId, holdingId);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!asOf) {
      return;
    }
    setError(null);
    setAmountError(null);

    const unitPriceMinor = amountToMinor(price, currency);
    if (unitPriceMinor === null) {
      setAmountError("Enter a valid amount.");
      return;
    }

    try {
      const created = await recordPrice.mutateAsync({
        unit_price_minor: unitPriceMinor,
        as_of: asOf,
        source: source.trim() || null,
      });
      setPrice("");
      setSource("");
      onSuccess(created);
    } catch {
      setError("Couldn't record this price. Please try again.");
    }
  }

  const canSubmit = price.trim() !== "" && asOf !== "";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="price-form-unit-price">Unit price</FieldLabel>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
            {currency}
          </span>
          <input
            id="price-form-unit-price"
            inputMode="decimal"
            placeholder="0.00"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? "price-form-unit-price-error" : undefined}
            className={cn(
              textFieldInputClasses,
              amountError ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
              focusRingClass,
            )}
          />
        </div>
        {amountError ? (
          <FieldError id="price-form-unit-price-error">{amountError}</FieldError>
        ) : null}
      </div>

      <TextField
        label="Date"
        type="date"
        value={asOf}
        onChange={(event) => setAsOf(event.target.value)}
        required
      />
      <TextField
        label="Source"
        placeholder="e.g. Broker statement"
        value={source}
        onChange={(event) => setSource(event.target.value)}
      />

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={recordPrice.isPending} disabled={!canSubmit}>
          Record price
        </Button>
      </div>
    </form>
  );
}

export default PriceUpdateForm;
