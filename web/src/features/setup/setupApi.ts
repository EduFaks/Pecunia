import { apiFetch } from "../../lib/api";
import type { TokenResponse } from "../../lib/auth";

/** Mirrors `OwnerIn` (`api/src/pecunia/api/setup.py`). */
export interface InitializeOwnerPayload {
  name: string;
  email: string;
  password: string;
}

/** Mirrors `PreferencesIn` (`api/src/pecunia/api/setup.py`) exactly, field
 * for field — including `first_day_of_week` as the named-weekday string the
 * backend validates, not a numeric index. */
export interface InitializePreferencesPayload {
  base_currency: string;
  locale: string;
  date_format: string;
  number_format: string;
  timezone: string;
  first_day_of_week: "monday" | "sunday" | "saturday";
}

export interface InitializePayload {
  owner: InitializeOwnerPayload;
  preferences: InitializePreferencesPayload;
}

/**
 * The wizard's one pivotal write: `POST /setup/initialize`, combining
 * steps 1–3's data (owner + preferences) into the single atomic call that
 * creates the instance's owner account. `client: "web"` is injected here
 * (never left to the caller) so every web call is consistent with the
 * backend's `client: Literal["web", "native"]` discriminator — a native
 * client would get its own call site, not a parameter on this one. On 201
 * the backend also sets the refresh cookie itself; the returned
 * `TokenResponse`'s `access_token` is what `StepPreferences` hands to
 * `useAuth().adoptSession` for the auto-login. Errors (409
 * `SETUP_ALREADY_COMPLETE`, 403 `INVALID_SETUP_TOKEN`, 422 field errors,
 * network failure) are left as thrown `ApiError`s/rejections for the caller
 * to interpret — this function stays a dumb transport, per
 * `lib/api.ts`'s "error → copy is always a detail → message map at the call
 * site" rule (CONVENTIONS §9.6).
 */
export function initialize(payload: InitializePayload): Promise<TokenResponse> {
  return apiFetch<TokenResponse>("/setup/initialize", {
    method: "POST",
    json: { ...payload, client: "web" },
    skipAuthRetry: true,
  });
}

/** Mirrors `AccountType` (`api/src/pecunia/models/account.py`). */
export type AccountType = "checking" | "savings" | "credit_card" | "cash" | "brokerage" | "wallet";

/** Mirrors `AccountIn` (`api/src/pecunia/api/accounts.py`) — only the fields
 * the wizard's quick-add form collects; `initial_balance_minor` is left to
 * its server-side default of 0. */
export interface CreateAccountPayload {
  name: string;
  type: AccountType;
  currency: string;
}

/** The subset of `AccountOut` (`api/src/pecunia/api/accounts.py`) the
 * wizard's quick-add list actually displays — name and type, per the Step 4
 * spec. Typed narrowly (not the full `AccountOut` shape with balance/
 * timestamps) since nothing else here reads those fields. */
export interface CreatedAccount {
  id: string;
  name: string;
  type: string;
  currency: string;
}

/**
 * `StepStartingPoint`'s "Add my first accounts" card: one authed
 * `POST /accounts` per quick-add. Runs after `initialize`'s auto-login, so
 * `apiFetch` already attaches the in-memory bearer token — no
 * `skipAuthRetry` needed here, unlike `initialize`'s own pre-auth call.
 */
export function createAccount(payload: CreateAccountPayload): Promise<CreatedAccount> {
  return apiFetch<CreatedAccount>("/accounts", { method: "POST", json: payload });
}

/** Mirrors `DemoStatusOut` (`api/src/pecunia/api/demo.py`). */
export interface DemoStatus {
  present: boolean;
  counts: Record<string, number>;
}

/**
 * `StepStartingPoint`'s "Explore with demo data" card:
 * `POST /demo` seeds the demo dataset. On success the backend returns 201
 * with `present: true`; a second call (demo already seeded) is rejected
 * with a 409 `DEMO_ALREADY_PRESENT` `ApiError`, left for the caller to map
 * to copy — same "dumb transport" rule as `initialize`.
 */
export function seedDemo(): Promise<DemoStatus> {
  return apiFetch<DemoStatus>("/demo", { method: "POST" });
}
