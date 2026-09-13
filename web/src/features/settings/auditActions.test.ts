import { describe, expect, it } from "vitest";
import { humanizeAuditToken, KNOWN_ACTIONS, KNOWN_RESOURCE_TYPES } from "./auditActions";

describe("humanizeAuditToken", () => {
  it("turns a dotted action id into a friendly, capitalized phrase", () => {
    expect(humanizeAuditToken("account.created")).toBe("Account created");
    expect(humanizeAuditToken("auth.logout_all")).toBe("Auth logout all");
    expect(humanizeAuditToken("asset.valuation.created")).toBe("Asset valuation created");
  });

  it("humanizes a bare resource type", () => {
    expect(humanizeAuditToken("project_item")).toBe("Project item");
  });
});

describe("KNOWN_ACTIONS / KNOWN_RESOURCE_TYPES", () => {
  it("mirrors the backend's closed action catalog (api/src/pecunia/audit/actions.py)", () => {
    expect(KNOWN_ACTIONS).toContain("account.created");
    expect(KNOWN_ACTIONS).toContain("transaction.created");
    expect(KNOWN_ACTIONS).toContain("auth.login.success");
  });

  it("mirrors the backend's closed resource_type set", () => {
    expect(KNOWN_RESOURCE_TYPES).toContain("account");
    expect(KNOWN_RESOURCE_TYPES).toContain("asset_valuation");
    expect(KNOWN_RESOURCE_TYPES).toContain("session");
  });
});
