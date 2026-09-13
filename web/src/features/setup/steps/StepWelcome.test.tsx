import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import StepWelcome from "./StepWelcome";
import type { WizardStepProps } from "../types";

function stepProps(overrides: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    draft: { ownerName: "", ownerEmail: "", preferences: {} },
    updateDraft: vi.fn(),
    onNext: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe("StepWelcome", () => {
  it("renders the wordmark, the tagline, the privacy statement, and the restore link", () => {
    render(<StepWelcome {...stepProps()} />);

    expect(screen.getByText("PECUNIA")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /your financial life, in one place\./i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/your money\. your server\. your data\./i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /restore an existing pecunia backup/i }),
    ).toBeInTheDocument();
  });

  it("calls onNext when Get Started is clicked", () => {
    const onNext = vi.fn();
    render(<StepWelcome {...stepProps({ onNext })} />);

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("opens an informational dialog about the CLI restore path, and closes it again", () => {
    render(<StepWelcome {...stepProps()} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /restore an existing pecunia backup/i }));

    const dialog = screen.getByRole("dialog", { name: /restoring from a backup/i });
    expect(dialog).toHaveTextContent(/cli/i);
    // V1 has no upload UI — the copy must not imply one exists here.
    expect(screen.queryByLabelText(/upload/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the restore dialog on Escape", () => {
    render(<StepWelcome {...stepProps()} />);

    fireEvent.click(screen.getByRole("button", { name: /restore an existing pecunia backup/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
