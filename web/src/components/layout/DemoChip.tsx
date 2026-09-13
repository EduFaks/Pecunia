import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { cn } from "../../lib/cn";
import { financeQueryKeys, qk } from "../../lib/queries";
import { focusRingClass } from "../ui/a11y";
import ConfirmDialog from "../ui/ConfirmDialog";
import { useToast } from "../ui/Toast";

interface DemoStatus {
  present: boolean;
  counts: Record<string, number>;
}

/**
 * Small topbar chip announcing that demo data is present, with an inline
 * "Remove" action — mounted once in `AppShell`'s header so it's visible
 * across every screen. Seeding demo data happens elsewhere (the setup
 * wizard/Settings), so this component only ever reads and deletes.
 *
 * Renders nothing while the `GET /demo` query is loading or once it
 * resolves `present: false` — no flash of an empty chip, and no chip at all
 * once an instance has no demo data (or never had any).
 */
function DemoChip() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [confirming, setConfirming] = useState(false);

  const { data } = useQuery({
    queryKey: qk.demo,
    queryFn: () => apiFetch<DemoStatus>("/demo"),
  });

  const removeDemo = useMutation({
    mutationFn: () => apiFetch<void>("/demo", { method: "DELETE" }),
    onSuccess: async () => {
      // Every finance-domain listing may contain demo rows that just
      // vanished, plus the demo status itself (so this chip disappears).
      // Audit/activity are deliberately untouched — CONVENTIONS §7: demo
      // removal deletes only the demo domain rows, never that history.
      await Promise.all([
        ...financeQueryKeys.map((key) => queryClient.invalidateQueries({ queryKey: key })),
        queryClient.invalidateQueries({ queryKey: qk.demo }),
      ]);
      showToast("Demo data removed.", { variant: "positive" });
    },
  });

  if (!data?.present) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-pc border border-hairline bg-surface-2 py-1 pl-3 pr-1.5 font-mono text-xs text-ink-2">
      Demo data
      <span aria-hidden="true" className="text-ink-faint">
        ·
      </span>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={removeDemo.isPending}
        aria-busy={removeDemo.isPending || undefined}
        className={cn(
          "rounded-pc px-1.5 py-0.5 text-accent transition-colors duration-150 ease-pc hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-60",
          focusRingClass,
        )}
      >
        {removeDemo.isPending ? "Removing…" : "Remove"}
      </button>

      {confirming ? (
        <ConfirmDialog
          title="Remove demo data?"
          description="This permanently deletes every demo account, transaction, asset, project, and budget. This can't be undone."
          confirmLabel="Remove demo data"
          onConfirm={() => {
            setConfirming(false);
            removeDemo.mutate();
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </span>
  );
}

export default DemoChip;
