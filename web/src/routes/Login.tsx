import { useState } from "react";
import type { FormEvent } from "react";
import Wordmark from "../components/brand/Wordmark";
import Button from "../components/ui/Button";
import Callout from "../components/ui/Callout";
import Card from "../components/ui/Card";
import PasswordField from "../components/ui/PasswordField";
import TextField from "../components/ui/TextField";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";

/**
 * Maps a stable, machine-readable API error `detail` (per
 * docs/CONVENTIONS.md §6/§9) to the friendly copy shown in the error
 * `Callout`. Unrecognized details (a network hiccup, a 500) fall back to a
 * generic message rather than surfacing the raw `SCREAMING_SNAKE` code.
 */
const LOGIN_ERROR_COPY: Record<string, string> = {
  INVALID_CREDENTIALS: "Incorrect email or password.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Please wait a few minutes.",
};

const GENERIC_LOGIN_ERROR = "Something went wrong. Please try again.";

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return LOGIN_ERROR_COPY[error.detail] ?? GENERIC_LOGIN_ERROR;
  }
  return GENERIC_LOGIN_ERROR;
}

/**
 * The sign-in screen: a centered card on canvas, the wordmark,
 * email + password, and a primary white-accent submit. `RedirectIfAuthed`
 * (./guards.tsx) bounces the visitor to `/` automatically once `login`
 * resolves; this component never navigates itself. Enter submits from
 * either field (native form behavior — no keydown plumbing needed) and tab
 * order follows the natural source order (email → password → show/hide →
 * submit).
 */
function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6 py-12">
      <Card className="w-full max-w-sm">
        <Wordmark size="lg" withMark />
        <h1 className="mt-8 font-display text-2xl text-ink">Sign in</h1>
        <p className="mt-1 text-sm text-ink-2">Welcome back to your ledger.</p>

        <form
          className="mt-8 flex flex-col gap-5"
          noValidate
          onSubmit={(event) => void handleSubmit(event)}
        >
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <PasswordField
            label="Password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error ? <Callout variant="negative">{error}</Callout> : null}
          <Button type="submit" size="lg" loading={submitting} className="mt-2">
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}

export default Login;
