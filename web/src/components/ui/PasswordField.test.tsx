import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PasswordField from "./PasswordField";

describe("PasswordField", () => {
  it("toggles the input type between password and text via the show/hide control", () => {
    render(<PasswordField label="Password" value="hunter2" onChange={() => {}} />);
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: /show password/i }));
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: /hide password/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /hide password/i }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("marks the toggle button aria-pressed to reflect visibility state", () => {
    render(<PasswordField label="Password" value="" onChange={() => {}} />);
    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("renders an error via an accessible alert and marks the input invalid", () => {
    render(<PasswordField label="Password" value="" onChange={() => {}} error="Too short" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Too short");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
  });

  it("applies the shared white focus-visible ring to the input and toggle", () => {
    render(<PasswordField label="Password" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Password").className).toMatch(/focus-visible:outline-focus/);
    expect(screen.getByRole("button", { name: /show password/i }).className).toMatch(
      /focus-visible:outline-focus/,
    );
  });
});
