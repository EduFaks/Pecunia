import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { qk } from "../../lib/queries";
import PreferencesPanel from "./PreferencesPanel";

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(qk.me, {
    user: null,
    preferences: {
      base_currency: "EUR",
      locale: "en-GB",
      date_format: "DD/MM/YYYY",
      number_format: "1.234,56",
      timezone: "Europe/London",
      first_day_of_week: "monday",
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("PreferencesPanel", () => {
  it("displays every instance preference read-only", () => {
    renderWithProviders(<PreferencesPanel />);

    expect(screen.getByText("EUR")).toBeInTheDocument();
    expect(screen.getByText("en-GB")).toBeInTheDocument();
    expect(screen.getByText("DD/MM/YYYY")).toBeInTheDocument();
    expect(screen.getByText("1.234,56")).toBeInTheDocument();
    expect(screen.getByText("Europe/London")).toBeInTheDocument();
    expect(screen.getByText(/monday/i)).toBeInTheDocument();
  });

  it("notes that editing preferences isn't available yet", () => {
    renderWithProviders(<PreferencesPanel />);

    expect(screen.getByText(/coming in a future update/i)).toBeInTheDocument();
  });

  it("renders no editable form controls", () => {
    renderWithProviders(<PreferencesPanel />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });
});
