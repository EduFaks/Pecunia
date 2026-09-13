import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import StepPreferences from "./StepPreferences";
import type { SetupDraft } from "../useSetupDraft";
import { apiFetch, ApiError } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import type { AuthContextValue } from "../../../lib/auth";

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("../../../lib/auth", () => ({ useAuth: vi.fn() }));

const mockApiFetch = vi.mocked(apiFetch);
const mockUseAuth = vi.mocked(useAuth);
const DEFAULT_PASSWORD = "N7k$pQ2wZr9vLmX4tY8u";

function authState(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: null,
    status: "anon",
    login: vi.fn(),
    adoptSession: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    ...overrides,
  };
}

function draftWith(preferences: SetupDraft["preferences"] = {}): SetupDraft {
  return { ownerName: "Ada Lovelace", ownerEmail: "ada@example.com", preferences };
}

function mergeDraft(prev: SetupDraft, partial: Partial<SetupDraft>): SetupDraft {
  return {
    ownerName: partial.ownerName ?? prev.ownerName,
    ownerEmail: partial.ownerEmail ?? prev.ownerEmail,
    preferences: { ...prev.preferences, ...partial.preferences },
  };
}

interface HarnessProps {
  initialDraft: SetupDraft;
  onNext: () => void;
  onBack: () => void;
  clearDraft: () => void;
  password: string;
  onDraftChange?: (draft: SetupDraft) => void;
  onPasswordChangeObserved?: (password: string) => void;
}

/** Mirrors the real `WizardShell`: `draft` lives in actual React state (so
 * `updateDraft` re-renders `StepPreferences` with fresh `draft.preferences`,
 * exactly like `useSetupDraft`'s `update()` does) and the owner password is
 * a controlled value one level up, cleared via `onPasswordChange` the same
 * way `WizardShell` threads it into `StepOwner`. */
function StepPreferencesHarness({
  initialDraft,
  onNext,
  onBack,
  clearDraft,
  password,
  onDraftChange,
  onPasswordChangeObserved,
}: HarnessProps) {
  const [draft, setDraft] = useState<SetupDraft>(initialDraft);
  const [pw, setPw] = useState(password);

  useEffect(() => {
    onDraftChange?.(draft);
    // `onDraftChange` is a test-only observer callback, not a reactive
    // dependency — see PasswordStrength.tsx's identical pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  useEffect(() => {
    onPasswordChangeObserved?.(pw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pw]);

  function updateDraft(partial: Partial<SetupDraft>) {
    setDraft((prev) => mergeDraft(prev, partial));
  }

  return (
    <StepPreferences
      draft={draft}
      updateDraft={updateDraft}
      onNext={onNext}
      onBack={onBack}
      clearDraft={clearDraft}
      password={pw}
      onPasswordChange={setPw}
    />
  );
}

function renderStep(options: {
  draft?: SetupDraft;
  onNext?: () => void;
  onBack?: () => void;
  clearDraft?: () => void;
  password?: string;
  onDraftChange?: (draft: SetupDraft) => void;
  onPasswordChangeObserved?: (password: string) => void;
} = {}) {
  const initialDraft = options.draft ?? draftWith();
  const onNext = options.onNext ?? vi.fn();
  const onBack = options.onBack ?? vi.fn();
  const clearDraft = options.clearDraft ?? vi.fn();
  const password = options.password ?? DEFAULT_PASSWORD;
  // A real QueryClient (not mocked), mirroring StepFinish.test.tsx: the 409
  // handler reads `useQueryClient()` to mark the setup-status cache
  // initialized in the same tick it navigates to "/" — no network query
  // ever actually runs against it in these tests, only direct cache
  // writes/reads.
  const queryClient = new QueryClient();

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={["/setup/preferences"]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route
            path="/setup/preferences"
            element={
              <StepPreferencesHarness
                initialDraft={initialDraft}
                onNext={onNext}
                onBack={onBack}
                clearDraft={clearDraft}
                password={password}
                onDraftChange={options.onDraftChange}
                onPasswordChangeObserved={options.onPasswordChangeObserved}
              />
            }
          />
          <Route path="/" element={<div>App shell (post-setup landing)</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { ...view, onNext, onBack, clearDraft, queryClient };
}

/** Renders the step and returns a getter for the latest merged draft, driven
 * by the harness's real `useState` — used by tests asserting on prefill/
 * selection results rather than on `apiFetch`'s call args. */
function renderStepTrackingDraft(options: Parameters<typeof renderStep>[0] = {}) {
  let latest: SetupDraft = options.draft ?? draftWith();
  const result = renderStep({ ...options, onDraftChange: (draft) => { latest = draft; } });
  return { ...result, getDraft: () => latest };
}

function tokenResponse() {
  return {
    access_token: "setup-access-token",
    token_type: "bearer",
    expires_in: 900,
    refresh_token: null,
    user: { id: "u1", email: "ada@example.com", name: "Ada Lovelace", display_name: null },
  };
}

function continueButton() {
  return screen.getByRole("button", { name: /continue/i });
}

function selectCurrency(code: string) {
  // Several native `<select>`s on this step also register as
  // role="combobox" (that's how ARIA maps a single-value `<select>`) — the
  // currency search box is the one distinguished by its placeholder.
  fireEvent.focus(screen.getByPlaceholderText(/search currencies/i));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(`^${code}`) }));
}

