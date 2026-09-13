import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import GoalsWidget from "./GoalsWidget";
import type { GoalOut } from "../goals/useGoals";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

let goals: GoalOut[] = [];

function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: null });
    }
    if (path.startsWith("/goals")) {
      return Promise.resolve({ items: goals, next_cursor: null });
    }
    return Promise.reject(new Error(`unexpected call: ${path}`));
  });
}

function renderWidget() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <GoalsWidget />
      </MemoryRouter>
    </QueryClientProvider>,
  );
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

describe("GoalsWidget", () => {
  beforeEach(() => {
    goals = [];
    installFakeBackend();
  });

  it("shows a calm empty state with a CTA when there are no goals", async () => {
    renderWidget();

    expect(await screen.findByText(/no savings goals yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set one up" })).toHaveAttribute("href", "/goals");
  });

  it("renders each goal's ring, linking out to the goals screen", async () => {
    goals = [goal()];
    renderWidget();

    expect(await screen.findByText("Emergency fund")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    const link = screen.getByText("Emergency fund").closest("a");
    expect(link).toHaveAttribute("href", "/goals");
  });

  it("caps the preview and links to the rest when there are more goals than fit", async () => {
    goals = [1, 2, 3, 4, 5].map((n) => goal({ id: `g${n}`, name: `Goal ${n}` }));
    renderWidget();

    await screen.findByText("Goal 1");
    expect(screen.getByText("Goal 2")).toBeInTheDocument();
    expect(screen.getByText("Goal 3")).toBeInTheDocument();
    expect(screen.queryByText("Goal 4")).not.toBeInTheDocument();
    expect(screen.getByText("and 2 more goals →")).toBeInTheDocument();
  });
});
