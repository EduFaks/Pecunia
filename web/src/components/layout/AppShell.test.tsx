import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppShell from "./AppShell";
import { useAuth } from "../../lib/auth";
import type { AuthContextValue } from "../../lib/auth";

vi.mock("../../lib/auth", () => ({ useAuth: vi.fn() }));
const mockUseAuth = vi.mocked(useAuth);

// AppShell mounts DemoChip, which has its own query/network concerns
// (covered by DemoChip.test.tsx) — stubbed here per CONVENTIONS §9.10 so
// these tests exercise only nav wiring, not a QueryClientProvider round
// trip.
vi.mock("./DemoChip", () => ({ default: () => <span>demo-chip-stub</span> }));

function authState(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: { id: "u1", email: "ada@example.com", name: "Ada Lovelace", display_name: null },
    status: "authed",
    login: vi.fn(),
    adoptSession: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    ...overrides,
  };
}

function renderShell(initialPath: string) {
  return render(
    <MemoryRouter
      initialEntries={[initialPath]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<div>Dashboard screen</div>} />
          <Route path="insights" element={<div>Insights screen</div>} />
          <Route path="accounts" element={<div>Accounts screen</div>} />
          <Route path="transactions" element={<div>Transactions screen</div>} />
        <Route path="planned" element={<div>Planned screen</div>} />
          <Route path="projects" element={<div>Projects screen</div>} />
          <Route path="assets" element={<div>Assets screen</div>} />
          <Route path="portfolio" element={<div>Portfolio screen</div>} />
          <Route path="loans" element={<div>Loans screen</div>} />
          <Route path="subscriptions" element={<div>Subscriptions screen</div>} />
          <Route path="budgets" element={<div>Budgets screen</div>} />
          <Route path="activity" element={<div>Activity screen</div>} />
          <Route path="settings" element={<div>Settings screen</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppShell", () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue(authState());
  });

  it("renders every nav item as a link to its real route", () => {
    renderShell("/");

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Insights" })).toHaveAttribute("href", "/insights");
    expect(screen.getByRole("link", { name: "Accounts" })).toHaveAttribute("href", "/accounts");
    expect(screen.getByRole("link", { name: "Transactions" })).toHaveAttribute(
      "href",
      "/transactions",
    );
    expect(screen.getByRole("link", { name: "Goals" })).toHaveAttribute("href", "/goals");
    expect(screen.getByRole("link", { name: "Contacts" })).toHaveAttribute("href", "/contacts");
    expect(screen.getByRole("link", { name: "Planned" })).toHaveAttribute("href", "/planned");
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/projects");
    expect(screen.getByRole("link", { name: "Assets" })).toHaveAttribute("href", "/assets");
    expect(screen.getByRole("link", { name: "Portfolio" })).toHaveAttribute("href", "/portfolio");
    expect(screen.getByRole("link", { name: "Loans" })).toHaveAttribute("href", "/loans");
    expect(screen.getByRole("link", { name: "Subscriptions" })).toHaveAttribute(
      "href",
      "/subscriptions",
    );
    expect(screen.getByRole("link", { name: "Budgets" })).toHaveAttribute("href", "/budgets");
    expect(screen.getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/activity");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  it("renders the section headers grouping the nav, as labels rather than links", () => {
    renderShell("/");

    for (const header of ["Overview", "Money", "Net worth", "Plan"]) {
      const label = screen.getByText(header);
      expect(label).toBeInTheDocument();
      // Non-clickable label, styled like the Settings sub-nav's group
      // headers (uppercase tracked muted), not a nav link.
      expect(label.closest("a")).toBeNull();
      expect(label).toHaveClass("uppercase", "text-ink-faint");
    }
  });

  it("renders a lucide icon alongside each nav item's label", () => {
    renderShell("/");

    // The icon is decorative (aria-hidden), so the link's accessible name
    // stays the plain label; the glyph is an svg inside the link.
    const dashboard = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboard.querySelector("svg")).toBeInTheDocument();
    const accounts = screen.getByRole("link", { name: "Accounts" });
    expect(accounts.querySelector("svg")).toBeInTheDocument();
  });

  it("renders the matching nested route under the shared shell", () => {
    renderShell("/accounts");

    expect(screen.getByText("Accounts screen")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard screen")).not.toBeInTheDocument();
  });

  it("routes the Subscriptions nav item to the subscriptions screen", () => {
    renderShell("/");

    fireEvent.click(screen.getByRole("link", { name: "Subscriptions" }));

    expect(screen.getByText("Subscriptions screen")).toBeInTheDocument();
  });

  it("marks the active nav item for the current route, and only that one", () => {
    renderShell("/accounts");

    expect(screen.getByRole("link", { name: "Accounts" })).toHaveClass("bg-accent-soft");
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveClass("bg-accent-soft");
    expect(screen.getByRole("link", { name: "Transactions" })).not.toHaveClass("bg-accent-soft");
  });

  it("marks Dashboard active only at the exact root path, not every nested route", () => {
    renderShell("/settings");

    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveClass("bg-accent-soft");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveClass("bg-accent-soft");
  });

  it("mounts the demo chip in the topbar", () => {
    renderShell("/");

    expect(screen.getByText("demo-chip-stub")).toBeInTheDocument();
  });

  // Below ~768px the fixed sidebar collapses into an off-canvas drawer
  // toggled from the topbar (see AppShell.tsx). jsdom doesn't evaluate the
  // `md:` media-query classes that actually hide/show it at a given
  // viewport width, so these tests exercise the toggle's own behavior and
  // wiring — the thing that's actually testable — rather than a real
  // narrow-viewport render.
  describe("responsive nav drawer", () => {
    it("renders a nav toggle wired to the nav landmark, closed by default", () => {
      renderShell("/");

      const toggle = screen.getByRole("button", { name: /navigation/i });
      const nav = screen.getByRole("navigation");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveAttribute("aria-controls", nav.id);
      expect(nav.id).toBeTruthy();
    });

    it("applies the shared white focus-visible ring to the toggle", () => {
      renderShell("/");

      expect(screen.getByRole("button", { name: /navigation/i }).className).toMatch(
        /focus-visible:outline-focus/,
      );
    });

    it("opens the drawer on click and closes it again on a second click", () => {
      renderShell("/");
      const toggle = screen.getByRole("button", { name: /navigation/i });

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    it("closes the drawer on Escape and returns focus to the toggle", () => {
      renderShell("/");
      const toggle = screen.getByRole("button", { name: /navigation/i });

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");

      fireEvent.keyDown(document, { key: "Escape" });

      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveFocus();
    });

    it("closes the drawer when a nav link is activated", () => {
      renderShell("/");
      const toggle = screen.getByRole("button", { name: /navigation/i });

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");

      fireEvent.click(screen.getByRole("link", { name: "Accounts" }));

      expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    it("does not still render every nav item twice (single shared nav landmark)", () => {
      renderShell("/");

      expect(screen.getAllByRole("link", { name: "Dashboard" })).toHaveLength(1);
    });
  });
});
