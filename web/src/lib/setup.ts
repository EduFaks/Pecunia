import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./api";

interface SetupStatusResponse {
  initialized: boolean;
}

export interface UseSetupStatusResult {
  /** `undefined` only while `isLoading` is true (no response yet). */
  initialized: boolean | undefined;
  isLoading: boolean;
  /** `true` when the query has failed (network error, non-2xx). `RequireSetup`
   * renders a retry state rather than falling through to the app/wizard. */
  isError: boolean;
  /** Re-runs the query — wired to the retry action `RequireSetup` renders on `isError`. */
  refetch: () => void;
}

/**
 * Queries `GET /setup/status` — unauthenticated, since an instance with no
 * owner yet has no one to authenticate as. `RequireSetup` (./guards.tsx)
 * gates the entire route tree on this.
 */
export function useSetupStatus(): UseSetupStatusResult {
  const query = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => apiFetch<SetupStatusResponse>("/setup/status"),
  });

  return {
    initialized: query.data?.initialized,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
