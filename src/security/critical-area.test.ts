import { describe, it, expect } from "vitest";
import { isCriticalSecurityArea, type CriticalAreaFlags } from "./critical-area.js";

const noFlags: CriticalAreaFlags = {
  touchesAuth: false,
  touchesPayment: false,
  touchesPII: false,
  touchesWebhook: false,
  touchesRLS: false,
};

describe("isCriticalSecurityArea", () => {
  it.each([
    ["src/auth/login.ts", "auth dir"],
    ["src/middleware/auth.ts", "auth file"],
    ["src/middleware/authorization.ts", "authorization file"],
    ["app/payments/checkout.ts", "payment dir"],
    ["src/billing/payment-service.ts", "payment file"],
    ["src/webhooks/stripe.ts", "webhook dir"],
    ["db/rls/tenants.sql", "rls dir"],
    ["supabase/policies/orders-policy.sql", "policy file"],
    ["prisma/migrations/20260101_add_email_to_users/migration.sql", "PII migration dir"],
    ["db/add_cpf_column.sql", "PII sql file"],
  ])("flags %s as critical (%s)", (file) => {
    expect(isCriticalSecurityArea([file], noFlags)).toBe(true);
  });

  it.each([
    ["src/report/risk-score.ts"],
    ["src/authors/list.ts"], // "authors" is not auth
    ["prisma/migrations/20260101_add_index/migration.sql"], // migration without PII tokens
    ["README.md"],
  ])("does not flag %s", (file) => {
    expect(isCriticalSecurityArea([file], noFlags)).toBe(false);
  });

  it("any verify-derived flag alone makes the area critical", () => {
    for (const key of Object.keys(noFlags) as Array<keyof CriticalAreaFlags>) {
      expect(isCriticalSecurityArea([], { ...noFlags, [key]: true })).toBe(true);
    }
  });

  it("empty diff with no flags is not critical", () => {
    expect(isCriticalSecurityArea([], noFlags)).toBe(false);
  });
});
