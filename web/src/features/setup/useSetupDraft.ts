import { useCallback, useState } from "react";

const STORAGE_KEY = "pecunia.setup.draft";

/**
 * Non-sensitive preference fields the wizard collects. Mirrors
 * `POST /setup/initialize`'s `preferences` shape (see
 * docs/superpowers/plans/2026-09-11-06-setup-wizard.md) — Plan 06 Task 3
 * fills these in from `Intl` hints. All optional: a fresh draft, or one
 * restored mid-wizard, may not have every field set yet. `first_day_of_week`
 * mirrors the backend's own `Literal["monday", "sunday", "saturday"]`
 * (`PreferencesIn` in `api/src/pecunia/api/setup.py`) — a named weekday
 * string, not a numeric index.
 */
export interface SetupPreferencesDraft {
  base_currency?: string;
  locale?: string;
  date_format?: string;
  number_format?: string;
  timezone?: string;
  first_day_of_week?: "monday" | "sunday" | "saturday";
}

/**
 * The resumable wizard draft. Deliberately excludes password/confirm —
 * those live in step-local component state only (Plan 06 Task 2, `StepOwner`)
 * and must never reach this type, `sessionStorage`, or anywhere persisted.
 */
export interface SetupDraft {
  ownerName: string;
  ownerEmail: string;
  preferences: SetupPreferencesDraft;
}

const EMPTY_DRAFT: SetupDraft = {
  ownerName: "",
  ownerEmail: "",
  preferences: {},
};

export interface UseSetupDraftResult {
  draft: SetupDraft;
  /** Merges the top-level draft; `preferences` is merged one level deep so a
   * caller can patch a single preference without re-sending every field
   * already collected. */
  update: (partial: Partial<SetupDraft>) => void;
  clear: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads and validates whatever is in `sessionStorage`, tolerating missing,
 * malformed, or foreign-shaped JSON (a stale draft from an old schema,
 * hand-edited storage, corrupted write) by rebuilding the draft field-by-field
 * rather than trusting the parsed blob wholesale.
 */
function readStoredDraft(): SetupDraft {
  if (typeof window === "undefined") {
    return EMPTY_DRAFT;
  }
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return EMPTY_DRAFT;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return EMPTY_DRAFT;
    }
    return {
      ownerName: typeof parsed.ownerName === "string" ? parsed.ownerName : "",
      ownerEmail: typeof parsed.ownerEmail === "string" ? parsed.ownerEmail : "",
      preferences: isRecord(parsed.preferences)
        ? (parsed.preferences as SetupPreferencesDraft)
        : {},
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function persistDraft(draft: SetupDraft): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // sessionStorage unavailable (private browsing, quota) — the draft
    // simply won't resume; nothing else depends on this write succeeding.
  }
}

/**
 * Persists the non-sensitive setup draft (owner name/email + preferences) to
 * `sessionStorage` under `pecunia.setup.draft`, restoring it on mount (the
 * lazy `useState` initializer runs during the hook's first render) so a
 * refresh mid-wizard doesn't lose progress.
 *
 * SECURITY-CRITICAL: `SetupDraft` structurally has no password field, and
 * `update()` writes an explicit field allowlist (`ownerName`, `ownerEmail`,
 * `preferences`) rather than spreading the caller's `partial` wholesale — so
 * even a caller that bypasses the type system (e.g. an `as any` cast on an
 * owner-state object that happens to carry a password) cannot get a
 * password persisted here. This mirrors the "secrets are structurally
 * unreachable" pattern in docs/CONVENTIONS.md §7.
 */
export function useSetupDraft(): UseSetupDraftResult {
  const [draft, setDraft] = useState<SetupDraft>(readStoredDraft);

  const update = useCallback((partial: Partial<SetupDraft>) => {
    setDraft((prev) => {
      const next: SetupDraft = {
        ownerName: partial.ownerName ?? prev.ownerName,
        ownerEmail: partial.ownerEmail ?? prev.ownerEmail,
        preferences: { ...prev.preferences, ...partial.preferences },
      };
      persistDraft(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // see persistDraft
      }
    }
  }, []);

  return { draft, update, clear };
}
