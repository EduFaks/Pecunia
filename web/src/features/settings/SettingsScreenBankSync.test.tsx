import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import { AuthProvider } from "../../lib/auth";
import { qk } from "../../lib/queries";
import SettingsScreen from "./SettingsScreen";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function installFakeBackend() {
  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET";

      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: null });
      }
      if (path.startsWith("/auth/sessions") && method === "GET") {
        return Promise.resolve([]);
      }
      if (path.startsWith("/bank-sync/connections") && method === "GET") {
        return Promise.resolve([]);
      }
      if (path.startsWith("/bank-sync/category-mappings") && method === "GET") {
        return Promise.resolve([]);
      }
      if (path.startsWith("/audit-events") && method === "GET") {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      if (path.startsWith("/categories") && method === "GET") {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  return render(
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <SettingsScreen />
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

describe("SettingsScreen with bank sync", () => {
  beforeEach(() => {
    installFakeBackend();
  });

  it("shows a bank connections section in the settings navigation", async () => {
    renderSettings();

    const connectionsButton = await screen.findByRole("button", { name: /bank connections|connections/i });
    expect(connectionsButton).toBeInTheDocument();
  });

  it("renders the connections panel when selected", async () => {
    renderSettings();

    const connectionsButton = await screen.findByRole("button", { name: /bank connections|connections/i });
    fireEvent.click(connectionsButton);

    // Should render ConnectionsPanel content - look for the Sync now button or empty state message
    expect(await screen.findByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });
});
