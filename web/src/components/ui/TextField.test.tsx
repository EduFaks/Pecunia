import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import TextField, { textFieldInputClasses } from "./TextField";

describe("TextField", () => {
  it("associates the label with the input", () => {
    render(<TextField label="Email" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("renders a description and wires it via aria-describedby", () => {
    render(
      <TextField label="Email" description="We'll never share it." value="" onChange={() => {}} />,
    );
    const input = screen.getByLabelText("Email");
    expect(screen.getByText("We'll never share it.")).toBeInTheDocument();
    expect(input.getAttribute("aria-describedby")).toContain(
      screen.getByText("We'll never share it.").id,
    );
  });

  it("renders an error via an accessible alert and marks the input invalid", () => {
    render(<TextField label="Email" value="" onChange={() => {}} error="Required" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  });

  it("applies the shared white focus-visible ring", () => {
    render(<TextField label="Email" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Email").className).toMatch(/focus-visible:outline-focus/);
  });

  it("renders 16px on mobile (text-base) and reverts to the compact 14px at sm: and up, so iOS never auto-zooms on focus", () => {
    expect(textFieldInputClasses).toMatch(/\btext-base\b/);
    expect(textFieldInputClasses).toMatch(/\bsm:text-sm\b/);
    render(<TextField label="Email" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Email").className).toMatch(/\btext-base\b/);
  });
});
