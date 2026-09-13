import type * as React from "react";
import { vi } from "vitest";
import "@testing-library/jest-dom/vitest";

// Recharts' `ResponsiveContainer` measures its parent through ResizeObserver,
// which reports 0×0 in jsdom — so every chart nested inside it collapses and
// renders no `<svg>`, making charts untestable. Stub it once, here, so the
// whole suite (Track G charts and beyond) shares one jsdom-friendly render
// path: render children in a fixed-size box and clone the single chart child
// with explicit width/height, exactly what the real container injects. Only
// `ResponsiveContainer` is replaced — every other Recharts export stays real
// via `importOriginal`.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const ReactRuntime = await import("react");
  const ResponsiveContainer = ({ children }: { children: React.ReactNode }) => {
    const sized = ReactRuntime.isValidElement(children)
      ? ReactRuntime.cloneElement(
          children as React.ReactElement<{ width?: number; height?: number }>,
          { width: 800, height: 400 },
        )
      : children;
    return ReactRuntime.createElement("div", { style: { width: 800, height: 400 } }, sized);
  };
  return { ...actual, ResponsiveContainer };
});
