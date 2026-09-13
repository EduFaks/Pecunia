import Avatar from "../../components/ui/Avatar";
import { cn } from "../../lib/cn";
import type { ContactOut } from "./useContacts";

export interface ContactBadgeProps {
  /** `null`/`undefined` renders nothing — a contact is optional on a
   * transaction, so an absent one shouldn't add a placeholder the way
   * `CategoryBadge`'s "Uncategorized" does (a category is conceptually always
   * present, even if unset; a contact simply may not apply). Only `name` is
   * required, so a caller can pass a plain `{name}`; `avatar`/`type` are used
   * for the small `Avatar` when present. */
  contact?: (Pick<ContactOut, "name"> & Partial<Pick<ContactOut, "avatar" | "type">>) | null;
  className?: string;
}

/**
 * Compact label for a transaction's contact in a list row: a small `Avatar`
 * (the uploaded image, or a monogram fallback) followed by the name in the
 * same muted treatment the row's other metadata uses (`text-ink-2`). Unlike
 * `CategoryBadge` there is no color dot — a contact has no palette (see
 * `useContacts`'s `ContactOut`); the avatar carries the visual identity.
 */
function ContactBadge({ contact, className }: ContactBadgeProps) {
  if (!contact) {
    return null;
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-ink-2", className)}>
      <Avatar src={contact.avatar ?? null} name={contact.name} type={contact.type} size="sm" />
      <span className="font-mono">{contact.name}</span>
    </span>
  );
}

export default ContactBadge;
