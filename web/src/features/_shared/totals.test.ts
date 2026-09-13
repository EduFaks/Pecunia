import { describe, expect, it } from "vitest";
import { sumByCurrency } from "./totals";

interface Item {
  currency: string;
  minor: number;
}

describe("sumByCurrency", () => {
  it("groups and sums per currency", () => {
    const items: Item[] = [
      { currency: "USD", minor: 1000 },
      { currency: "EUR", minor: 500 },
      { currency: "USD", minor: 250 },
    ];

    const result = sumByCurrency(
      items,
      (item) => item.minor,
      (item) => item.currency,
    );

    expect(result).toEqual([
      { currency: "USD", total_minor: 1250 },
      { currency: "EUR", total_minor: 500 },
    ]);
  });

  it("includes negative amounts in the sum (never floors/clamps)", () => {
    const items: Item[] = [
      { currency: "USD", minor: 1000 },
      { currency: "USD", minor: -1500 },
    ];

    const result = sumByCurrency(
      items,
      (item) => item.minor,
      (item) => item.currency,
    );

    expect(result).toEqual([{ currency: "USD", total_minor: -500 }]);
  });

  it("never mixes currencies into one figure — each stays its own entry", () => {
    const items: Item[] = [
      { currency: "USD", minor: 100 },
      { currency: "EUR", minor: 100 },
      { currency: "JPY", minor: 100 },
    ];

    const result = sumByCurrency(
      items,
      (item) => item.minor,
      (item) => item.currency,
    );

    expect(result).toHaveLength(3);
    expect(result.map((entry) => entry.currency)).toEqual(["USD", "EUR", "JPY"]);
  });

  it("returns a stable currency order — first-seen order of the input, not alphabetical", () => {
    const items: Item[] = [
      { currency: "EUR", minor: 100 },
      { currency: "USD", minor: 100 },
      { currency: "EUR", minor: 50 },
    ];

    const result = sumByCurrency(
      items,
      (item) => item.minor,
      (item) => item.currency,
    );

    expect(result.map((entry) => entry.currency)).toEqual(["EUR", "USD"]);
  });

  it("omits empty — no items yields no entries", () => {
    const result = sumByCurrency<Item>(
      [],
      (item) => item.minor,
      (item) => item.currency,
    );

    expect(result).toEqual([]);
  });
});
