import { useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "../../components/ui/Avatar";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import Checkbox from "../../components/ui/Checkbox";
import Pill from "../../components/ui/Pill";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import EmptyState from "../../components/data/EmptyState";
import CategoryBadge from "../categories/CategoryBadge";
import { useCategories } from "../categories/useCategories";
import ContactForm from "./ContactForm";
import { useArchiveContact, useContacts } from "./useContacts";
import type { ContactOut } from "./useContacts";

type FormState = { mode: "create" } | { mode: "edit"; contact: ContactOut };

const TYPE_LABEL: Record<ContactOut["type"], string> = {
  person: "Person",
  company: "Company",
};

/**
 * `/contacts` — the top-level Contacts management screen (formerly a Settings
 * panel): create/edit/archive the parties on transactions. Reads
 * `useContacts`'s bounded flat list (a workspace's contacts are a small,
 * user-managed set — see that hook's docstring) rather than a keyset-paginated
 * `DataList`, exactly as `CategoriesPanel` does. Each row shows the contact's
 * `Avatar`, name, person/company type, and default category (resolved via
 * `useCategories`) so its create-time convenience is visible at a glance.
 * Archiving is the only removal (no delete) — `ON DELETE SET NULL` protects a
 * contact's transactions on the backend, but archiving is the front-door
 * action here.
 */
function ContactsScreen() {
  const { showToast } = useToast();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [formState, setFormState] = useState<FormState | null>(null);
  const contactsQuery = useContacts(includeArchived);
  const archiveContact = useArchiveContact();

  // Archived categories included so a contact whose default category was later
  // archived still resolves its badge — same rationale as the pickers.
  const categoriesQuery = useCategories(true);
  const categories = categoriesQuery.data?.items ?? [];
  const categoryFor = (categoryId: string | null) =>
    categories.find((category) => category.id === categoryId) ?? null;

  const contacts = contactsQuery.data?.items ?? [];

  async function handleArchive(contact: ContactOut) {
    try {
      await archiveContact.mutateAsync(contact.id);
      showToast(`"${contact.name}" archived.`);
    } catch {
      showToast("Couldn't archive that contact. Please try again.", { variant: "negative" });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Contacts</h1>
        <Button onClick={() => setFormState({ mode: "create" })}>New contact</Button>
      </div>

      {formState ? (
        <Card>
          <h2 className="font-display text-lg text-ink">
            {formState.mode === "edit" ? "Edit contact" : "New contact"}
          </h2>
          <div className="mt-4">
            <ContactForm
              contact={formState.mode === "edit" ? formState.contact : undefined}
              onCancel={() => setFormState(null)}
              onSuccess={() => {
                const wasEdit = formState.mode === "edit";
                setFormState(null);
                showToast(wasEdit ? "Contact updated." : "Contact created.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      <Checkbox
        label="Show archived contacts"
        checked={includeArchived}
        onChange={(event) => setIncludeArchived(event.target.checked)}
      />

      {contactsQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner label="Loading contacts" />
        </div>
      ) : contacts.length === 0 ? (
        <EmptyState
          title="No contacts yet"
          body="Add the people and companies you transact with — a shop, your landlord, an employer — to attach them to transactions."
          action={<Button onClick={() => setFormState({ mode: "create" })}>Add a contact</Button>}
        />
      ) : (
        <ul className="divide-y divide-hairline rounded-pc-lg border border-hairline">
          {contacts.map((contact) => {
            const defaultCategory = categoryFor(contact.default_category_id);
            return (
              <li key={contact.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <Link to={`/contacts/${contact.id}`} className="flex min-w-0 items-center gap-3">
                  <Avatar src={contact.avatar} name={contact.name} type={contact.type} />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-sm text-ink hover:text-accent">{contact.name}</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill>{TYPE_LABEL[contact.type]}</Pill>
                      {defaultCategory ? <CategoryBadge category={defaultCategory} /> : null}
                      {contact.archived_at ? <Pill>Archived</Pill> : null}
                    </div>
                  </div>
                </Link>
                <div className="flex shrink-0 items-center gap-3">
                  <Button variant="ghost" size="sm" onClick={() => setFormState({ mode: "edit", contact })}>
                    Edit
                  </Button>
                  {!contact.archived_at ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={archiveContact.isPending}
                      onClick={() => void handleArchive(contact)}
                    >
                      Archive
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default ContactsScreen;
