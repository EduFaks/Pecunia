import { useState } from "react";
import { Link } from "react-router-dom";
import DataList from "../../components/data/DataList";
import EmptyState from "../../components/data/EmptyState";
import Pill from "../../components/ui/Pill";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import { useToast } from "../../components/ui/Toast";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import FundingBar from "./FundingBar";
import ProjectForm from "./ProjectForm";
import { PROJECT_STATUS_LABELS } from "./projectTypes";
import type { ProjectOut, ProjectPage } from "./useProjects";

/** One walked page's size for the projects `DataList`. */
const PAGE_LIMIT = 20;

type FormState = { mode: "create" } | { mode: "edit"; project: ProjectOut };

/**
 * `/projects` — the projects list: name, a status `Pill`, and a funding
 * progress bar (`FundingBar`, white-accent fill — actual/target). `DataList` owns
 * the keyset walk (`GET /projects?cursor=&limit=`).
 */
function ProjectsScreen() {
  const { showToast } = useToast();
  const [formState, setFormState] = useState<FormState | null>(null);

  function fetchPage(cursor: string | null) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return apiFetch<ProjectPage>(`/projects?${params.toString()}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Projects</h1>
        <Button onClick={() => setFormState({ mode: "create" })}>New project</Button>
      </div>

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {formState.mode === "edit" ? "Edit project" : "New project"}
          </h2>
          <div className="mt-4">
            <ProjectForm
              project={formState.mode === "edit" ? formState.project : undefined}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Project updated." : "Project created.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      <DataList<ProjectOut>
        queryKey={qk.projects}
        fetchPage={fetchPage}
        empty={
          <EmptyState
            title="No projects yet"
            body="Add your first project to start tracking its funding progress."
            action={
              <Button onClick={() => setFormState({ mode: "create" })}>Add your first project</Button>
            }
          />
        }
        renderRow={(project) => (
          <div className="flex flex-col gap-2 py-3">
            <div className="flex items-center justify-between gap-4">
              <Link to={`/projects/${project.id}`} className="min-w-0">
                <p className="truncate font-sans text-sm text-ink hover:text-accent">{project.name}</p>
              </Link>
              <div className="flex shrink-0 items-center gap-3">
                <Pill>{PROJECT_STATUS_LABELS[project.status] ?? project.status}</Pill>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFormState({ mode: "edit", project })}
                >
                  Edit
                </Button>
              </div>
            </div>
            <FundingBar
              actualMinor={project.actual_minor}
              targetAmountMinor={project.target_amount_minor}
              type={project.type}
              currency={project.currency}
            />
          </div>
        )}
      />
    </div>
  );
}

export default ProjectsScreen;
