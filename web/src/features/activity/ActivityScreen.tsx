import DayGroupedList from "../../components/data/DayGroupedList";
import type { KeysetPage } from "../../components/data/DataList";
import EmptyState from "../../components/data/EmptyState";
import { apiFetch } from "../../lib/api";
import type { ActivityEntry } from "../../lib/activity";
import { usePreferences } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import ActivityRow from "./ActivityRow";

/** One walked page's size for the activity feed's `DayGroupedList`. */
const PAGE_LIMIT = 20;

function fetchPage(cursor: string | null) {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor) {
    params.set("cursor", cursor);
  }
  return apiFetch<KeysetPage<ActivityEntry>>(`/activity?${params.toString()}`);
}

/**
 * `/activity` — the full workspace activity feed: every `template_key` +
 * `params` entry the backend has recorded, day-grouped (Today / Yesterday /
 * an explicit date, via `DayGroupedList`) with keyset "Load more". Each row
 * is `ActivityRow`, which special-cases `activity.asset.valuation_changed`
 * for a colored from→to treatment and otherwise renders `renderActivity`'s
 * plain sentence — see that component's docstring.
 */
function ActivityScreen() {
  const preferences = usePreferences();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-2xl text-ink">Activity</h1>

      <DayGroupedList<ActivityEntry>
        queryKey={qk.activity}
        fetchPage={fetchPage}
        locale={preferences.locale}
        dateFormat={preferences.date_format}
        empty={
          <EmptyState
            title="No activity yet"
            body="Actions you take across Pecunia — adding accounts, recording transactions, updating valuations — will show up here."
          />
        }
        renderRow={(entry) => <ActivityRow entry={entry} />}
      />
    </div>
  );
}

export default ActivityScreen;
