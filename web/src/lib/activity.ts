/**
 * Activity-feed template-key -> sentence rendering. `GET /activity` returns
 * `{template_key, params}` pairs (per `api/src/pecunia/activity/templates.py`
 * and `api/src/pecunia/services/*`) rather than pre-rendered text, so the
 * client owns turning a template key + its params into words — the
 * SCREAMING_SNAKE-adjacent-but-dotted key itself is never shown to a user
 * (mirrors the detail -> copy mapping pattern for API errors, CONVENTIONS
 * §9.6).
 *
 * This is a deliberately minimal mapper covering the template keys that
 * exist today (`account.created`, `transaction.created`, `asset.created`,
 * `asset.valuation_changed`, `project.created`,
 * `project.target_reached`, `budget.created`). A later plan task expands
 * this as more templates land; an unrecognized key falls back to a
 * humanized rendering of the key itself rather than a blank row, so a new
 * template key never produces silently missing activity — just a slightly
 * plainer sentence until this file is taught its params.
 */

import { formatMoney } from "./money";

export interface ActivityEntry {
  id: number;
  occurred_at: string;
  template_key: string;
  params: Record<string, unknown>;
  actor_user_id?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
}

type Params = Record<string, unknown>;

const MISSING = "—";

function str(params: Params, key: string, fallback = MISSING): string {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(params: Params, key: string): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function money(params: Params, key: string, currency: string, locale?: string): string {
  return formatMoney(num(params, key), currency, locale);
}

/** Humanizes an unrecognized template key into a sentence-ish fallback:
 * `"activity.workspace.renamed"` -> `"Workspace renamed."` */
function humanizeTemplateKey(templateKey: string): string {
  const withoutPrefix = templateKey.startsWith("activity.")
    ? templateKey.slice("activity.".length)
    : templateKey;
  const words = withoutPrefix.split(".").join(" ").split("_").join(" ").trim();
  if (!words) {
    return "Activity recorded.";
  }
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

type Renderer = (params: Params, locale: string | undefined) => string;

const RENDERERS: Record<string, Renderer> = {
  "activity.account.created": (params) => {
    const name = str(params, "name");
    const type = typeof params.type === "string" ? params.type : undefined;
    return type ? `Account "${name}" created (${type}).` : `Account "${name}" created.`;
  },
  "activity.transaction.created": (params, locale) => {
    const description = str(params, "description");
    const currency = str(params, "currency", "USD");
    return `Transaction "${description}" recorded — ${money(params, "amount_minor", currency, locale)}.`;
  },
  "activity.asset.created": (params) => {
    const name = str(params, "name");
    const type = typeof params.type === "string" ? params.type : undefined;
    return type ? `Asset "${name}" added (${type}).` : `Asset "${name}" added.`;
  },
  "activity.asset.valuation_changed": (params, locale) => {
    const asset = str(params, "asset");
    const currency = str(params, "currency", "USD");
    const from = money(params, "from", currency, locale);
    const to = money(params, "to", currency, locale);
    return `${asset} valuation changed · ${from} → ${to}.`;
  },
  "activity.project.created": (params, locale) => {
    const name = str(params, "name");
    const currency = str(params, "currency", "USD");
    return `Project "${name}" created — target ${money(params, "target_amount_minor", currency, locale)}.`;
  },
  "activity.project.target_reached": (params, locale) => {
    const project = str(params, "project");
    const currency = str(params, "currency", "USD");
    return `Project "${project}" reached its target of ${money(params, "target", currency, locale)}.`;
  },
  "activity.budget.created": (params, locale) => {
    const name = str(params, "name");
    const currency = str(params, "currency", "USD");
    return `Budget "${name}" created — ${money(params, "amount_minor", currency, locale)}.`;
  },
};

/**
 * Renders one activity entry's `template_key` + `params` into a plain
 * sentence for the activity feed. Never throws on missing/malformed params
 * — every field access falls back to a safe placeholder (`"—"` for text,
 * `0` for a missing amount) so a partially-shaped entry still renders
 * something readable instead of crashing the panel.
 */
export function renderActivity(templateKey: string, params: Params = {}, locale?: string): string {
  const renderer = RENDERERS[templateKey];
  return renderer ? renderer(params, locale) : humanizeTemplateKey(templateKey);
}
