import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders without crashing and shows the branded splash while setup/auth resolve", () => {
    // A never-resolving fetch keeps setup-status and the auth boot sequence
    // both in their initial loading state, so this is a deterministic
    // smoke test of the route tree's outermost guard rather than a real
    // network round trip (which guards.test.tsx covers in detail with
    // mocked hooks).
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<App />);

    expect(screen.getByText(/PECUNIA/)).toBeInTheDocument();
  });
});
