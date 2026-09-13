import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RedirectIfAuthed, RequireAuth, RequireSetup } from "./guards";
import { useSetupStatus } from "../lib/setup";
import type { UseSetupStatusResult } from "../lib/setup";
import { useAuth } from "../lib/auth";
import type { AuthContextValue } from "../lib/auth";

vi.mock("../lib/setup", () => ({ useSetupStatus: vi.fn() }));
vi.mock("../lib/auth", () => ({ useAuth: vi.fn() }));

const mockSetupStatus = vi.mocked(useSetupStatus);
const mockAuth = vi.mocked(useAuth);

function setupStatus(overrides: Partial<UseSetupStatusResult>): UseSetupStatusResult {
  return {
    initialized: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function authState(overrides: Partial<AuthContextValue>): AuthContextValue {
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

/** Mirrors the guard composition in App.tsx, with plain stand-in screens so
 * these tests exercise only guard behavior, not the real routes/AppShell. */
function renderGuardedApp(initialPath: string) {
  return render(
    <MemoryRouter
      initialEntries={[initialPath]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route element={<RequireSetup />}>
          <Route path="/setup/*" element={<div>Setup wizard</div>} />
          <Route element={<RedirectIfAuthed />}>
            <Route path="/login" element={<div>Login screen</div>} />
          </Route>
          <Route element={<RequireAuth />}>
            <Route path="/" element={<div>App shell</div>} />
          </Route>
          <Route path="*" element={<div>Not found</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("route guards", () => {
  beforeEach(() => {
    mockSetupStatus.mockReset();
    mockAuth.mockReset();
  });

  it("sends an uninitialized instance to /setup", () => {
    mockSetupStatus.mockReturnValue(setupStatus({ initialized: false }));
    mockAuth.mockReturnValue(authState({ status: "anon" }));

    renderGuardedApp("/");

    expect(screen.getByText("Setup wizard")).toBeInTheDocument();
  });

  it("sends an uninitialized instance to /setup even from an unknown path", () => {
    mockSetupStatus.mockReturnValue(setupStatus({ initialized: false }));
    mockAuth.mockReturnValue(authState({ status: "anon" }));

    renderGuardedApp("/nonexistent");

    expect(screen.getByText("Setup wizard")).toBeInTheDocument();
  });

  it("sends an initialized, anonymous visitor to /login", () => {
    mockSetupStatus.mockReturnValue(setupStatus({ initialized: true }));
    mockAuth.mockReturnValue(authState({ status: "anon" }));

    renderGuardedApp("/");

    expect(screen.getByText("Login screen")).toBeInTheDocument();
  });

  it("renders the app shell for an initialized, authed visitor", () => {
    mockSetupStatus.mockReturnValue(setupStatus({ initialized: true }));
    mockAuth.mockReturnValue(
      authState({
        status: "authed",
        user: { id: "1", email: "ada@example.com", name: "Ada Lovelace", display_name: null },
      }),
    );

    renderGuardedApp("/");

    expect(screen.getByText("App shell")).toBeInTheDocument();
  });

  it("redirects away from /setup once the instance is initialized", () => {
    mockSetupStatus.mockReturnValue(setupStatus({ initialized: true }));
    mockAuth.mockReturnValue(authState({ status: "authed" }));

    renderGuardedApp("/setup/owner");

    expect(screen.getByText("App shell")).toBeInTheDocument();
    expect(screen.queryByText("Setup wizard")).not.toBeInTheDocument();
  });

  it("bounces an already-authed visitor off /login", () => {
    mockSetupStatus.mockReturnValue(setupStatus({ initialized: true }));
    mockAuth.mockReturnValue(authState({ status: "authed" }));

    renderGuardedApp("/login");

    expect(screen.getByText("App shell")).toBeInTheDocument();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();
  });

  it("shows an error state with a retry action when the setup-status query fails, not the app or login", () => {
    const refetch = vi.fn();
    mockSetupStatus.mockReturnValue(setupStatus({ isError: true, refetch }));
    mockAuth.mockReturnValue(authState({ status: "anon" }));

    renderGuardedApp("/");

    expect(screen.queryByText("Setup wizard")).not.toBeInTheDocument();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retryButton);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the branded splash while setup status is loading, not any route content", () => {
    mockSetupStatus.mockReturnValue(setupStatus({ isLoading: true }));
    mockAuth.mockReturnValue(authState({ status: "loading" }));

    renderGuardedApp("/");

    expect(screen.getByText("PECUNIA")).toBeInTheDocument();
    expect(screen.queryByText("Setup wizard")).not.toBeInTheDocument();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("shows the branded splash while auth is loading, once setup has resolved", () => {
    mockSetupStatus.mockReturnValue(setupStatus({ initialized: true }));
    mockAuth.mockReturnValue(authState({ status: "loading" }));

    renderGuardedApp("/");

    expect(screen.getByText("PECUNIA")).toBeInTheDocument();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("renders the catch-all for an unknown path once initialized and authed", () => {
    mockSetupStatus.mockReturnValue(setupStatus({ initialized: true }));
    mockAuth.mockReturnValue(authState({ status: "authed" }));

    renderGuardedApp("/nonexistent");

    expect(screen.getByText("Not found")).toBeInTheDocument();
  });
});
