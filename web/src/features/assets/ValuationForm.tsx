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
import { useAddValuation } from "./useAssets";
import type { AssetValuationOut } from "./useAssets";

export interface ValuationFormProps {
  assetId: string;
  /** The asset's own currency — a valuation carries no currency of its own
   * (`AssetValuationIn` has none), so the amount field always converts
   * against the asset it belongs to. */
  currency: string;
  onSuccess: (valuation: AssetValuationOut) => void;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * "Add valuation" panel on `AssetDetail`: a currency-aware value amount
 * (`amountToMinor`, unsigned — a valuation is always a plain value, unlike
 * `TransactionForm`'s signed inflow/outflow), an as-of date (defaults to
 * today), and an optional free-text source ("Appraisal", "KBB estimate",
 * …). On success the asset's `current_value_minor` and valuation-history
 * chart both update via `useAddValuation`'s `qk.assets` invalidation.
 */
function ValuationForm({ assetId, currency, onSuccess }: ValuationFormProps) {
  const [value, setValue] = useState("");
  const [asOf, setAsOf] = useState(todayIsoDate());
  const [source, setSource] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addValuation = useAddValuation(assetId);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!asOf) {
      return;
    }
    setError(null);
    setAmountError(null);

    const valueMinor = amountToMinor(value, currency);
    if (valueMinor === null) {
      setAmountError("Enter a valid amount.");
      return;
    }

    try {
      const created = await addValuation.mutateAsync({
        value_minor: valueMinor,
        as_of: asOf,
        source: source.trim() || null,
      });
      setValue("");
      setSource("");
      onSuccess(created);
    } catch {
      setError("Couldn't add this valuation. Please try again.");
    }
  }

  const canSubmit = value.trim() !== "" && asOf !== "";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="valuation-form-value">Value</FieldLabel>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
            {currency}
          </span>
          <input
            id="valuation-form-value"
            inputMode="decimal"
            placeholder="0.00"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? "valuation-form-value-error" : undefined}
            className={cn(
              textFieldInputClasses,
              amountError ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
              focusRingClass,
            )}
          />
        </div>
        {amountError ? <FieldError id="valuation-form-value-error">{amountError}</FieldError> : null}
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
        placeholder="e.g. Appraisal"
        value={source}
        onChange={(event) => setSource(event.target.value)}
      />

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end">
        <Button type="submit" loading={addValuation.isPending} disabled={!canSubmit}>
          Add valuation
        </Button>
      </div>
    </form>
  );
}

export default ValuationForm;
