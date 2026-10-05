# Native v2 old-binary refusal fixture

`native-v2-base-sources.json` contains the exact eleven-file relative-import
closure of `packages/harness/src/session-store.js` at public P2b revision
`10f501d4f1dc102db9951fcebb09a96001910452`. It includes the actual reader, schema,
store, locks, legacy importer, interruption code and their native helpers.
Per-file SHA-256 digests accompany the unchanged source text. There are no
external package imports, credentials or consumer data.

`native-header-upgrade.test.js` checks every digest, extracts the modules into
an owned temporary directory, imports the actual old code and removes the
source directory. It invokes old open (repairing and nonrepairing), streaming
scan with old header validation, catalogue listing, direct removal, deletion
and handle retirement against real current-format files, including the first
unterminated v3 record. Warm-index invalidation and an unguarded truncation
control distinguish real refusal from a fixture that simply never repairs.
Normal tests do not execute Git, require an old object to remain reachable,
install dependencies, create symlinks or make provider requests.

For intentional manual regeneration, use `git show <revision>:<path>` for the
entrypoint and recursively follow its relative static imports; retain each
source file verbatim and calculate SHA-256 over its UTF-8 bytes. Update the
snapshot's `base`, `files` and `sha256` maps together, and document why the
compatibility floor changed. Do not replace old behavior with a mock parser or
normalize source code to make the refusal tests pass.

The source snapshot preserves upstream copyright notices. Its compaction-kit
message helper remains covered by the package's `THIRD_PARTY_NOTICES.md`.
