import { useState } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Pill from "../../components/ui/Pill";
import Spinner from "../../components/ui/Spinner";
import SummaryHeader from "../../components/ui/SummaryHeader";
import type { SummaryStat } from "../../components/ui/SummaryHeader";
import { useToast } from "../../components/ui/Toast";
import EmptyState from "../../components/data/EmptyState";
import { DateText, MoneyText } from "../../lib/preferences";
import { useAccounts } from "../accounts/useAccounts";
import CategoryBadge from "../categories/CategoryBadge";
import { useCategories } from "../categories/useCategories";
import ContactBadge from "../contacts/ContactBadge";
import { useContacts } from "../contacts/useContacts";
import { sumByCurrency } from "../_shared/totals";
import ScheduleForm from "./ScheduleForm";
import {
  usePlanned,
  usePostSchedule,
  useSkipSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
} from "./usePlanned";
import type { ScheduleFrequency, ScheduledTransactionOut } from "./usePlanned";

type FormState = { mode: "create" } | { mode: "edit"; schedule: ScheduledTransactionOut };

const FREQUENCY_LABEL: Record<ScheduleFrequency, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

const FREQUENCY_UNIT: Record<ScheduleFrequency, string> = {
  weekly: "week",
  monthly: "month",
  quarterly: "quarter",
  yearly: "year",
};

/** "Monthly" for interval 1, "Every 2 weeks" for a wider interval. */
function frequencyText(frequency: ScheduleFrequency, interval: number): string {
  if (interval > 1) {
    return `Every ${interval} ${FREQUENCY_UNIT[frequency]}s`;
  }
  return FREQUENCY_LABEL[frequency];
}

interface PlannedRowProps {
  schedule: ScheduledTransactionOut;
  accountName: string;
  category: { name: string; color: string } | null;
  contact: { name: string } | null;
  onEdit: () => void;
  onRequestDelete: () => void;
}

/**
 * One schedule's row. Owns its own post/skip/pause mutations so each row has
 * an independent loading state (a per-row hook, not a screen-level one shared
 * across every row). Delete is lifted to the screen — it opens a single shared
 * `ConfirmDialog` (a hard delete is permanent, CONVENTIONS reference: mirror
 * `ProjectDetail`).
 */
