import { useEffect, useMemo } from "react";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import { adjacencyGraphs, dictionary } from "@zxcvbn-ts/language-common";

export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4;

/**
 * `@zxcvbn-ts/core`'s dictionaries/keyboard-adjacency graphs never change at
 * runtime, so the `ZxcvbnFactory` is configured exactly once, at module
 * load, and shared by every `PasswordStrength` instance — never rebuilt per
 * render or per keystroke. `@zxcvbn-ts/language-common` supplies the
 * dictionary (common passwords/names/words) and adjacency graphs (keyboard
 * patterns like "qwerty"); no `translations` package is configured since
 * this component only reads the numeric `.score`, never the English
 * warning/suggestion feedback strings.
 */
const zxcvbn = new ZxcvbnFactory({
  dictionary: { ...dictionary },
  graphs: adjacencyGraphs,
});

function scoreOf(password: string): PasswordStrengthScore {
  if (!password) {
    return 0;
  }
  return zxcvbn.check(password).score;
}

const STRENGTH_LABEL: Record<PasswordStrengthScore, string> = {
  0: "Weak",
  1: "Weak",
  2: "Fair",
  3: "Good",
  4: "Strong",
};

export interface PasswordStrengthProps {
  password: string;
  /** Notifies the parent of the current zxcvbn score (0–4) on every change,
   * so a step can gate its own Continue action. */
  onScoreChange?: (score: PasswordStrengthScore) => void;
  className?: string;
}

/**
 * A shared password-strength meter: a single clean bar that widens and
 * fills in the white accent as the score rises (0–4 mapped to 0–100%) —
 * not a segmented traffic-light bar, and not a hand-drawn line. The textual
 * label lives in an `aria-live="polite"` region so screen-reader users get
 * the same signal sighted users get from the bar.
 */
function PasswordStrength({ password, onScoreChange, className }: PasswordStrengthProps) {
  const score = useMemo(() => scoreOf(password), [password]);

  useEffect(() => {
    onScoreChange?.(score);
    // `onScoreChange` is intentionally excluded: parents typically pass an
    // inline setter that isn't memoized, and re-invoking with the same
    // score on every parent render is harmless (a React state setter is a
    // no-op for an unchanged value) but re-running this effect on identity
    // churn alone would be noise, not a real score change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  const hasPassword = password.length > 0;
  const fillPercent = (score / 4) * 100;

  return (
    <div className={className}>
      <div className="h-1 w-full max-w-[220px] overflow-hidden rounded-full bg-ink-faint/20">
        <div
          data-password-fill
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-pc-out"
          style={{ width: `${fillPercent}%` }}
        />
      </div>
      <p role="status" aria-live="polite" className="mt-1 font-mono text-xs uppercase tracking-[0.15em] text-ink-2">
        {hasPassword ? STRENGTH_LABEL[score] : ""}
      </p>
    </div>
  );
}

export default PasswordStrength;