describe("StepPreferences", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockUseAuth.mockReset();
    mockUseAuth.mockReturnValue(authState());
  });

  it("prefills timezone and locale from Intl.DateTimeFormat().resolvedOptions() on mount", () => {
    const { getDraft } = renderStepTrackingDraft();

    const resolved = Intl.DateTimeFormat().resolvedOptions();
    expect(getDraft().preferences.timezone).toBe(resolved.timeZone);
    expect(getDraft().preferences.locale).toBe(resolved.locale);
  });

  it("also fills in sensible date_format/number_format/first_day_of_week defaults on mount", () => {
    const { getDraft } = renderStepTrackingDraft();

    expect(getDraft().preferences.date_format).toBeTruthy();
    expect(getDraft().preferences.number_format).toBeTruthy();
    expect(["monday", "sunday", "saturday"]).toContain(getDraft().preferences.first_day_of_week);
  });

  it("does not clobber preference fields the draft already has (resuming mid-wizard)", () => {
    const seeded = draftWith({
      timezone: "Europe/Lisbon",
      locale: "pt-PT",
      date_format: "DD/MM/YYYY",
      number_format: "1.234,56",
      first_day_of_week: "monday",
      base_currency: "EUR",
    });
    const { getDraft } = renderStepTrackingDraft({ draft: seeded });

    expect(getDraft().preferences.timezone).toBe("Europe/Lisbon");
    expect(getDraft().preferences.locale).toBe("pt-PT");
  });

  it("shows the footnote about changing preferences later in Settings", () => {
    renderStep();
    expect(screen.getByText(/change all of this later in settings/i)).toBeInTheDocument();
  });

  it("the currency picker selects a code and renders the selection ring", () => {
    const { getDraft } = renderStepTrackingDraft();

    selectCurrency("EUR");

    expect(getDraft().preferences.base_currency).toBe("EUR");
    expect(screen.getByTestId("currency-select-circle")).toBeInTheDocument();
  });

  it("Continue POSTs the assembled owner+preferences payload exactly once, with client: web", async () => {
    mockApiFetch.mockResolvedValue(tokenResponse());
    const seeded = draftWith({
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      date_format: "DD/MM/YYYY",
      number_format: "1.234,56",
      first_day_of_week: "sunday",
    });
    const { onNext } = renderStep({ draft: seeded, password: DEFAULT_PASSWORD });

    selectCurrency("BRL");
    fireEvent.click(continueButton());

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/setup/initialize");
    expect((opts as { method?: string }).method).toBe("POST");
    expect((opts as { json?: unknown }).json).toEqual({
      owner: { name: "Ada Lovelace", email: "ada@example.com", password: DEFAULT_PASSWORD },
      preferences: {
        base_currency: "BRL",
        locale: "pt-BR",
        date_format: "DD/MM/YYYY",
        number_format: "1.234,56",
        timezone: "America/Sao_Paulo",
        first_day_of_week: "sunday",
      },
      client: "web",
    });
  });

  it("on 201, adopts the session into the auth store and advances to step 4", async () => {
    const response = tokenResponse();
    mockApiFetch.mockResolvedValue(response);
    const adoptSession = vi.fn();
    mockUseAuth.mockReturnValue(authState({ adoptSession }));
    const { onNext } = renderStep();

    selectCurrency("USD");
    fireEvent.click(continueButton());

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(adoptSession).toHaveBeenCalledWith(response);
  });

  it("on 201, clears the setup draft and the in-memory password", async () => {
    mockApiFetch.mockResolvedValue(tokenResponse());
    const clearDraft = vi.fn();
    let observedPassword = "";
    const { onNext } = renderStep({
      clearDraft,
      password: DEFAULT_PASSWORD,
      onPasswordChangeObserved: (pw) => { observedPassword = pw; },
    });

    selectCurrency("USD");
    fireEvent.click(continueButton());

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(clearDraft).toHaveBeenCalledTimes(1);
    expect(observedPassword).toBe("");
  });

  it("on 409 SETUP_ALREADY_COMPLETE, navigates to the app instead of advancing the wizard", async () => {
    mockApiFetch.mockRejectedValue(new ApiError(409, "SETUP_ALREADY_COMPLETE"));
    const { onNext } = renderStep();

    selectCurrency("USD");
    fireEvent.click(continueButton());

    await screen.findByText("App shell (post-setup landing)");
    expect(onNext).not.toHaveBeenCalled();
  });

  it("on 409 SETUP_ALREADY_COMPLETE, marks the setup-status query cache initialized so the outermost RequireSetup guard doesn't bounce the visitor back to /setup", async () => {
    mockApiFetch.mockRejectedValue(new ApiError(409, "SETUP_ALREADY_COMPLETE"));
    const { queryClient } = renderStep();

    expect(queryClient.getQueryData(["setup-status"])).toBeUndefined();

    selectCurrency("USD");
    fireEvent.click(continueButton());

    await screen.findByText("App shell (post-setup landing)");
    expect(queryClient.getQueryData(["setup-status"])).toEqual({ initialized: true });
  });

  it("on 422, surfaces a Callout naming the offending field and stays on the step", async () => {
    mockApiFetch.mockRejectedValue(
      new ApiError(422, "VALIDATION_ERROR", [
        { loc: ["body", "preferences", "base_currency"], msg: "String should match pattern" },
      ]),
    );
    const { onNext } = renderStep();

    selectCurrency("USD");
    fireEvent.click(continueButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/base currency/i);
    expect(onNext).not.toHaveBeenCalled();
    // Still on this step — its own heading is present.
    expect(screen.getByRole("heading", { name: /preferences/i })).toBeInTheDocument();
  });

  it("on 403 INVALID_SETUP_TOKEN, shows an explanatory Callout and stays on the step", async () => {
    mockApiFetch.mockRejectedValue(new ApiError(403, "INVALID_SETUP_TOKEN"));
    const { onNext } = renderStep();

    selectCurrency("USD");
    fireEvent.click(continueButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/setup token/i);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("on a network error, shows a retry Callout and stays on the step (idempotent)", async () => {
    mockApiFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const { onNext } = renderStep();

    selectCurrency("USD");
    fireEvent.click(continueButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn.t reach pecunia/i);
    expect(onNext).not.toHaveBeenCalled();
    expect(continueButton()).toBeEnabled();
  });

  it("on a 500 ApiError (server responded, but not 403/422), shows a generic server-error Callout distinct from the network-error copy", async () => {
    mockApiFetch.mockRejectedValue(new ApiError(500, "INTERNAL_SERVER_ERROR"));
    const { onNext } = renderStep();

    selectCurrency("USD");
    fireEvent.click(continueButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/something went wrong/i);
    expect(alert).not.toHaveTextContent(/couldn.t reach pecunia/i);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("Back calls onBack (returns to the owner step)", () => {
    const { onBack } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("disables Continue until a base currency is chosen", () => {
    renderStep();
    expect(continueButton()).toBeDisabled();
  });

  it("does not double-submit when Continue is clicked more than once while pending", async () => {
    let resolveInitialize: (value: ReturnType<typeof tokenResponse>) => void = () => {};
    mockApiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInitialize = resolve;
        }),
    );
    renderStep();

    selectCurrency("USD");
    fireEvent.click(continueButton());
    fireEvent.click(continueButton());
    fireEvent.click(continueButton());

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveInitialize(tokenResponse());
    });
  });
});
