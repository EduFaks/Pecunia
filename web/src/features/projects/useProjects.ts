/**
 * Query/mutation hooks for the `/projects` resource and its nested
 * `/projects/{id}/items` sub-resource. Same shape as `features/assets/
 * useAssets.ts`: every mutation invalidates the single top-level
 * `qk.projects` key, which — via TanStack Query's partial-match
 * invalidation — also covers every `qk.project(id)` detail and every
 * `qk.projectItems(id)` items list currently mounted.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import type { ProjectType } from "./projectTypes";

/** Mirrors `ProjectStatus` (`api/src/pecunia/models/project.py`). */
export type ProjectStatus = "active" | "completed" | "archived";

/** Mirrors `ProjectOut` (`api/src/pecunia/api/projects.py`). Both money
 * figures are server-computed, never derived client-side:
 *   - `planned_minor` = Σ of the project's part estimates (the *plan*);
 *   - `actual_minor` = Σ ABS(transactions linked to the project) (the
 *     *realized* funding).
 * `actual_minor` vs `target_amount_minor` is what `FundingBar` draws.
 * (`funded_minor` — the old Σ-items figure — is gone; the plan is now
 * `planned_minor`, and funding is the separate `actual_minor`.) */
export interface ProjectOut {
  id: string;
  name: string;
  description: string | null;
  target_amount_minor: number | null;
  currency: string;
  status: ProjectStatus;
  type: ProjectType;
  planned_minor: number;
  actual_minor: number;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectPage {
  items: ProjectOut[];
  next_cursor: string | null;
}

/** Mirrors `ProjectIn`. */
export interface CreateProjectPayload {
  name: string;
  description?: string | null;
  target_amount_minor?: number | null;
  currency: string;
  status?: ProjectStatus;
  type?: ProjectType;
}

/** Mirrors `ProjectUpdate` — every field optional, only what changed is sent. */
export interface UpdateProjectPayload {
  name?: string;
  description?: string | null;
  target_amount_minor?: number | null;
  currency?: string;
  status?: ProjectStatus;
  type?: ProjectType;
}

/** Mirrors `ProjectItemOut`. A part is *bought* once `transaction_id` is set
 * (a real transaction fulfills it); `actual_minor` is that transaction's
 * magnitude, and `null` while the part is still just planned. */
export interface ProjectItemOut {
  id: string;
  project_id: string;
  transaction_id: string | null;
  name: string;
  amount_minor: number;
  actual_minor: number | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectItemPage {
  items: ProjectItemOut[];
  next_cursor: string | null;
}

/** Mirrors `ProjectItemIn`. */
export interface CreateProjectItemPayload {
  name: string;
  amount_minor: number;
}

/** Mirrors `ProjectItemUpdate`. */
export interface UpdateProjectItemPayload {
  name?: string;
  amount_minor?: number;
}

/** A single project by id, including its live `planned_minor`/`actual_minor`
 * — disabled while `id` is undefined, same pattern as `useAccount`/`useAsset`. */
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: qk.project(id ?? ""),
    queryFn: () => apiFetch<ProjectOut>(`/projects/${id}`),
    enabled: id !== undefined,
  });
}

/** Comfortably covers a personal workspace's project list in one request —
 * same rationale/limit as `useContacts`'s bounded read. */
const PROJECTS_LIST_LIMIT = 200;

/** A bounded flat page of the workspace's projects, powering
 * `TransactionForm`'s `ProjectPicker` (link a transaction to a project) — the
 * same self-contained read `useContacts` gives `ContactPicker`. Keyed with a
 * `"flat"` suffix (`["projects", "flat"]`) so it never collides with the
 * `useInfiniteQuery` list `ProjectsScreen` mounts under the bare `qk.projects`
 * prefix, while every project mutation still invalidates that prefix and
 * refreshes this list via TanStack Query's partial match. */
export function useProjectList() {
  return useQuery({
    queryKey: [...qk.projects, "flat"],
    queryFn: () => apiFetch<ProjectPage>(`/projects?limit=${PROJECTS_LIST_LIMIT}`),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateProjectPayload) =>
      apiFetch<ProjectOut>("/projects", { method: "POST", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projects });
    },
  });
}

export function useUpdateProject(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateProjectPayload) =>
      apiFetch<ProjectOut>(`/projects/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projects });
    },
  });
}

/** Hard delete (`DELETE /projects/{id}` → 204, cascades to its items).
 * Takes the project id as the mutation argument. */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projects });
    },
  });
}

/** `POST /projects/{id}/items` — adding a part moves the project's
 * server-computed `planned_minor` (Σ parts), so this invalidates the same
 * `qk.projects` prefix as every other project mutation. */
export function useAddProjectItem(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateProjectItemPayload) =>
      apiFetch<ProjectItemOut>(`/projects/${projectId}/items`, { method: "POST", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projects });
    },
  });
}

/** `PATCH /projects/{id}/items/{item_id}` — same planned-total rationale as
 * `useAddProjectItem`. There is no delete-item endpoint (backend only
 * exposes create/list/update for items), so no `useDeleteProjectItem`
 * exists here. */
export function useUpdateProjectItem(projectId: string, itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateProjectItemPayload) =>
      apiFetch<ProjectItemOut>(`/projects/${projectId}/items/${itemId}`, {
        method: "PATCH",
        json: payload,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projects });
    },
  });
}

/** Attach/detach both touch two independent cache prefixes, so unlike the
 * project-only mutations above they invalidate `qk.transactions()` as well
 * as `qk.projects`:
 *   - `qk.projects` covers the project detail (its `actual_minor` moves as
 *     the linked transaction is counted/uncounted) *and* its items list
 *     (`qk.projectItems(id)` nests under it — the part flips bought/planned);
 *   - `qk.transactions()` because attach sets the transaction's `project_id`
 *     (and marking it bought is the one place a transaction gains a project
 *     link without going through `TransactionForm`), so every transactions
 *     list must re-read to show the new linkage. */
function invalidateProjectsAndTransactions(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: qk.projects });
  void queryClient.invalidateQueries({ queryKey: qk.transactions() });
}

/** `POST /projects/{id}/items/{item_id}/attach` — marks a part *bought* by
 * linking an existing transaction to it (the backend also stamps that
 * transaction's `project_id`). Rejects with `TRANSACTION_ALREADY_ATTACHED`
 * (409) if the transaction already fulfills another part, or
 * `TRANSACTION_NOT_FOUND` (404) if it isn't this workspace's. */
export function useAttachItemTransaction(projectId: string, itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (transactionId: string) =>
      apiFetch<ProjectItemOut>(`/projects/${projectId}/items/${itemId}/attach`, {
        method: "POST",
        json: { transaction_id: transactionId },
      }),
    onSuccess: () => invalidateProjectsAndTransactions(queryClient),
  });
}

/** `POST /projects/{id}/items/{item_id}/detach` — un-marks a part
 * (clears its `transaction_id`). The transaction stays linked to the project
 * (`project_id` is left as-is, per the service's documented choice). */
export function useDetachItemTransaction(projectId: string, itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ProjectItemOut>(`/projects/${projectId}/items/${itemId}/detach`, { method: "POST" }),
    onSuccess: () => invalidateProjectsAndTransactions(queryClient),
  });
}
