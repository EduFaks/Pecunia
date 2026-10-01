import { useCallback, useEffect, useRef, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import { useToast } from "../../components/ui/Toast";
import type { ApiError } from "../../lib/api";
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
 * Link wizard dialog (Track T; fix wave 2 — Meu Pluggy free tier). Step 0:
 * the user pastes the Pluggy Item ID and submits it ("Buscar contas") — Meu
 * Pluggy's free tier has no client-wide item listing, so discovery is one
 * item at a time, by id, rather than a picker over every connected bank.
 * Step 1: select a discovered account on that item (filtered to unlinked).
 * Step 2: link to an existing Pecunia account (filtered to the same
 * currency as the discovered account) or create new. A 404 on that item id
 * is shown inline distinctly from a 503 (provider unavailable).
 */
/** Today's date as an ISO `YYYY-MM-DD` string — the default (and, absent
 * user input, the only) value `sync_from` ever took before finding 13's
 * fix. Kept as a helper so the initial state and the post-link reset agree. */
function todayIsoDate(): string {
  return new Date().toISOString().split("T")[0];
}

function LinkDialog({ open, onClose }: LinkDialogProps) {
  const { showToast } = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [itemIdInput, setItemIdInput] = useState("");
  const [submittedItemId, setSubmittedItemId] = useState("");
  const [selectedAccount, setSelectedAccount] = useState<DiscoveredAccountOut | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState(false);
  const [newAccountName, setNewAccountName] = useState("");
  // The user picks the sync start date at link time — default today, but
  // never locked to it (finding 13: a locked decision was rendering NO date
  // input at all).
  const [syncFrom, setSyncFrom] = useState(todayIsoDate);

  const accountsQuery = useQuery({
    queryKey: [...qk.accounts, "flat"],
    queryFn: () => apiFetch<{ items: AccountOut[] }>("/accounts?limit=1000"),
    enabled: open,
  });

  // Discovery fires only once the user has submitted a non-empty item id
  // AND the dialog is open — never on every keystroke, never while closed.
  const discoveryQuery = useBankDiscovery(submittedItemId, open);
  const linkAccount = useLinkAccount();

  const handleClose = useCallback(() => {
    setItemIdInput("");
    setSubmittedItemId("");
    setSelectedAccount(null);
    setSelectedAccountId(null);
    setCreateMode(false);
    setNewAccountName("");
    setSyncFrom(todayIsoDate());
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

  function handleSearch() {
    setSelectedAccount(null);
    setSubmittedItemId(itemIdInput.trim());
  }

  // The discovered connection's accounts, filtered to those not yet linked
  // to a Pecunia account.
  const unlinkedAccounts = useMemo<DiscoveredAccountOut[]>(() => {
    return (discoveryQuery.data?.accounts ?? []).filter(
      (account) => account.linked_account_id === null,
    );
  }, [discoveryQuery.data]);

  // Existing Pecunia accounts offered as a link target are limited to the
  // same currency as the selected discovered account — linking across
  // currencies isn't representable (mirrors the backend's CURRENCY_MISMATCH).
  const filteredAccounts = useMemo(() => {
    if (!selectedAccount) return [];
    return (accountsQuery.data?.items ?? []).filter(
      (acc) => acc.currency === selectedAccount.currency,
    );
  }, [selectedAccount, accountsQuery.data]);

  const discoveryErrorStatus = discoveryQuery.isError
    ? (discoveryQuery.error as ApiError | undefined)?.status
    : undefined;
  const itemNotFound = discoveryErrorStatus === 404;
  const providerUnavailable = discoveryErrorStatus === 503;
  const genericDiscoveryError = discoveryQuery.isError && !itemNotFound && !providerUnavailable;

  async function handleLink() {
    if (!selectedAccount) return;

    try {
      const payload = {
        pluggy_item_id: submittedItemId,
        pluggy_account_id: selectedAccount.pluggy_account_id,
        sync_from: syncFrom,
        ...(createMode
          ? {
              new_account: {
                name: newAccountName,
                currency: selectedAccount.currency,
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
          {/* Step 0: enter the Pluggy Item ID and search */}
          <div className="flex flex-col gap-3">
            <label htmlFor="pluggy-item-id" className="block font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">
              Item ID
            </label>
            <input
              id="pluggy-item-id"
              type="text"
              className="rounded-pc border border-hairline bg-surface-0 px-3 py-2 text-sm text-ink"
              value={itemIdInput}
              onChange={(e) => setItemIdInput(e.target.value)}
            />
            <p className="text-xs text-ink-faint">
              Copie o Item ID no painel da Pluggy (dashboard.pluggy.ai → sua aplicação → item conectado).
            </p>
            <Button
              variant="ghost"
              size="sm"
              loading={discoveryQuery.isFetching}
              disabled={!itemIdInput.trim()}
              onClick={handleSearch}
            >
              Buscar contas
            </Button>
          </div>

          {itemNotFound ? (
            <Callout variant="negative">Item não encontrado — confira o ID.</Callout>
          ) : null}

          {providerUnavailable ? (
            <Callout variant="info">
              Bank discovery is temporarily unavailable. Please try again later.
            </Callout>
          ) : null}

          {genericDiscoveryError ? (
            <Callout variant="negative">Couldn't load discovered accounts. Please try again.</Callout>
          ) : null}

          {discoveryQuery.isFetching ? (
            <p className="text-sm text-ink-faint">Loading discovered accounts...</p>
          ) : null}

          {submittedItemId && !discoveryQuery.isFetching && !discoveryQuery.isError && unlinkedAccounts.length === 0 ? (
            <p className="text-sm text-ink-faint">No new accounts to link.</p>
          ) : null}

          {/* Step 1: Select discovered account */}
          {unlinkedAccounts.length > 0 && !selectedAccount ? (
            <div className="flex flex-col gap-3">
              <label htmlFor="discovered-account" className="block font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">
                Discovered Account
              </label>
              <select
                id="discovered-account"
                className="rounded-pc border border-hairline bg-surface-0 px-3 py-2 text-sm text-ink"
                onChange={(e) => {
                  const account = unlinkedAccounts.find(
                    (a) => a.pluggy_account_id === e.target.value,
                  );
                  setSelectedAccount(account || null);
                }}
              >
                <option value="">Select an account...</option>
                {unlinkedAccounts.map((account) => (
                  <option key={account.pluggy_account_id} value={account.pluggy_account_id}>
                    {account.name} ({account.pluggy_account_id})
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {/* Step 2: Select target account or create new */}
          {selectedAccount && !createMode ? (
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
          {selectedAccount && createMode ? (
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

          {/* Sync start date — user-editable, defaults to today (finding 13:
              this used to be silently locked to today with no input). */}
          {selectedAccount ? (
            <div className="flex flex-col gap-3">
              <label htmlFor="sync-from" className="block font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">
                Sync From
              </label>
              <input
                id="sync-from"
                type="date"
                className="rounded-pc border border-hairline bg-surface-0 px-3 py-2 text-sm text-ink"
                value={syncFrom}
                onChange={(e) => setSyncFrom(e.target.value)}
              />
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
              !selectedAccount ||
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
