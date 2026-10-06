import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import { DateText, MoneyText } from "../../lib/preferences";
import type { BillingFrequency, SubscriptionSuggestion } from "./useSubscriptions";

const FREQUENCY_LABELS: Record<BillingFrequency, string> = {
  weekly: "weekly",
  monthly: "monthly",
  quarterly: "quarterly",
  yearly: "yearly",
};

export interface SubscriptionSuggestionsProps {
  suggestions: SubscriptionSuggestion[];
  /** category id → display name, for the suggested-category hint. */
  categoryNameById: Record<string, string>;
  onAdd: (suggestion: SubscriptionSuggestion) => void;
  onIgnore: (merchant: string) => void;
}

/**
 * The detected recurring-charge review strip (Track W), shown above the
 * subscription list. Each candidate was found in the imported bank/card
 * transactions (merchant + ~equal amount + a regular cadence); "Add" opens
 * the normal create form pre-filled so the user confirms/edits before it
 * becomes a real subscription, and "Ignore" dismisses it for the session.
 * Renders nothing when there are no candidates.
 */
function SubscriptionSuggestions({ suggestions, categoryNameById, onAdd, onIgnore }: SubscriptionSuggestionsProps) {
  if (suggestions.length === 0) {
    return null;
  }
  return (
    <Card>
      <h2 className="font-display text-lg text-ink">
        {suggestions.length === 1
          ? "We found 1 possible subscription"
          : `We found ${suggestions.length} possible subscriptions`}
      </h2>
      <p className="mt-1 text-sm text-ink-2">
        Recurring charges spotted in your imported transactions. Add the ones you want to track.
      </p>
      <ul className="mt-4 divide-y divide-hairline">
        {suggestions.map((s) => {
          const categoryName = s.suggested_category_id
            ? categoryNameById[s.suggested_category_id]
            : undefined;
          return (
            <li
              key={`${s.merchant}:${s.currency}`}
              className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-sm text-ink">{s.merchant}</span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-ink-2">
                  <MoneyText minor={s.amount_minor} currency={s.currency} />
                  <span className="text-ink-faint">· {FREQUENCY_LABELS[s.billing_frequency]}</span>
                  <span className="text-ink-faint">· seen {s.occurrences}×</span>
                  <span className="text-ink-faint">· since</span>
                  <DateText iso={s.first_seen} />
                  {categoryName ? <span className="text-ink-faint">· {categoryName}</span> : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" onClick={() => onAdd(s)}>
                  Add
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onIgnore(s.merchant)}>
                  Ignore
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default SubscriptionSuggestions;
