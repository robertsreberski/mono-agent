# Default projection golden bytes

`projection-golden-v3.json` and `projection-golden-v4.json` were captured from
P2b base `10f501d4f1dc102db9951fcebb09a96001910452`, not from the implementation
under test. Normal tests read these committed fixtures and never call Git, so
squashing/deleting the feature branch cannot invalidate the baseline.

Coverage includes complete default native journal/checkpoint bytes, v3/v4
legacy import outputs and imported journal bytes, raw ancestry, actual
Anthropic/OpenAI wire payload strings, repair entries and synthetic projection,
manual driver compaction (including repaired branch preparation), Pi adapter
context and usage/message estimators, real guarded mid-run compaction (including
its existing split-turn summary requests) and native recovery receipt/ancestry
validation. Every captured string/object is compared in full. There is no
post-capture output normalization.

The worker freezes external inputs before execution: time, performance clock,
UUID/random entropy and the filesystem identity returned for import descriptor
serialization. The latter uses fictional device/inode/time values; content
hashing and the reader's real pinned path/fd identity guards still run against
actual files. Physical identity-security cases are separately covered by the
journal-reader/store/import suites. Providers and text are fictional; provider
transports are mocked and no credentials or paid request are involved.

## Intentional regeneration

Use only for a reviewed baseline/scenario update. Obtain the exact base object
first if local Git history no longer contains it, install dependencies, then
run from the repository root:

```bash
pnpm --dir packages/turn run test:fixtures
node .worklab-tmp/turn-test-fixtures/engine/__tests__/fixtures/regenerate-projection-goldens.mjs
pnpm --dir packages/turn run build
pnpm --filter @mono-agent/turn exec vitest run \
  src/engine/__tests__/projection-default-parity.test.ts
```

The authored `regenerate-projection-goldens.mts` is compiled by `test:fixtures`.
Its canonical data and output directory remains
`packages/turn/src/engine/__tests__/fixtures`, not the emitted fixture tree.
The manual generator archives original harness/runtime source into an owned
`.worklab-tmp` temporary directory, runs the current scenario against those
original modules, and removes the directory in `finally`. It writes only the
two golden files. Inspect the diff and keep the base/scenario provenance above
accurate; do not regenerate from changed production code merely to turn a
regression green.

## Intentional summary-request-only refresh

The `release-freeze` fixtures retain the historical projection, checkpoint,
import/repair and runtime outputs above. Their two `runtime.midRun.requests`
strings were selectively refreshed from shipping turn at `f4649137b` for the
intentional historical-summary instructions, request-local chronology and
`SUMMARY_FOCUS` v2. Conversation frames, dispatch options and every other captured
value remain identical to the prior freeze.

The reviewed historical-preservation follow-up selectively refreshes those four
request strings again for immutable protected tuples and NEW top-level resolution
events. The re-review refresh changes only the `SUMMARY_FOCUS` label from v2 to
v3 in those same four strings, making the immutable-event policy unambiguous.
The guarded refresh confirms no accounting change: zero-tuple compaction
does not add `preservation`. No journal, projection, import, result, estimator,
usage or recovery fields were refreshed.

There is no `UPDATE_*` environment switch. The historical archive generator above
recreates old behavior and is not a current-prompt updater. For a reviewed summary
instruction change, use this narrower procedure from the repository root. It
captures the real worker, refuses changes outside the two requests, then also
refuses request changes outside summary focus and post-conversation instruction
text. Inspect that instruction diff before committing; these guards are not
approval for arbitrary prompt changes.

```bash
pnpm --filter @mono-agent/turn run build
pnpm --dir packages/turn run test:fixtures
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const fixtures = join(root, "packages/turn/src/engine/__tests__/fixtures");
const worker = join(root, ".worklab-tmp/turn-test-fixtures/engine/__tests__/fixtures/projection-parity-worker.mjs");
const scratch = await mkdtemp(join(root, ".worklab-tmp/summary-request-refresh-"));
try {
  for (const version of [3, 4]) {
    const path = join(fixtures, `projection-golden-v${version}.json`);
    const golden = JSON.parse(await readFile(path, "utf8"));
    assert.equal(golden.format, "release-freeze");
    const legacy = join(fixtures, `legacy-v${version}.jsonl`);
    const storage = join(scratch, `storage-${version}`);
    await mkdir(`${storage}-import/legacy`, { recursive: true });
    await copyFile(legacy, `${storage}-import/legacy/fixture_fixture-session.jsonl`);
    const capture = JSON.parse(execFileSync(process.execPath, ["--no-warnings", worker,
      join(root, "packages/turn/dist/engine"), join(root, "packages/turn/dist"), storage, legacy],
    { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
    const before = golden.capture.runtime.midRun.requests;
    const after = capture.runtime.midRun.requests;
    assert.equal(before.length, 2);
    assert.equal(after.length, 2);
    // Refuse to bless any projection, checkpoint, import, repair, estimator,
    // usage, compaction result/accounting, recovery or other runtime delta.
    const expected = structuredClone(golden.capture);
    expected.runtime.midRun.requests = after;
    assert.deepStrictEqual(capture, expected);
    for (let index = 0; index < after.length; index++) {
      const oldRequest = JSON.parse(before[index]);
      const request = JSON.parse(after[index]);
      const oldText = oldRequest.context.messages[0].content[0].text;
      const text = request.context.messages[0].content[0].text;
      const frame = value => value.match(/^<conversation>\n[\s\S]*?\n<\/conversation>\n\n/u)?.[0];
      assert.ok(frame(text));
      assert.equal(frame(text), frame(oldText));
      assert.equal(request.context.systemPrompt.split("\n\nMono-agent summary focus")[0],
        oldRequest.context.systemPrompt.split("\n\nMono-agent summary focus")[0]);
      for (const marker of ["<request-local-positions>", "## Historical events and corrections", "## Pending items"])
        assert.ok(text.slice(frame(text).length).includes(marker));
      // Only summary focus and the post-conversation instruction text may differ.
      request.context.systemPrompt = oldRequest.context.systemPrompt;
      request.context.messages[0].content[0].text = oldText;
      assert.deepStrictEqual(request, oldRequest);
    }
    golden.capture.runtime.midRun.requests = after;
    await writeFile(path, JSON.stringify(golden, null, 2) + "\n");
    console.log(`Refreshed only v${version} runtime.midRun.requests (2 summary requests)`);
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
NODE
pnpm --filter @mono-agent/turn exec vitest run \
  src/engine/__tests__/projection-default-parity.test.ts
```

Do not remove the whole-capture or request-envelope assertions to regenerate a
regression. Update this provenance note when intentionally refreshing the pins.
