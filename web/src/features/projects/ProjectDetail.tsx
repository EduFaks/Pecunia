import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import DataList from "../../components/data/DataList";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { ApiError, apiFetch } from "../../lib/api";
import { MoneyText } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import TransactionPicker from "../transactions/TransactionPicker";
import type { TransactionOut } from "../transactions/useTransactions";
import FundingBar from "./FundingBar";
import ProjectForm from "./ProjectForm";
import ProjectItemForm from "./ProjectItemForm";
import { PROJECT_STATUS_LABELS, projectTypeLabels } from "./projectTypes";
import {
  useAttachItemTransaction,
  useDeleteProject,
  useDetachItemTransaction,
  useProject,
} from "./useProjects";
import type { ProjectItemOut, ProjectItemPage } from "./useProjects";

/** One walked page's size for this project's items `DataList`. */
const PAGE_LIMIT = 20;

/** A single project part: its planned estimate, and either a "mark bought"
 * affordance (pick an existing transaction to attach — `TransactionPicker`)
 * or, once bought, the realized amount and a "Detach". Extracted into its own
 * component (not an inline `renderRow`) so each row can hold the attach/detach
 * mutation hooks and its own edit/attach mode without the parent tracking a
 * per-row id. */
function ProjectItemRow({
  item,
  projectId,
  currency,
}: {
  item: ProjectItemOut;
  projectId: string;
  currency: string;
}) {
  const { showToast } = useToast();
  const [mode, setMode] = useState<"view" | "edit" | "attach">("view");
  const attach = useAttachItemTransaction(projectId, item.id);
  const detach = useDetachItemTransaction(projectId, item.id);

  const isBought = item.transaction_id !== null;

  async function handleAttach(transaction: TransactionOut) {
    try {
      await attach.mutateAsync(transaction.id);
      setMode("view");
      showToast("Marked bought.", { variant: "positive" });
    } catch (error) {
      if (error instanceof ApiError && error.detail === "TRANSACTION_ALREADY_ATTACHED") {
        showToast("That transaction already fulfills another part.", { variant: "negative" });
      } else {
        showToast("Couldn't attach that transaction. Please try again.", { variant: "negative" });
      }
    }
  }

  async function handleDetach() {
    try {
      await detach.mutateAsync();
      showToast("Marked not bought.", { variant: "positive" });
    } catch {
      showToast("Couldn't detach that transaction. Please try again.", { variant: "negative" });
    }
  }

  if (mode === "edit") {
    return (
      <div className="py-3">
        <ProjectItemForm
          projectId={projectId}
          currency={currency}
          item={item}
          onCancel={() => setMode("view")}
          onSuccess={() => {
            setMode("view");
            showToast("Part updated.", { variant: "positive" });
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm text-ink">{item.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {isBought ? (
            <span className="flex items-center gap-1.5">
              <span className="text-xs text-ink-faint">bought</span>
              <MoneyText minor={item.actual_minor ?? 0} currency={currency} />
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="text-xs text-ink-faint">planned</span>
              <MoneyText minor={item.amount_minor} currency={currency} />
            </span>
          )}
          {isBought ? (
            <Button variant="ghost" size="sm" loading={detach.isPending} onClick={() => void handleDetach()}>
              Detach
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMode((current) => (current === "attach" ? "view" : "attach"))}
            >
              {mode === "attach" ? "Cancel" : "Attach transaction"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setMode("edit")}>
            Edit
          </Button>
        </div>
      </div>

      {mode === "attach" ? (
        <TransactionPicker onSelect={(transaction) => void handleAttach(transaction)} />
      ) : null}
    </div>
  );
}

/**
 * `/projects/:id` — one project's detail: header (name, status), the
 * **planned vs actual vs target** picture (`FundingBar` draws actual against
 * target with type-aware vocabulary and the over-budget switch; a caption
 * carries the planned total), an "Add item" panel, and the parts `DataList`
 * where each part can be **marked bought** (attach an existing transaction)
 * or detached. Inline edit/delete for the project itself.
 */
function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const projectQuery = useProject(id);
  const deleteProject = useDeleteProject();

  function fetchPage(cursor: string | null) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return apiFetch<ProjectItemPage>(`/projects/${id}/items?${params.toString()}`);
  }

  async function handleDelete() {
    if (!id) {
      return;
    }
    try {
      await deleteProject.mutateAsync(id);
      showToast("Project deleted.");
      navigate("/projects");
    } catch {
      showToast("Couldn't delete this project. Please try again.", { variant: "negative" });
    } finally {
      setConfirmingDelete(false);
    }
  }

  if (projectQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading project" />
      </div>
    );
  }

  if (projectQuery.isError || !projectQuery.data) {
    return <Callout variant="negative">Couldn't load this project.</Callout>;
  }

  const project = projectQuery.data;
  const labels = projectTypeLabels(project.type);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
            {PROJECT_STATUS_LABELS[project.status] ?? project.status}
          </p>
          <h1 className="mt-1 font-display text-2xl text-ink">{project.name}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setIsEditing((editing) => !editing)}>
            {isEditing ? "Cancel" : "Edit"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={deleteProject.isPending}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      {confirmingDelete ? (
        <ConfirmDialog
          title={`Delete "${project.name}"?`}
          description="This permanently deletes the project and its items. This can't be undone."
          confirmLabel="Delete project"
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmingDelete(false)}
          isConfirming={deleteProject.isPending}
        />
      ) : null}

      <div className="flex flex-col gap-3">
        <FundingBar
          actualMinor={project.actual_minor}
          targetAmountMinor={project.target_amount_minor}
          type={project.type}
          currency={project.currency}
        />
        <p className="flex items-center gap-1.5 text-sm">
          <span className="text-xs text-ink-faint">Planned</span>
          <MoneyText minor={project.planned_minor} currency={project.currency} />
          <span className="text-xs text-ink-faint">
            across this project's parts · {labels.actual.toLowerCase()} so far{" "}
          </span>
          <MoneyText minor={project.actual_minor} currency={project.currency} />
        </p>
      </div>

      {isEditing ? (
        <Card>
          <h2 className="font-display text-lg text-ink">Edit project</h2>
          <div className="mt-4">
            <ProjectForm
              project={project}
              onCancel={() => setIsEditing(false)}
              onSuccess={() => {
                setIsEditing(false);
                showToast("Project updated.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
        <h2 className="font-display text-lg text-ink">Add part</h2>
        <div className="mt-4">
          <ProjectItemForm
            projectId={project.id}
            currency={project.currency}
            onSuccess={() => showToast("Part added.", { variant: "positive" })}
          />
        </div>
      </div>

      <div>
        <h2 className="font-display text-lg text-ink">Parts</h2>
        <DataList<ProjectItemOut>
          className="mt-4"
          queryKey={qk.projectItems(project.id)}
          fetchPage={fetchPage}
          empty={<EmptyState title="No parts yet" body="Add this project's first part above." />}
          renderRow={(item) => (
            <ProjectItemRow item={item} projectId={project.id} currency={project.currency} />
          )}
        />
      </div>
    </div>
  );
}

export default ProjectDetail;
