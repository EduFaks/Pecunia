import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import { useAuth } from "../../lib/auth";
import type { AuthContextValue } from "../../lib/auth";
import SessionsPanel from "./SessionsPanel";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

vi.mock("../../lib/auth", () => ({ useAuth: vi.fn() }));
const mockUseAuth = vi.mocked(useAuth);

function authState(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: { id: "u1", email: "ada@example.com", name: "Ada Lovelace", display_name: null },
    status: "authed",
    login: vi.fn(),
    adoptSession: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

interface SessionFixture {
  id: string;
  client: string;
  device_label: string | null;
  created_at: string;
  last_active: string;
  current: boolean;
}

let sessions: SessionFixture[];

function seedSessions(seed: SessionFixture[]) {
  sessions = seed.map((s) => ({ ...s }));
}

function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: unknown, opts?: { method?: string }) => {
    const p = String(path);
    const method = opts?.method ?? "GET";

    if (p === "/auth/sessions" && method === "GET") {
      return Promise.resolve(sessions);
    }
    const revokeMatch = /^\/auth\/sessions\/([^/]+)$/.exec(p);
    if (revokeMatch && method === "DELETE") {
      sessions = sessions.filter((s) => s.id !== revokeMatch[1]);
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`Unexpected apiFetch call: ${method} ${p}`));
  });
}

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

const CURRENT: SessionFixture = {
  id: "family-1",
  client: "web",
  device_label: "Chrome on macOS",
  created_at: "2026-09-01T00:00:00Z",
  last_active: "2026-09-11T08:00:00Z",
  current: true,
};

const OTHER: SessionFixture = {
  id: "family-2",
  client: "native",
  device_label: "Pecunia iOS",
  created_at: "2026-08-01T00:00:00Z",
  last_active: "2026-09-10T08:00:00Z",
  current: false,
};

describe("SessionsPanel", () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue(authState());
    seedSessions([CURRENT, OTHER]);
    installFakeBackend();
  });

  it("lists every session with its device, client, and last-active date", async () => {
    renderWithProviders(<SessionsPanel />);

    expect(await screen.findByText(/Chrome on macOS/)).toBeInTheDocument();
    expect(screen.getByText(/Pecunia iOS/)).toBeInTheDocument();
    expect(screen.getAllByText(/web|native/).length).toBeGreaterThan(0);
  });

  it("marks the current session and omits a Revoke action on it", async () => {
    renderWithProviders(<SessionsPanel />);

    await screen.findByText(/Chrome on macOS/);
    expect(screen.getByText(/current session/i)).toBeInTheDocument();

    const rows = screen.getAllByRole("listitem");
    const currentRow = rows.find((row) => row.textContent?.includes("Chrome on macOS"));
    const otherRow = rows.find((row) => row.textContent?.includes("Pecunia iOS"));
    expect(currentRow).toBeDefined();
    expect(otherRow).toBeDefined();
    expect(within(currentRow!).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
    expect(within(otherRow!).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });

  it("clicking Revoke opens a confirmation instead of revoking immediately", async () => {
    renderWithProviders(<SessionsPanel />);

    await screen.findByText(/Pecunia iOS/);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName('Revoke "Pecunia iOS"?');
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      "/auth/sessions/family-2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("cancelling the confirmation leaves the session active", async () => {
    renderWithProviders(<SessionsPanel />);

    await screen.findByText(/Pecunia iOS/);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText(/Pecunia iOS/)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      "/auth/sessions/family-2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("confirming revokes a non-current session, calling DELETE and removing it from the list on refetch", async () => {
    renderWithProviders(<SessionsPanel />);

    await screen.findByText(/Pecunia iOS/);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke session" }));

    await waitFor(() => expect(screen.queryByText(/Pecunia iOS/)).not.toBeInTheDocument());
    expect(mockApiFetch).toHaveBeenCalledWith("/auth/sessions/family-2", expect.objectContaining({ method: "DELETE" }));
  });

  it("'Log out everywhere' calls useAuth().logoutAll", async () => {
    const logoutAll = vi.fn().mockResolvedValue(undefined);
    mockUseAuth.mockReturnValue(authState({ logoutAll }));

    renderWithProviders(<SessionsPanel />);

    await screen.findByText(/Chrome on macOS/);
    fireEvent.click(screen.getByRole("button", { name: /log out everywhere/i }));

    await waitFor(() => expect(logoutAll).toHaveBeenCalled());
  });
});
