import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import GoalsScreen from "./GoalsScreen";
import type { GoalOut } from "./useGoals";

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

let goals: GoalOut[];
let nextId: number;

function seedGoals(seed: GoalOut[]) {
  goals = seed.map((goal) => ({ ...goal }));
  nextId = seed.length + 1;
}

function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path.startsWith("/accounts?")) {
      return Promise.resolve({ items: [], next_cursor: null });
    }
    if (path.startsWith("/portfolios?")) {
      return Promise.resolve({ items: [], next_cursor: null });
    }
    if (path.startsWith("/goals?") && method === "GET") {
      return Promise.resolve({ items: goals, next_cursor: null });
    }
    if (path === "/goals" && method === "POST") {
      const body = opts?.json as {
        name: string;
        target_minor: number;
        currency: string;
        source_kind: GoalOut["source_kind"];
        manual_current_minor?: number | null;
        target_date?: string | null;
      };
      const created: GoalOut = {
        id: `g${nextId++}`,
        name: body.name,
        target_minor: body.target_minor,
        currency: body.currency,
        target_date: body.target_date ?? null,
        source_kind: body.source_kind,
        source_id: null,
        manual_current_minor: body.manual_current_minor ?? null,
        created_at: "2026-09-13T00:00:00Z",
        progress: {
          current_minor: body.manual_current_minor ?? 0,
          target_minor: body.target_minor,
          pct_bps: 0,
        },
        eta: { reached_on: null, on_track: false },
      };
      goals.push(created);
      return Promise.resolve(created);
    }
    const patchMatch = /^\/goals\/([^/]+)$/.exec(path);
    if (patchMatch && method === "PATCH") {
      const goal = goals.find((g) => g.id === patchMatch[1]);
      if (goal) {
        Object.assign(goal, opts?.json as Partial<GoalOut>);
      }
      return Promise.resolve(goal);
    }
    if (patchMatch && method === "DELETE") {
      goals = goals.filter((g) => g.id !== patchMatch[1]);
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <GoalsScreen />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const EMERGENCY_FUND: GoalOut = {
  id: "g-emergency",
  name: "Emergency fund",
  target_minor: 500_000,
  currency: "USD",
  target_date: null,
  source_kind: "manual",
  source_id: null,
  manual_current_minor: 125_000,
  created_at: "2026-09-10T00:00:00Z",
  progress: { current_minor: 125_000, target_minor: 500_000, pct_bps: 2_500 },
  eta: { reached_on: null, on_track: false },
};

describe("GoalsScreen", () => {
  beforeEach(() => {
    seedGoals([]);
    installFakeBackend();
  });

  it("shows a guiding empty state on a fresh workspace", async () => {
    renderScreen();
    expect(await screen.findByText(/no goals yet/i)).toBeInTheDocument();
  });

  it("lists a goal with its progress ring", async () => {
    seedGoals([EMERGENCY_FUND]);
    renderScreen();

    const row = (await screen.findByText("Emergency fund")).closest("li")!;
    expect(within(row).getByText("25%")).toBeInTheDocument();
  });

  it("creates a manual goal and shows it in the list", async () => {
    renderScreen();
    await screen.findByText(/no goals yet/i);

    fireEvent.click(screen.getByRole("button", { name: /new goal/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Vacation" } });
    fireEvent.change(screen.getByLabelText("Target amount"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/goals",
        expect.objectContaining({
          method: "POST",
          json: expect.objectContaining({ name: "Vacation", target_minor: 200_000 }),
        }),
      ),
    );
    expect(await screen.findByText("Vacation")).toBeInTheDocument();
    expect(await screen.findByText("Goal created.")).toBeInTheDocument();
  });

  it("edits a goal's manual current amount", async () => {
    seedGoals([EMERGENCY_FUND]);
    renderScreen();
    await screen.findByText("Emergency fund");

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByLabelText("Current amount"), { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/goals/g-emergency",
        expect.objectContaining({
          method: "PATCH",
          json: expect.objectContaining({ manual_current_minor: 300_000 }),
        }),
      ),
    );
    expect(await screen.findByText("Goal updated.")).toBeInTheDocument();
  });

  it("deletes a goal after confirming", async () => {
    seedGoals([EMERGENCY_FUND]);
    renderScreen();
    await screen.findByText("Emergency fund");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete goal/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/goals/g-emergency", { method: "DELETE" }),
    );
    await waitFor(() => expect(screen.queryByText("Emergency fund")).not.toBeInTheDocument());
  });
});
