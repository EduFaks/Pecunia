import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import SummaryHeader from "./SummaryHeader";
import type { SummaryStat } from "./SummaryHeader";

// `SummaryHeader` renders amounts via `MoneyText`, which reads preferences via
// `usePreferences` -> `apiFetch("/auth/me")` (CONVENTIONS §9.10) — mocked here
// rather than a real network round trip, same pattern as `BalanceTiles.test.tsx`.
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function renderWithQuery(ui: ReactElement) {
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

describe("SummaryHeader", () => {
  beforeEach(() => {
    mockApiFetch.mockReset().mockResolvedValue({ user: null, preferences: null });
  });

  it("renders each stat's label and per-currency figures", () => {
    const stats: SummaryStat[] = [
      {
        label: "Total balance",
        entries: [
          { currency: "USD", value_minor: 150000 },
          { currency: "EUR", value_minor: 20000 },
        ],
      },
    ];

    renderWithQuery(<SummaryHeader stats={stats} />);

    expect(screen.getByText("Total balance")).toBeInTheDocument();
    expect(screen.getByText(/1,500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/200\.00/)).toBeInTheDocument();
  });

  it("renders multiple stats side by side", () => {
    const stats: SummaryStat[] = [
      { label: "Borrowed", entries: [{ currency: "USD", value_minor: 100000 }] },
      { label: "Lent", entries: [{ currency: "USD", value_minor: 50000 }] },
    ];

    renderWithQuery(<SummaryHeader stats={stats} />);

    expect(screen.getByText("Borrowed")).toBeInTheDocument();
    expect(screen.getByText("Lent")).toBeInTheDocument();
  });

  it("applies the 'pos' tone as the positive color, never the accent", () => {
    const stats: SummaryStat[] = [
      { label: "In", entries: [{ currency: "USD", value_minor: 100000, tone: "pos" }] },
    ];

    renderWithQuery(<SummaryHeader stats={stats} />);

    expect(screen.getByText(/1,000\.00/)).toHaveClass("text-positive");
  });

  it("applies the 'neg' tone as the negative color", () => {
    const stats: SummaryStat[] = [
      { label: "Out", entries: [{ currency: "USD", value_minor: -100000, tone: "neg" }] },
    ];

    renderWithQuery(<SummaryHeader stats={stats} />);

    expect(screen.getByText(/1,000\.00/)).toHaveClass("text-negative");
  });

  it("applies the 'muted' tone as faint ink, and leaves an untoned entry plain", () => {
    const stats: SummaryStat[] = [
      {
        label: "Remaining",
        entries: [{ currency: "USD", value_minor: 100000, tone: "muted" }],
      },
      {
        label: "Grand total",
        entries: [{ currency: "USD", value_minor: 200000 }],
      },
    ];

    const { container } = renderWithQuery(<SummaryHeader stats={stats} />);

    expect(screen.getByText(/1,000\.00/)).toHaveClass("text-ink-faint");
    expect(screen.getByText(/2,000\.00/)).not.toHaveClass("text-positive");
    expect(screen.getByText(/2,000\.00/)).not.toHaveClass("text-negative");
    expect(container.querySelectorAll(".text-positive")).toHaveLength(0);
  });

  it("shows the note when given", () => {
    const stats: SummaryStat[] = [
      { label: "Net", entries: [{ currency: "USD", value_minor: 100000 }] },
    ];

    renderWithQuery(<SummaryHeader stats={stats} note="this page" />);

    expect(screen.getByText(/this page/i)).toBeInTheDocument();
  });

  it("renders nothing extra when no note is given", () => {
    const stats: SummaryStat[] = [
      { label: "Net", entries: [{ currency: "USD", value_minor: 100000 }] },
    ];

    renderWithQuery(<SummaryHeader stats={stats} />);

    expect(screen.queryByText(/this page/i)).not.toBeInTheDocument();
  });

  it("renders an empty state when every stat has no currency entries", () => {
    const stats: SummaryStat[] = [
      { label: "Total balance", entries: [] },
      { label: "Grand total", entries: [] },
    ];

    renderWithQuery(<SummaryHeader stats={stats} />);

    expect(screen.getByText(/nothing to summarize/i)).toBeInTheDocument();
    expect(screen.queryByText("Total balance")).not.toBeInTheDocument();
  });

  it("renders an empty state when given no stats at all", () => {
    renderWithQuery(<SummaryHeader stats={[]} />);

    expect(screen.getByText(/nothing to summarize/i)).toBeInTheDocument();
  });
});
