import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { CURRENCY_CODES } from "../setup/CurrencySelect";
import { useCreatePortfolio, useUpdatePortfolio } from "./usePortfolios";
import type { PortfolioOut } from "./usePortfolios";

const CURRENCY_OPTIONS: SelectOption[] = CURRENCY_CODES.map((code) => ({ value: code, label: code }));

export interface PortfolioFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  portfolio?: PortfolioOut;
  /** Create mode's currency default (the workspace base currency). Ignored in
   * edit mode (the portfolio's own currency wins). */
  defaultCurrency?: string;
  onSuccess: (portfolio: PortfolioOut) => void;
  onCancel?: () => void;
}

/**
 * Create/edit form for one portfolio: name, currency, and an optional
 * description. Used both as `PortfolioScreen`'s "New portfolio"/"Edit" panel
 * and `PortfolioDetail`'s inline edit panel. Currency is chosen once per
 * portfolio — holdings inherit it (one currency per portfolio in V1) — so
 * editing an existing portfolio's currency is allowed but there's no
 * per-holding currency anywhere.
 */
function PortfolioForm({ portfolio, defaultCurrency, onSuccess, onCancel }: PortfolioFormProps) {
  const isEdit = portfolio !== undefined;

  const [name, setName] = useState(portfolio?.name ?? "");
  const [currency, setCurrency] = useState(
    portfolio?.currency ??
      (defaultCurrency && CURRENCY_CODES.includes(defaultCurrency)
        ? defaultCurrency
        : CURRENCY_CODES[0]),
  );
  const [description, setDescription] = useState(portfolio?.description ?? "");
  const [error, setError] = useState<string | null>(null);

  const createPortfolio = useCreatePortfolio();
  const updatePortfolio = useUpdatePortfolio(portfolio?.id ?? "");
  const isSubmitting = createPortfolio.isPending || updatePortfolio.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setError(null);

    try {
      if (isEdit) {
        const updated = await updatePortfolio.mutateAsync({
          name: trimmedName,
          currency,
          description: description.trim() || null,
        });
        onSuccess(updated);
        return;
      }
      const created = await createPortfolio.mutateAsync({
        name: trimmedName,
        currency,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onSuccess(created);
    } catch {
      setError("Couldn't save this portfolio. Please try again.");
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Name"
        placeholder="e.g. Brokerage"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <Select
        label="Currency"
        options={CURRENCY_OPTIONS}
        value={currency}
        onChange={(event) => setCurrency(event.target.value)}
      />

      <TextField
        label="Description"
        description="Optional — a note about this portfolio."
        placeholder="e.g. Long-term retirement holdings"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!name.trim()}>
          {isEdit ? "Save changes" : "Create portfolio"}
        </Button>
      </div>
    </form>
  );
}

export default PortfolioForm;
