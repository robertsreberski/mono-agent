# Independent conversation corpus tooling

These scripts only validate, render, compare and freeze fictional benchmark data.
They do not prepare a product treatment or call a provider. Suite loading and
statistical registration are documented in [the registration workflow](./REGISTRATION.md); existing benchmark suites are unchanged.

## Author isolation

Give the isolated author **only** [the neutral format](./AUTHOR-FORMAT.md), not
this README or a checkout. Accept `index.json` and one file per family. Keep all
authored material, exceptions, reports, rubric, protocol and frozen outputs
private and outside the checkout. Never check an actual corpus into this public
repository. The tests contain deliberately synthetic placeholders, not a seed
pool for an evaluation.

The neutral document's `holdout-validate` interface maps to:

```bash
node scripts/holdout-validate.mjs --spec-dir /external/authored --schema-only
```

Schema-only validation never renders histories or consults comparison sources.
It checks declared fictional/independent provenance, not the truth of those
claims or semantic adequacy of evidence. Authored strings reject C0 controls
other than newline/tab, with the case and field in the error. In JSON regex
patterns, write `"\\b"` for a word boundary; `"\b"` is a backspace and is rejected. The custodian must review these claims,
each family's independence, and corrections/decisions/work-state evidence.

## Reproducible selection and overlap

Supply a seeds JSON object with distinct positive 32-bit integer fields
`ordinary` and `distractor`. Each family has a fixed quota, summing to 256 per
group. Families and case pools are ordered by ID before seeded selection without
replacement. Rendering seeds and selected identities are recorded separately.
Histories use only the authored strings; shared dataset validation does not
supply generation content.

Supply an explicit allowlist JSON object with `schema` set to
`holdout-overlap-allowlist-v1` and an `entries` array (empty is valid). Each entry
has `mode` (`raw7` or `content3`), a normalized `phrase`, and a `justification`
with at least 20 characters. Exceptions must be narrow generic language, reviewed
and fixed before acceptance, never a way to admit reused narrative.

```bash
node scripts/continuity-holdout-overlap.mjs \
  --spec-dir /external/authored --seeds /external/seeds.json \
  --allowlist /external/allowlist.json --output /external/overlap-run
```

The JSON report covers authored narrative fields (including unused cases), rendered
titles and owner names, all
rendered histories, and exact reader probe text. It compares against every string
and joined template literal in the development generator, original checked-in suite string values, and production ledger
and ranking sources, using shared AST extraction and normalization. Narrative
values are compared, not schema keys or tool names. The two checks are raw
seven-word runs and function-word-stripped content trigrams. A non-allowlisted
match exits nonzero. Identical text is scanned once; each unique overlap records
its first location and all matching reference files. Lexical disjointness alone
is not proof of conceptual independence.

## Freeze and verify

Freeze only after all loader/controller tooling has merged. Freeze and verify
reject tracked or untracked dirt (gitignored artifacts are excluded). Freeze recomputes
and requires an exactly matching passing overlap report; stale reports fail.
The destination must be new and outside the checkout, including through symlinks.
The spec directory and every input file must also be outside the checkout.
All file writes are exclusive. A failed freeze may leave a partial directory;
it is not valid without a verified manifest and must not be reused.

```bash
node scripts/continuity-holdout-freeze.mjs freeze \
  --spec-dir /external/authored --seeds /external/seeds.json \
  --rubric /external/rubric --protocol /external/protocol \
  --overlap /external/overlap-run/overlap.json \
  --allowlist /external/allowlist.json --output /external/frozen
node scripts/continuity-holdout-freeze.mjs verify \
  --directory /external/frozen --manifest-sha256 <registered-digest>
```

Record the returned manifest digest in independent custodian-controlled
registration; do **not** obtain the trusted digest from the directory being
verified. `manifest.sha256` is a convenience copy, not a trust anchor.

Canonical JSON sorts object keys, preserves array order, and uses one trailing
newline for files. Semantic input digests hash canonical JSON without a newline;
`files` entries hash actual bytes, including the newline. The manifest binds the
merged canonical author spec, statistical design, group and per-case seeds, frozen mixture, each conversation
and answer-key file, rubric, protocol, allowlist, overlap report, generator and
supporting benchmark/tooling snapshots, Git revision for audit, Node version,
lockfile SHA-256 and resolved TypeScript version. All tracked continuity benchmark
modules, entrypoints, development fixtures and holdout scripts are bound, including
subsequent loader/controller additions. Raw author formatting is not
part of the merged spec digest. No timestamps or caller paths enter the freeze.
Verify checks every artifact and the externally pinned manifest, rejects extra
files/symlinks, and checks the current bound-file inventory/content, lockfile,
TypeScript version and Node major version. An unrelated descendant commit is
allowed; changing bound content or runtime provenance requires a new registration.

No model execution or quality/acceptance claim follows from a successful freeze.

Design E is 32 families × 16 selected conversations (16 families per group),
512 total. Schema/selection/overlap/freeze APIs take their population from the
statistical spec; the CLIs use the checked-in spec. Registration additionally
verifies the exact selected family layout. Alternative designs must be approved
and frozen before execution; no post-outcome change is permitted. Verification
rehashes every artifact and tooling byte on every call, using bounded concurrent
I/O without a content or metadata cache.
