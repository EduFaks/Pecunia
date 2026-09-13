import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { DateText, MoneyText, usePreferences } from "./preferences";
import type { Preferences } from "./preferences";
import { qk } from "./queries";

// `usePreferences` calls `apiFetch` itself (see its docstring) — mocked here
// per CONVENTIONS §9.10 rather than letting it hit the network in a
// component test.
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

// Distinct from `usePreferences`'s internal FALLBACK_PREFERENCES.locale
// ("en-US") so a test can tell "read the seeded cache" apart from "fell
// back to the default".
const SEEDED_PREFERENCES: Preferences = {
  base_currency: "GBP",
  locale: "en-GB",
  date_format: "DD/MM/YYYY",
  number_format: "1,234.56",
  timezone: "Europe/London",
  first_day_of_week: "monday",
};

function renderWithQuery(ui: ReactElement, seed?: Preferences) {
  const queryClient = new QueryClient();
  if (seed) {
    queryClient.setQueryData(qk.me, { user: null, preferences: seed });
  }
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function PreferencesConsumer() {
  const preferences = usePreferences();
  return <span>{preferences.locale}</span>;
}

describe("usePreferences", () => {
  beforeEach(() => {
    // A sane default so a background refetch (TanStack Query's default
    // staleTime is 0, so mounting with seeded cache data still triggers one)
    // resolves cleanly instead of a mock with no implementation returning
    // `undefined`, which React Query rejects as an invalid queryFn result.
    mockApiFetch.mockReset().mockResolvedValue({ user: null, preferences: SEEDED_PREFERENCES });
  });

  it("returns the cached /auth/me preferences on the very first render, before any fetch could resolve", () => {
    renderWithQuery(<PreferencesConsumer />, SEEDED_PREFERENCES);

    // Synchronous: no `waitFor` needed — the seeded cache value is what
    // `usePreferences` returns on mount, not a later, awaited fetch result.
    expect(screen.getByText("en-GB")).toBeInTheDocument();
  });

  it("falls back to sensible defaults before /auth/me has resolved", () => {
    mockApiFetch.mockImplementation(() => new Promise(() => {}));

    renderWithQuery(<PreferencesConsumer />);

    expect(screen.getByText("en-US")).toBeInTheDocument();
  });
});

describe("MoneyText", () => {
  beforeEach(() => {
    mockApiFetch.mockReset().mockResolvedValue({ user: null, preferences: SEEDED_PREFERENCES });
  });

  it("renders the formatted amount, mono and tabular", () => {
    renderWithQuery(<MoneyText minor={123456} currency="USD" />, SEEDED_PREFERENCES);

    const el = screen.getByText(/1,234\.56/);
    expect(el).toHaveClass("font-mono", "tabular-figures");
  });

  it("never colors a plain balance, even when negative", () => {
    renderWithQuery(<MoneyText minor={-500} currency="USD" />, SEEDED_PREFERENCES);

    const el = screen.getByText(/5\.00/);
    expect(el.className).not.toMatch(/text-positive|text-negative/);
  });

  it("applies text-positive for a positive amount only when colorBySign is set", () => {
    renderWithQuery(<MoneyText minor={500} currency="USD" colorBySign />, SEEDED_PREFERENCES);

    expect(screen.getByText(/5\.00/)).toHaveClass("text-positive");
  });

  it("applies text-negative for a negative amount when colorBySign is set", () => {
    renderWithQuery(<MoneyText minor={-500} currency="USD" colorBySign />, SEEDED_PREFERENCES);

    expect(screen.getByText(/5\.00/)).toHaveClass("text-negative");
  });

  it("colors exactly zero as plain ink, not positive or negative, even with colorBySign", () => {
    renderWithQuery(<MoneyText minor={0} currency="USD" colorBySign />, SEEDED_PREFERENCES);

    const el = screen.getByText(/0\.00/);
    expect(el).toHaveClass("text-ink");
    expect(el.className).not.toMatch(/text-positive|text-negative/);
  });

  it("merges a caller-provided className", () => {
    renderWithQuery(
      <MoneyText minor={100} currency="USD" className="text-lg" />,
      SEEDED_PREFERENCES,
    );

    expect(screen.getByText(/1\.00/)).toHaveClass("text-lg");
  });

  it("defaults to the mono variant (font-mono, tabular-figures)", () => {
    renderWithQuery(<MoneyText minor={100} currency="USD" />, SEEDED_PREFERENCES);

    expect(screen.getByText(/1\.00/)).toHaveClass("font-mono", "tabular-figures");
  });

  it("renders the hero variant in the display font, still tabular", () => {
    renderWithQuery(<MoneyText minor={100} currency="USD" variant="hero" />, SEEDED_PREFERENCES);

    const el = screen.getByText(/1\.00/);
    expect(el).toHaveClass("font-display", "tabular-figures");
    expect(el.className).not.toMatch(/font-mono/);
  });

  it("flagNegative colors a negative amount text-negative", () => {
    renderWithQuery(<MoneyText minor={-500} currency="USD" flagNegative />, SEEDED_PREFERENCES);

    expect(screen.getByText(/5\.00/)).toHaveClass("text-negative");
  });

  it("flagNegative never colors a positive amount (no green-by-default)", () => {
    renderWithQuery(<MoneyText minor={500} currency="USD" flagNegative />, SEEDED_PREFERENCES);

    const el = screen.getByText(/5\.00/);
    expect(el.className).not.toMatch(/text-positive|text-negative/);
  });

  it("flagNegative leaves exactly zero plain", () => {
    renderWithQuery(<MoneyText minor={0} currency="USD" flagNegative />, SEEDED_PREFERENCES);

    const el = screen.getByText(/0\.00/);
    expect(el.className).not.toMatch(/text-positive|text-negative/);
  });
});

describe("DateText", () => {
  beforeEach(() => {
    mockApiFetch.mockReset().mockResolvedValue({ user: null, preferences: SEEDED_PREFERENCES });
  });

  it("formats the ISO date using the preference's date_format", () => {
    renderWithQuery(
      <DateText iso="2026-09-11T00:00:00.000Z" />,
      SEEDED_PREFERENCES, // DD/MM/YYYY
    );

    expect(screen.getByText("11/09/2026")).toBeInTheDocument();
  });
});
