import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { overlapSources } from "../lib/continuity-holdout-overlap.mjs";
it("pins the re-frozen overlap source inventory after History guidance changes", async () => {
  const frozen = JSON.parse(await readFile(new URL("../fixtures/history-overlap-source-pins.json", import.meta.url)));
  expect((await overlapSources()).map(({name,text})=>({name,sha256:createHash("sha256").update(text).digest("hex")}))).toEqual(frozen.sources);
});
