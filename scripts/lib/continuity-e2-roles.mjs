// Pricing classification is independent of the legacy faux replay role/counts.
export const E2_USD_UNITS = 1000000000n;
export const E2_PAID_ROLES = Object.freeze(["summary", "continuation", "probe"]);
export function e2PaidRole(mode, method = "streamSimple") {
  if (!["streamSimple", "completeSimple"].includes(method) || !["setup-scripted", "cancel-forwarded", "continuation", "probe"].includes(mode))
    throw Object.assign(Error("E2_COST_ROLE_INVALID"), { code: "E2_COST_ROLE_INVALID" });
  if (method === "completeSimple") return "summary";
  return mode === "setup-scripted" ? null : mode === "cancel-forwarded" ? "continuation" : mode;
}
export function requireE2PaidRole(row) {
  if (!row || typeof row !== "object" || !Object.hasOwn(row, "paidRole"))
    throw Object.assign(Error("E2_SIZING_PAID_ROLE_REQUIRED"), { code: "E2_SIZING_PAID_ROLE_REQUIRED" });
  if (!(row.paidRole === null && row.role === "setup-scripted" || E2_PAID_ROLES.includes(row.paidRole)
    && (row.role === row.paidRole || row.role === "setup-scripted" && row.paidRole === "continuation")))
    throw Object.assign(Error("E2_COST_ROLE_INVALID"), { code: "E2_COST_ROLE_INVALID" });
  return row.paidRole;
}
