import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import ProjectsScreen from "./ProjectsScreen";
import type { ProjectOut } from "./useProjects";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

let projects: ProjectOut[];
let nextId: number;

function seedProjects(seed: ProjectOut[]) {
  projects = seed.map((project) => ({ ...project }));
  nextId = seed.length + 1;
}

function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path.startsWith("/projects?") && method === "GET") {
      return Promise.resolve({ items: projects, next_cursor: null });
    }
    if (path === "/projects" && method === "POST") {
      const body = opts?.json as {
        name: string;
        currency: string;
        status: string;
        type: ProjectOut["type"];
        target_amount_minor?: number;
      };
      const created: ProjectOut = {
        id: `p${nextId++}`,
        name: body.name,
        description: null,
        target_amount_minor: body.target_amount_minor ?? null,
        currency: body.currency,
        status: body.status as ProjectOut["status"],
        type: body.type,
        planned_minor: 0,
        actual_minor: 0,
        is_demo: false,
        created_at: "2026-09-11T00:00:00Z",
        updated_at: "2026-09-11T00:00:00Z",
      };
      projects.push(created);
      return Promise.resolve(created);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={["/projects"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/projects" element={<ProjectsScreen />} />
            <Route path="/projects/:id" element={<div>Project detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const ROOF: ProjectOut = {
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

describe("ProjectsScreen", () => {
  beforeEach(() => {
    seedProjects([]);
    installFakeBackend();
  });

  it("shows a guiding empty state on a fresh workspace", async () => {
    renderScreen();
    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();
  });

  it("lists projects with name, status pill, and a funding progress bar", async () => {
    seedProjects([ROOF]);
    renderScreen();

    const row = (await screen.findByText("New roof")).closest("li")!;
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).getByText(/2,500\.00/)).toBeInTheDocument();
    expect(within(row).getByText(/10,000\.00/)).toBeInTheDocument();
    expect(within(row).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("creates a project with the posted fields and shows it in the list", async () => {
    renderScreen();
    await screen.findByText(/no projects yet/i);

    fireEvent.click(screen.getAllByRole("button", { name: /new project|add your first project/i })[0]);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Vacation fund" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "active" } });

    fireEvent.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects", {
        method: "POST",
        json: { name: "Vacation fund", currency: "USD", status: "active", type: "spending" },
      }),
    );

    expect(await screen.findByText("Vacation fund")).toBeInTheDocument();
  });

  it("navigates to the project detail screen when a row is clicked", async () => {
    seedProjects([ROOF]);
    renderScreen();

    fireEvent.click(await screen.findByText("New roof"));

    expect(await screen.findByText("Project detail screen")).toBeInTheDocument();
  });
});