function PlannedRow({
  schedule,
  accountName,
  category,
  contact,
  onEdit,
  onRequestDelete,
}: PlannedRowProps) {
  const { showToast } = useToast();
  const postSchedule = usePostSchedule();
  const skipSchedule = useSkipSchedule();
  const setActive = useUpdateSchedule(schedule.id);

  async function handlePost() {
    try {
      await postSchedule.mutateAsync(schedule.id);
      showToast("Posted.", { variant: "positive" });
    } catch {
      showToast("Couldn't post this schedule. Please try again.", { variant: "negative" });
    }
  }

  async function handleSkip() {
    try {
      await skipSchedule.mutateAsync(schedule.id);
      showToast("Skipped.");
    } catch {
      showToast("Couldn't skip this schedule. Please try again.", { variant: "negative" });
    }
  }

  async function handleToggleActive() {
    try {
      await setActive.mutateAsync({ is_active: !schedule.is_active });
      showToast(schedule.is_active ? "Paused." : "Resumed.");
    } catch {
      showToast("Couldn't update this schedule. Please try again.", { variant: "negative" });
    }
  }

  return (
    <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm text-ink">{schedule.description}</p>
          {!schedule.is_active ? <Pill>Paused</Pill> : null}
        </div>
        <p className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
          {accountName} · {frequencyText(schedule.frequency, schedule.interval_count)} · Next:{" "}
          <DateText iso={schedule.next_due} />
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <CategoryBadge category={category} />
          <ContactBadge contact={contact} />
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <MoneyText minor={schedule.amount_minor} currency={schedule.currency} colorBySign />
        <Button variant="ghost" size="sm" loading={postSchedule.isPending} onClick={() => void handlePost()}>
          Post now
        </Button>
        <Button variant="ghost" size="sm" loading={skipSchedule.isPending} onClick={() => void handleSkip()}>
          Skip
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={setActive.isPending}
          onClick={() => void handleToggleActive()}
        >
          {schedule.is_active ? "Pause" : "Resume"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onRequestDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}

/**
 * `/planned` — recurring/scheduled money the user knows is coming (salary,
 * rent, subscriptions). Each schedule is a *rule*: when it's due, the user
 * **posts** it (creating the real transaction and advancing the schedule) or
 * **skips** it — no auto-posting, consistent with Pecunia's manual philosophy.
 *
 * The list is active-first (`usePlanned`), each active row above the paused
 * ones (which stay visible, marked with a `Paused` pill and offering
 * "Resume"). Includes archived accounts/categories/contacts when resolving names
 * so a schedule still resolves its labels even if one was later archived —
 * same rationale as `TransactionsScreen`.
 */
function PlannedScreen() {
  const { showToast } = useToast();
  const [formState, setFormState] = useState<FormState | null>(null);
  const [deleting, setDeleting] = useState<ScheduledTransactionOut | null>(null);

  const plannedQuery = usePlanned();
  const accountsQuery = useAccounts(true);
  const categoriesQuery = useCategories(true);
  const contactsQuery = useContacts(true);
  const deleteSchedule = useDeleteSchedule();

  const accounts = accountsQuery.data?.items ?? [];
  const accountName = (accountId: string): string =>
    accounts.find((a) => a.id === accountId)?.name ?? "Unknown account";

  const categories = categoriesQuery.data?.items ?? [];
  const categoryFor = (categoryId: string | null) =>
    categories.find((category) => category.id === categoryId) ?? null;

  const contacts = contactsQuery.data?.items ?? [];
  const contactFor = (contactId: string | null) =>
    contacts.find((contact) => contact.id === contactId) ?? null;

  const schedules = plannedQuery.data?.items ?? [];
  // Paused schedules aren't actually coming due until resumed, so the
  // "upcoming" total counts active ones only — signed, per currency, same
  // convention each row's own `colorBySign` amount uses.
  const upcomingStats: SummaryStat[] = [
    {
      label: "Total upcoming",
      entries: sumByCurrency(
        schedules.filter((schedule) => schedule.is_active),
        (schedule) => schedule.amount_minor,
        (schedule) => schedule.currency,
      ).map(({ currency, total_minor }) => ({
        currency,
        value_minor: total_minor,
        tone: total_minor > 0 ? "pos" : total_minor < 0 ? "neg" : undefined,
      })),
    },
  ];

  async function handleDelete() {
    if (!deleting) {
      return;
    }
    try {
      await deleteSchedule.mutateAsync(deleting.id);
      showToast("Schedule deleted.");
    } catch {
      showToast("Couldn't delete this schedule. Please try again.", { variant: "negative" });
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Planned</h1>
        <Button onClick={() => setFormState({ mode: "create" })} disabled={accounts.length === 0}>
          New schedule
        </Button>
      </div>

      {schedules.length > 0 ? <SummaryHeader stats={upcomingStats} /> : null}

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {formState.mode === "edit" ? "Edit schedule" : "New schedule"}
          </h2>
          <div className="mt-4">
            <ScheduleForm
              accounts={accounts}
              schedule={formState.mode === "edit" ? formState.schedule : undefined}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Schedule updated." : "Schedule created.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Delete "${deleting.description}"?`}
          description="This permanently deletes the schedule. Transactions already posted from it are kept. This can't be undone."
          confirmLabel="Delete schedule"
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleting(null)}
          isConfirming={deleteSchedule.isPending}
        />
      ) : null}

      {plannedQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner label="Loading" />
        </div>
      ) : plannedQuery.isError ? (
        <Callout variant="negative">Couldn't load your schedules. Try again.</Callout>
      ) : schedules.length === 0 ? (
        <EmptyState
          title="No planned items yet"
          body="Add a recurring schedule — salary, rent, a subscription — to see what's coming up."
          action={
            accounts.length > 0 ? (
              <Button onClick={() => setFormState({ mode: "create" })}>Add a schedule</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-pc-lg border border-hairline bg-surface-1">
          <ul className="divide-y divide-hairline px-4">
            {schedules.map((schedule) => (
              <li key={schedule.id}>
                <PlannedRow
                  schedule={schedule}
                  accountName={accountName(schedule.account_id)}
                  category={categoryFor(schedule.category_id)}
                  contact={contactFor(schedule.contact_id)}
                  onEdit={() => setFormState({ mode: "edit", schedule })}
                  onRequestDelete={() => setDeleting(schedule)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default PlannedScreen;
