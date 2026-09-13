import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSetupDraft } from "./useSetupDraft";
import type { SetupDraft } from "./useSetupDraft";

const STORAGE_KEY = "pecunia.setup.draft";

describe("useSetupDraft", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("starts empty when sessionStorage has no prior draft", () => {
    const { result } = renderHook(() => useSetupDraft());
    expect(result.current.draft).toEqual({ ownerName: "", ownerEmail: "", preferences: {} });
  });

  it("round-trips owner name/email and preferences through sessionStorage", () => {
    const { result, unmount } = renderHook(() => useSetupDraft());

    act(() => {
      result.current.update({
        ownerName: "Ada Lovelace",
        ownerEmail: "ada@example.com",
        preferences: { base_currency: "USD", locale: "en-US" },
      });
    });

    expect(result.current.draft).toEqual({
      ownerName: "Ada Lovelace",
      ownerEmail: "ada@example.com",
      preferences: { base_currency: "USD", locale: "en-US" },
    });

    // Simulate a refresh mid-wizard: a fresh hook instance should restore
    // the same draft from sessionStorage on mount.
    unmount();
    const { result: restored } = renderHook(() => useSetupDraft());
    expect(restored.current.draft).toEqual({
      ownerName: "Ada Lovelace",
      ownerEmail: "ada@example.com",
      preferences: { base_currency: "USD", locale: "en-US" },
    });
  });

  it("merges preferences one level deep rather than replacing the whole object", () => {
    const { result } = renderHook(() => useSetupDraft());

    act(() => {
      result.current.update({ preferences: { base_currency: "USD" } });
    });
    act(() => {
      result.current.update({ preferences: { locale: "en-US" } });
    });

    expect(result.current.draft.preferences).toEqual({ base_currency: "USD", locale: "en-US" });
  });

  it("persists under the exact key pecunia.setup.draft", () => {
    const { result } = renderHook(() => useSetupDraft());

    act(() => {
      result.current.update({ ownerName: "Ada" });
    });

    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("clear() resets the draft and removes it from sessionStorage", () => {
    const { result } = renderHook(() => useSetupDraft());

    act(() => {
      result.current.update({ ownerName: "Ada", ownerEmail: "ada@example.com" });
    });
    act(() => {
      result.current.clear();
    });

    expect(result.current.draft).toEqual({ ownerName: "", ownerEmail: "", preferences: {} });
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("NEVER writes a password to sessionStorage, even if a caller smuggles one past the type system", () => {
    const { result } = renderHook(() => useSetupDraft());

    // `SetupDraft` has no password field, so this cast simulates a caller
    // bypassing TypeScript (e.g. spreading an owner-state object that
    // happens to carry a password field) — the hook must still refuse to
    // persist it, structurally, not just by type contract.
    const smuggled = {
      ownerName: "Ada Lovelace",
      ownerEmail: "ada@example.com",
      password: "hunter2-super-secret",
      confirmPassword: "hunter2-super-secret",
    } as unknown as Partial<SetupDraft>;

    act(() => {
      result.current.update(smuggled);
    });

    const stored = window.sessionStorage.getItem(STORAGE_KEY) ?? "";
    expect(stored).not.toContain("hunter2-super-secret");
    expect(stored.toLowerCase()).not.toContain("password");

    // Also scan every sessionStorage key/value the hook could plausibly
    // have written to, not just the known one.
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i) ?? "";
      const value = window.sessionStorage.getItem(key) ?? "";
      expect(key.toLowerCase()).not.toContain("password");
      expect(value).not.toContain("hunter2-super-secret");
    }
  });

  it("ignores a malformed or foreign-shaped blob already in sessionStorage rather than throwing", () => {
    window.sessionStorage.setItem(STORAGE_KEY, "{not valid json");
    const { result } = renderHook(() => useSetupDraft());
    expect(result.current.draft).toEqual({ ownerName: "", ownerEmail: "", preferences: {} });
  });
});
