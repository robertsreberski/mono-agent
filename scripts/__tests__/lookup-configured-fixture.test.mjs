import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { stripPackRetrievalGuidance } from "../proofs/fixtures/lookup-configured-fixture.mjs";

const read = name => readFileSync(new URL(`../../packages/conversation/src/continuity/${name}`, import.meta.url), "utf8");

it("removes the pack retrieval guidance declaration, import and use from R0", () => {
  const { render, implementation } = stripPackRetrievalGuidance(read("render-fit.ts"), read("pack.ts"));
  expect(render).not.toMatch(/\bPACK_RETRIEVAL_GUIDANCE\b/u);
  expect(implementation).not.toMatch(/\bPACK_RETRIEVAL_GUIDANCE\b/u);
  expect(implementation).toContain('const guidance = "";');
  expect(implementation).toContain('fitsLedgerPrefix, CONTINUITY_PACK_MAX_TOKENS } from "./render-fit.js";');
});
