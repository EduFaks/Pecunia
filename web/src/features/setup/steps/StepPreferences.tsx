import { useLayoutEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import Button from "../../../components/ui/Button";
import Callout from "../../../components/ui/Callout";
import Card from "../../../components/ui/Card";
import Select from "../../../components/ui/Select";
import type { SelectOption } from "../../../components/ui/Select";
import { ApiError } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import CurrencySelect from "../CurrencySelect";
import { initialize } from "../setupApi";
import type { SetupPreferencesDraft } from "../useSetupDraft";
import type { WizardStepProps } from "../types";

export interface StepPreferencesProps extends WizardStepProps {
  /** The in-progress owner password — see `StepOwner`'s identical prop.
   * Read here (never persisted) for the one atomic `initialize` call, then
   * blanked out via `onPasswordChange("")` once that call succeeds. */
  password: string;
  onPasswordChange: (password: string) => void;
  /** `useSetupDraft()`'s `clear()`, threaded down from `WizardShell` — wipes
   * the resumable draft once the owner account actually exists server-side,
   * since nothing in it is needed past this point (the app reads the owner
   * from the auth store from here on). */
  clearDraft: () => void;
}

type FirstDayOfWeek = "monday" | "sunday" | "saturday";

const DATE_FORMAT_OPTIONS: SelectOption[] = [
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY" },
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD" },
  { value: "DD.MM.YYYY", label: "DD.MM.YYYY" },
];

const NUMBER_FORMAT_OPTIONS: SelectOption[] = [
  { value: "1,234.56", label: "1,234.56" },
  { value: "1.234,56", label: "1.234,56" },
  { value: "1 234,56", label: "1 234,56" },
  { value: "1'234.56", label: "1’234.56" },
];

const FIRST_DAY_OPTIONS: SelectOption[] = [
  { value: "monday", label: "Monday" },
  { value: "sunday", label: "Sunday" },
  { value: "saturday", label: "Saturday" },
];

const LOCALE_CODES = [
  "en-US",
  "en-GB",
  "pt-BR",
  "pt-PT",
  "es-ES",
  "es-MX",
  "fr-FR",
  "de-DE",
  "it-IT",
  "nl-NL",
  "sv-SE",
  "pl-PL",
  "tr-TR",
  "ru-RU",
  "ja-JP",
  "ko-KR",
  "zh-CN",
  "zh-TW",
  "ar-SA",
  "hi-IN",
];

function localeLabel(code: string): string {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    const label = names.of(code);
    return label ? `${label} (${code})` : code;
  } catch {
    return code;
  }
}

function localeOptions(resolvedLocale: string): SelectOption[] {
  const codes = LOCALE_CODES.includes(resolvedLocale)
    ? LOCALE_CODES
    : [resolvedLocale, ...LOCALE_CODES];
  return codes.map((code) => ({ value: code, label: localeLabel(code) }));
}

const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Lisbon",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
];

function timezoneOptions(resolvedTimeZone: string): SelectOption[] {
  let zones: string[] = [];
  try {
    zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    zones = [];
  }
  if (zones.length === 0) {
    zones = FALLBACK_TIMEZONES;
  }
  if (!zones.includes(resolvedTimeZone)) {
    zones = [resolvedTimeZone, ...zones];
  }
  return zones.map((zone) => ({ value: zone, label: zone }));
}

// Best-effort per-locale defaults, keyed off the locale's region subtag —
// not authoritative (calendar conventions have real exceptions), but a
// reasonable guess so "confirm and continue" is the common path (per the
// Plan 06 spec). The user can always change these, here or later in
// Settings.
const COMMA_DECIMAL_REGIONS = new Set([
  "DE", "AT", "CH", "FR", "IT", "ES", "PT", "NL", "BE", "PL", "CZ", "SK", "HU",
  "RO", "BG", "GR", "SE", "NO", "DK", "FI", "RU", "UA", "BR", "AR", "CL", "CO", "PE",
]);
const DOT_DATE_REGIONS = new Set(["DE", "AT", "CH", "DK"]);
const YMD_DATE_REGIONS = new Set(["JP", "KR", "CN", "TW", "HU", "LT", "IS"]);
const MDY_DATE_REGIONS = new Set(["US"]);
const SUNDAY_FIRST_REGIONS = new Set([
  "US", "CA", "BR", "MX", "JP", "KR", "PH", "TW", "HK", "CO", "VE", "IL",
]);
const SATURDAY_FIRST_REGIONS = new Set(["EG", "AE", "SA", "QA", "BH", "KW", "DZ", "SY"]);

function regionOf(locale: string): string {
  try {
    const parsed = new Intl.Locale(locale);
    return (parsed.region ?? parsed.maximize().region ?? "").toUpperCase();
  } catch {
    const parts = locale.split(/[-_]/);
    return (parts[1] ?? "").toUpperCase();
  }
}

