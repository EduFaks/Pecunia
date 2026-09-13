import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Wordmark from "./Wordmark";

describe("Wordmark", () => {
  it("renders the PECUNIA wordmark text", () => {
    render(<Wordmark />);
    expect(screen.getByText("PECUNIA")).toBeInTheDocument();
  });

  it("renders text only (no mark) by default", () => {
    const { container } = render(<Wordmark />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders the Plume mark alongside the text when withMark is set", () => {
    const { container } = render(<Wordmark withMark />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByText("PECUNIA")).toBeInTheDocument();
  });
});
