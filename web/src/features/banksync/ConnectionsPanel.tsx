import { useState } from "react";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Pill from "../../components/ui/Pill";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { formatMoney } from "../../lib/money";
import CategoryMappingEditor from "./CategoryMappingEditor";
import LinkDialog from "./LinkDialog";
import { useBankConnections, useDeleteConnection, useReconcile, useSyncNow, useUnlinkAccount } from "./useBankSync";
import type { BankLinkOut } from "./useBankSync";

type ConfirmTarget = { type: "unlink"; linkId: string } | { type: "reconcile"; linkId: string } | { type: "delete"; connectionId: string } | null;

/**
 * Settings → Connections (Track T). Lists active connections from Pluggy,
 * each showing its linked accounts. Per-link actions: reconcile (confirm and
 * post balancing txn), unlink (sever the Pluggy→Pecunia link). Per-connection
 * action: delete (remove all links and the connection). Global actions:
 * "Link an account" (opens `LinkDialog`) and "Sync now" (fetch transactions
 * for all connections). `CategoryMappingEditor` renders beneath the
 * connections list per the Task 7 brief.
 */
function ConnectionsPanel() {
  const { showToast } = useToast();
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  const connectionsQuery = useBankConnections();
  const syncNow = useSyncNow();
  const reconcileMutation = useReconcile();
  const unlinkMutation = useUnlinkAccount();
  const deleteConnectionMutation = useDeleteConnection();

  async function handleSyncNow() {
    try {
      const result = await syncNow.mutateAsync();
      showToast(
        `Synced ${result.connections} connection${result.connections !== 1 ? "s" : ""}: ${result.created} new transaction${result.created !== 1 ? "s" : ""}, ${result.skipped} skipped${result.errors.length > 0 ? `, ${result.errors.length} error${result.errors.length !== 1 ? "s" : ""}` : ""}.`,
      );
    } catch {
      showToast("Sync failed. Please try again.", { variant: "negative" });
    }
  }

  async function handleReconcile(linkId: string) {
    try {
      await reconcileMutation.mutateAsync(linkId);
      showToast("Account reconciled.");
    } catch {
      showToast("Reconciliation failed. Please try again.", { variant: "negative" });
    } finally {
      setConfirmTarget(null);
    }
  }

  async function handleUnlink(linkId: string) {
    try {
      await unlinkMutation.mutateAsync(linkId);
      showToast("Account unlinked.");
    } catch {
      showToast("Couldn't unlink that account. Please try again.", { variant: "negative" });
    } finally {
      setConfirmTarget(null);
    }
  }

  async function handleDeleteConnection(connectionId: string) {
    try {
      await deleteConnectionMutation.mutateAsync(connectionId);
      showToast("Connection deleted.");
    } catch {
      showToast("Couldn't delete that connection. Please try again.", { variant: "negative" });
    } finally {
      setConfirmTarget(null);
    }
  }

  if (connectionsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner label="Loading connections" />
      </div>
    );
  }

  if (connectionsQuery.isError) {
    return <Callout variant="negative">Couldn't load your bank connections. Try again.</Callout>;
  }

  const connections = connectionsQuery.data ?? [];

  function renderLink(link: BankLinkOut) {
    const isDiverged = link.provider_balance_minor !== link.derived_balance_minor;
    const divergence = link.provider_balance_minor - link.derived_balance_minor;

    return (
      <div
        key={link.id}
        className="flex flex-wrap items-center justify-between gap-4 rounded-pc bg-surface-1 p-3"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-sans text-sm text-ink">{link.account_name}</p>
            {isDiverged ? (
              <Pill tone="negative">Divergence</Pill>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-4 font-mono text-xs text-ink-faint">
            <span>
              Provider: {formatMoney(link.provider_balance_minor, link.account_currency)}
            </span>
            <span>
              Derived: {formatMoney(link.derived_balance_minor, link.account_currency)}
            </span>
            {isDiverged ? (
              <span>
                Diff: {formatMoney(divergence, link.account_currency)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {isDiverged ? (
            <Button
              variant="ghost"
              size="sm"
              loading={reconcileMutation.isPending && confirmTarget?.type === "reconcile" && confirmTarget?.linkId === link.id}
              onClick={() => setConfirmTarget({ type: "reconcile", linkId: link.id })}
            >
              Reconcile
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            loading={unlinkMutation.isPending && confirmTarget?.type === "unlink" && confirmTarget?.linkId === link.id}
            onClick={() => setConfirmTarget({ type: "unlink", linkId: link.id })}
          >
            Unlink
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-lg text-ink">Bank Connections</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLinkDialogOpen(true)}
            >
              Link an account
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={syncNow.isPending}
              onClick={() => void handleSyncNow()}
            >
              Sync now
            </Button>
          </div>
        </div>

        {connections.length === 0 ? (
          <EmptyState
            title="No bank connections"
            body="Link a bank account to start syncing transactions."
            action={
              <Button variant="primary" size="sm" onClick={() => setLinkDialogOpen(true)}>
                Link an account
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-6">
            {connections.map((connection) => (
              <div
                key={connection.id}
                className="flex flex-col gap-3 rounded-pc-lg border border-hairline bg-surface-1 p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm text-ink-faint">
                      Status: <span className={connection.status === "ok" ? "text-positive" : "text-negative"}>
                        {connection.status === "ok" ? "Connected" : "Error"}
                      </span>
                    </p>
                    {connection.last_synced_at ? (
                      <p className="mt-1 font-mono text-xs text-ink-faint">
                        Last synced: {new Date(connection.last_synced_at).toLocaleString()}
                      </p>
                    ) : null}
                    {connection.last_error ? (
                      <p className="mt-1 font-mono text-xs text-negative">
                        Error: {connection.last_error}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={deleteConnectionMutation.isPending && confirmTarget?.type === "delete" && confirmTarget?.connectionId === connection.id}
                    onClick={() => setConfirmTarget({ type: "delete", connectionId: connection.id })}
                  >
                    Delete connection
                  </Button>
                </div>

                {connection.links.length === 0 ? (
                  <p className="text-sm text-ink-faint">No linked accounts.</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {connection.links.map((link) => (
                      <li key={link.id}>
                        {renderLink(link)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        {confirmTarget?.type === "reconcile" ? (
          <ConfirmDialog
            title="Reconcile account?"
            description="This will post a balancing transaction to match the bank's balance."
            confirmLabel="Reconcile"
            onConfirm={() => void handleReconcile(confirmTarget.linkId)}
            onCancel={() => setConfirmTarget(null)}
            isConfirming={reconcileMutation.isPending}
          />
        ) : null}

        {confirmTarget?.type === "unlink" ? (
          <ConfirmDialog
            title="Unlink account?"
            description="This severs the link between this Pecunia account and the bank. No data is deleted."
            confirmLabel="Unlink"
            onConfirm={() => void handleUnlink(confirmTarget.linkId)}
            onCancel={() => setConfirmTarget(null)}
            isConfirming={unlinkMutation.isPending}
          />
        ) : null}

        {confirmTarget?.type === "delete" ? (
          <ConfirmDialog
            title="Delete connection?"
            description="This removes all linked accounts and the connection. No Pecunia accounts are deleted."
            confirmLabel="Delete connection"
            onConfirm={() => void handleDeleteConnection(confirmTarget.connectionId)}
            onCancel={() => setConfirmTarget(null)}
            isConfirming={deleteConnectionMutation.isPending}
          />
        ) : null}
      </div>

      <CategoryMappingEditor />

      <LinkDialog open={linkDialogOpen} onClose={() => setLinkDialogOpen(false)} />
    </div>
  );
}

export default ConnectionsPanel;
