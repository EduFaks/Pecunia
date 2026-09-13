import type { SelectOption } from "../../components/ui/Select";

/** Mirrors backend `AssetType` (`api/src/pecunia/models/asset.py`). Same
 * "options + labels derived from one list" shape as
 * `features/accounts/accountTypes.ts`. */
export const ASSET_TYPE_OPTIONS: SelectOption[] = [
  { value: "vehicle", label: "Vehicle" },
  { value: "property", label: "Property" },
  { value: "investment", label: "Investment" },
  { value: "watch", label: "Watch" },
  { value: "other", label: "Other" },
];

export const ASSET_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  ASSET_TYPE_OPTIONS.map((option) => [option.value, option.label]),
);
