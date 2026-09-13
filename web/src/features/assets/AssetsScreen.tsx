import { useState } from "react";
import { Link } from "react-router-dom";
import DataList from "../../components/data/DataList";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import SummaryHeader from "../../components/ui/SummaryHeader";
import type { SummaryStat } from "../../components/ui/SummaryHeader";
import { useToast } from "../../components/ui/Toast";
import { apiFetch } from "../../lib/api";
import { MoneyText } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import { sumByCurrency } from "../_shared/totals";
import AssetForm from "./AssetForm";
import { ASSET_TYPE_LABELS } from "./assetTypes";
import { useAssets } from "./useAssets";
import type { AssetOut, AssetPage } from "./useAssets";

/** One walked page's size for the assets `DataList` — same rationale as
 * `AccountsScreen`'s `PAGE_LIMIT`. */
const PAGE_LIMIT = 20;

type FormState = { mode: "create" } | { mode: "edit"; asset: AssetOut };

/**
 * `/assets` — the assets list: name, type, `MoneyText` current value, and
 * inline create/edit via `AssetForm`. `DataList` owns the keyset walk (`GET
 * /assets?cursor=&limit=`). `current_value_minor` is `null` until the asset
 * has at least one valuation — rendered as a plain em dash rather than a
 * `MoneyText` of zero (an unvalued asset isn't worth $0, it's simply
 * unvalued yet).
 */
function AssetsScreen() {
  const { showToast } = useToast();
  const [formState, setFormState] = useState<FormState | null>(null);

  // The summary header's own bounded flat read (Track P) — independent of
  // `DataList`'s keyset walk below, same rationale as `AccountsScreen`'s
  // `useAccounts` call. Unvalued assets (`current_value_minor: null`) are
  // skipped rather than counted as zero — a missing valuation isn't "worth
  // nothing", it's unknown.
  const assetsForTotals = (useAssets().data?.items ?? []).filter(
    (asset): asset is AssetOut & { current_value_minor: number } => asset.current_value_minor !== null,
  );
  const valueStats: SummaryStat[] = [
    {
      label: "Total value",
      entries: sumByCurrency(
        assetsForTotals,
        (asset) => asset.current_value_minor,
        (asset) => asset.currency,
      ).map(({ currency, total_minor }) => ({ currency, value_minor: total_minor })),
    },
  ];

  function fetchPage(cursor: string | null) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return apiFetch<AssetPage>(`/assets?${params.toString()}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Assets</h1>
        <Button onClick={() => setFormState({ mode: "create" })}>New asset</Button>
      </div>

      {assetsForTotals.length > 0 ? <SummaryHeader stats={valueStats} /> : null}

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {formState.mode === "edit" ? "Edit asset" : "New asset"}
          </h2>
          <div className="mt-4">
            <AssetForm
              asset={formState.mode === "edit" ? formState.asset : undefined}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Asset updated." : "Asset created.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      <DataList<AssetOut>
        queryKey={qk.assets}
        fetchPage={fetchPage}
        empty={
          <EmptyState
            title="No assets yet"
            body="Add your first asset to start tracking its value over time."
            action={<Button onClick={() => setFormState({ mode: "create" })}>Add your first asset</Button>}
          />
        }
        renderRow={(asset) => (
          <div className="flex items-center justify-between gap-4 py-3">
            <Link to={`/assets/${asset.id}`} className="min-w-0">
              <p className="truncate font-sans text-sm text-ink hover:text-accent">{asset.name}</p>
              <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
                {ASSET_TYPE_LABELS[asset.type] ?? asset.type}
              </p>
            </Link>
            <div className="flex shrink-0 items-center gap-4">
              {asset.current_value_minor !== null ? (
                <MoneyText minor={asset.current_value_minor} currency={asset.currency} />
              ) : (
                <span className="font-mono text-sm text-ink-faint">—</span>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFormState({ mode: "edit", asset })}
              >
                Edit
              </Button>
            </div>
          </div>
        )}
      />
    </div>
  );
}

export default AssetsScreen;
