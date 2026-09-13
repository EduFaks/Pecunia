import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { useArchiveContact, useContacts, useCreateContact, useUpdateContact } from "./useContacts";
import type { ContactOut } from "./useContacts";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper, queryClient };
}

const CONTACT: ContactOut = {
  id: "p1",
  name: "Grocery Store",
  default_category_id: "c-groceries",
  type: "company",
  avatar: null,
  archived_at: null,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
};

describe("useContacts", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches the flat, non-archived-by-default list", async () => {
    mockApiFetch.mockResolvedValue({ items: [CONTACT], next_cursor: null });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useContacts(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/contacts?include_archived=false&limit=200");
    expect(result.current.data?.items).toEqual([CONTACT]);
  });

  it("passes include_archived=true through when asked", async () => {
    mockApiFetch.mockResolvedValue({ items: [CONTACT], next_cursor: null });
    const { wrapper } = makeWrapper();

    renderHook(() => useContacts(true), { wrapper });

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/contacts?include_archived=true&limit=200"),
    );
  });
});

describe("useCreateContact", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts the create payload and invalidates the contacts queries on success", async () => {
    mockApiFetch.mockResolvedValue(CONTACT);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateContact(), { wrapper });

    result.current.mutate({ name: "Grocery Store", type: "company", default_category_id: "c-groceries" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/contacts", {
      method: "POST",
      json: { name: "Grocery Store", type: "company", default_category_id: "c-groceries" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["contacts"] });
  });
});

describe("useUpdateContact", () => {
  it("patches the contact and invalidates the contacts queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...CONTACT, name: "Corner Shop" });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateContact("p1"), { wrapper });

    result.current.mutate({ name: "Corner Shop" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/contacts/p1", {
      method: "PATCH",
      json: { name: "Corner Shop" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["contacts"] });
  });
});

describe("useArchiveContact", () => {
  it("archives the contact and invalidates the contacts queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useArchiveContact(), { wrapper });

    result.current.mutate("p1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/contacts/p1/archive", { method: "POST" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["contacts"] });
  });
});
