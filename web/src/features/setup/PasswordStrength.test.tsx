import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import PasswordStrength from "./PasswordStrength";

// Chosen (and verified against the actual @zxcvbn-ts/core + language-common
// scoring) as a score-0 password ("password" is the single most common
// password in the dictionary) and a score-4 password (24 random mixed-case/
// digit/symbol characters — astronomically high guess count).
const WEAK_PASSWORD = "password";
const STRONG_PASSWORD = "kX9$vL2!qZ8@mR5&pW1#tY6";

describe("PasswordStrength", () => {
  it("renders an aria-live=polite label region", () => {
    render(<PasswordStrength password={WEAK_PASSWORD} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it('labels a weak password ("password") as Weak', () => {
    render(<PasswordStrength password={WEAK_PASSWORD} />);
    expect(screen.getByRole("status")).toHaveTextContent(/weak/i);
  });

  it("labels a long, random, high-entropy password as Strong", () => {
    render(<PasswordStrength password={STRONG_PASSWORD} />);
    expect(screen.getByRole("status")).toHaveTextContent(/strong/i);
  });

  it("shows a different label for weak vs strong passwords", () => {
    const { rerender } = render(<PasswordStrength password={WEAK_PASSWORD} />);
    const weakLabel = screen.getByRole("status").textContent;

    rerender(<PasswordStrength password={STRONG_PASSWORD} />);
    const strongLabel = screen.getByRole("status").textContent;

    expect(weakLabel).not.toEqual(strongLabel);
  });

  it("reports the numeric score to the parent via onScoreChange", () => {
    const onScoreChange = vi.fn();
    const { rerender } = render(
      <PasswordStrength password={WEAK_PASSWORD} onScoreChange={onScoreChange} />,
    );
    expect(onScoreChange).toHaveBeenLastCalledWith(0);

    rerender(<PasswordStrength password={STRONG_PASSWORD} onScoreChange={onScoreChange} />);
    expect(onScoreChange).toHaveBeenLastCalledWith(4);
  });

  it("renders the meter as a single widening bar, not a segmented traffic-light bar", () => {
    const { container } = render(<PasswordStrength password={STRONG_PASSWORD} />);

    // A single clean fill bar, not an SVG stroke.
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelectorAll("[data-password-fill]").length).toBe(1);

    // Not a segmented/traffic-light bar: no row of discrete colored blocks.
    expect(container.querySelectorAll('[data-segment]').length).toBe(0);
  });

  it("widens the fill bar as the score rises", () => {
    const { container: weakContainer } = render(<PasswordStrength password={WEAK_PASSWORD} />);
    const { container: strongContainer } = render(
      <PasswordStrength password={STRONG_PASSWORD} />,
    );

    const weakFill = weakContainer.querySelector("[data-password-fill]") as HTMLElement | null;
    const strongFill = strongContainer.querySelector("[data-password-fill]") as HTMLElement | null;
    expect(weakFill).not.toBeNull();
    expect(strongFill).not.toBeNull();

    const weakWidth = Number.parseFloat(weakFill!.style.width);
    const strongWidth = Number.parseFloat(strongFill!.style.width);
    expect(strongWidth).toBeGreaterThan(weakWidth);
  });

  it("shows nothing yet for an empty password", () => {
    render(<PasswordStrength password="" />);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});
