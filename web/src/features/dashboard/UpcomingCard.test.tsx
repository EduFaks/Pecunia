import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import UpcomingCard from "./UpcomingCard";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const PREFERENCES = {
  base_currency: "USD",
  locale: "en-US",
  date_format: "MM/DD/YYYY",
  number_format: "1,234.56",
  timezone: "UTC",
  first_day_of_week: "monday",
};

/** A date-only ISO string `n` days from today, read/written in UTC — same
 * rationale as `UpcomingWidget.test.tsx`'s helper, so the 14-day cutoff the
 * card computes stays deterministic no matter when the suite runs. */
function isoInDays(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mockUpcoming(response: unknown) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path.startsWith("/analytics/upcoming")) {
      return Promise.resolve(response);
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <UpcomingCard />
    </QueryClientProvider>,
  );
}

describe("UpcomingCard", () => {
  it("renders rows within the next 14 days sorted soonest-first, with receivables positive and bills negative, loan amounts neutral", async () => {
    mockUpcoming({
      due: [
        // Deliberately out of order, and includes one item past the 14-day
        // cutoff that must NOT render.
        {
          kind: "loan",
          id: "l1",
          label: "Car loan",
          due_on: isoInDays(10),
          amount_minor: 20_000,
          currency: "USD",
          direction: "borrowed",
        },
        {
          kind: "planned",
          id: "p1",
          label: "Salary",
          due_on: isoInDays(5),
          amount_minor: 100_000,
          currency: "USD",
        },
        {
          kind: "subscription",
          id: "s1",
          label: "Netflix",
          due_on: isoInDays(2),
          amount_minor: -1_999,
          currency: "USD",
        },
        {
          kind: "planned",
          id: "p2",
          label: "Rent",
          due_on: isoInDays(20),
          amount_minor: -200_000,
          currency: "USD",
        },
      ],
      over_budget: [],
    });

    renderCard();

    await screen.findByText("Netflix");

    // Soonest-first within 14 days: Netflix (+2) -> Salary (+5) -> Car loan (+10).
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Netflix"),
      expect.stringContaining("Salary"),
      expect.stringContaining("Car loan"),
    ]);

    // Rent is beyond the 14-day horizon — excluded entirely.
    expect(screen.queryByText("Rent")).not.toBeInTheDocument();

    // Salary (receivable, positive amount) renders in positive tone.
    expect(screen.getByText(/1,000\.00/)).toHaveClass("text-positive");
    // Netflix (bill, negative amount) renders in negative tone.
    expect(screen.getByText(/19\.99/)).toHaveClass("text-negative");
    // Car loan's planned payment is a direction-agnostic magnitude — neutral,
    // no sign coloring, matching `UpcomingWidget`.
    const carAmount = screen.getByText(/200\.00/);
    expect(carAmount).not.toHaveClass("text-positive");
    expect(carAmount).not.toHaveClass("text-negative");
  });

  it("shows a calm empty state when nothing is due in the next 14 days", async () => {
    mockUpcoming({
      due: [
        {
          kind: "planned",
          id: "p1",
          label: "Far off",
          due_on: isoInDays(25),
          amount_minor: 1_000,
          currency: "USD",
        },
      ],
      over_budget: [],
    });

    renderCard();

    expect(await screen.findByText("nada nos próximos 14 dias")).toBeInTheDocument();
    expect(screen.queryByText("Far off")).not.toBeInTheDocument();
  });

  it("shows a loading state while fetching", () => {
    mockApiFetch.mockReset().mockImplementation(() => new Promise(() => {}));

    renderCard();

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an error state when the fetch fails", async () => {
    mockApiFetch.mockReset().mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      return Promise.reject(new Error("boom"));
    });

    renderCard();

    expect(await screen.findByText(/couldn't load/i)).toBeInTheDocument();
  });
});
