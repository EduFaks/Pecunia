import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8480",
        // NOT `changeOrigin: true` — this is a plain local dev proxy, not a
        // virtual-hosting one, and `changeOrigin` rewrites the outgoing
        // request's `Host` header to the target's, which breaks the API's
        // `check_origin` CSRF guard (auth.py): the browser's `Origin` header
        // (the dev server's own origin, e.g. `localhost:5173`) would then
        // disagree with the rewritten `Host` (`localhost:8480`), and every
        // credential endpoint (`/setup/initialize`, `/auth/login`,
        // `/auth/refresh`) would 403 `ORIGIN_MISMATCH` — found by Task 5's
        // real-browser-against-a-real-API e2e run, invisible to the mocked
        // unit suite. Leaving `changeOrigin` unset keeps the original Host
        // header intact, so it matches Origin and the guard passes.
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./vitest.setup.ts",
    globals: true,
    // Unit tests are co-located under src/ (CONVENTIONS §9.3); `e2e/` holds
    // Playwright specs run via `npm run e2e`, not Vitest — without this
    // exclude, Vitest's default glob also picks up `e2e/*.spec.ts`, whose
    // `@playwright/test` `test`/`expect` collide with Vitest's own globals.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
