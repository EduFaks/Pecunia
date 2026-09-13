import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../../lib/api";
import type { ContactOut } from "../contacts/useContacts";
import SubscriptionForm from "./SubscriptionForm";
import type { SubscriptionOut } from "./useSubscriptions";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const ALICE: ContactOut = {
  id: "contact-alice",
  name: "Alice Streaming",
  default_category_id: null,
  type: "company",
  avatar: null,
  archived_at: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
};

const NETFLIX: SubscriptionOut = {
  id: "s-netflix",
  name: "Netflix",
  logo: "data:image/png;base64,AAAA",
  amount_minor: 1599,
  currency: "USD",
  billing_frequency: "monthly",
  next_renewal: "2026-10-01",
  started_on: "2025-01-01",
  status: "active",
  contact_id: null,
  account_id: null,
  category_id: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  monthly_minor: 1599,
  annual_minor: 19188,
};

/** Serves the picker/select reads (`/contacts`, `/categories`, `/accounts`)
 * from fixed lists and routes writes through `onWrite`. */
function installBackend(
  contacts: ContactOut[],
  onWrite?: (path: string, opts?: { method?: string; json?: unknown }) => unknown,
) {
  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      if (path.startsWith("/contacts?")) {
        return Promise.resolve({ items: contacts, next_cursor: null });
      }
      if (path.startsWith("/categories?")) {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      if (path.startsWith("/accounts?")) {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      if (onWrite) {
        try {
          return Promise.resolve(onWrite(path, opts));
        } catch (err) {
          return Promise.reject(err);
        }
      }
      const body = (opts?.json ?? {}) as Partial<SubscriptionOut>;
      return Promise.resolve({ ...NETFLIX, ...body, id: "s-new" } satisfies SubscriptionOut);
    });
}

function renderForm(props: Partial<React.ComponentProps<typeof SubscriptionForm>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SubscriptionForm onSuccess={props.onSuccess ?? (() => {})} defaultCurrency="USD" {...props} />
    </QueryClientProvider>,
  );
}

describe("SubscriptionForm", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("creates a subscription with name, amount, frequency, and next renewal", async () => {
    installBackend([]);
    const onSuccess = vi.fn();
    renderForm({ onSuccess });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Netflix" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "15.99" } });
    fireEvent.change(screen.getByLabelText("Billing frequency"), { target: { value: "monthly" } });
    fireEvent.change(screen.getByLabelText("Next renewal"), { target: { value: "2026-10-01" } });

    fireEvent.click(screen.getByRole("button", { name: /create subscription/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/subscriptions", {
        method: "POST",
        json: {
          name: "Netflix",
          amount_minor: 1599,
          currency: "USD",
          billing_frequency: "monthly",
          next_renewal: "2026-10-01",
          status: "active",
        },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it("includes the linked contact when one is picked", async () => {
    installBackend([ALICE]);
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Netflix" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "15.99" } });
    fireEvent.change(screen.getByLabelText("Next renewal"), { target: { value: "2026-10-01" } });

    // Pick the vendor contact through the reused ContactPicker.
    fireEvent.focus(screen.getByLabelText("Contact"));
    fireEvent.click(await screen.findByRole("option", { name: /alice streaming/i }));

    fireEvent.click(screen.getByRole("button", { name: /create subscription/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/subscriptions",
        expect.objectContaining({
          method: "POST",
          json: expect.objectContaining({ name: "Netflix", contact_id: "contact-alice" }),
        }),
      ),
    );
  });

  it("shows the current logo and round-trips it through ImageUpload on edit", async () => {
    installBackend([]);
    renderForm({ subscription: NETFLIX });

    // ImageUpload renders the current data-URI as its preview image.
    expect(document.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AAAA");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Netflix Premium" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/subscriptions/s-netflix",
        expect.objectContaining({
          method: "PATCH",
          json: expect.objectContaining({
            name: "Netflix Premium",
            logo: "data:image/png;base64,AAAA",
          }),
        }),
      ),
    );
  });

  it("surfaces the non-positive amount error on the amount field", async () => {
    installBackend([], (path, opts) => {
      if (path === "/subscriptions" && opts?.method === "POST") {
        throw new ApiError(422, "SUBSCRIPTION_NONPOSITIVE");
      }
      return undefined;
    });
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Freebie" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Next renewal"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: /create subscription/i }));

    expect(await screen.findByText(/greater than zero/i)).toBeInTheDocument();
  });

  it("surfaces a clear message when the logo is rejected (LOGO_INVALID)", async () => {
    installBackend([], (path, opts) => {
      if (path === "/subscriptions" && opts?.method === "POST") {
        throw new ApiError(422, "LOGO_INVALID");
      }
      return undefined;
    });
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Netflix" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "15.99" } });
    fireEvent.change(screen.getByLabelText("Next renewal"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: /create subscription/i }));

    expect(await screen.findByText(/image couldn't be saved/i)).toBeInTheDocument();
  });
});
