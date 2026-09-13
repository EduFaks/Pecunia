import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins truthy string values with a space", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, undefined, null, "", "b")).toBe("a b");
  });

  it("keeps only truthy keys from an object argument", () => {
    expect(cn({ a: true, b: false, c: true })).toBe("a c");
  });

  it("mixes strings and objects", () => {
    expect(cn("base", { active: true, disabled: false }, "extra")).toBe("base active extra");
  });
});
