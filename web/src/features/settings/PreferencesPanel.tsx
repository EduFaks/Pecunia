import Callout from "../../components/ui/Callout";
import { usePreferences } from "../../lib/preferences";

/**
 * Settings → Preferences: a read-only view of the instance's preferences
 * (from `GET /auth/me`, via `usePreferences`). There is no settings-update
 * endpoint in V1 (CONVENTIONS/spec) — Plan 06's setup wizard is the only
 * place these are ever set — so this deliberately renders no form controls,
 * just the current values plus a note that editing is coming later.
 */
function PreferencesPanel() {
  const preferences = usePreferences();

  const rows: { label: string; value: string }[] = [
    { label: "Base currency", value: preferences.base_currency },
    { label: "Locale", value: preferences.locale },
    { label: "Date format", value: preferences.date_format },
    { label: "Number format", value: preferences.number_format },
    { label: "Timezone", value: preferences.timezone },
    {
      label: "First day of week",
      value: `${preferences.first_day_of_week.charAt(0).toUpperCase()}${preferences.first_day_of_week.slice(1)}`,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-display text-lg text-ink">Preferences</h2>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="rounded-pc border border-hairline bg-surface-1 p-4">
            <dt className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">{row.label}</dt>
            <dd className="mt-1 text-sm text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
      <Callout variant="info">Editing preferences is coming in a future update.</Callout>
    </div>
  );
}

export default PreferencesPanel;
