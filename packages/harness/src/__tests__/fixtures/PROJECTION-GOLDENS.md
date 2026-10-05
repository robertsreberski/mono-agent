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
node packages/harness/src/__tests__/fixtures/regenerate-projection-goldens.mjs
pnpm --filter @mono-agent/harness exec vitest run \
  src/__tests__/projection-default-parity.test.js
```

The manual generator archives original harness/runtime source into an owned
`node_modules` temporary directory, runs the current scenario against those
original modules, and removes the directory in `finally`. It writes only the
two golden files. Inspect the diff and keep the base/scenario provenance above
accurate; do not regenerate from changed production code merely to turn a
regression green.
