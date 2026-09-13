import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { CURRENCY_CODES } from "../setup/CurrencySelect";
import { ASSET_TYPE_OPTIONS } from "./assetTypes";
import { useCreateAsset, useUpdateAsset } from "./useAssets";
import type { AssetOut, AssetType } from "./useAssets";

const CURRENCY_OPTIONS: SelectOption[] = CURRENCY_CODES.map((code) => ({ value: code, label: code }));

export interface AssetFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  asset?: AssetOut;
  /** Create mode's currency default. Ignored in edit mode (the asset's own
   * currency wins). */
  defaultCurrency?: string;
  onSuccess: (asset: AssetOut) => void;
  onCancel?: () => void;
}

/** Error → copy map (CONVENTIONS §9.6) — no named backend error is specific
 * to assets today, so every failure gets the same generic fallback rather
 * than a raw error string. */
function assetErrorMessage(): string {
  return "Couldn't save this asset. Please try again.";
}

/**
 * Create/edit form for one asset: name, type, currency, and an optional
 * acquired-on date. Used both as `AssetsScreen`'s "New asset"/"Edit" panel
 * and `AssetDetail`'s inline edit panel.
 */
function AssetForm({ asset, defaultCurrency, onSuccess, onCancel }: AssetFormProps) {
  const isEdit = asset !== undefined;

  const [name, setName] = useState(asset?.name ?? "");
  const [type, setType] = useState<AssetType>(asset?.type ?? "vehicle");
  const [currency, setCurrency] = useState(
    asset?.currency ?? (defaultCurrency && CURRENCY_CODES.includes(defaultCurrency) ? defaultCurrency : CURRENCY_CODES[0]),
  );
  const [acquiredOn, setAcquiredOn] = useState(asset?.acquired_on ?? "");
  const [error, setError] = useState<string | null>(null);

  const createAsset = useCreateAsset();
  const updateAsset = useUpdateAsset(asset?.id ?? "");
  const isSubmitting = createAsset.isPending || updateAsset.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setError(null);

    try {
      if (isEdit) {
        const updated = await updateAsset.mutateAsync({
          name: trimmedName,
          type,
          currency,
          acquired_on: acquiredOn || null,
        });
        onSuccess(updated);
        return;
      }
      const created = await createAsset.mutateAsync({
        name: trimmedName,
        type,
        currency,
        ...(acquiredOn ? { acquired_on: acquiredOn } : {}),
      });
      onSuccess(created);
    } catch {
      setError(assetErrorMessage());
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Name"
        placeholder="e.g. 1967 Mustang"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Type"
          options={ASSET_TYPE_OPTIONS}
          value={type}
          onChange={(event) => setType(event.target.value as AssetType)}
        />
        <Select
          label="Currency"
          options={CURRENCY_OPTIONS}
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        />
      </div>

      <TextField
        label="Acquired on"
        description="Optional — when this asset was acquired."
        type="date"
        value={acquiredOn}
        onChange={(event) => setAcquiredOn(event.target.value)}
      />

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!name.trim()}>
          {isEdit ? "Save changes" : "Create asset"}
        </Button>
      </div>
    </form>
  );
}

export default AssetForm;