interface LocaleDefaults {
  date_format: string;
  number_format: string;
  first_day_of_week: FirstDayOfWeek;
}

function localeDefaults(locale: string): LocaleDefaults {
  const region = regionOf(locale);
  const date_format = MDY_DATE_REGIONS.has(region)
    ? "MM/DD/YYYY"
    : YMD_DATE_REGIONS.has(region)
      ? "YYYY-MM-DD"
      : DOT_DATE_REGIONS.has(region)
        ? "DD.MM.YYYY"
        : "DD/MM/YYYY";
  const number_format = COMMA_DECIMAL_REGIONS.has(region) ? "1.234,56" : "1,234.56";
  const first_day_of_week: FirstDayOfWeek = SATURDAY_FIRST_REGIONS.has(region)
    ? "saturday"
    : SUNDAY_FIRST_REGIONS.has(region)
      ? "sunday"
      : "monday";
  return { date_format, number_format, first_day_of_week };
}

const FIELD_LABELS: Record<string, string> = {
  name: "name",
  email: "email",
  password: "password",
  base_currency: "base currency",
  locale: "locale",
  date_format: "date format",
  number_format: "number format",
  timezone: "timezone",
  first_day_of_week: "first day of week",
};

const NETWORK_ERROR_MESSAGE = "Couldn't reach Pecunia. Check your connection and try again.";
const SETUP_TOKEN_ERROR_MESSAGE =
  "This Pecunia instance requires a setup token before it can be initialized. Set PECUNIA_SETUP_TOKEN when starting the server, or ask whoever deployed it, then try again.";
const SERVER_ERROR_MESSAGE = "Something went wrong initializing Pecunia. Please try again.";

/**
 * `error instanceof ApiError` means the server actually responded (with a
 * real HTTP status) — `apiFetch` (lib/api.ts) only ever throws `ApiError`
 * from a non-2xx response, never from the request failing to reach the
 * server at all. So for any status this function doesn't special-case
 * (403's missing/invalid setup token, 422's per-field message), the honest
 * message is a generic server error, not `NETWORK_ERROR_MESSAGE` — a 500
 * did reach Pecunia; a `TypeError` from `fetch` itself (caught by the
 * `else` below, not `instanceof ApiError`) didn't.
 */
function initializeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return SETUP_TOKEN_ERROR_MESSAGE;
    }
    if (error.status === 422) {
      const first = error.fieldErrors?.[0];
      const lastSegment = first?.loc[first.loc.length - 1];
      const field = typeof lastSegment === "string" ? (FIELD_LABELS[lastSegment] ?? lastSegment) : undefined;
      return field
        ? `There's a problem with ${field}. ${first?.msg ?? "Please check your entries and try again."}`
        : NETWORK_ERROR_MESSAGE;
    }
    return SERVER_ERROR_MESSAGE;
  }
  return NETWORK_ERROR_MESSAGE;
}

/**
 * Step 3 — Preferences: the wizard's pivotal step. Base currency is the
 * hero control (`CurrencySelect`, the one field left to a deliberate
 * choice); locale/timezone/date format/number format/first day of week are
 * pre-filled from `Intl.DateTimeFormat().resolvedOptions()` plus
 * `localeDefaults()`'s best-effort per-locale guesses, so the common path is
 * "confirm and continue" (Plan 06 spec). Continue fires the wizard's one
 * pivotal write: `POST /setup/initialize`, combining owner (name/email from
 * the draft, password from `WizardShell`'s in-memory state) and preferences
 * into a single atomic call. On success the returned session is adopted
 * into the auth store (auto-login), the draft and in-memory password are
 * both wiped, and the wizard advances to step 4 — see the module-level error
 * matrix in `initializeErrorMessage` for how 409/422/403/network failures
 * are each handled.
 *
 * On success (201) the setup-status query cache (`["setup-status"]`, same
 * key `useSetupStatus`/`StepFinish` use) is deliberately left untouched
 * here — see `StepFinish`'s doc comment for why that write has to wait
 * until the wizard actually leaves `/setup/*`, or `RequireSetup` would
 * redirect to `/` immediately and skip Steps 4 and 5. The 409
 * (`SETUP_ALREADY_COMPLETE`) branch is different: it already navigates
 * straight to `/`, bypassing Steps 4/5 entirely, so it's the one place in
 * *this* step that leaves `/setup/*` — same situation `StepFinish` is in,
 * so it gets the same fix, in the same tick as the `navigate` call: a 409
 * here authoritatively means the instance IS initialized (some other
 * client won the race), so the cache is written directly rather than left
 * to expire on its own `staleTime` — otherwise `RequireSetup` (the
 * outermost guard, which doesn't remount on this child navigation) can
 * still be serving the stale `{initialized: false}` it fetched when the
 * wizard first mounted, and bounce the visitor straight back to `/setup`.
 */
