import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import Pill from "../../components/ui/Pill";
import { apiFetch } from "../../lib/api";
import { cn } from "../../lib/cn";
import { DateText, MoneyText } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import { ACCOUNT_TYPE_LABELS } from "../accounts/accountTypes";
import { useBankConnections } from "../banksync/useBankSync";
import type { BankLinkOut } from "../banksync/useBankSync";
import type { AccountSummary } from "./balances";
import { creditCardUsage } from "./creditCardUsage";

interface KeysetResponse<T> {
  items: T[];
}

/** Comfortably covers a personal workspace's full accounts list in one
 * request — same bound and cache-key move `Dashboard.tsx`'s own accounts
 * read uses (`"dashboard"`-suffixed `qk.accounts`, see that file's
 * docstring): sharing the exact key + queryFn means this standalone card
 * costs no extra request when mounted alongside the Dashboard screen. */
const ACCOUNTS_FETCH_LIMIT = 200;

/**
 * The dashboard's accounts-and-cards card (Track U, v1.6) — every active
 * account with its balance, joined against `/bank-sync/connections` by
 * `account_id` so a linked account gets an "Open Finance" chip. A linked
 * credit card additionally shows a used/limit bar (outstanding balance over
 * its credit limit, clamped 0–100%, omitted when the limit is unknown or
 * non-positive) and its next bill's due date when known. A non-synced
 * account renders its balance alone — same calm degrade `AccountsSnapshot`
 * follows. Archived accounts are skipped (they're not part of "what do I
 * have right now"). Standalone card — `Dashboard.tsx` places it (not here).
 */
function AccountsCardsCard() {
  const accountsQuery = useQuery({
    queryKey: [...qk.accounts, "dashboard"],
    queryFn: () =>
      apiFetch<KeysetResponse<AccountSummary>>(`/accounts?limit=${ACCOUNTS_FETCH_LIMIT}`),
  });
  const bankConnectionsQuery = useBankConnections();

  const isLoading = accountsQuery.isLoading || bankConnectionsQuery.isLoading;
  const isError = accountsQuery.isError || bankConnectionsQuery.isError;

  const accounts = (accountsQuery.data?.items ?? []).filter(
    (account) => account.archived_at === null,
  );
  const links: BankLinkOut[] = (bankConnectionsQuery.data ?? []).flatMap(
    (connection) => connection.links,
  );
  const linkFor = (accountId: string): BankLinkOut | undefined =>
    links.find((link) => link.account_id === accountId);

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg text-ink">Contas e cartões</h2>
        <Link
          to="/accounts"
          className="font-sans text-sm text-accent transition-colors duration-150 ease-pc hover:text-accent-hover"
        >
          Ver tudo
        </Link>
      </div>

      {isError ? (
        <p className="mt-5 text-sm text-ink-faint">
          Não foi possível carregar suas contas. Tente atualizar.
        </p>
      ) : isLoading ? (
        <p className="mt-5 text-sm text-ink-2">Carregando…</p>
      ) : accounts.length === 0 ? (
        <p className="mt-5 text-sm text-ink-2">Nenhuma conta ainda.</p>
      ) : (
        <ul className="mt-5 flex flex-col divide-y divide-hairline">
          {accounts.map((account) => {
            const link = linkFor(account.id);
            const usage =
              link && account.type === "credit_card"
                ? creditCardUsage(link.derived_balance_minor, link.credit_limit_minor)
                : null;

            return (
              <li key={account.id} className="flex flex-col gap-2 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-sans text-sm text-ink">{account.name}</span>
                      {link ? <Pill className="shrink-0">Open Finance</Pill> : null}
                    </p>
                    <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
                      {ACCOUNT_TYPE_LABELS[account.type] ?? account.type}
                    </p>
                  </div>
                  <MoneyText
                    minor={account.balance_minor}
                    currency={account.currency}
                    flagNegative
                    className="shrink-0"
                  />
                </div>

                {usage ? (
                  <div
                    role="progressbar"
                    aria-valuenow={Math.round(usage.percent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${account.name}: limite usado`}
                    className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
                  >
                    <div
                      className={cn(
                        "h-full rounded-full transition-[width] duration-150 ease-pc",
                        usage.overLimit ? "bg-negative" : "bg-accent",
                      )}
                      style={{ width: `${usage.percent}%` }}
                    />
                  </div>
                ) : null}

                {link?.bill_due_date && account.type === "credit_card" ? (
                  <p className="text-xs text-ink-faint">
                    vence <DateText iso={link.bill_due_date} />
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default AccountsCardsCard;
