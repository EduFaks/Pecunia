import { useEffect, useRef, useState } from "react";
import Wordmark from "../../../components/brand/Wordmark";
import Button from "../../../components/ui/Button";
import Callout from "../../../components/ui/Callout";
import Card from "../../../components/ui/Card";
import type { WizardStepProps } from "../types";

/**
 * Informational dialog behind "Restore an existing Pecunia backup" — V1 has
 * no upload UI (spec §3: "promising an upload UI we haven't built would be
 * worse than honesty"). Explains that restore is a server-side, CLI-driven
 * operation performed before setup, not something this screen does.
 * Minimal accessible dialog: labelled by its own heading, closes on Escape
 * or the Close button, and returns focus to the trigger that opened it.
 */
function RestoreInfoDialog({ onClose }: { onClose: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 px-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-dialog-heading"
      onClick={onClose}
    >
      <Card className="w-full max-w-md text-left" onClick={(event) => event.stopPropagation()}>
        <h2
          ref={headingRef}
          id="restore-dialog-heading"
          tabIndex={-1}
          className="font-display text-xl text-ink"
        >
          Restoring from a backup
        </h2>
        <Callout variant="info" className="mt-4">
          If you already have a Pecunia backup, this screen doesn&rsquo;t restore it yet.
          Restore is a server-side operation: stop this instance, run the documented CLI
          restore command against your backup file, then start Pecunia again — it will boot
          with your restored data and skip setup entirely. See your deployment&rsquo;s restore
          documentation for the exact command.
        </Callout>
        <Button variant="ghost" className="mt-6" onClick={onClose}>
          Close
        </Button>
      </Card>
    </div>
  );
}

/**
 * Step 1 — Welcome: the wizard's identity showcase (spec §3). Full-viewport
 * on canvas, calm and generously spaced rather than form-like: the wordmark,
 * then the promise line, then the privacy statement in plain type — no drawn
 * flourishes. `Get Started →` is the only emphasized action; restoring a
 * backup is a quiet, informational aside.
 */
function StepWelcome({ onNext }: WizardStepProps) {
  const [restoreOpen, setRestoreOpen] = useState(false);
  const restoreTriggerRef = useRef<HTMLButtonElement>(null);

  function closeRestoreDialog() {
    setRestoreOpen(false);
    restoreTriggerRef.current?.focus();
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 py-20 text-center">
      <div className="flex max-w-2xl flex-col items-center">
        <Wordmark size="lg" withMark />

        <h1 className="mt-10 max-w-xl text-balance font-display text-4xl font-normal leading-[1.15] text-ink sm:text-5xl">
          Your financial life, in one place.
        </h1>

        <div className="mt-9 flex flex-col items-center">
          <p className="font-mono text-sm uppercase tracking-[0.2em] text-ink-2">
            Your money. Your server. Your data.
          </p>
        </div>

        <div className="mt-16 flex flex-col items-center gap-4">
          <Button size="lg" onClick={onNext}>
            Get Started →
          </Button>
          <Button
            ref={restoreTriggerRef}
            variant="quiet"
            size="sm"
            onClick={() => setRestoreOpen(true)}
          >
            Restore an existing Pecunia backup
          </Button>
        </div>
      </div>

      {restoreOpen ? <RestoreInfoDialog onClose={closeRestoreDialog} /> : null}
    </div>
  );
}

export default StepWelcome;
