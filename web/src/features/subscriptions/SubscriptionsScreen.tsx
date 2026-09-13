import { useState } from "react";
import Avatar from "../../components/ui/Avatar";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Pill from "../../components/ui/Pill";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import EmptyState from "../../components/data/EmptyState";
import { DateText, MoneyText, usePreferences } from "../../lib/preferences";
import { cn } from "../../lib/cn";
import CategoryBadge from "../categories/CategoryBadge";
import { useCategories } from "../categories/useCategories";
import ContactBadge from "../contacts/ContactBadge";
import { useContacts } from "../contacts/useContacts";
import SubscriptionForm from "./SubscriptionForm";
import {
  useDeleteSubscription,
  useRenewSubscription,
  useSetSubscriptionStatus,
  useSubscriptionTotals,
  useSubscriptions,
} from "./useSubscriptions";
import type { BillingFrequency, SubscriptionOut } from "./useSubscriptions";

type FormState = { mode: "create" } | { mode: "edit"; subscription: SubscriptionOut };

const FREQUENCY_LABELS: Record<BillingFrequency, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

/**
 * `/subscriptions` — the recurring-services registry. A header rolls up the
 * base-currency **monthly + annualized** spend (`useSubscriptionTotals`, the
 * server's per-currency `/totals`), then a list shows each subscription with
 * its vendor logo (`Avatar`, name + logo → monogram fallback), the normalized
 * monthly cost (`monthly_minor` via `MoneyText`) and billing cycle, the next
 * renewal date, any linked contact/category, and a status. Row actions
 * **Renew** (advances the date — a tracker action that posts no transaction),
 * Edit, Cancel/Reactivate, and Delete. Active subscriptions sort
 * soonest-renewal-first (via `useSubscriptions`'s `select`); canceled ones
 * trail, shown muted.
 *
 * Reads the bounded flat `useSubscriptions` list rather than a keyset
 * `DataList` — a workspace's subscriptions are a small, user-managed set, same
 * rationale as `LoansScreen`.
 */
