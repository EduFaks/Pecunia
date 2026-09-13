import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import ProjectPicker from "./ProjectPicker";
import type { ProjectOut } from "./useProjects";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const KITCHEN: ProjectOut = {
  id: "pr-kitchen",
  name: "Kitchen remodel",
  description: null,
  target_amount_minor: 5_000_000,
  currency: "USD",
  status: "active",
  type: "spending",
  planned_minor: 0,
  actual_minor: 0,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

const RAINY_DAY: ProjectOut = {
  ...KITCHEN,
  id: "pr-rainy",
  name: "Rainy day fund",
  type: "saving",
};

function installBackend(projects: ProjectOut[]) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path.startsWith("/projects?")) {
      return Promise.resolve({ items: projects, next_cursor: null });
    }
    return Promise.reject(new Error(`unexpected call: ${path}`));
  });
}

function Host({ onChange }: { onChange?: (id: string, project: ProjectOut | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <ProjectPicker
      value={value}
      onChange={(id, project) => {
        setValue(id);
        onChange?.(id, project);
      }}
    />
  );
}

function renderPicker(projects: ProjectOut[], onChange = vi.fn()) {
  installBackend(projects);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Host onChange={onChange} />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe("ProjectPicker", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("lists the workspace's projects when opened", async () => {
    renderPicker([KITCHEN, RAINY_DAY]);

    fireEvent.focus(await screen.findByLabelText("Project"));

    expect(await screen.findByRole("option", { name: /kitchen remodel/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /rainy day fund/i })).toBeInTheDocument();
  });

  it("filters the options by the typed text", async () => {
    renderPicker([KITCHEN, RAINY_DAY]);

    fireEvent.change(await screen.findByLabelText("Project"), { target: { value: "rainy" } });

    expect(await screen.findByRole("option", { name: /rainy day fund/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /kitchen remodel/i })).not.toBeInTheDocument();
  });

  it("calls onChange with the selected project's id and object", async () => {
    const { onChange } = renderPicker([KITCHEN, RAINY_DAY]);

    fireEvent.focus(await screen.findByLabelText("Project"));
    fireEvent.click(await screen.findByRole("option", { name: /kitchen remodel/i }));

    expect(onChange).toHaveBeenCalledWith("pr-kitchen", KITCHEN);
  });

  it("clears the selection via the none option", async () => {
    const { onChange } = renderPicker([KITCHEN, RAINY_DAY]);

    const input = await screen.findByLabelText("Project");
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: /kitchen remodel/i }));
    expect(onChange).toHaveBeenLastCalledWith("pr-kitchen", KITCHEN);

    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: /no project/i }));

    expect(onChange).toHaveBeenLastCalledWith("", null);
  });
});
