// Real C2 faux subprocess producer, never a real provider or consumption registry.
import { expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runE2Proofs } from "../lib/continuity-e2-proofs.mjs";
import { estimateE2Reservations } from "../lib/continuity-e2-estimate.mjs";
import { loadE2Catalog, e2RequestPrice } from "../lib/continuity-e2-pricing.mjs";
it("prices the actual C2 cancel-forwarded sizing request as paid without changing legacy 31/4 counts", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-paid-role-")));
  try {
    const [{ sizing }] = await runE2Proofs({ output: join(root, "run"), arm: "cancel" });
    const requests = sizing.variants.flatMap((v, checkpoint) => v.requests.map(({ ordinal: _ordinal, ...row }) => ({ checkpoint, ...row })));
    expect(requests.filter(r => r.role === "setup-scripted")).toHaveLength(31);
    expect(requests.filter(r => r.role === "continuation")).toHaveLength(4);
    expect(requests.every(r => Object.hasOwn(r, "paidRole"))).toBe(true);
    const forwarded = requests.filter(r => r.role === "setup-scripted" && r.paidRole === "continuation");
    expect(forwarded).toHaveLength(1); expect(requests.filter(r => r.paidRole === null)).toHaveLength(30);
    const registered = new Map();
    for (const r of requests.filter(r => r.paidRole !== null)) {
      const key = `${r.paidRole}:${r.model}`, prior = registered.get(key);
      registered.set(key, { role: r.paidRole, model: r.model, maxInputTokens: Math.max(prior?.maxInputTokens ?? 0, r.size.maximum), maxOutputTokens: 128000, expectedOutputTokens: 64 });
    }
    const roles = [...registered.values()], catalog = await loadE2Catalog();
    const withCancellation = estimateE2Reservations({ roles, requests, catalog });
    const withoutCancellation = estimateE2Reservations({ roles, requests: requests.filter(r => r !== forwarded[0]), catalog });
    const role = roles.find(r => r.role === "continuation" && r.model === forwarded[0].model);
    const reserve = e2RequestPrice(catalog.find(c => c.model === role.model), { inputTokens: role.maxInputTokens, maxOutputTokens: role.maxOutputTokens }).reservationUnits;
    expect(BigInt(withCancellation.minimumCapUnits) - BigInt(withoutCancellation.minimumCapUnits)).toBe(BigInt(reserve));
    expect(withCancellation.checkpoints.find(r => r.role === "continuation").requests).toBe(5);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
