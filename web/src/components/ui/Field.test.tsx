import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FieldDescription, FieldError, FieldLabel } from "./Field";

describe("Field primitives", () => {
  it("FieldLabel associates with its control via htmlFor and marks required", () => {
    render(
      <>
        <FieldLabel htmlFor="x" required>
          Name
        </FieldLabel>
        <input id="x" />
      </>,
    );
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
  });

  it("FieldError renders as an accessible alert", () => {
    render(<FieldError id="err">Required</FieldError>);
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
  });

  it("FieldDescription renders plain helper text", () => {
    render(<FieldDescription id="desc">Helper text</FieldDescription>);
    expect(screen.getByText("Helper text")).toBeInTheDocument();
  });
});
