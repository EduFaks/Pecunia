import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { describeTrend, trendDirection } from "../../components/charts/chartMath";
import type { ChartPoint, TrendDirection } from "../../components/charts/chartMath";
import DataList from "../../components/data/DataList";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart";
import type { ChartConfig } from "../../components/ui/chart";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { apiFetch } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { formatMoney, minorUnitFactor } from "../../lib/money";
import { DateText, MoneyText } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import AssetForm from "./AssetForm";
import ValuationForm from "./ValuationForm";
import { ASSET_TYPE_LABELS } from "./assetTypes";
import { useAsset, useDeleteAsset } from "./useAssets";
import type { AssetValuationOut, AssetValuationPage } from "./useAssets";

/** One walked page's size for this asset's valuation-history `DataList`. */
const PAGE_LIMIT = 20;
/** How many of the most recent valuations to walk when building the
 * trend chart — a bounded flat fetch distinct from the paginated
 * `DataList` below, same "chart gets a bounded snapshot, the list owns the
 * full keyset walk" split `Dashboard`/`AccountDetail` use (see
 * `qk.assetValuations`'s docstring for why these two live under different
 * cache keys despite reading the same endpoint). */
const CHART_FETCH_LIMIT = 60;

/**
 * Reconstructs the chronological (oldest → newest) series the valuation chart
 * expects from `GET /assets/{id}/valuations`'s newest-first (`as_of desc`)
 * page — the same "reverse the keyset order" move `balanceSeries.ts` does
 * for transactions.
 */
function buildValuationSeries(valuationsNewestFirst: AssetValuationOut[]): ChartPoint[] {
  return [...valuationsNewestFirst]
    .reverse()
    .map((valuation) => ({ date: valuation.as_of, valueMinor: valuation.value_minor }));
}

/** An asset's value trend is real value movement (CONVENTIONS §9.1), so the
 * series is delta-colored: emerald as it rises, coral as it falls, and neutral
 * white when it's flat (never green-by-default). */
const TREND_COLOR: Record<TrendDirection, string> = {
  up: "var(--pc-positive)",
  down: "var(--pc-negative)",
  flat: "var(--pc-text)",
};

/** A compact money axis tick ($1.2k, ¥3M) from integer minor units — full
 * amounts stay on the tooltip (via `formatMoney`); the axis gets the short
 * form so long tick labels don't crowd the plot. */
function compactMoney(minor: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(minor / minorUnitFactor(currency, locale));
}

/**
 * The valuation-history chart — a Recharts `AreaChart` via `ChartContainer`
 * (x = valuation date, y = value). The single series is delta-colored by its
 * own trend (`trendDirection` → emerald up / coral down / neutral flat, driven
 * through the `--color-valueMinor` config var), which is exactly the value
 * movement §9.1 reserves emerald/coral for. `isAnimationActive` is off so the
 * draw-in never fights the reduced-motion policy and the render is
 * deterministic; the labeled `ChartContainer` (`role="img"` + a trend
 * `aria-label`) carries the summary for assistive tech.
 */
function ValuationChart({
  points,
  currency,
  label,
  locale,
}: {
  points: ChartPoint[];
  currency: string;
  label: string;
  locale?: string;
}) {
  const config: ChartConfig = {
    valueMinor: { label: "Value", color: TREND_COLOR[trendDirection(points)] },
  };
  return (
    <ChartContainer
      config={config}
      className="h-64 w-full"
      role="img"
      aria-label={describeTrend(label, points, currency, locale)}
    >
      <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value) => formatDate(String(value), { locale })}
        />
        <YAxis
          width={56}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value) => compactMoney(Number(value), currency, locale)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => formatDate(String(value), { locale })}
              valueFormatter={(value) => formatMoney(Number(value), currency, locale)}
            />
          }
        />
        <Area
          dataKey="valueMinor"
          type="monotone"
          stroke="var(--color-valueMinor)"
          fill="var(--color-valueMinor)"
          fillOpacity={0.08}
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 3 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

