/**
 * Query/mutation hooks for the `/contacts` resource. The contacts sibling of
 * `features/categories/useCategories.ts` — a flat (non-paginated) query hook
 * plus create/update/archive mutations, all invalidating the single
 * `qk.contacts` prefix.
 *
 * As with categories, the flat hook is deliberately the *only* read path:
 * `ContactPicker` (the transaction-form autocomplete) and `ContactsScreen`
 * (the top-level management screen) both read the same bounded flat list. A
 * workspace's contacts are a small, user-managed set — you add them as you go
 * (unlike categories there are no seeded defaults; a fresh workspace starts
 * with none) — not an unbounded/append-only list like transactions, so a
 * keyset-paginated `DataList` buys nothing here. The endpoint still supports
 * cursor paging (`ContactPage.next_cursor`); this bounded fetch just reads a
 * generous first page, same rationale/limit as `useCategories`/`useAccounts`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import type { AnalyticsRange } from "../../lib/queries";

/** A contact is a person or a company — the party on a transaction. Mirrors
 * `ContactType` (`api/src/pecunia/models/contact.py`). */
export type ContactType = "person" | "company";

/** Mirrors `ContactOut` (`api/src/pecunia/api/contacts.py`). Beyond the name a
 * contact carries a `type` (person/company), an optional `default_category_id`,
 * and an optional `avatar` — a size-capped `data:image/(png|jpeg|webp);base64,…`
 * data-URI (downscaled client-side by `ImageUpload`), null when unset (the UI
 * renders a monogram fallback via `Avatar`). */
export interface ContactOut {
  id: string;
  name: string;
  default_category_id: string | null;
  type: ContactType;
  avatar: string | null;
  archived_at: string | null;
  is_demo: boolean;
  created_at: string;
}

export interface ContactPage {
  items: ContactOut[];
  next_cursor: string | null;
}

/** Mirrors `ContactIn`. `type` defaults to `company` server-side, but the form
 * always sends one. `avatar` is a data-URI or null. */
export interface CreateContactPayload {
  name: string;
  type?: ContactType;
  avatar?: string | null;
  default_category_id?: string | null;
}

/** Mirrors `ContactUpdate` — every field optional, only what changed is sent. */
export interface UpdateContactPayload {
  name?: string;
  type?: ContactType;
  avatar?: string | null;
  default_category_id?: string | null;
}

/** Comfortably covers a personal workspace's full contact list in one request
 * — same rationale/limit as `useCategories`'s `CATEGORIES_LIST_LIMIT`. */
const CONTACTS_LIST_LIMIT = 200;

/** The flat (non-paginated) contact list, `include_archived` defaulting to
 * `false` — powers `ContactPicker` (active contacts to pick from, plus the
 * currently-selected one even if since archived) and `ContactsScreen` (its own
 * "Show archived" toggle passes this straight through).
 *
 * Keyed with a `"flat"` suffix (`[...qk.contacts, "flat", {includeArchived}]`)
 * — same collision-avoidance rationale as `useCategories`/`useAccounts`'s
 * flat hooks — so a future caller that reads `qk.contacts` some other way
 * never collides with this shape, while the mutations below still invalidate
 * the bare prefix. */
export function useContacts(includeArchived = false) {
  return useQuery({
    queryKey: [...qk.contacts, "flat", { includeArchived }],
    queryFn: () =>
      apiFetch<ContactPage>(
        `/contacts?include_archived=${includeArchived}&limit=${CONTACTS_LIST_LIMIT}`,
      ),
  });
}

/** One category's slice of a contact's activity — money received (`in_minor`)
 * and spent (`out_minor`) with this contact under that category. Mirrors
 * `ContactCategoryBreakdown` (`api/src/pecunia/api/contacts.py`); a null
 * `category_id` is the "Uncategorized" bucket (`color: null`). */
export interface ContactCategoryBreakdown {
  category_id: string | null;
  name: string;
  color: string | null;
  in_minor: number;
  out_minor: number;
}

/** One currency's totals for a contact over the reporting window. Mirrors
 * `ContactOverviewCurrency` — money is integer minor units (§4), never summed
 * across currencies. */
export interface ContactOverviewCurrency {
  money_in_minor: number;
  money_out_minor: number;
  net_minor: number;
  transaction_count: number;
  by_category: ContactCategoryBreakdown[];
}

/** The per-currency overview envelope `GET /contacts/{id}/overview` returns —
 * `{currency: {...}}`, mirroring the `/analytics/*` per-currency shape. */
export type ContactOverview = Record<string, ContactOverviewCurrency>;

/** A single contact by id (`GET /contacts/{id}`) — powers `ContactDetail`'s
 * header, the read-side sibling of `useAccount`. Keyed `["contacts", id]`, so
 * it nests under the `qk.contacts` prefix every mutation invalidates. */
export function useContact(id: string | undefined) {
  return useQuery({
    queryKey: [...qk.contacts, id ?? ""],
    queryFn: () => apiFetch<ContactOut>(`/contacts/${id}`),
    enabled: id !== undefined,
  });
}

/** A contact's per-currency overview over a reporting `range` (money in/out/
 * net + count + a by-category breakdown), driven by `ContactDetail`'s period
 * selector. The `range` rides in the query key — a distinct cache slot per
 * window (3/6/12 months) that still nests under `qk.contacts` for
 * invalidation, exactly as `useAnalytics` keys its windows. */
export function useContactOverview(id: string | undefined, range?: AnalyticsRange) {
  return useQuery({
    queryKey: [...qk.contacts, id ?? "", "overview", range ?? null],
    queryFn: () => {
      const suffix = range ? `?from=${range.from}&to=${range.to}` : "";
      return apiFetch<ContactOverview>(`/contacts/${id}/overview${suffix}`);
    },
    enabled: id !== undefined,
  });
}

export function useCreateContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateContactPayload) =>
      apiFetch<ContactOut>("/contacts", { method: "POST", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.contacts });
    },
  });
}

export function useUpdateContact(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateContactPayload) =>
      apiFetch<ContactOut>(`/contacts/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.contacts });
    },
  });
}

/** Takes the contact id as the mutation's argument, same shape as
 * `useArchiveCategory` — fired from a management-screen row that already has
 * the id in hand. */
export function useArchiveContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/contacts/${id}/archive`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.contacts });
    },
  });
}
