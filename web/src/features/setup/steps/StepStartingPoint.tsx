import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../../components/ui/Button";
import Callout from "../../../components/ui/Callout";
import Card from "../../../components/ui/Card";
import Select from "../../../components/ui/Select";
import type { SelectOption } from "../../../components/ui/Select";
import TextField from "../../../components/ui/TextField";
import { ApiError } from "../../../lib/api";
import { CURRENCY_CODES } from "../CurrencySelect";
import { createAccount, seedDemo } from "../setupApi";
import type { AccountType, CreatedAccount } from "../setupApi";

export interface StepStartingPointProps {
  onNext: () => void;
  /** The base currency chosen in Step 3 (Preferences) — threaded down from
   * `WizardShell`'s own state, since the resumable draft is cleared once
   * `initialize` succeeds and no longer has it (see `WizardShell`'s doc
   * comment). Used only as the quick-add currency field's default; an empty
   * string (no currency ever chosen — shouldn't happen reaching this step,
   * but defensively handled) falls back to the first common currency. */
  baseCurrency: string;
}

const ACCOUNT_TYPE_OPTIONS: SelectOption[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit card" },
  { value: "cash", label: "Cash" },
  { value: "brokerage", label: "Brokerage" },
  { value: "wallet", label: "Wallet" },
];

const ACCOUNT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  ACCOUNT_TYPE_OPTIONS.map((option) => [option.value, option.label]),
);

const CURRENCY_OPTIONS: SelectOption[] = CURRENCY_CODES.map((code) => ({ value: code, label: code }));

const DEFAULT_CURRENCY = CURRENCY_CODES[0];

function accountErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 422) {
    return "Check the account details and try again.";
  }
  return "Couldn't add that account. Please try again.";
}

/**
 * "Add my first accounts" card: an inline, repeatable quick-add form (name +
 * type + currency, defaulting to the wizard's chosen base currency). Each
 * submit is its own `POST /accounts` — there's no batch "save all" step —
 * and a successful add appends to the list below the form and clears just
 * the name field, so adding a second (third, ...) account is a matter of
 * typing a new name and submitting again.
 */
function QuickAddAccountsCard({ baseCurrency }: { baseCurrency: string }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [currency, setCurrency] = useState(
    baseCurrency && CURRENCY_CODES.includes(baseCurrency) ? baseCurrency : DEFAULT_CURRENCY,
  );
  const [accounts, setAccounts] = useState<CreatedAccount[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (submitting || !trimmed) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createAccount({ name: trimmed, type, currency });
      setAccounts((prev) => [...prev, created]);
      setName("");
    } catch (err) {
      setError(accountErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">Add my first accounts</h2>
      <p className="mt-1 text-sm text-ink-2">
        Create as many as you like — you can always add more later.
      </p>

      <form className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end" noValidate onSubmit={(event) => void handleAdd(event)}>
        <div className="sm:flex-1">
          <TextField
            label="Name"
            placeholder="e.g. Everyday checking"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="sm:w-40">
          <Select
            label="Type"
            options={ACCOUNT_TYPE_OPTIONS}
            value={type}
            onChange={(event) => setType(event.target.value as AccountType)}
          />
        </div>
        <div className="sm:w-28">
          <Select
            label="Currency"
            options={CURRENCY_OPTIONS}
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          />
        </div>
        <Button
          type="submit"
          variant="ghost"
          disabled={!name.trim() || submitting}
          loading={submitting}
        >
          Add account
        </Button>
      </form>

      {error ? (
        <Callout variant="negative" className="mt-3">
          {error}
        </Callout>
      ) : null}

      {accounts.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Accounts added">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between rounded-pc border border-hairline bg-surface-2 px-3 py-2 text-sm"
            >
              <span className="text-ink">{account.name}</span>
              <span className="font-mono text-xs uppercase tracking-wide text-ink-faint">
                {ACCOUNT_TYPE_LABELS[account.type] ?? account.type}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

type DemoState = "idle" | "loading" | "added" | "present" | "error";

/**
 * "Explore with demo data" card: a single button posting `/demo`. 201 seeds
 * the demo dataset and shows a confirmation (mentioning it's removable from
 * the header — Plan 07 wires the actual removal control); 409
 * `DEMO_ALREADY_PRESENT` (a previous visit already seeded it) shows a plain
 * "already present" notice instead of treating it as an error. Either
 * outcome disables the button — there's nothing useful a second click does
 * in either state.
 */
function DemoDataCard() {
  const [state, setState] = useState<DemoState>("idle");

  async function handleSeedDemo() {
    if (state === "loading" || state === "added" || state === "present") {
      return;
    }
    setState("loading");
    try {
      await seedDemo();
      setState("added");
    } catch (err) {
      if (err instanceof ApiError && err.detail === "DEMO_ALREADY_PRESENT") {
        setState("present");
        return;
      }
      setState("error");
    }
  }

  const disabled = state === "loading" || state === "added" || state === "present";

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">Explore with demo data</h2>
      <p className="mt-1 text-sm text-ink-2">
        See Pecunia populated with a few weeks of realistic activity before you commit any of your
        own.
      </p>
      <Button
        variant="ghost"
        className="mt-4"
        onClick={() => void handleSeedDemo()}
        disabled={disabled}
        loading={state === "loading"}
      >
        Add demo data
      </Button>

      {state === "added" ? (
        <Callout variant="positive" className="mt-3">
          Demo data added — you can remove it anytime from the header.
        </Callout>
      ) : null}
      {state === "present" ? (
        <Callout variant="info" className="mt-3">
          Demo data is already present.
        </Callout>
      ) : null}
      {state === "error" ? (
        <Callout variant="negative" className="mt-3">
          Couldn&rsquo;t add demo data. Please try again.
        </Callout>
      ) : null}
    </Card>
  );
}

/**
 * Step 4 — Starting point: three independent, optional cards (accounts
 * quick-add, demo data, skip) plus a primary Continue that advances to
 * Finish regardless of what — if anything — was done here. Pecunia is fully
 * usable with none of this done; nothing here is required. Deliberately has
 * no Back: once the owner account exists (Step 3's atomic initialize), going
 * back to re-run Preferences/Owner doesn't make sense — see `WizardShell`'s
 * wiring.
 */
function StepStartingPoint({ onNext, baseCurrency }: StepStartingPointProps) {
  return (
    <div className="flex min-h-screen flex-col items-center bg-canvas px-6 py-16">
      <div className="w-full max-w-xl">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-ink-faint">Setup · Step 4 of 5</p>
        <h1 className="mt-2 font-display text-2xl text-ink">Choose your starting point</h1>
        <p className="mt-1 text-sm text-ink-2">
          Pecunia works right away — everything below is entirely optional.
        </p>

        <div className="mt-8 flex flex-col gap-5">
          <QuickAddAccountsCard baseCurrency={baseCurrency} />
          <DemoDataCard />
          <Card>
            <h2 className="font-display text-lg text-ink">Skip for now</h2>
            <p className="mt-1 text-sm text-ink-2">
              Jump straight into Pecunia — add accounts or explore demo data anytime.
            </p>
            <Button variant="ghost" className="mt-4" onClick={onNext}>
              Skip for now
            </Button>
          </Card>
        </div>

        <div className="mt-8 flex justify-end">
          <Button size="lg" onClick={onNext}>
            Continue →
          </Button>
        </div>
      </div>
    </div>
  );
}

export default StepStartingPoint;
