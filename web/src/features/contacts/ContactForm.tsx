import { useState } from "react";
import type { FormEvent } from "react";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import ImageUpload from "../../components/ui/ImageUpload";
import TextField from "../../components/ui/TextField";
import { focusRingClass } from "../../components/ui/a11y";
import { FieldLabel } from "../../components/ui/Field";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import CategoryPicker from "../categories/CategoryPicker";
import { useCreateContact, useUpdateContact } from "./useContacts";
import type { ContactOut, ContactType } from "./useContacts";

export interface ContactFormProps {
  /** Presence switches the form into edit mode (PATCH, prefilled fields).
   * Absence is create mode (POST). */
  contact?: ContactOut;
  onSuccess: (contact: ContactOut) => void;
  onCancel?: () => void;
}

/** Error → copy map (CONVENTIONS §9.6). `AVATAR_INVALID` (422) is the one the
 * user can actually act on — the image was rejected (wrong type or too big),
 * so it gets its own message. `DEFAULT_CATEGORY_NOT_FOUND` shouldn't be
 * reachable (the `CategoryPicker` only offers this workspace's categories), so
 * anything else falls back to a generic message. */
function contactErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.detail === "AVATAR_INVALID") {
    return "That image couldn't be saved. Please try a smaller one (PNG, JPEG, or WebP under 64KB).";
  }
  return "Couldn't save this contact. Please try again.";
}

const TYPE_OPTIONS: { value: ContactType; label: string }[] = [
  { value: "company", label: "Company" },
  { value: "person", label: "Person" },
];

/**
 * Create/edit form for one contact: a name, a person/company toggle, an
 * optional default category (reusing `CategoryPicker`, whose "Uncategorized"
 * option means "no default"), and an optional avatar (`ImageUpload`, which
 * downscales + caps the image to a `data:` URI). The `ContactsScreen`'s "New
 * contact"/"Edit" body.
 */
function ContactForm({ contact, onSuccess, onCancel }: ContactFormProps) {
  const isEdit = contact !== undefined;

  const [name, setName] = useState(contact?.name ?? "");
  const [type, setType] = useState<ContactType>(contact?.type ?? "company");
  const [defaultCategoryId, setDefaultCategoryId] = useState(contact?.default_category_id ?? "");
  const [avatar, setAvatar] = useState<string | null>(contact?.avatar ?? null);
  const [error, setError] = useState<string | null>(null);

  const createContact = useCreateContact();
  const updateContact = useUpdateContact(contact?.id ?? "");
  const isSubmitting = createContact.isPending || updateContact.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setError(null);

    try {
      if (isEdit) {
        const updated = await updateContact.mutateAsync({
          name: trimmedName,
          type,
          avatar,
          default_category_id: defaultCategoryId || null,
        });
        onSuccess(updated);
        return;
      }
      const created = await createContact.mutateAsync({
        name: trimmedName,
        type,
        avatar,
        ...(defaultCategoryId ? { default_category_id: defaultCategoryId } : {}),
      });
      onSuccess(created);
    } catch (err) {
      setError(contactErrorMessage(err));
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Name"
        placeholder="e.g. Grocery Store"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="contact-form-type">Type</FieldLabel>
        <div
          id="contact-form-type"
          role="group"
          aria-label="Type"
          className="inline-flex w-fit rounded-pc border border-hairline p-0.5"
        >
          {TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={type === option.value}
              onClick={() => setType(option.value)}
              className={cn(
                "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
                type === option.value
                  ? "bg-accent-soft text-ink"
                  : "text-ink-2 hover:text-ink",
                focusRingClass,
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <CategoryPicker
        label="Default category"
        value={defaultCategoryId}
        onChange={setDefaultCategoryId}
      />

      <ImageUpload label="Avatar" value={avatar} onChange={setAvatar} />

      {error ? <Callout variant="negative">{error}</Callout> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={isSubmitting} disabled={!name.trim()}>
          {isEdit ? "Save changes" : "Create contact"}
        </Button>
      </div>
    </form>
  );
}

export default ContactForm;