function SubscriptionsScreen() {
  const { showToast } = useToast();
  const preferences = usePreferences();
  const [formState, setFormState] = useState<FormState | null>(null);
  const [deleting, setDeleting] = useState<SubscriptionOut | null>(null);

  const subscriptionsQuery = useSubscriptions();
  const totalsQuery = useSubscriptionTotals();

  // Archived included so a subscription whose linked contact/category was later
  // archived still resolves its badge — same rationale as the pickers.
  const contactsQuery = useContacts(true);
  const contacts = contactsQuery.data?.items ?? [];
  const categoriesQuery = useCategories(true);
  const categories = categoriesQuery.data?.items ?? [];

  const renewSubscription = useRenewSubscription();
  const setStatus = useSetSubscriptionStatus();
  const deleteSubscription = useDeleteSubscription();

  const subscriptions = subscriptionsQuery.data?.items ?? [];
  const baseCurrency = preferences.base_currency;
  const totals = totalsQuery.data ?? {};
  const baseTotal = totals[baseCurrency] ?? { monthly_minor: 0, annual_minor: 0, count: 0 };
  // Any currency other than the base that still carries subscriptions — money
  // is never summed across currencies (§4), so these ride as secondary lines.
  const otherCurrencies = Object.entries(totals).filter(([code]) => code !== baseCurrency);

  const contactFor = (contactId: string | null) =>
    contacts.find((contact) => contact.id === contactId) ?? null;
  const categoryFor = (categoryId: string | null) =>
    categories.find((category) => category.id === categoryId) ?? null;

  async function handleRenew(subscription: SubscriptionOut) {
    try {
      await renewSubscription.mutateAsync(subscription.id);
      showToast(`"${subscription.name}" renewed.`, { variant: "positive" });
    } catch {
      showToast("Couldn't renew that subscription. Please try again.", { variant: "negative" });
    }
  }

  async function handleToggleStatus(subscription: SubscriptionOut) {
    const next = subscription.status === "active" ? "canceled" : "active";
    try {
      await setStatus.mutateAsync({ id: subscription.id, status: next });
      showToast(
        next === "canceled" ? `"${subscription.name}" canceled.` : `"${subscription.name}" reactivated.`,
      );
    } catch {
      showToast("Couldn't update that subscription. Please try again.", { variant: "negative" });
    }
  }

  async function handleDelete() {
    if (!deleting) {
      return;
    }
    try {
      await deleteSubscription.mutateAsync(deleting.id);
      showToast(`"${deleting.name}" deleted.`);
      setDeleting(null);
    } catch {
      showToast("Couldn't delete that subscription. Please try again.", { variant: "negative" });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Subscriptions</h1>
        <Button onClick={() => setFormState({ mode: "create" })}>New subscription</Button>
      </div>

      {subscriptions.length > 0 ? (
        <Card className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
              Monthly spend
            </p>
            <MoneyText
              minor={baseTotal.monthly_minor}
              currency={baseCurrency}
              variant="hero"
              className="text-3xl text-ink"
            />
          </div>
          <div className="sm:text-right">
            <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">Annualized</p>
            <MoneyText minor={baseTotal.annual_minor} currency={baseCurrency} className="text-lg text-ink-2" />
            {otherCurrencies.length > 0 ? (
              <p className="mt-1 font-mono text-xs text-ink-faint">
                {otherCurrencies.map(([code, total]) => (
                  <span key={code} className="ml-2 first:ml-0">
                    <MoneyText minor={total.monthly_minor} currency={code} className="text-xs" /> / mo
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {formState.mode === "edit" ? "Edit subscription" : "New subscription"}
          </h2>
          <div className="mt-4">
            <SubscriptionForm
              subscription={formState.mode === "edit" ? formState.subscription : undefined}
              defaultCurrency={baseCurrency}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Subscription updated." : "Subscription created.", {
                  variant: "positive",
                });
              }}
            />
          </div>
        </Card>
      ) : null}

      {subscriptionsQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner label="Loading subscriptions" />
        </div>
      ) : subscriptionsQuery.isError ? (
        <Callout variant="negative">Couldn't load your subscriptions. Try again.</Callout>
      ) : subscriptions.length === 0 ? (
        <EmptyState
          title="No subscriptions yet"
          body="Add a recurring service you pay for — a streaming plan, a gym, a cloud tool — to track its cost and next renewal."
          action={<Button onClick={() => setFormState({ mode: "create" })}>Add your first subscription</Button>}
        />
      ) : (
        <ul className="divide-y divide-hairline rounded-pc-lg border border-hairline bg-surface-1">
          {subscriptions.map((subscription) => {
            const isCanceled = subscription.status === "canceled";
            const contact = contactFor(subscription.contact_id);
            const category = categoryFor(subscription.category_id);
            return (
              <li
                key={subscription.id}
                className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className={cn("flex min-w-0 items-center gap-3", isCanceled && "opacity-60")}>
                  <Avatar src={subscription.logo} name={subscription.name} size="lg" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-ink">{subscription.name}</span>
                      {isCanceled ? <Pill>Canceled</Pill> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-ink-2">
                      <MoneyText minor={subscription.monthly_minor} currency={subscription.currency} />
                      <span className="text-ink-faint">/ mo</span>
                      <span className="text-ink-faint">·</span>
                      <span>{FREQUENCY_LABELS[subscription.billing_frequency]}</span>
                      <span className="text-ink-faint">·</span>
                      <span className="text-ink-faint">Renews</span>
                      <DateText iso={subscription.next_renewal} />
                    </div>
                    {contact || category ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {contact ? <ContactBadge contact={contact} /> : null}
                        {category ? <CategoryBadge category={category} /> : null}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
                  {!isCanceled ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={renewSubscription.isPending}
                      onClick={() => void handleRenew(subscription)}
                    >
                      Renew
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFormState({ mode: "edit", subscription })}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={setStatus.isPending}
                    onClick={() => void handleToggleStatus(subscription)}
                  >
                    {isCanceled ? "Reactivate" : "Cancel"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(subscription)}>
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {deleting ? (
        <ConfirmDialog
          title={`Delete "${deleting.name}"?`}
          description="This permanently removes the subscription and its renewal tracking. This can't be undone."
          confirmLabel="Delete"
          isConfirming={deleteSubscription.isPending}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

export default SubscriptionsScreen;
