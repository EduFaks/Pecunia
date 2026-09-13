import { useState } from "react";
import type { KeysetPage } from "../../components/data/DataList";
import DayGroupedList from "../../components/data/DayGroupedList";
import EmptyState from "../../components/data/EmptyState";
import Callout from "../../components/ui/Callout";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import TextField from "../../components/ui/TextField";
import { apiFetch, ApiError } from "../../lib/api";
import { DateText, usePreferences } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import type { AuditEventFilters } from "../../lib/queries";
import { humanizeAuditToken, KNOWN_ACTIONS, KNOWN_RESOURCE_TYPES } from "./auditActions";

/** Mirrors `AuditEventOut` (`api/src/pecunia/api/audit.py`) — only the
 * fields this panel renders; the endpoint returns a few more
 * (`actor_session_id`, `workspace_id`, `request_id`) this UI has no use
 * for. */
export interface AuditEventOut {
  id: number;
  occurred_at: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const ALL = "";
const PAGE_LIMIT = 20;

const ACTION_OPTIONS: SelectOption[] = [
  { value: ALL, label: "All actions" },
  ...KNOWN_ACTIONS.map((action) => ({ value: action, label: humanizeAuditToken(action) })),
];

const RESOURCE_TYPE_OPTIONS: SelectOption[] = [
  { value: ALL, label: "All types" },
  ...KNOWN_RESOURCE_TYPES.map((type) => ({ value: type, label: humanizeAuditToken(type) })),
];

function buildParams(filters: AuditEventFilters, cursor: string | null): URLSearchParams {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (filters.action) {
    params.set("action", filters.action);
  }
  if (filters.resourceType) {
    params.set("resource_type", filters.resourceType);
  }
  if (filters.since) {
    params.set("since", filters.since);
  }
  if (filters.until) {
    params.set("until", filters.until);
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  return params;
}

function DetailBlock({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">{label}</p>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-ink-2">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function AuditEventRow({ event }: { event: AuditEventOut }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = event.before !== null || event.after !== null || event.metadata !== null;

  return (
    <div className="px-4 py-3">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={expanded}
      >
        <div className="min-w-0">
          <p className="text-sm text-ink">
            {humanizeAuditToken(event.action)}
            {event.resource_type ? ` · ${humanizeAuditToken(event.resource_type)}` : ""}
          </p>
          <p className="mt-0.5 font-mono text-xs text-ink-faint">
            <DateText iso={event.occurred_at} />
            {event.ip ? ` · ${event.ip}` : ""}
          </p>
        </div>
        {hasDetail ? (
          <span aria-hidden="true" className="shrink-0 text-ink-faint">
            {expanded ? "−" : "+"}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="mt-3 flex flex-col gap-3 rounded-pc border border-hairline bg-surface-2 p-3">
          {event.before ? <DetailBlock label="Before" value={event.before} /> : null}
          {event.after ? <DetailBlock label="After" value={event.after} /> : null}
          {event.metadata ? <DetailBlock label="Metadata" value={event.metadata} /> : null}
          {!hasDetail ? <p className="text-xs text-ink-faint">No additional detail recorded.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Settings → Security → Audit Log: `GET /audit-events` is owner-only (403
 * `NOT_OWNER` for anyone else, per `require_owner` in
 * `api/src/pecunia/api/deps.py`) — rather than trying to know ownership
 * ahead of time (no `is_owner` flag comes back from `/auth/me`), this
 * screen just attempts the fetch and, via `DayGroupedList`'s `renderError`
 * override, turns that specific refusal into a calm, expected message
 * instead of the generic "couldn't load" error callout every other failure
 * gets.
 *
 * Filters (action, resource type, a since/until date range) are plain
 * controlled state folded into `qk.auditEvents(filters)` — changing any of
 * them is a normal query-key change, so `DayGroupedList` refetches from a
 * fresh first page exactly like `TransactionsScreen`'s account filter does.
 */
function AuditLogPanel() {
  const preferences = usePreferences();
  const [filters, setFilters] = useState<AuditEventFilters>({});

  function fetchPage(cursor: string | null) {
    return apiFetch<KeysetPage<AuditEventOut>>(`/audit-events?${buildParams(filters, cursor).toString()}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="font-display text-lg text-ink">Audit Log</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label="Action"
          options={ACTION_OPTIONS}
          value={filters.action ?? ALL}
          onChange={(event) =>
            setFilters((current) => ({ ...current, action: event.target.value || undefined }))
          }
        />
        <Select
          label="Resource type"
          options={RESOURCE_TYPE_OPTIONS}
          value={filters.resourceType ?? ALL}
          onChange={(event) =>
            setFilters((current) => ({ ...current, resourceType: event.target.value || undefined }))
          }
        />
        <TextField
          label="From"
          type="date"
          value={filters.since ?? ""}
          onChange={(event) =>
            setFilters((current) => ({ ...current, since: event.target.value || undefined }))
          }
        />
        <TextField
          label="To"
          type="date"
          value={filters.until ?? ""}
          onChange={(event) =>
            setFilters((current) => ({ ...current, until: event.target.value || undefined }))
          }
        />
      </div>

      <DayGroupedList<AuditEventOut>
        queryKey={qk.auditEvents(filters)}
        fetchPage={fetchPage}
        locale={preferences.locale}
        dateFormat={preferences.date_format}
        empty={<EmptyState title="No matching events" body="Nothing in the audit log matches these filters yet." />}
        renderError={(error) =>
          error instanceof ApiError && error.status === 403 && error.detail === "NOT_OWNER" ? (
            <Callout variant="info">Only the instance owner can view the audit log.</Callout>
          ) : (
            <Callout variant="negative">Couldn't load the audit log. Try again.</Callout>
          )
        }
        renderRow={(event) => <AuditEventRow event={event} />}
      />
    </div>
  );
}

export default AuditLogPanel;
