import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import StepOwner from "./StepOwner";
import type { SetupDraft } from "../useSetupDraft";

// Verified against the real @zxcvbn-ts/core + language-common scoring (see
// PasswordStrength.test.tsx): score 0, score 1 (weak but 10+ chars), and
// score 4 respectively.
const SHORT_PASSWORD = "short1!"; // 7 chars — fails the 10-char floor
const WEAK_BUT_LONG_PASSWORD = "iloveyou1!"; // 10 chars, zxcvbn score 1
const STRONG_PASSWORD = "N7k$pQ2wZr9vLmX4tY8u"; // 20 chars, zxcvbn score 4

function emptyDraft(): SetupDraft {
  return { ownerName: "", ownerEmail: "", preferences: {} };
}

interface HarnessProps {
  draft: SetupDraft;
  updateDraft: (partial: Partial<SetupDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}

/** Mirrors how `WizardShell` actually wires `StepOwner`: the password lives
 * in state one level up (here, the harness) and reaches the step as a
 * controlled `password`/`onPasswordChange` pair — never through `draft`. */
function StepOwnerHarness({ draft, updateDraft, onNext, onBack }: HarnessProps) {
  const [password, setPassword] = useState("");
  return (
    <StepOwner
      draft={draft}
      updateDraft={updateDraft}
      onNext={onNext}
      onBack={onBack}
      password={password}
      onPasswordChange={setPassword}
    />
  );
}

function nameField() {
  return screen.getByLabelText(/^name$/i);
}
function emailField() {
  return screen.getByLabelText(/^email$/i);
}
function passwordField() {
  return screen.getByLabelText(/^password$/i);
}
function confirmField() {
  return screen.getByLabelText(/^confirm password$/i);
}
function continueButton() {
  return screen.getByRole("button", { name: /continue/i });
}

function fillForm({
  name = "Ada Lovelace",
  email = "ada@example.com",
  password = STRONG_PASSWORD,
  confirm = password,
}: { name?: string; email?: string; password?: string; confirm?: string } = {}) {
  fireEvent.change(nameField(), { target: { value: name } });
  fireEvent.blur(nameField());
  fireEvent.change(emailField(), { target: { value: email } });
  fireEvent.blur(emailField());
  fireEvent.change(passwordField(), { target: { value: password } });
  fireEvent.blur(passwordField());
  fireEvent.change(confirmField(), { target: { value: confirm } });
  fireEvent.blur(confirmField());
}

describe("StepOwner", () => {
  it('shows the copy "This account controls this Pecunia instance." near the heading', () => {
    render(
      <StepOwnerHarness draft={emptyDraft()} updateDraft={vi.fn()} onNext={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByRole("heading")).toBeInTheDocument();
    expect(screen.getByText("This account controls this Pecunia instance.")).toBeInTheDocument();
  });

  it("Continue starts disabled", () => {
    render(
      <StepOwnerHarness draft={emptyDraft()} updateDraft={vi.fn()} onNext={vi.fn()} onBack={vi.fn()} />,
    );
    expect(continueButton()).toBeDisabled();
  });

  it("keeps Continue disabled with an invalid email", () => {
    render(
      <StepOwnerHarness draft={emptyDraft()} updateDraft={vi.fn()} onNext={vi.fn()} onBack={vi.fn()} />,
    );
    fillForm({ email: "not-an-email" });
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText(/valid email/i)).toBeInTheDocument();
  });

  it("keeps Continue disabled with a password shorter than 10 characters", () => {
    render(
      <StepOwnerHarness draft={emptyDraft()} updateDraft={vi.fn()} onNext={vi.fn()} onBack={vi.fn()} />,
    );
    fillForm({ password: SHORT_PASSWORD, confirm: SHORT_PASSWORD });
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText(/10.*128 characters/i)).toBeInTheDocument();
  });

  it("keeps Continue disabled when confirm does not match password", () => {
    render(
      <StepOwnerHarness draft={emptyDraft()} updateDraft={vi.fn()} onNext={vi.fn()} onBack={vi.fn()} />,
    );
    fillForm({ password: STRONG_PASSWORD, confirm: STRONG_PASSWORD + "x" });
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText(/don.t match/i)).toBeInTheDocument();
  });

  it("keeps Continue disabled when the password is long enough but too weak (score < 2)", () => {
    render(
      <StepOwnerHarness draft={emptyDraft()} updateDraft={vi.fn()} onNext={vi.fn()} onBack={vi.fn()} />,
    );
    fillForm({ password: WEAK_BUT_LONG_PASSWORD, confirm: WEAK_BUT_LONG_PASSWORD });
    expect(continueButton()).toBeDisabled();
    // Both the strength meter's label ("Weak") and the field's own error
    // ("too weak") mention weakness — assert the field error specifically.
    expect(screen.getByText(/too weak/i)).toBeInTheDocument();
  });

  it("enables Continue once name, email, a strong 10+ char password, and a matching confirm are all valid", () => {
    render(
      <StepOwnerHarness draft={emptyDraft()} updateDraft={vi.fn()} onNext={vi.fn()} onBack={vi.fn()} />,
    );
    fillForm();
    expect(continueButton()).toBeEnabled();
  });

  it("Back calls onBack (returns to Welcome)", () => {
    const onBack = vi.fn();
    render(
      <StepOwnerHarness draft={emptyDraft()} updateDraft={vi.fn()} onNext={vi.fn()} onBack={onBack} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("on Continue, writes only name/email into the draft (never the password) and advances", () => {
    const updateDraft = vi.fn();
    const onNext = vi.fn();
    render(
      <StepOwnerHarness draft={emptyDraft()} updateDraft={updateDraft} onNext={onNext} onBack={vi.fn()} />,
    );
    fillForm({ name: "Ada Lovelace", email: "ada@example.com", password: STRONG_PASSWORD });

    fireEvent.click(continueButton());

    expect(updateDraft).toHaveBeenCalledWith({ ownerName: "Ada Lovelace", ownerEmail: "ada@example.com" });
    expect(onNext).toHaveBeenCalledTimes(1);

    // Structural guarantee: no call to updateDraft ever carried a `password`
    // key or the raw password string.
    for (const call of updateDraft.mock.calls) {
      const partial = call[0] as Record<string, unknown>;
      expect(partial).not.toHaveProperty("password");
      expect(JSON.stringify(partial)).not.toContain(STRONG_PASSWORD);
    }
  });

  it("prefills name/email from an existing draft (resuming mid-wizard)", () => {
    render(
      <StepOwnerHarness
        draft={{ ownerName: "Grace Hopper", ownerEmail: "grace@example.com", preferences: {} }}
        updateDraft={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(nameField()).toHaveValue("Grace Hopper");
    expect(emailField()).toHaveValue("grace@example.com");
  });
});
