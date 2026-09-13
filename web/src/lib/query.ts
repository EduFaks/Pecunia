import { QueryClient } from "@tanstack/react-query";

/**
 * The single `QueryClient` for the app, shared by every `useQuery`/
 * `useMutation` call (starting with `useSetupStatus` in `./setup.ts`).
 *
 * Defaults are deliberately conservative for a local-first, same-origin
 * app talking to its own backend: one retry (not TanStack's default three)
 * so a guard's loading state resolves quickly instead of stalling for
 * several backoff rounds, and no refetch-on-window-focus, since route
 * guards already refetch naturally on navigation/remount.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});
