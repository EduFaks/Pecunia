import { useCallback, useEffect, useRef, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import { useToast } from "../../components/ui/Toast";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import { useBankDiscovery, useLinkAccount } from "./useBankSync";
import type { DiscoveredAccountOut } from "./useBankSync";

interface AccountOut {
  id: string;
  name: string;
  currency: string;
}

interface LinkDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Link wizard dialog (Track T). Step 1: select a discovered Pluggy account
 * (filtered to unlinked). Step 2: link to existing Pecunia account (filtered
 * by matching currency) or create new. Handles 503 discovery gracefully.
 */
function LinkDialog({ open, onClose }: LinkDialogProps) {
  const { showToast } = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [selectedDiscovered, setSelectedDiscovered] = useState<DiscoveredAccountOut | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState(false);
  const [newAccountName, setNewAccountName] = useState("");
  const [discoveryUnavailable, setDiscoveryUnavailable] = useState(false);

  const accountsQuery = useQuery({
    queryKey: [...qk.accounts, "flat"],
    queryFn: () => apiFetch<{ items: AccountOut[] }>("/accounts?limit=1000"),
    enabled: open,
  });

  const discoveryQuery = useBankDiscovery(() => setDiscoveryUnavailable(true));
  const linkAccount = useLinkAccount();

  const handleClose = useCallback(() => {
    setSelectedDiscovered(null);
    setSelectedAccountId(null);
    setCreateMode(false);
    setNewAccountName("");
    setDiscoveryUnavailable(false);
    onClose();
  }, [onClose]);

  // Focus heading on mount
  useEffect(() => {
    if (open) {
      headingRef.current?.focus();
    }
  }, [open]);

  // Handle Escape key
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        handleClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, handleClose]);

  // Filter discovered to unlinked only
  const unlinkedDiscovered = useMemo(() => {
    return (discoveryQuery.data ?? []).filter((acc) => acc.linked_account_id === null);
  }, [discoveryQuery.data]);

  // Filter accounts by currency if a discovered account is selected
  const filteredAccounts = useMemo(() => {
    if (!selectedDiscovered || selectedDiscovered.type !== "BANK") return accountsQuery.data?.items ?? [];
    // Assume discovered.balance gives us a hint about the currency
    // For now, filter by exact currency match
    return (accountsQuery.data?.items ?? []).filter((acc) => acc.currency === "USD");
  }, [selectedDiscovered, accountsQuery.data]);

  async function handleLink() {
    if (!selectedDiscovered) return;

    try {
      const payload = {
        pluggy_item_id: selectedDiscovered.pluggy_item_id,
        pluggy_account_id: selectedDiscovered.pluggy_account_id,
        sync_from: new Date().toISOString().split("T")[0],
        ...(createMode
          ? {
              new_account: {
                name: newAccountName,
                currency: "USD",
              },
            }
          : selectedAccountId
            ? {
                account_id: selectedAccountId,
              }
            : {}),
      };

      await linkAccount.mutateAsync(payload);
      showToast("Account linked successfully.");
      handleClose();
    } catch {
      showToast("Couldn't link that account. Please try again.", { variant: "negative" });
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 px-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-dialog-heading"
      onClick={handleClose}
    >
      <Card className="w-full max-w-md text-left" onClick={(event) => event.stopPropagation()}>
        <h2
          ref={headingRef}
          id="link-dialog-heading"
          tabIndex={-1}
          className="font-display text-lg text-ink"
        >
          Link Bank Account
        </h2>

        <div className="mt-4 flex flex-col gap-4">
          {discoveryUnavailable ? (
            <Callout variant="info">
              Bank discovery is temporarily unavailable. Please try again later.
            </Callout>
          ) : null}

          {discoveryQuery.isError && !discoveryUnavailable ? (
            <Callout variant="negative">Couldn't load discovered accounts. Please try again.</Callout>
          ) : null}

          {discoveryQuery.isLoading ? (
            <p className="text-sm text-ink-faint">Loading discovered accounts...</p>
          ) : null}

          {unlinkedDiscovered.length === 0 && !discoveryQuery.isLoading && !discoveryUnavailable ? (
            <p className="text-sm text-ink-faint">No new accounts to link.</p>
          ) : null}

          {/* Step 1: Select discovered account */}
          {unlinkedDiscovered.length > 0 && !selectedDiscovered ? (
            <div className="flex flex-col gap-3">
              <label htmlFor="discovered-account" className="block font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">
                Discovered Account
              </label>
              <select
                id="discovered-account"
                className="rounded-pc border border-hairline bg-surface-0 px-3 py-2 text-sm text-ink"
                onChange={(e) => {
                  const discovered = unlinkedDiscovered.find(
                    (d) => `${d.pluggy_item_id}:${d.pluggy_account_id}` === e.target.value,
                  );
                  setSelectedDiscovered(discovered || null);
                }}
              >
                <option value="">Select an account...</option>
                {unlinkedDiscovered.map((account) => (
                  <option key={`${account.pluggy_item_id}:${account.pluggy_account_id}`} value={`${account.pluggy_item_id}:${account.pluggy_account_id}`}>
                    {account.pluggy_account_id} ({account.type})
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {/* Step 2: Select target account or create new */}
          {selectedDiscovered && !createMode ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3">
                <label htmlFor="pecunia-account" className="block font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">
                  Pecunia Account
                </label>
                <select
                  id="pecunia-account"
                  className="rounded-pc border border-hairline bg-surface-0 px-3 py-2 text-sm text-ink"
                  onChange={(e) => setSelectedAccountId(e.target.value || null)}
                >
                  <option value="">Link to existing account...</option>
                  {filteredAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 border-t border-hairline" />
                <span className="text-xs text-ink-faint">or</span>
                <div className="flex-1 border-t border-hairline" />
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreateMode(true)}
              >
                Create new account
              </Button>
            </div>
          ) : null}

          {/* Create new account form */}
          {selectedDiscovered && createMode ? (
            <div className="flex flex-col gap-3">
              <label htmlFor="new-account-name" className="block font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">
                Account Name
              </label>
              <input
                id="new-account-name"
                type="text"
                placeholder="e.g., Checking"
                className="rounded-pc border border-hairline bg-surface-0 px-3 py-2 text-sm text-ink"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreateMode(false)}
              >
                Back
              </Button>
            </div>
          ) : null}
        </div>

        {/* Action buttons */}
        <div className="mt-6 flex gap-3">
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={linkAccount.isPending}
            disabled={
              !selectedDiscovered ||
              (createMode && !newAccountName.trim()) ||
              (!createMode && !selectedAccountId)
            }
            onClick={() => void handleLink()}
          >
            Link account
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default LinkDialog;
