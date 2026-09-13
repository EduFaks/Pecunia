import { forwardRef } from "react";
import { cn } from "../../lib/cn";
import Surface from "./Surface";
import type { SurfaceProps } from "./Surface";

export type CardProps = SurfaceProps;

/** `Surface` with the padding and elevation a self-contained content block
 * (a login panel, a summary tile) wants by default. Override `level`/
 * `shadow` per use; the padding stays put — drop to bare `Surface` if a
 * caller needs to own its own spacing entirely. */
const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { level = 1, shadow = "lg", className, children, ...rest },
  ref,
) {
  return (
    <Surface ref={ref} level={level} shadow={shadow} className={cn("p-6 sm:p-8", className)} {...rest}>
      {children}
    </Surface>
  );
});

export default Card;
