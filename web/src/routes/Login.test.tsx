import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Login from "./Login";
import { useAuth } from "../lib/auth";
import type { AuthContextValue } from "../lib/auth";
import { ApiError } from "../lib/api";

vi.mock("../lib/auth", () => ({ useAuth: vi.fn() }));

const mockAuth = vi.mocked(useAuth);

function authState(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: null,
    status: "anon",
    login: vi.fn(),
    adoptSession: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    ...overrides,
  };
}

describe("Login", () => {
  beforeEach(() => {
    mockAuth.mockReset();
  });

  it("submits the entered email and password to login", async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    mockAuth.mockReturnValue(authState({ login }));

    render(<Login />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(login).toHaveBeenCalledWith("ada@example.com", "s3cret"));
  });

  it("shows a friendly error Callout when login rejects with INVALID_CREDENTIALS", async () => {
    const login = vi.fn().mockRejectedValue(new ApiError(401, "INVALID_CREDENTIALS"));
    mockAuth.mockReturnValue(authState({ login }));

    render(<Login />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Incorrect email or password.");
  });

  it("shows a friendly error Callout when login rejects with TOO_MANY_ATTEMPTS", async () => {
    const login = vi.fn().mockRejectedValue(new ApiError(429, "TOO_MANY_ATTEMPTS"));
    mockAuth.mockReturnValue(authState({ login }));

    render(<Login />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too many attempts. Please wait a few minutes.");
  });

  it("falls back to a generic message for an unrecognized error detail", async () => {
    const login = vi.fn().mockRejectedValue(new ApiError(500, "SOMETHING_WEIRD"));
    mockAuth.mockReturnValue(authState({ login }));

    render(<Login />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/something went wrong/i);
  });

  it("disables the submit button and shows a busy state while submitting", async () => {
    let resolveLogin: () => void = () => {};
    const login = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    mockAuth.mockReturnValue(authState({ login }));

    render(<Login />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(screen.getByRole("button", { name: /sign in/i })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    resolveLogin();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign in/i })).not.toHaveAttribute("aria-busy"),
    );
  });
});
