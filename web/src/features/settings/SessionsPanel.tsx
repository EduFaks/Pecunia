import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Pill from "../../components/ui/Pill";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { DateText } from "../../lib/preferences";
import { qk } from "../../lib/queries";

/** Mirrors `SessionOut` (`api/src/pecunia/api/auth.py`) — `id` is the
 * session family id, the stable identity across refresh-token rotations. */
export interface SessionOut {
  id: string;
  client: string;
  device_label: string | null;
  created_at: string;
  last_active: string;
  current: boolean;
}

/**
 * Settings → Security → Sessions: every active session family for this
 * user (`GET /auth/sessions` — a plain array, not keyset-paginated, so this
 * is an ordinary `useQuery`, not `DataList`/`DayGroupedList`). Each
 * non-current row gets a **Revoke** (`DELETE /auth/sessions/{id}`, refetches
 * on success); the current session is labeled instead of offered a Revoke
 * button, since revoking it would just be a slower way to do what **Log out
 * everywhere** already does on purpose — end every session, including this
 * tab's (`useAuth().logoutAll()`, which clears local auth state and routes
 * the app to `/login`).
 */
function SessionsPanel() {
  const { logoutAll } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<SessionOut | null>(null);

  const sessionsQuery = useQuery({
    queryKey: qk.sessions,
    queryFn: () => apiFetch<SessionOut[]>("/auth/sessions"),
  });

  const revokeSession = useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/auth/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.sessions });
    },
  });

  async function handleRevoke(id: string) {
    try {
      await revokeSession.mutateAsync(id);
      showToast("Session revoked.");
    } catch {
      showToast("Couldn't revoke that session. Please try again.", { variant: "negative" });
    } finally {
      setConfirmTarget(null);
    }
  }

  async function handleLogoutAll() {
    setLoggingOutAll(true);
    try {
      await logoutAll();
    } finally {
      // Only reachable if `logoutAll` somehow leaves this component mounted
      // (it never should — it clears auth and the app routes to /login) —
      // guards against a stuck spinner rather than expecting to run.
      setLoggingOutAll(false);
    }
  }

  if (sessionsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner label="Loading sessions" />
      </div>
    );
  }

  if (sessionsQuery.isError) {
    return <Callout variant="negative">Couldn't load your sessions. Try again.</Callout>;
  }

  const sessions = sessionsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-display text-lg text-ink">Sessions</h2>
        <Button variant="ghost" size="sm" loading={loggingOutAll} onClick={() => void handleLogoutAll()}>
          Log out everywhere
        </Button>
      </div>

      {sessions.length === 0 ? (
        <EmptyState title="No active sessions" body="You aren't signed in anywhere right now." />
      ) : (
        <ul className="divide-y divide-hairline rounded-pc-lg border border-hairline bg-surface-1">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm text-ink">
                  <span className="truncate">{session.device_label ?? "Unknown device"}</span>
                  <span className="font-mono text-xs text-ink-faint">· {session.client}</span>
                  {/* Neutral, not emerald: "current" is an identifying fact
                   * about this row, not a value judgment — CONVENTIONS §9.1
                   * reserves emerald/coral for genuine value movement/semantic
                   * status (a target reached, a gain), not decoration. */}
                  {session.current ? <Pill tone="neutral">Current session</Pill> : null}
                </p>
                <p className="mt-1 font-mono text-xs text-ink-faint">
                  Last active <DateText iso={session.last_active} />
                </p>
              </div>
              {session.current ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={revokeSession.isPending && confirmTarget?.id === session.id}
                  onClick={() => setConfirmTarget(session)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirmTarget ? (
        <ConfirmDialog
          title={`Revoke "${confirmTarget.device_label ?? "Unknown device"}"?`}
          description="This immediately signs that device out. It will need to log in again."
          confirmLabel="Revoke session"
          onConfirm={() => void handleRevoke(confirmTarget.id)}
          onCancel={() => setConfirmTarget(null)}
          isConfirming={revokeSession.isPending}
        />
      ) : null}
    </div>
  );
}

export default SessionsPanel;