function StepPreferences({
  draft,
  updateDraft,
  onNext,
  onBack,
  password,
  onPasswordChange,
  clearDraft,
}: StepPreferencesProps) {
  const { adoptSession } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Runs once, on mount: fills in only the preference fields the draft
  // doesn't already have (so returning to this step via Back/forward, or
  // resuming a mid-wizard refresh, never clobbers a value the user already
  // confirmed or changed). `useLayoutEffect` (not `useEffect`) so the guess
  // is in place before the first paint — the selects never flash empty.
  useLayoutEffect(() => {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    const defaults = localeDefaults(draft.preferences.locale ?? resolved.locale);
    const patch: SetupPreferencesDraft = {};
    if (!draft.preferences.timezone) {
      patch.timezone = resolved.timeZone;
    }
    if (!draft.preferences.locale) {
      patch.locale = resolved.locale;
    }
    if (!draft.preferences.date_format) {
      patch.date_format = defaults.date_format;
    }
    if (!draft.preferences.number_format) {
      patch.number_format = defaults.number_format;
    }
    if (!draft.preferences.first_day_of_week) {
      patch.first_day_of_week = defaults.first_day_of_week;
    }
    if (Object.keys(patch).length > 0) {
      updateDraft({ preferences: patch });
    }
    // Deliberately runs once on mount only — see the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prefs = draft.preferences;
  const canContinue = Boolean(
    prefs.base_currency &&
      prefs.locale &&
      prefs.date_format &&
      prefs.number_format &&
      prefs.timezone &&
      prefs.first_day_of_week,
  );

  function patchPreferences(partial: SetupPreferencesDraft) {
    updateDraft({ preferences: partial });
  }

  function selectHandler(field: keyof SetupPreferencesDraft) {
    return (event: ChangeEvent<HTMLSelectElement>) => {
      patchPreferences({ [field]: event.target.value } as SetupPreferencesDraft);
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !canContinue) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await initialize({
        owner: { name: draft.ownerName, email: draft.ownerEmail, password },
        preferences: {
          base_currency: prefs.base_currency!,
          locale: prefs.locale!,
          date_format: prefs.date_format!,
          number_format: prefs.number_format!,
          timezone: prefs.timezone!,
          first_day_of_week: prefs.first_day_of_week!,
        },
      });
      adoptSession(response);
      clearDraft();
      onPasswordChange("");
      onNext();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        navigate("/", { replace: true });
        queryClient.setQueryData(["setup-status"], { initialized: true });
        return;
      }
      setError(initializeErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const resolvedLocaleForOptions = prefs.locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  const resolvedTimezoneForOptions =
    prefs.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6 py-12">
      <Card className="w-full max-w-lg">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-ink-faint">Setup · Step 3 of 5</p>
        <h1 className="mt-2 font-display text-2xl text-ink">Set your preferences</h1>
        <p className="mt-1 text-sm text-ink-2">
          We&rsquo;ve guessed these from your browser — just confirm and continue.
        </p>

        <form className="mt-8 flex flex-col gap-6" noValidate onSubmit={(event) => void handleSubmit(event)}>
          <CurrencySelect
            value={prefs.base_currency ?? ""}
            onChange={(code) => patchPreferences({ base_currency: code })}
          />

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Select
              label="Locale"
              options={localeOptions(resolvedLocaleForOptions)}
              value={prefs.locale ?? ""}
              onChange={selectHandler("locale")}
            />
            <Select
              label="Timezone"
              options={timezoneOptions(resolvedTimezoneForOptions)}
              value={prefs.timezone ?? ""}
              onChange={selectHandler("timezone")}
            />
            <Select
              label="Date format"
              options={DATE_FORMAT_OPTIONS}
              value={prefs.date_format ?? ""}
              onChange={selectHandler("date_format")}
            />
            <Select
              label="Number format"
              options={NUMBER_FORMAT_OPTIONS}
              value={prefs.number_format ?? ""}
              onChange={selectHandler("number_format")}
            />
            <Select
              label="First day of week"
              options={FIRST_DAY_OPTIONS}
              value={prefs.first_day_of_week ?? ""}
              onChange={selectHandler("first_day_of_week")}
            />
          </div>

          {error ? <Callout variant="negative">{error}</Callout> : null}

          <p className="text-xs text-ink-faint">You can change all of this later in Settings.</p>

          <div className="mt-2 flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" onClick={onBack} disabled={submitting}>
              ← Back
            </Button>
            <Button type="submit" disabled={!canContinue || submitting} loading={submitting}>
              Continue →
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

export default StepPreferences;
