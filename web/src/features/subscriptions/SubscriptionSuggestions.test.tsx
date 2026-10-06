import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { qk } from "../../lib/queries";
import SubscriptionSuggestions from "./SubscriptionSuggestions";
import type { SubscriptionSuggestion } from "./useSubscriptions";

const base: SubscriptionSuggestion = {
  merchant: "Netflix",
  suggested_name: "Netflix",
  amount_minor: 1990,
  currency: "BRL",
  billing_frequency: "monthly",
  occurrences: 3,
  first_seen: "2026-07-05",
  last_seen: "2026-09-05",
  suggested_next_renewal: "2026-10-05",
  suggested_category_id: null,
  suggested_account_id: null,
};

function renderWithProvider(component: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  return render(
    <QueryClientProvider client={queryClient}>
      {component}
    </QueryClientProvider>,
  );
}

describe("SubscriptionSuggestions", () => {
  it("renders nothing when there are no suggestions", () => {
    const { container } = renderWithProvider(
      <SubscriptionSuggestions suggestions={[]} categoryNameById={{}} onAdd={vi.fn()} onIgnore={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("fires onAdd and onIgnore", () => {
    const onAdd = vi.fn();
    const onIgnore = vi.fn();
    renderWithProvider(
      <SubscriptionSuggestions
        suggestions={[base, { ...base, merchant: "Spotify", suggested_name: "Spotify" }]}
        categoryNameById={{}}
        onAdd={onAdd}
        onIgnore={onIgnore}
      />,
    );
    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /add/i })[0]);
    expect(onAdd).toHaveBeenCalledWith(base);
    fireEvent.click(screen.getAllByRole("button", { name: /ignore/i })[0]);
    expect(onIgnore).toHaveBeenCalledWith("Netflix");
  });
});