/**
 * `/assets/:id` — one asset's detail: header (name, type, live
 * `current_value_minor`), a delta-colored valuation-history `ValuationChart`
 * (emerald when the series has risen from its first point to its last, coral
 * when it has declined — CONVENTIONS: emerald/coral are reserved for real value
 * movement, and an asset's value trend is exactly that), "Add valuation"
 * (`ValuationForm`), the valuation-history `DataList`, and inline edit/delete
 * for the asset itself.
 */
function AssetDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const assetQuery = useAsset(id);
  const deleteAsset = useDeleteAsset();

  const chartQuery = useQuery({
    queryKey: [...qk.assetValuations(id ?? ""), "chart"],
    queryFn: () =>
      apiFetch<AssetValuationPage>(`/assets/${id}/valuations?limit=${CHART_FETCH_LIMIT}`),
    enabled: id !== undefined,
  });

  function fetchPage(cursor: string | null) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return apiFetch<AssetValuationPage>(`/assets/${id}/valuations?${params.toString()}`);
  }

  async function handleDelete() {
    if (!id) {
      return;
    }
    try {
      await deleteAsset.mutateAsync(id);
      showToast("Asset deleted.");
      navigate("/assets");
    } catch {
      showToast("Couldn't delete this asset. Please try again.", { variant: "negative" });
    } finally {
      setConfirmingDelete(false);
    }
  }

  if (assetQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading asset" />
      </div>
    );
  }

  if (assetQuery.isError || !assetQuery.data) {
    return <Callout variant="negative">Couldn't load this asset.</Callout>;
  }

  const asset = assetQuery.data;
  const series = buildValuationSeries(chartQuery.data?.items ?? []);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
            {ASSET_TYPE_LABELS[asset.type] ?? asset.type}
          </p>
          <h1 className="mt-1 font-display text-2xl text-ink">{asset.name}</h1>
          {asset.current_value_minor !== null ? (
            <MoneyText
              minor={asset.current_value_minor}
              currency={asset.currency}
              variant="hero"
              className="mt-2 block text-3xl"
            />
          ) : (
            <p className="mt-2 text-sm text-ink-faint">No valuation recorded yet.</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setIsEditing((editing) => !editing)}>
            {isEditing ? "Cancel" : "Edit"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={deleteAsset.isPending}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      {confirmingDelete ? (
        <ConfirmDialog
          title={`Delete "${asset.name}"?`}
          description="This permanently deletes the asset and its entire valuation history. This can't be undone."
          confirmLabel="Delete asset"
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmingDelete(false)}
          isConfirming={deleteAsset.isPending}
        />
      ) : null}

      {isEditing ? (
        <Card>
          <h2 className="font-display text-lg text-ink">Edit asset</h2>
          <div className="mt-4">
            <AssetForm
              asset={asset}
              onCancel={() => setIsEditing(false)}
              onSuccess={() => {
                setIsEditing(false);
                showToast("Asset updated.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      {series.length >= 2 ? (
        <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
          <h2 className="font-display text-lg text-ink">Value over time</h2>
          <div className="mt-4">
            <ValuationChart points={series} currency={asset.currency} label={asset.name} />
          </div>
        </div>
      ) : (
        <EmptyState
          title="Nothing to chart yet"
          body="Add a second valuation and this asset's value trend will show up here."
        />
      )}

      <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
        <h2 className="font-display text-lg text-ink">Add valuation</h2>
        <div className="mt-4">
          <ValuationForm
            assetId={asset.id}
            currency={asset.currency}
            onSuccess={() => showToast("Valuation added.", { variant: "positive" })}
          />
        </div>
      </div>

      <div>
        <h2 className="font-display text-lg text-ink">Valuation history</h2>
        <DataList<AssetValuationOut>
          className="mt-4"
          queryKey={qk.assetValuations(asset.id)}
          fetchPage={fetchPage}
          empty={
            <EmptyState title="No valuations yet" body="Add this asset's first valuation above." />
          }
          renderRow={(valuation) => (
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <DateText iso={valuation.as_of} className="block text-sm text-ink" />
                <p className="truncate text-xs text-ink-faint">{valuation.source ?? "—"}</p>
              </div>
              <MoneyText minor={valuation.value_minor} currency={asset.currency} />
            </div>
          )}
        />
      </div>
    </div>
  );
}

export default AssetDetail;
