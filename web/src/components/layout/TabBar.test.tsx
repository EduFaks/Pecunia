import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TabBar from "./TabBar";

function renderTabBar(initialPath: string) {
  return render(
    <MemoryRouter
      initialEntries={[initialPath]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <TabBar />
    </MemoryRouter>,
  );
}

describe("TabBar", () => {
  it("renders all six tabs as links to their real routes", () => {
    renderTabBar("/");

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Transações" })).toHaveAttribute(
      "href",
      "/transactions",
    );
    expect(screen.getByRole("link", { name: "Insights" })).toHaveAttribute("href", "/insights");
    expect(screen.getByRole("link", { name: "Previsão" })).toHaveAttribute("href", "/forecast");
    expect(screen.getByRole("link", { name: "Contas" })).toHaveAttribute("href", "/accounts");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  it("renders a lucide icon alongside each tab's label", () => {
    renderTabBar("/");

    const dashboard = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboard.querySelector("svg")).toBeInTheDocument();
    const contas = screen.getByRole("link", { name: "Contas" });
    expect(contas.querySelector("svg")).toBeInTheDocument();
  });

  it("marks the active tab for the current route via aria-current, and only that one", () => {
    renderTabBar("/transactions");

    expect(screen.getByRole("link", { name: "Transações" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Insights" })).not.toHaveAttribute("aria-current");
  });

  it("marks Previsão active at the /forecast route, and only that one", () => {
    renderTabBar("/forecast");

    expect(screen.getByRole("link", { name: "Previsão" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Insights" })).not.toHaveAttribute("aria-current");
  });

  it("marks Dashboard active only at the exact root path, not every nested route", () => {
    renderTabBar("/settings");

    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });

  // Desktop keeps the AppShell sidebar; the bar only ever appears below the
  // `md` breakpoint. jsdom doesn't evaluate `md:` media queries, so this
  // asserts the class is present rather than a real narrow-viewport render
  // (same caveat AppShell.test.tsx documents for its own drawer).
  it("is hidden at the md breakpoint and up (desktop keeps the sidebar)", () => {
    renderTabBar("/");

    expect(screen.getByRole("navigation", { name: /tab bar/i })).toHaveClass("md:hidden");
  });

  it("clears the iPhone home indicator with a safe-area-aware bottom pad", () => {
    renderTabBar("/");

    expect(screen.getByRole("navigation", { name: /tab bar/i }).className).toMatch(
      /pb-\[env\(safe-area-inset-bottom\)\]/,
    );
  });
});
