import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { formatRelativeDate } from "../../lib/format";
import { MoneyText } from "../../lib/preferences";
import HoldingForm from "./HoldingForm";
import PortfolioForm from "./PortfolioForm";
import PriceUpdateForm from "./PriceUpdateForm";
import { formatQuantity } from "./quantity";
import {
  useDeleteHolding,
  useDeletePortfolio,
  useHoldings,
  usePortfolio,
  useRefreshPrices,
} from "./usePortfolios";
import type { HoldingOut } from "./usePortfolios";

/** "via CoinGecko · 3d ago" — the latest price's provenance, or `null` when
 * no price has ever been recorded (`latest_price_as_of` is the signal: a
 * manual price can carry a null `source` but always has an `as_of`). */
function priceProvenance(source: string | null, asOf: string | null): string | null {
  if (!asOf) {
    return null;
  }
  const relative = formatRelativeDate(asOf);
  return source ? `via ${source} · ${relative}` : relative;
}

type HoldingFormState = { mode: "create" } | { mode: "edit"; holding: HoldingOut };

/**
 * `/portfolio/:id` — one portfolio's detail: header (name, currency, live
 * total `value_minor`), the holdings table (name/symbol, quantity, latest
 * unit price, value), a per-holding **Record price** action that appends a
 * `HoldingPrice` (mirroring an asset's valuation history), add/edit/delete
 * holding, and inline edit/delete for the portfolio itself. Deletes (holding
 * or portfolio) route through `ConfirmDialog` — both cascade permanently.
 */
function PortfolioDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [isEditingPortfolio, setIsEditingPortfolio] = useState(false);
  const [confirmingPortfolioDelete, setConfirmingPortfolioDelete] = useState(false);
  const [holdingForm, setHoldingForm] = useState<HoldingFormState | null>(null);
  const [pricingHolding, setPricingHolding] = useState<HoldingOut | null>(null);
  const [deletingHolding, setDeletingHolding] = useState<HoldingOut | null>(null);

  const portfolioQuery = usePortfolio(id);
  const holdingsQuery = useHoldings(id);
  const deletePortfolio = useDeletePortfolio();
  const deleteHolding = useDeleteHolding(id ?? "");
  const refreshPrices = useRefreshPrices();

  async function handleRefreshPrices() {
    try {
      const result = await refreshPrices.mutateAsync();
      const parts = [`Updated ${result.updated}, skipped ${result.skipped}.`];
      if (result.errors.length > 0) {
        parts.push(`${result.errors.length} error(s): ${result.errors.join("; ")}`);
      }
      showToast(parts.join(" "), { variant: result.errors.length > 0 ? "negative" : "positive" });
    } catch {
      showToast("Couldn't refresh crypto prices. Please try again.", { variant: "negative" });
    }
  }

  async function handleDeletePortfolio() {
    if (!id) {
      return;
    }
    try {
      await deletePortfolio.mutateAsync(id);
      showToast("Portfolio deleted.");
      navigate("/portfolio");
    } catch {
      showToast("Couldn't delete this portfolio. Please try again.", { variant: "negative" });
    } finally {
      setConfirmingPortfolioDelete(false);
    }
  }

  async function handleDeleteHolding() {
    if (!deletingHolding) {
      return;
    }
    try {
      await deleteHolding.mutateAsync(deletingHolding.id);
      showToast("Holding deleted.");
    } catch {
      showToast("Couldn't delete this holding. Please try again.", { variant: "negative" });
    } finally {
      setDeletingHolding(null);
    }
  }

  if (portfolioQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading portfolio" />
      </div>
    );
  }

  if (portfolioQuery.isError || !portfolioQuery.data) {
    return <Callout variant="negative">Couldn't load this portfolio.</Callout>;
  }

  const portfolio = portfolioQuery.data;
  const holdings = holdingsQuery.data?.items ?? [];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
            {portfolio.currency} · Portfolio
          </p>
          <h1 className="mt-1 font-display text-2xl text-ink">{portfolio.name}</h1>
          <MoneyText
            minor={portfolio.value_minor}
            currency={portfolio.currency}
            variant="hero"
            className="mt-2 block text-3xl"
          />
          {portfolio.description ? (
            <p className="mt-2 max-w-prose text-sm text-ink-2">{portfolio.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsEditingPortfolio((editing) => !editing)}
          >
            {isEditingPortfolio ? "Cancel" : "Edit"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={deletePortfolio.isPending}
            onClick={() => setConfirmingPortfolioDelete(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      {confirmingPortfolioDelete ? (
        <ConfirmDialog
          title={`Delete "${portfolio.name}"?`}
          description="This permanently deletes the portfolio and all of its holdings and price history. This can't be undone."
          confirmLabel="Delete portfolio"
          onConfirm={() => void handleDeletePortfolio()}
          onCancel={() => setConfirmingPortfolioDelete(false)}
          isConfirming={deletePortfolio.isPending}
        />
      ) : null}

      {deletingHolding ? (
        <ConfirmDialog
          title={`Delete "${deletingHolding.name}"?`}
          description="This permanently deletes the holding and its entire price history. This can't be undone."
          confirmLabel="Delete holding"
          onConfirm={() => void handleDeleteHolding()}
          onCancel={() => setDeletingHolding(null)}
          isConfirming={deleteHolding.isPending}
        />
      ) : null}

      {isEditingPortfolio ? (
        <Card>
          <h2 className="font-display text-lg text-ink">Edit portfolio</h2>
          <div className="mt-4">
            <PortfolioForm
              portfolio={portfolio}
              onCancel={() => setIsEditingPortfolio(false)}
              onSuccess={() => {
                setIsEditingPortfolio(false);
                showToast("Portfolio updated.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      {pricingHolding ? (
        <Card>
          <h2 className="font-display text-lg text-ink">Record price — {pricingHolding.name}</h2>
          <div className="mt-4">
            <PriceUpdateForm
              portfolioId={portfolio.id}
              holdingId={pricingHolding.id}
              currency={portfolio.currency}
              onCancel={() => setPricingHolding(null)}
              onSuccess={() => {
                setPricingHolding(null);
                showToast("Price recorded.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      {holdingForm ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {holdingForm.mode === "edit" ? "Edit holding" : "Add holding"}
          </h2>
          <div className="mt-4">
            <HoldingForm
              portfolioId={portfolio.id}
              holding={holdingForm.mode === "edit" ? holdingForm.holding : undefined}
              onCancel={() => setHoldingForm(null)}
              onSuccess={() => {
                const wasEdit = holdingForm.mode === "edit";
                setHoldingForm(null);
                showToast(wasEdit ? "Holding updated." : "Holding added.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg text-ink">Holdings</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              loading={refreshPrices.isPending}
              onClick={() => void handleRefreshPrices()}
            >
              Update prices
            </Button>
            <Button size="sm" onClick={() => setHoldingForm({ mode: "create" })}>
              Add holding
            </Button>
          </div>
        </div>

        {holdingsQuery.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner label="Loading holdings" />
          </div>
        ) : holdingsQuery.isError ? (
          <Callout variant="negative" className="mt-4">
            Couldn't load this portfolio's holdings. Try again.
          </Callout>
        ) : holdings.length === 0 ? (
          <EmptyState
            className="mt-4"
            title="No holdings yet"
            body="Add this portfolio's first holding, then record a price to see its value."
            action={<Button onClick={() => setHoldingForm({ mode: "create" })}>Add a holding</Button>}
          />
        ) : (
          <div className="mt-4 overflow-x-auto rounded-pc-lg border border-hairline bg-surface-1">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-ink-faint">
                  <th scope="col" className="px-4 py-3 font-mono text-xs uppercase tracking-[0.1em]">
                    Holding
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right font-mono text-xs uppercase tracking-[0.1em]"
                  >
                    Quantity
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right font-mono text-xs uppercase tracking-[0.1em]"
                  >
                    Latest price
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right font-mono text-xs uppercase tracking-[0.1em]"
                  >
                    Value
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {holdings.map((holding) => {
                  // Hoisted so a row with provenance to show doesn't compute
                  // it twice (once to check truthiness, once to render it).
                  const provenance = priceProvenance(
                    holding.latest_price_source,
                    holding.latest_price_as_of,
                  );
                  return (
                    <tr key={holding.id}>
                      <td className="px-4 py-3">
                        <p className="text-ink">{holding.name}</p>
                        {holding.symbol ? (
                          <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
                            {holding.symbol}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-figures text-ink-2">
                        {formatQuantity(holding.quantity)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {holding.latest_unit_price_minor !== null ? (
                          <>
                            <MoneyText
                              minor={holding.latest_unit_price_minor}
                              currency={portfolio.currency}
                            />
                            {provenance ? (
                              <p className="mt-0.5 text-xs text-ink-faint">{provenance}</p>
                            ) : null}
                          </>
                        ) : (
                          <span className="font-mono text-sm text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <MoneyText minor={holding.value_minor} currency={portfolio.currency} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPricingHolding(holding)}
                          >
                            Record price
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setHoldingForm({ mode: "edit", holding })}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeletingHolding(holding)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default PortfolioDetail;
