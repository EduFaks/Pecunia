import type { SetupDraft } from "./useSetupDraft";

/**
 * The shared contract every wizard step component receives from
 * `WizardShell`: the resumable draft plus forward/back navigation. Only
 * `StepWelcome` exists yet (Plan 06 Task 1) and uses just `onNext` — but the
 * full shape is wired through now (rather than invented per-step later) so
 * Tasks 2–5 can start reading/writing the draft without changing this
 * contract. Lives in its own module (not `WizardShell.tsx`) so step
 * components can import the type without a circular import back to the
 * shell that renders them.
 */
export interface WizardStepProps {
  draft: SetupDraft;
  /** Shallow-merges into the draft (see `useSetupDraft`'s `update`). */
  updateDraft: (partial: Partial<SetupDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}
