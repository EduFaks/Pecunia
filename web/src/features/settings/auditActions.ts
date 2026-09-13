/**
 * The audit log's closed `action`/`resource_type` vocabularies, mirrored
 * from `api/src/pecunia/audit/actions.py`'s `Actions` class (spec D3:
 * "resource.action[.qualifier]") and the `resource_type=` literals each
 * service passes to `DomainEvent` — there's no `/audit-events/actions`
 * endpoint to discover this from, so the `AuditLogPanel` filter `Select`s
 * hardcode the same closed catalog the backend enforces. A new action/
 * resource type added on the backend needs this list updated too.
 */

export const KNOWN_ACTIONS = [
  // auth
  "auth.login.success",
  "auth.login.failed",
  "auth.login.throttled",
  "auth.logout",
  "auth.logout_all",
  "auth.session.revoked",
  "auth.session.reuse_detected",
  "auth.password.changed",
  // accounts
  "account.created",
  "account.updated",
  "account.archived",
  "account.deleted",
  "account.balance_reconciled",
  // transactions
  "transaction.created",
  "transaction.updated",
  "transaction.deleted",
  "transaction.restored",
  "transaction.imported",
  // projects
  "project.created",
  "project.updated",
  "project.deleted",
  "project_item.created",
  "project_item.updated",
  // assets
  "asset.created",
  "asset.updated",
  "asset.deleted",
  "asset.valuation.created",
  "asset.valuation.updated",
  // budgets
  "budget.created",
  "budget.updated",
  "budget.deleted",
  // categories
  "category.created",
  "category.updated",
  "category.archived",
  // config / data
  "settings.updated",
  "user.created",
  "user.updated",
  "setup.completed",
  "backup.created",
  "backup.restored",
  "data.imported",
  "data.exported",
  "data.demo_seeded",
  "data.demo_removed",
] as const;

export const KNOWN_RESOURCE_TYPES = [
  "account",
  "asset",
  "asset_valuation",
  "budget",
  "category",
  "project",
  "project_item",
  "session",
  "settings",
  "transaction",
  "user",
  "workspace",
] as const;

/** `"asset.valuation.created"` -> `"Asset valuation created"`,
 * `"project_item"` -> `"Project item"` — same "dots/underscores to spaces,
 * capitalize the first letter" move `lib/activity.ts`'s
 * `humanizeTemplateKey` uses for an unrecognized template key. */
export function humanizeAuditToken(token: string): string {
  const words = token.split(".").join(" ").split("_").join(" ").trim();
  if (!words) {
    return token;
  }
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
