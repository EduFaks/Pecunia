import { useState } from "react";
import type { ComponentType } from "react";
import { cn } from "../../lib/cn";
import { focusRingClass } from "../../components/ui/a11y";
import CategoriesPanel from "../categories/CategoriesPanel";
import AuditLogPanel from "./AuditLogPanel";
import PreferencesPanel from "./PreferencesPanel";
import SessionsPanel from "./SessionsPanel";

type SettingsSection = "sessions" | "audit-log" | "preferences" | "categories";

interface SectionDef {
  id: SettingsSection;
  label: string;
  group: "Security" | "General";
}

const SECTIONS: SectionDef[] = [
  { id: "sessions", label: "Sessions", group: "Security" },
  { id: "audit-log", label: "Audit Log", group: "Security" },
  { id: "preferences", label: "Preferences", group: "General" },
  { id: "categories", label: "Categories", group: "General" },
];

const PANELS: Record<SettingsSection, ComponentType> = {
  sessions: SessionsPanel,
  "audit-log": AuditLogPanel,
  preferences: PreferencesPanel,
  categories: CategoriesPanel,
};

/**
 * `/settings` — in-page subnav (no nested routes: every section reads the
 * same signed-in workspace's data, and none needs to be independently
 * deep-linkable in V1) over four sections: Security → Sessions, Security →
 * Audit Log, General → Preferences, and General → Categories. Each section is
 * its own component so its data-fetching only kicks in once selected.
 * (Contacts, formerly a section here, is now its own top-level `/contacts`
 * screen.)
 */
function SettingsScreen() {
  const [section, setSection] = useState<SettingsSection>("sessions");
  const Panel = PANELS[section];

  function renderGroup(group: SectionDef["group"]) {
    return (
      <div key={group}>
        <p className="mb-1 font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">{group}</p>
        <ul className="flex flex-col gap-1">
          {SECTIONS.filter((item) => item.group === group).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => setSection(item.id)}
                className={cn(
                  "w-full rounded-pc px-3 py-2 text-left font-sans text-sm transition-colors duration-150 ease-pc",
                  section === item.id
                    ? "bg-accent-soft text-ink"
                    : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                  focusRingClass,
                )}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-2xl text-ink">Settings</h1>
      <div className="flex flex-col gap-8 lg:flex-row">
        <nav aria-label="Settings sections" className="flex shrink-0 flex-col gap-6 lg:w-48">
          {renderGroup("Security")}
          {renderGroup("General")}
        </nav>
        <div className="min-w-0 flex-1">
          <Panel />
        </div>
      </div>
    </div>
  );
}

export default SettingsScreen;
