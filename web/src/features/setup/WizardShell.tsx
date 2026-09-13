import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import StepWelcome from "./steps/StepWelcome";
import StepOwner from "./steps/StepOwner";
import StepPreferences from "./steps/StepPreferences";
import StepStartingPoint from "./steps/StepStartingPoint";
import StepFinish from "./steps/StepFinish";
import { useSetupDraft } from "./useSetupDraft";
import type { WizardStepProps } from "./types";

export const TOTAL_STEPS = 5;

type WizardStepNumber = 1 | 2 | 3 | 4 | 5;

const STEP_NUMBERS: WizardStepNumber[] = [1, 2, 3, 4, 5];

/**
 * Quiet progress indicator: five short bars, the current step in the white
 * accent (`--pc-accent`, via `bg-accent`), every other step in faint ink —
 * never more than one color competing for attention, per CONVENTIONS §9's
 * interactive-only rule for the accent. The dots carry no text, so no
 * `text-on-accent` contrast fix applies here. Fixed to a corner so it reads
 * as unobtrusive chrome rather than a form control, even on the
 * full-viewport Welcome step.
 */
function WizardProgress({ step }: { step: WizardStepNumber }) {
  return (
    <ol
      className="fixed right-6 top-6 z-10 flex items-center gap-2"
      aria-label={`Step ${step} of ${TOTAL_STEPS}`}
    >
      {STEP_NUMBERS.map((n) => (
        <li key={n} aria-current={n === step ? "step" : undefined}>
          <span
            className={cn(
              "block h-1.5 w-6 rounded-full transition-colors duration-150 ease-pc",
              n === step ? "bg-accent" : "bg-ink-faint/40",
            )}
            aria-hidden="true"
          />
        </li>
      ))}
    </ol>
  );
}

/**
 * The setup wizard's shell (Plan 06). Owns the step position (1–5), the
 * resumable draft (`useSetupDraft`), and — SECURITY-CRITICAL — the owner
 * password: it lives only in this component's own `useState`, threaded into
 * `StepOwner` AND `StepPreferences` as a controlled `password`/
 * `onPasswordChange` pair, and is NEVER passed to `updateDraft` or otherwise
 * persisted. It stays in memory here (rather than either step's own local
 * state) so it survives navigating back to Welcome and forward again, and so
 * `StepPreferences` can read it for the one atomic `POST /setup/initialize`
 * call — which blanks it out via `onPasswordChange("")` once that call
 * succeeds (see `StepPreferences`'s own doc comment).
 * Renders the progress indicator plus whichever step is active, and moves
 * keyboard focus to the new step's heading on every transition — a
 * route-change-style announcement so forward/back navigation is legible to
 * screen readers and doesn't leave focus stranded on a button that just
 * unmounted. `RequireSetup` (see routes/guards.tsx) only ever renders this
 * while the instance is uninitialized.
 *
 * Also retains the chosen base currency in its own state, mirrored from the
 * draft: `StepPreferences` clears the whole resumable draft once
 * `initialize` succeeds (nothing in it is needed past that point — see its
 * own doc comment), which would otherwise take `base_currency` down with it
 * before Step 4 (`StepStartingPoint`) ever gets a chance to read it for its
 * quick-add accounts' default currency. The effect below copies
 * `draft.preferences.base_currency` into `baseCurrency` the moment it's set
 * (during Step 3, well before Continue triggers the clear) and only ever
 * overwrites it with another truthy value, so the mirrored copy survives
 * `clear()` resetting the draft back to `""`.
 */
function WizardShell() {
  const [step, setStep] = useState<WizardStepNumber>(1);
  const { draft, update, clear } = useSetupDraft();
  const [ownerPassword, setOwnerPassword] = useState("");
  const [baseCurrency, setBaseCurrency] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (draft.preferences.base_currency) {
      setBaseCurrency(draft.preferences.base_currency);
    }
  }, [draft.preferences.base_currency]);

  useEffect(() => {
    const container = containerRef.current;
    const heading = container?.querySelector<HTMLElement>("h1, h2, [role='heading']");
    if (!heading) {
      return;
    }
    if (!heading.hasAttribute("tabindex")) {
      heading.setAttribute("tabindex", "-1");
    }
    // Focus moves here only to announce the new step to assistive tech. The
    // heading is tabindex=-1 (never keyboard-reachable), so this programmatic
    // focus is the only focus it ever gets — and the global white focus ring
    // around a large display heading reads as an editorial frame, which the
    // minimal identity drops. Suppress the ring on these targets only.
    heading.classList.add("step-focus-target");
    heading.focus();
  }, [step]);

  function onNext() {
    setStep((current) => (current < TOTAL_STEPS ? ((current + 1) as WizardStepNumber) : current));
  }

  function onBack() {
    setStep((current) => (current > 1 ? ((current - 1) as WizardStepNumber) : current));
  }

  const stepProps: WizardStepProps = { draft, updateDraft: update, onNext, onBack };

  return (
    <div ref={containerRef} className="relative">
      <WizardProgress step={step} />
      {step === 1 ? <StepWelcome {...stepProps} /> : null}
      {step === 2 ? (
        <StepOwner {...stepProps} password={ownerPassword} onPasswordChange={setOwnerPassword} />
      ) : null}
      {step === 3 ? (
        <StepPreferences
          {...stepProps}
          password={ownerPassword}
          onPasswordChange={setOwnerPassword}
          clearDraft={clear}
        />
      ) : null}
      {step === 4 ? <StepStartingPoint onNext={onNext} baseCurrency={baseCurrency} /> : null}
      {step === 5 ? <StepFinish /> : null}
    </div>
  );
}

export default WizardShell;
