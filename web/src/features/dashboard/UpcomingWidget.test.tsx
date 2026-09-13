import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import UpcomingWidget from "./UpcomingWidget";

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

/** A date-only ISO string `n` days from today, read/written in UTC so the
 * relative "in N days" label the widget computes stays deterministic no matter
 * when (or where) the suite runs. */
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

function renderWidget() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <UpcomingWidget />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("UpcomingWidget", () => {
  it("renders due rows soonest-first with the per-kind icon, label, due date and amount, linking to the owning screen", async () => {
    mockUpcoming({
      due: [
        {
          kind: "planned",
          id: "p1",
          label: "Salary",
          due_on: isoInDays(0),
          amount_minor: 300_000,
          currency: "USD",
        },
        {
          kind: "subscription",
          id: "s1",
          label: "Netflix",
          due_on: isoInDays(3),
          amount_minor: -999,
          currency: "USD",
        },
        {
          kind: "loan",
          id: "l1",
          label: "Car loan",
          due_on: isoInDays(5),
          amount_minor: 50_000,
          currency: "USD",
          direction: "borrowed",
        },
      ],
      over_budget: [],
    });

    renderWidget();

    expect(await screen.findByRole("heading", { name: /upcoming/i })).toBeInTheDocument();

    const salary = await screen.findByRole("link", { name: /salary/i });
    // Soonest-first: Salary (today) → Netflix (+3) → Car loan (+5).
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      expect.stringContaining("Salary"),
      expect.stringContaining("Netflix"),
      expect.stringContaining("Car loan"),
    ]);

    // planned → CalendarClock, links to /planned, today, positive amount
    // rendered in the sign style (income → emerald).
    expect(salary).toHaveAttribute("href", "/planned");
    expect(salary.querySelector(".lucide-calendar-clock")).not.toBeNull();
    expect(within(salary).getByText(/today/i)).toBeInTheDocument();
    expect(within(salary).getByText(/3,000\.00/)).toHaveClass("text-positive");

    // subscription → RefreshCw, links to /subscriptions, relative date.
    const netflix = screen.getByRole("link", { name: /netflix/i });
    expect(netflix).toHaveAttribute("href", "/subscriptions");
    expect(netflix.querySelector(".lucide-refresh-cw")).not.toBeNull();
    expect(within(netflix).getByText(/in 3 days/i)).toBeInTheDocument();

    // loan → Landmark, links to /loans. Its planned payment is a
    // direction-agnostic positive magnitude — a borrowed loan's payment is
    // money going OUT, so the amount must render neutrally (no emerald/coral
    // sign coloring), matching LoanDetail.
    const car = screen.getByRole("link", { name: /car loan/i });
    expect(car).toHaveAttribute("href", "/loans");
    expect(car.querySelector(".lucide-landmark")).not.toBeNull();
    const carAmount = within(car).getByText(/500\.00/);
    expect(carAmount).not.toHaveClass("text-positive");
    expect(carAmount).not.toHaveClass("text-negative");
  });

  it("renders a loan row with a null planned payment as just label + due date (no amount)", async () => {
    mockUpcoming({
      due: [
        {
          kind: "loan",
          id: "l2",
          label: "Mortgage",
          due_on: isoInDays(1),
          amount_minor: null,
          currency: "USD",
          direction: "borrowed",
        },
      ],
      over_budget: [],
    });

    renderWidget();

    const mortgage = await screen.findByRole("link", { name: /mortgage/i });
    expect(within(mortgage).getByText(/tomorrow/i)).toBeInTheDocument();
    // No money figure is rendered for a null planned payment.
    expect(mortgage.textContent).not.toMatch(/\$/);
  });

  it("renders an over-budget nudge with the over-by amount, linking to budgets", async () => {
    mockUpcoming({
      due: [],
      over_budget: [
        {
          budget_id: "b1",
          label: "Groceries",
          amount_minor: 10_000,
          actual_minor: 12_000,
          over_minor: 2_000,
          currency: "USD",
        },
      ],
    });

    renderWidget();

    const nudge = await screen.findByRole("link", { name: /groceries/i });
    expect(nudge).toHaveAttribute("href", "/budgets");
    expect(within(nudge).getByText(/over by/i)).toBeInTheDocument();
    // over_minor 2000 → $20.00, of amount_minor 10000 → $100.00.
    expect(within(nudge).getByText(/20\.00/)).toBeInTheDocument();
    expect(within(nudge).getByText(/100\.00/)).toBeInTheDocument();
  });

  it("shows a clean empty state when nothing is due and nothing is over budget", async () => {
    mockUpcoming({ due: [], over_budget: [] });

    renderWidget();

    expect(await screen.findByText(/nothing due in the next 30 days/i)).toBeInTheDocument();
  });
});
