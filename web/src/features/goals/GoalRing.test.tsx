import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import GoalRing from "./GoalRing";
import type { GoalOut } from "./useGoals";

// `MoneyText`/`usePreferences` reads `/auth/me` (CONVENTIONS §9.10) — mocked
// here rather than a real network round trip, same pattern as
// `dashboard/BalanceTiles.test.tsx`.
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

function goal(overrides: Partial<GoalOut> = {}): GoalOut {
  return {
    id: "g1",
    name: "Emergency fund",
    target_minor: 500_000,
    currency: "USD",
    target_date: null,
    source_kind: "manual",
    source_id: null,
    manual_current_minor: 125_000,
    created_at: "2026-09-01T00:00:00Z",
    progress: { current_minor: 125_000, target_minor: 500_000, pct_bps: 2_500 },
    eta: { reached_on: null, on_track: false },
    ...overrides,
  };
}

describe("GoalRing", () => {
  beforeEach(() => {
    mockApiFetch.mockReset().mockResolvedValue({ user: null, preferences: null });
  });

  it("renders the goal name and current/target amounts", () => {
    renderWithQuery(<GoalRing goal={goal()} />);

    expect(screen.getByText("Emergency fund")).toBeInTheDocument();
    expect(screen.getByText("$1,250.00")).toBeInTheDocument();
    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
  });

  it("renders the rounded percent from pct_bps in the ring center", () => {
    renderWithQuery(<GoalRing goal={goal({ progress: { current_minor: 125_000, target_minor: 500_000, pct_bps: 2_500 } })} />);

    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("shows the projected reached-by month when on track", () => {
    renderWithQuery(
      <GoalRing
        goal={goal({ eta: { reached_on: "2026-12-31", on_track: true } })}
      />,
    );

    expect(screen.getByText("On track — by Dec 2026")).toBeInTheDocument();
  });

  it("shows a not-on-track line when the forecast never reaches the target", () => {
    renderWithQuery(<GoalRing goal={goal({ eta: { reached_on: null, on_track: false } })} />);

    expect(screen.getByText("Not on track within 6 months")).toBeInTheDocument();
  });

  it("shows a 'Goal reached' pill once the target is met, taking priority over eta", () => {
    renderWithQuery(
      <GoalRing
        goal={goal({
          progress: { current_minor: 600_000, target_minor: 500_000, pct_bps: 12_000 },
          eta: { reached_on: null, on_track: false },
        })}
      />,
    );

    expect(screen.getByText("Goal reached")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});
