import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { qk } from "../../lib/queries";
import ActivityRow from "./ActivityRow";
import type { ActivityEntry } from "../../lib/activity";

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(qk.me, {
    user: null,
    preferences: {
      base_currency: "USD",
      locale: "en-US",
      date_format: "MM/DD/YYYY",
      number_format: "1,234.56",
      timezone: "UTC",
      first_day_of_week: "monday",
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 1,
    occurred_at: "2026-09-11T09:00:00.000Z",
    template_key: "activity.account.created",
    params: { name: "Checking", type: "checking" },
    ...overrides,
  };
}

describe("ActivityRow", () => {
  it("renders a plain sentence for an ordinary template key", () => {
    renderWithProviders(
      <ActivityRow entry={entry({ template_key: "activity.transaction.created", params: { description: "Coffee", amount_minor: -450, currency: "USD" } })} />,
    );
    expect(screen.getByText(/Coffee.*recorded/)).toBeInTheDocument();
  });

  it("renders an increased valuation with the new value colored emerald (positive)", () => {
    renderWithProviders(
      <ActivityRow
        entry={entry({
          template_key: "activity.asset.valuation_changed",
          params: { asset: "Model 3", from: 3000000, to: 3800000, currency: "USD" },
        })}
      />,
    );
    expect(screen.getByText(/Model 3 valuation changed/)).toBeInTheDocument();
    expect(screen.getByText("$30,000.00")).toBeInTheDocument();
    const toValue = screen.getByText("$38,000.00");
    expect(toValue.parentElement?.className).toMatch(/text-positive/);
  });

  it("renders a decreased valuation with the new value colored coral (negative)", () => {
    renderWithProviders(
      <ActivityRow
        entry={entry({
          template_key: "activity.asset.valuation_changed",
          params: { asset: "Model 3", from: 4000000, to: 3800000, currency: "USD" },
        })}
      />,
    );
    const toValue = screen.getByText("$38,000.00");
    expect(toValue.parentElement?.className).toMatch(/text-negative/);
  });

  it("never crashes on an unrecognized template key, falling back to a safe generic line", () => {
    renderWithProviders(<ActivityRow entry={entry({ template_key: "activity.workspace.renamed", params: {} })} />);
    expect(screen.getByText("Workspace renamed.")).toBeInTheDocument();
  });
});
