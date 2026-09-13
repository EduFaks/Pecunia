import type { SemanticVariant } from "./semanticVariants";

/** Small line-icon per semantic variant, used by `Callout` and `Toast`. */
function VariantIcon({ variant }: { variant: SemanticVariant }) {
  switch (variant) {
    case "positive":
      return (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M5.3 8.2 L7.2 10.1 L10.7 6.1"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "negative":
      return (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
          <path
            d="M8 2.3 L14.2 12.8 H1.8 Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <line x1="8" y1="6.6" x2="8" y2="9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="11.3" r="0.9" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
          <line x1="8" y1="7.2" x2="8" y2="11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="5.1" r="0.9" fill="currentColor" />
        </svg>
      );
  }
}

export default VariantIcon;
