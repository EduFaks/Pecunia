import { forwardRef } from "react";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type SurfaceLevel = 1 | 2 | 3;
export type SurfaceShadow = "none" | "sm" | "lg";

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /** Elevation step: 1 = cards, 2 = raised cards/popovers, 3 = overlays/menus. */
  level?: SurfaceLevel;
  shadow?: SurfaceShadow;
}

const LEVEL_CLASSES: Record<SurfaceLevel, string> = {
  1: "bg-surface-1",
  2: "bg-surface-2",
  3: "bg-surface-3",
};

const SHADOW_CLASSES: Record<SurfaceShadow, string> = {
  none: "",
  sm: "shadow-pc-1",
  lg: "shadow-pc-2",
};

/**
 * The elevation primitive: a graphite ground (one of three `--pc-surface-*`
 * steps) plus a hairline border and an optional restrained shadow. `Card`
 * is `Surface` with sensible padding defaults for a self-contained content
 * block; bare `Surface` is for anything else that needs a raised ground
 * (a table wrapper, a popover shell) without dictating spacing.
 */
const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { level = 1, shadow = "none", className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-pc-lg border border-hairline",
        LEVEL_CLASSES[level],
        SHADOW_CLASSES[shadow],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});

export default Surface;
