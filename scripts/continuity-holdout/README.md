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


## Portable execution and validated joining

The workflow requires the merged, clean tooling and a newly matching freeze and
registration. Existing freezes bind the tooling bytes and cannot silently adopt
new controller code. Run on Linux/macOS with the repository's supported Node
version and built packages. All study inputs and outputs remain external/private.
These commands are interfaces, **not execution or spending authorization**.

```bash
ARGS=(
  --corpus-manifest /external/frozen/manifest.json --manifest-sha256 PINNED_SHA
  --registration /external/registration/registration.json
  --registration-sha256 REGISTRATION_SHA
  --statistical-spec /external/statistical-spec.json
  --pi-auth-path /external/private-auth.json
)
node scripts/continuity-holdout/workflow.mjs plan "${ARGS[@]}"   --output /external/dry-plans
node scripts/continuity-holdout/workflow.mjs proof "${ARGS[@]}"   --output /external/offline-proof
```

`plan` writes every shard's confirmed plan, catalog prices, inventory, expected
cost, planning upper and reservation total, plus a blocked-confirmation receipt.
Its real-mode preflight deliberately throws at `modulesLoader`: no provider module
is loaded and dispatch is zero. The auth path must pass the existing metadata-only
file/permission checks; contents are never read by preflight. Synthetic tests use
an empty owner-only file, not credentials. An unknown price/context limit or any
shard above its registered ceiling blocks admission for the entire registration;
obtain a new decision, not a smaller outcome-dependent workload.

`proof` never forwards the auth-path flag to execution and refuses provider-key
credentials in the environment. It runs all frozen conversations at one repeat,
one probe and four arms, then all 15 probes on one seeded representative/family.
It keeps work/captures and validates boundaries, three distinct preparation
children, journal identities/budgets, preservation, two-offer limits, source hashes,
host citations/order, exact injection and zero probe upkeep. It emits per-phase
receipts; offline output is never model-quality evidence. Full long-history
replay is intentionally an explicit drill rather than a short CI test.

After separate authorization, an operator supplies a private JSON record:

```json
{
  "planDigest": "CONFIRMED_SHARD_DIGEST",
  "ceilingUSD": 25,
  "authPathFingerprint": "SHA256_OF_THE_ABSOLUTE_AUTH_PATH_NOT_ITS_CONTENTS",
  "approver": "AUTHORIZED_CUSTODIAN",
  "timestamp": "2040-01-01T00:00:00.000Z"
}
```

The controller checks the record against the selected plan and ceiling. It creates
an exclusive, fsynced sibling `.claim` binding that record to one output root;
keep both files, and never copy a record to simulate fresh approval.

```bash
node scripts/continuity-holdout/workflow.mjs run "${ARGS[@]}" --shard 1   --authorization /external/shard-1-authorization.json   --output /external/run-shard-1 --deadline-seconds 1500 --concurrency 4
node scripts/continuity-holdout/workflow.mjs join "${ARGS[@]}"   --shard-roots /external/shard-roots.json --output /external/joined
```

The roots file is a JSON array of controller output directories. `run` uses a
crash-released SQLite lease, write-ahead fsynced reservations and a gated private
child session. It never retries failed/partial/killed units. Stops include auth,
unknown prices, admission cost, deadlines, malformed material and **more than
10% invalid/killed admitted units**; exactly 10% continues. Quality is never a
stopping rule. Known catalog costs, full unknown-usage reserves and full lost
chunk holds are separate: **not an invoice**, and Codex `stream_abort` cannot
guarantee containment. Unknown upkeep reserves use 128k/64k input plus 4,096
output; unknown readers reserve catalog context/output, including expensive tiers.

A crash leaves the reservation consumed. A still-live session on restart is not
authority to signal a potentially reused PID: it blocks reconciliation/reporting.
After owned workers are confirmed gone, restart records a lost chunk and stops;
it does not readmit it. Do not edit state to resume. Archive verification hashes
all unit/work/capture files and is repeated on restart and join, without a cache.

`join` rejects mismatched manifest/registration/spec/revision, duplicate units or
shards, unexpected membership, archive tampering, inconsistent accounting or an
unreconciled stop. Missing shards/partial units keep planned denominators and
known failures. Optional `--audit /external/audit.json` uses PR2's bound totals,
but **cannot certify the final entry population**. This stage always adds
`audit-workflow-pending:inconclusive`; no study pass is possible yet, even with
numerically passing totals. The mechanical/blinded two-auditor workflow and the
deterministic final report are deferred to the next PR. Missing audit or incomplete
data can never authorize acceptance.

### Synthetic verification

```bash
pnpm run build
node scripts/__tests__/fixtures/holdout-proof-drill.mjs
```

This provider-free production-harness drill creates its own tiny synthetic freeze
and retains phase timings and evidence under `.worklab-tmp/holdout-proof-drill-*`.
An optional `all` or `representative` argument selects one phase. The CI suite
uses reduced synthetic artifact fixtures through the same proof validator, plus
real process tests for reservation durability, crash/restart, stop thresholds,
unknown/lost accounting, owned deadline termination and blocked confirmation.
It does not claim the artifact fixture is a real replay. Run the explicit drill
for that evidence. No genuine holdout files belong in fixtures or this checkout.
