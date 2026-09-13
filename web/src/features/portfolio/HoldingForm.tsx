import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import TextField from "../../components/ui/TextField";
import { parseQuantity } from "./quantity";
import { useAddHolding, useUpdateHolding } from "./usePortfolios";
import type { HoldingOut } from "./usePortfolios";

export interface HoldingFormProps {
  portfolioId: string;
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  holding?: HoldingOut;
  onSuccess: (holding: HoldingOut) => void;
  onCancel?: () => void;
}

/**
 * Create/edit form for one holding: name, an optional ticker symbol, and a
 * quantity (fractional share/unit count, validated via `parseQuantity` and
 * sent as a STRING to preserve exact precision — CONVENTIONS §4: quantity is
 * not money, but never a float either). A holding inherits its portfolio's
 * currency, so there is no currency field here; the price (and thus value) is
 * recorded separately via `PriceUpdateForm`.
 */
function HoldingForm({ portfolioId, holding, onSuccess, onCancel }: HoldingFormProps) {
  const isEdit = holding !== undefined;

  const [name, setName] = useState(holding?.name ?? "");
  const [symbol, setSymbol] = useState(holding?.symbol ?? "");
  const [quantity, setQuantity] = useState(holding?.quantity ?? "");
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addHolding = useAddHolding(portfolioId);
  const updateHolding = useUpdateHolding(portfolioId, holding?.id ?? "");
  const isSubmitting = addHolding.isPending || updateHolding.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setError(null);
    setQuantityError(null);

    const normalizedQuantity = parseQuantity(quantity);
    if (normalizedQuantity === null) {
      setQuantityError("Enter a quantity greater than zero.");
      return;
    }

    try {
      if (isEdit) {
        const updated = await updateHolding.mutateAsync({
          name: trimmedName,
          quantity: normalizedQuantity,
          symbol: symbol.trim() || null,
        });
        onSuccess(updated);
        return;
      }
      const created = await addHolding.mutateAsync({
        name: trimmedName,
        quantity: normalizedQuantity,
        symbol: symbol.trim() || null,
      });
      onSuccess(created);
    } catch {
      setError("Couldn't save this holding. Please try again.");
    }
  }

  const canSubmit = name.trim() !== "" && quantity.trim() !== "";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Name"
        placeholder="e.g. Vanguard S&P 500 ETF"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Symbol"
          description="Optional ticker."
          placeholder="e.g. VOO"
          value={symbol}
          onChange={(event) => setSymbol(event.target.value)}
        />
        <TextField
          label="Quantity"
          inputMode="decimal"
          placeholder="e.g. 12.5"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          error={quantityError ?? undefined}
          required
        />
      </div>

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!canSubmit}>
          {isEdit ? "Save changes" : "Add holding"}
        </Button>
      </div>
    </form>
  );
}

export default HoldingForm;
