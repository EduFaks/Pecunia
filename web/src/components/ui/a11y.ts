/**
 * White focus-visible ring, applied as an explicit class on every
 * interactive primitive in the kit.
 *
 * `styles/global.css` already sets a bare `:focus-visible` base rule (same
 * `--pc-focus` token) as a universal safety net for any element this kit
 * doesn't cover. This per-component class is the documented, testable
 * contract: it makes each primitive's focus treatment visible in its own
 * source and assertable in its own test, rather than relying on an
 * implicit, un-scoped global rule. `outline-none` first removes the
 * default (mouse-click) outline so only keyboard/`:focus-visible` focus
 * shows the ring.
 */
export const focusRingClass =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
