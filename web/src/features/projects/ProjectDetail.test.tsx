import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import ProjectDetail from "./ProjectDetail";
import type { ProjectItemOut, ProjectOut } from "./useProjects";
import type { TransactionOut } from "../transactions/useTransactions";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const PROJECT: ProjectOut = {
  id: "p1",
  name: "New roof",
  description: null,
  target_amount_minor: 1_000_000,
  currency: "USD",
  status: "active",
  type: "spending",
  planned_minor: 250_000,
  actual_minor: 250_000,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const ITEM: ProjectItemOut = {
  id: "i1",
  project_id: "p1",
  transaction_id: null,
  name: "Shingles",
  amount_minor: 250_000,
  actual_minor: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const HARDWARE_TX: TransactionOut = {
  id: "tx1",
  account_id: "a1",
  category_id: null,
  contact_id: null,
  project_id: null,
  transfer_id: null,
  amount_minor: -240_000,
  currency: "USD",
  description: "Hardware store",
  occurred_on: "2026-02-01",
  is_demo: false,
  deleted_at: null,
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
};

function installFakeBackend(
  options: { project?: ProjectOut; items?: ProjectItemOut[]; transactions?: TransactionOut[] } = {},
) {
  const project = { ...(options.project ?? PROJECT) };
  const items = (options.items ?? []).map((item) => ({ ...item }));
  const transactions = options.transactions ?? [HARDWARE_TX];

  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path === "/auth/me" && method === "GET") {
      return Promise.resolve({ user: null, preferences: null });
    }
    if (path === "/projects/p1" && method === "GET") {
      return Promise.resolve({ ...project });
    }
    if (path.startsWith("/projects/p1/items?") && method === "GET") {
      return Promise.resolve({ items: items.map((i) => ({ ...i })), next_cursor: null });
    }
    if (path.startsWith("/transactions?") && method === "GET") {
      return Promise.resolve({ items: transactions, next_cursor: null });
    }
    if (path === "/projects/p1/items" && method === "POST") {
      const body = opts?.json as { name: string; amount_minor: number };
      const created: ProjectItemOut = {
        id: "i-new",
        project_id: "p1",
        transaction_id: null,
        name: body.name,
        amount_minor: body.amount_minor,
        actual_minor: null,
        is_demo: false,
        created_at: "2026-06-01T00:00:00Z",
        updated_at: "2026-06-01T00:00:00Z",
      };
      items.push(created);
      project.planned_minor += body.amount_minor;
      return Promise.resolve(created);
    }
    const attachMatch = /^\/projects\/p1\/items\/([^/]+)\/attach$/.exec(path);
    if (attachMatch && method === "POST") {
      const body = opts?.json as { transaction_id: string };
      const item = items.find((i) => i.id === attachMatch[1]);
      const tx = transactions.find((t) => t.id === body.transaction_id);
      if (item && tx) {
        item.transaction_id = tx.id;
        item.actual_minor = Math.abs(tx.amount_minor);
      }
      return Promise.resolve({ ...item });
    }
    const detachMatch = /^\/projects\/p1\/items\/([^/]+)\/detach$/.exec(path);
    if (detachMatch && method === "POST") {
      const item = items.find((i) => i.id === detachMatch[1]);
      if (item) {
        item.transaction_id = null;
        item.actual_minor = null;
      }
      return Promise.resolve({ ...item });
    }
    const patchMatch = /^\/projects\/p1\/items\/([^/]+)$/.exec(path);
    if (patchMatch && method === "PATCH") {
      const item = items.find((i) => i.id === patchMatch[1]);
      if (item) Object.assign(item, opts?.json as Partial<ProjectItemOut>);
      return Promise.resolve({ ...item });
    }
    if (path === "/projects/p1" && method === "PATCH") {
      Object.assign(project, opts?.json as Partial<ProjectOut>);
      return Promise.resolve({ ...project });
    }
    if (path === "/projects/p1" && method === "DELETE") {
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={["/projects/p1"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/projects" element={<div>Projects list screen</div>} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ProjectDetail", () => {
  beforeEach(() => {
    installFakeBackend();
  });

  it("shows the project's header and funding progress (25% of target)", async () => {
    installFakeBackend({ items: [ITEM] });
    renderDetail();

    expect(await screen.findByRole("heading", { name: "New roof" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("shows the planned total alongside the actual funding", async () => {
    installFakeBackend({
      project: { ...PROJECT, planned_minor: 300_000, actual_minor: 250_000 },
      items: [ITEM],
    });
    renderDetail();

    await screen.findByRole("heading", { name: "New roof" });
    // Planned total (Σ parts) is shown as its own figure…
    expect(screen.getByText(/3,000\.00/)).toBeInTheDocument();
    // …distinct from the realized actual funding (Σ linked transactions).
    expect(screen.getAllByText(/2,500\.00/).length).toBeGreaterThan(0);
  });

  it("shows a guiding empty state when the project has no items yet", async () => {
    renderDetail();
    expect(await screen.findByText(/no parts yet/i)).toBeInTheDocument();
  });

  it("lists a planned part with its estimate and an attach affordance", async () => {
    installFakeBackend({ items: [ITEM] });
    renderDetail();

    const row = (await screen.findByText("Shingles")).closest("li")!;
    expect(within(row).getByText(/planned/i)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /attach transaction/i })).toBeInTheDocument();
  });

  it("marks a part as bought when it has an attached transaction", async () => {
    installFakeBackend({
      items: [{ ...ITEM, transaction_id: "tx1", actual_minor: 240_000 }],
    });
    renderDetail();

    const row = (await screen.findByText("Shingles")).closest("li")!;
    expect(within(row).getByText(/bought/i)).toBeInTheDocument();
    expect(within(row).getByText(/2,400\.00/)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /detach/i })).toBeInTheDocument();
  });

  it("attaching a picked transaction calls the attach endpoint with that transaction", async () => {
    installFakeBackend({ items: [ITEM], transactions: [HARDWARE_TX] });
    renderDetail();

    const row = (await screen.findByText("Shingles")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /attach transaction/i }));

    fireEvent.click(await screen.findByRole("option", { name: /hardware store/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/items/i1/attach", {
        method: "POST",
        json: { transaction_id: "tx1" },
      }),
    );
  });

  it("detaching a bought part calls the detach endpoint", async () => {
    installFakeBackend({ items: [{ ...ITEM, transaction_id: "tx1", actual_minor: 240_000 }] });
    renderDetail();

    const row = (await screen.findByText("Shingles")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /detach/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/items/i1/detach", { method: "POST" }),
    );
  });

  it("adding an item updates the items list and the planned total", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "New roof" });

    fireEvent.change(screen.getByLabelText("Part"), { target: { value: "Gutters" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: /add part/i }));

    expect(await screen.findByText("Gutters")).toBeInTheDocument();
    // Planned climbs 250,000 + 100,000 = 350,000; actual is unchanged.
    await waitFor(() => expect(screen.getByText(/3,500\.00/)).toBeInTheDocument());
  });

  it("edits an item inline via the item's own edit action", async () => {
    installFakeBackend({ items: [ITEM] });
    renderDetail();
    await screen.findByText("Shingles");

    const row = screen.getByText("Shingles").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /^edit$/i }));
    fireEvent.change(within(row).getByLabelText("Amount"), { target: { value: "3000" } });
    fireEvent.click(within(row).getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/items/i1", {
        method: "PATCH",
        json: { name: "Shingles", amount_minor: 300_000 },
      }),
    );
  });

  it("edits the project via the inline edit panel", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "New roof" });

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed roof" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/projects/p1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
  });

  it("clicking Delete opens a confirmation instead of deleting immediately", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "New roof" });

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName('Delete "New roof"?');
    expect(mockApiFetch).not.toHaveBeenCalledWith("/projects/p1", { method: "DELETE" });
  });

  it("cancelling the confirmation does not delete the project", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "New roof" });

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith("/projects/p1", { method: "DELETE" });
  });

  it("confirming the deletion deletes the project and navigates back to the projects list", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "New roof" });

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete project" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1", { method: "DELETE" }),
    );
    expect(await screen.findByText("Projects list screen")).toBeInTheDocument();
  });
});
