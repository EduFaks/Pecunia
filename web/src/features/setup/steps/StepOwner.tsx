import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../../components/ui/Button";
import Card from "../../../components/ui/Card";
import PasswordField from "../../../components/ui/PasswordField";
import TextField from "../../../components/ui/TextField";
import PasswordStrength from "../PasswordStrength";
import type { PasswordStrengthScore } from "../PasswordStrength";
import type { WizardStepProps } from "../types";

// A simple, robust email-shape check mirroring the backend's intent
// (pydantic `EmailStr`) without reimplementing full RFC 5322 parsing —
// the backend remains the authority; this only avoids obviously-wrong
// input before it round-trips to the server.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;
const MIN_STRENGTH_SCORE: PasswordStrengthScore = 2;

export interface StepOwnerProps extends WizardStepProps {
  /** The in-progress owner password — lives in `WizardShell`'s component
   * state (never the resumable draft, never sessionStorage). Controlled
   * from here so it survives navigating Back to Welcome and forward again,
   * and so Step 3 (Preferences) can read it for the atomic initialize call. */
  password: string;
  onPasswordChange: (password: string) => void;
}

interface TouchedFields {
  name: boolean;
  email: boolean;
  password: boolean;
  confirm: boolean;
}

const UNTOUCHED: TouchedFields = { name: false, email: false, password: false, confirm: false };

/**
 * Step 2 — Owner account: collects the name/email/password that will
 * initialize this Pecunia instance. Validation mirrors the backend
 * (`OwnerIn` in `api/src/pecunia/api/setup.py`): name non-empty, a valid
 * email shape, password 10–128 characters — plus a UI-only floor the
 * backend doesn't enforce, a zxcvbn strength score of at least "Fair" (2),
 * shown live by `PasswordStrength`. Continue stays disabled until every
 * condition holds. On Continue, only name/email are written into the
 * resumable draft (`updateDraft`); the password is handed to the parent via
 * `onPasswordChange` (already current, since the field is controlled) and
 * never touches `sessionStorage`.
 */
function StepOwner({ draft, updateDraft, onNext, onBack, password, onPasswordChange }: StepOwnerProps) {
  const [name, setName] = useState(draft.ownerName);
  const [email, setEmail] = useState(draft.ownerEmail);
  const [confirm, setConfirm] = useState("");
  const [score, setScore] = useState<PasswordStrengthScore>(0);
  const [touched, setTouched] = useState<TouchedFields>(UNTOUCHED);

  function markTouched(field: keyof TouchedFields) {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  const nameValid = name.trim().length > 0;
  const emailValid = EMAIL_RE.test(email);
  const passwordLengthValid = password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
  const passwordStrongEnough = score >= MIN_STRENGTH_SCORE;
  const confirmValid = confirm === password;

  const canContinue = nameValid && emailValid && passwordLengthValid && passwordStrongEnough && confirmValid;

  const nameError = touched.name && !nameValid ? "Name is required." : undefined;
  const emailError = touched.email && !emailValid ? "Enter a valid email address." : undefined;
  const passwordError =
    touched.password && password.length === 0
      ? "Password is required."
      : touched.password && !passwordLengthValid
        ? "Password must be 10–128 characters."
        : touched.password && !passwordStrongEnough
          ? "This password is too weak. Try adding more length or variety."
          : undefined;
  const confirmError = touched.confirm && !confirmValid ? "Passwords don’t match." : undefined;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched({ name: true, email: true, password: true, confirm: true });
    if (!canContinue) {
      return;
    }
    updateDraft({ ownerName: name.trim(), ownerEmail: email.trim() });
    onNext();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6 py-12">
      <Card className="w-full max-w-md">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-ink-faint">Setup · Step 2 of 5</p>
        <h1 className="mt-2 font-display text-2xl text-ink">Create the owner account</h1>
        <p className="mt-1 text-sm text-ink-2">This account controls this Pecunia instance.</p>

        <form className="mt-8 flex flex-col gap-5" noValidate onSubmit={handleSubmit}>
          <TextField
            label="Name"
            autoComplete="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => markTouched("name")}
            error={nameError}
          />
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => markTouched("email")}
            error={emailError}
          />
          <div className="flex flex-col gap-2">
            <PasswordField
              label="Password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              onBlur={() => markTouched("password")}
              description={
                passwordError ? undefined : `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters. Aim for “Good” or better.`
              }
              error={passwordError}
            />
            <PasswordStrength password={password} onScoreChange={setScore} />
          </div>
          <PasswordField
            label="Confirm password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            onBlur={() => markTouched("confirm")}
            error={confirmError}
          />

          <div className="mt-2 flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" onClick={onBack}>
              ← Back
            </Button>
            <Button type="submit" disabled={!canContinue}>
              Continue →
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

export default StepOwner;
