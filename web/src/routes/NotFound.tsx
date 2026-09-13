import { Link } from "react-router-dom";

/** Catch-all for any path that doesn't match a real route. */
function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-ink-faint">404</p>
      <h1 className="font-display text-3xl text-ink">Page not found</h1>
      <Link to="/" className="mt-2 font-sans text-sm text-accent hover:text-accent-hover">
        Back to Pecunia
      </Link>
    </div>
  );
}

export default NotFound;
