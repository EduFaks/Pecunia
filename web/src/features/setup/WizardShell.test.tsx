import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import WizardShell from "./WizardShell";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { AuthContextValue } from "../../lib/auth";

// StepPreferences (step 3) reads `useAuth()` for `adoptSession` and calls
// `useNavigate()` — neither is exercised by most of these shell-level
// navigation tests (no Continue click happens on step 3 in most of them),
// but both need a provider/mock in place simply for the step to mount
// without throwing. Per CONVENTIONS §9.10: context dependencies are mocked,
// never a real provider, in a component test. `apiFetch` is mocked the same
// way so the one test that *does* complete step 3 (driving the wizard all
// the way to Step 4, to verify the base-currency handoff) doesn't attempt a
// real network call.
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("../../lib/auth", () => ({ useAuth: vi.fn() }));
const mockApiFetch = vi.mocked(apiFetch);
const mockUseAuth = vi.mocked(useAuth);

function authState(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: null,
    status: "anon",
    login: vi.fn(),
    adoptSession: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    ...overrides,
  };
}

function renderWizard() {
  // A real QueryClient (not mocked): step 3 (StepPreferences) reads
  // `useQueryClient()` to mark the setup-status cache initialized on a
  // successful submit — no network query ever actually runs against it in
  // these tests, only direct cache writes.
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <WizardShell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function tokenResponse() {
  return {
    access_token: "setup-access-token",
    token_type: "bearer",
    expires_in: 900,
    refresh_token: null,
    user: { id: "u1", email: "ada@example.com", name: "Ada Lovelace", display_name: null },
  };
}

function fillOwnerStep() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Ada Lovelace" } });
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: "ada@example.com" } });
  fireEvent.change(screen.getByLabelText(/^password$/i), {
    target: { value: "N7k$pQ2wZr9vLmX4tY8u" },
  });
  fireEvent.change(screen.getByLabelText(/^confirm password$/i), {
    target: { value: "N7k$pQ2wZr9vLmX4tY8u" },
  });
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
}

/** Selects a currency on the Preferences step's searchable combobox — the
 * one field the wizard doesn't guess (see `StepPreferences.test.tsx`'s
 * identical helper). */
function selectCurrency(code: string) {
  fireEvent.focus(screen.getByPlaceholderText(/search currencies/i));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(`^${code}`) }));
}

describe("WizardShell", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    mockApiFetch.mockReset();
    mockUseAuth.mockReset();
    mockUseAuth.mockReturnValue(authState());
  });

  it("starts at step 1 (Welcome)", () => {
    renderWizard();
    expect(screen.getByText("PECUNIA")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /your financial life, in one place/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Step 2" })).not.toBeInTheDocument();
  });

  it("advances to step 2 (owner account) when Get Started is clicked", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(screen.getByRole("heading", { name: /create the owner account/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /your financial life, in one place/i }),
    ).not.toBeInTheDocument();
  });

  it("advances to step 3 (preferences) once the owner account step is completed", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "N7k$pQ2wZr9vLmX4tY8u" },
    });
    fireEvent.change(screen.getByLabelText(/^confirm password$/i), {
      target: { value: "N7k$pQ2wZr9vLmX4tY8u" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(screen.getByRole("heading", { name: /set your preferences/i })).toBeInTheDocument();
  });

  it("keeps Back on the owner step returning to Welcome", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /back/i }));

    expect(
      screen.getByRole("heading", { name: /your financial life, in one place/i }),
    ).toBeInTheDocument();
  });

  it("NEVER writes the owner password to sessionStorage, even after typing it and clicking Continue", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    const secretPassword = "N7k$pQ2wZr9vLmX4tY8u-super-secret";
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: secretPassword } });
    fireEvent.change(screen.getByLabelText(/^confirm password$/i), {
      target: { value: secretPassword },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Confirms Continue actually worked (wired end to end), then proves the
    // password never leaked into sessionStorage along the way.
    expect(screen.getByRole("heading", { name: /set your preferences/i })).toBeInTheDocument();

    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i) ?? "";
      const value = window.sessionStorage.getItem(key) ?? "";
      expect(value).not.toContain(secretPassword);
      expect(key.toLowerCase()).not.toContain("password");
    }
  });

  it("renders a 5-step progress indicator with the current step highlighted in the white accent, others ink-faint", () => {
    renderWizard();

    const progress = screen.getByLabelText(/step 1 of 5/i);
    const items = progress.querySelectorAll("li");
    expect(items).toHaveLength(5);

    const current = progress.querySelector('[aria-current="step"] span');
    expect(current).not.toBeNull();
    expect(current?.className).toMatch(/bg-accent/);

    const others = progress.querySelectorAll('li:not([aria-current="step"]) span');
    expect(others.length).toBe(4);
    others.forEach((el) => {
      expect(el.className).toMatch(/ink-faint/);
      expect(el.className).not.toMatch(/bg-accent/);
    });
  });

  it("updates the progress indicator's current step after advancing", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    const progress = screen.getByLabelText(/step 2 of 5/i);
    const current = progress.querySelector('[aria-current="step"] span');
    expect(current?.className).toMatch(/bg-accent/);
  });

  it("moves keyboard focus to the new step's heading when the step changes", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(document.activeElement).toHaveTextContent(/create the owner account/i);
  });

  it("threads the base currency chosen on Preferences into Step 4's quick-add account currency default", async () => {
    mockApiFetch.mockResolvedValue(tokenResponse());
    renderWizard();

    fillOwnerStep();
    expect(screen.getByRole("heading", { name: /set your preferences/i })).toBeInTheDocument();

    selectCurrency("BRL");
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /choose your starting point/i })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/^currency$/i)).toHaveValue("BRL");
  });

  it("Step 4's Continue advances to Step 5 (Finish), and Step 5 renders the checkmark + Enter Pecunia", async () => {
    mockApiFetch.mockResolvedValue(tokenResponse());
    renderWizard();

    fillOwnerStep();
    selectCurrency("USD");
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByRole("heading", { name: /choose your starting point/i });

    fireEvent.click(screen.getByRole("button", { name: /^continue/i }));

    expect(screen.getByRole("heading", { name: /you.re ready/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enter pecunia/i })).toBeInTheDocument();
  });
});
