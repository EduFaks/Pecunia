import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import Button from "./Button";

export interface ConfirmDialogProps {
  /** Names what's being permanently deleted/revoked, e.g. `Delete
   * "Emergency fund"?` — never a generic "Are you sure?". */
  title: string;
  /** Supporting copy spelling out the irreversible consequence. */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Disables both actions and marks the confirm button busy while a
   * mutation triggered by a previous confirm is still in flight. */
  isConfirming?: boolean;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible confirmation modal for an irreversible action — a hard delete
 * (`AssetDetail`, `ProjectDetail`, `BudgetsScreen`), a session revoke
 * (`SessionsPanel`), or removing demo data (`DemoChip`). Before this
 * primitive existed, every one of those called its mutation directly on
 * click, with no chance to back out of a permanent delete.
 *
 * Mount conditionally at the call site (`{confirming ? <ConfirmDialog ... />
 * : null}`) — the same "conditional panel" shape every screen's inline
 * create/edit form already uses (`AccountsScreen`'s `formState`, etc.) —
 * rather than an `open` prop, so there is nothing to render when closed.
 *
 * `role="alertdialog"` (not a plain `dialog`): this always interrupts with a
 * yes/no question about a destructive action, matching the ARIA
 * confirmation-dialog pattern. Focus moves to **Cancel** on mount, never the
 * destructive confirm action — an accidental Enter should never delete
 * anything — and is trapped within the dialog while mounted (Tab/Shift+Tab
 * wrap at the edges); unmounting restores focus to whatever triggered the
 * dialog. Escape cancels, matching Cancel exactly.
 *
 * The confirm action renders as `Button variant="destructive"` (a solid
 * `--pc-negative` fill) — the one place in the kit a solid semantic color,
 * not just a soft tint, is warranted: this is the last chance to stop a
 * permanent action.
 */
function ConfirmDialog({
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  isConfirming = false,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus Cancel on mount; restore whatever had focus before the dialog
  // opened once it unmounts (confirmed, cancelled, or the screen it lives on
  // navigated away).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 px-6">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="w-full max-w-sm rounded-pc-lg border border-hairline bg-surface-1 p-6 shadow-pc-2"
      >
        <h2 id={titleId} className="font-display text-lg text-ink">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="mt-2 text-sm text-ink-2">
            {description}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-3">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={isConfirming}>
            {cancelLabel}
          </Button>
          <Button variant="destructive" onClick={onConfirm} loading={isConfirming}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
