import { Link } from "react-router-dom";
import { renderActivity } from "../../lib/activity";
import type { ActivityEntry } from "../../lib/activity";
import { DateText, usePreferences } from "../../lib/preferences";

export interface RecentActivityProps {
  entries: ActivityEntry[];
}

/**
 * A Surface panel previewing the latest activity-feed entries as plain
 * sentences (`renderActivity`, `lib/activity.ts`) with their timestamp —
 * links to the full `/activity` screen. A fresh instance with no history
 * yet gets a calm inline message, not an error tone.
 */
function RecentActivity({ entries }: RecentActivityProps) {
  const preferences = usePreferences();

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg text-ink">Recent activity</h2>
        <Link
          to="/activity"
          className="font-sans text-sm text-accent transition-colors duration-150 ease-pc hover:text-accent-hover"
        >
          View all
        </Link>
      </div>

      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-ink-2">No activity yet — it'll show up here as you go.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start justify-between gap-4">
              <p className="text-sm text-ink">
                {renderActivity(entry.template_key, entry.params, preferences.locale)}
              </p>
              <DateText iso={entry.occurred_at} className="shrink-0 text-xs text-ink-faint" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default RecentActivity;
