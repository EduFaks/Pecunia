import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SettingsScreen from "./SettingsScreen";

vi.mock("./SessionsPanel", () => ({ default: () => <div>sessions-panel-stub</div> }));
vi.mock("./AuditLogPanel", () => ({ default: () => <div>audit-log-panel-stub</div> }));
vi.mock("./PreferencesPanel", () => ({ default: () => <div>preferences-panel-stub</div> }));
vi.mock("../categories/CategoriesPanel", () => ({ default: () => <div>categories-panel-stub</div> }));

describe("SettingsScreen", () => {
  it("shows Sessions by default", () => {
    render(<SettingsScreen />);

    expect(screen.getByText("sessions-panel-stub")).toBeInTheDocument();
    expect(screen.queryByText("audit-log-panel-stub")).not.toBeInTheDocument();
    expect(screen.queryByText("preferences-panel-stub")).not.toBeInTheDocument();
  });

  it("switches to the Audit Log section", () => {
    render(<SettingsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Audit Log" }));

    expect(screen.getByText("audit-log-panel-stub")).toBeInTheDocument();
    expect(screen.queryByText("sessions-panel-stub")).not.toBeInTheDocument();
  });

  it("switches to the Preferences section", () => {
    render(<SettingsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));

    expect(screen.getByText("preferences-panel-stub")).toBeInTheDocument();
  });

  it("switches to the Categories section", () => {
    render(<SettingsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Categories" }));

    expect(screen.getByText("categories-panel-stub")).toBeInTheDocument();
    expect(screen.queryByText("sessions-panel-stub")).not.toBeInTheDocument();
  });

  it("marks the active section for assistive tech via aria-current", () => {
    render(<SettingsScreen />);

    expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Audit Log" })).not.toHaveAttribute("aria-current");

    fireEvent.click(screen.getByRole("button", { name: "Audit Log" }));
    expect(screen.getByRole("button", { name: "Audit Log" })).toHaveAttribute("aria-current", "page");
  });
});
