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

Freeze only after the complete loader/controller/audit/report tooling has merged.
Before freezing, copy the exact checked-in `audit-rubric.json` bytes to the external
`--rubric` input; certification rejects another rubric, even if its prose is similar. Freeze and verify
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

`plan` writes every shard's confirmed plan, an incomplete authorization template,
catalog prices, inventory, expected
cost, planning upper and reservation total, plus a blocked-confirmation receipt.
Its real-mode preflight deliberately throws at `modulesLoader`: no provider module
is loaded and dispatch is zero. The auth path must pass the existing metadata-only
file/permission checks; contents are never read by preflight. Synthetic tests use
an empty owner-only file, not credentials. An unknown price/context limit or any
shard above its registered ceiling blocks admission for the entire registration;
obtain a new decision, not a smaller outcome-dependent workload.

`proof` never forwards the auth-path flag to execution. It refuses the presence
(even an empty value) of exactly the environment names matching
`^(OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|CODEX|PI)_.*(API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$`:
those seven prefixes, any intermediate text, and one of those three suffixes.
Examples are `OPENAI_API_KEY`, `GOOGLE_GEMINI_API_KEY` and `PI_ACCESS_TOKEN`;
other credential names are not detected. Run with a clean credential-free
environment rather than treating this finite-name guard as a secret scanner.
It runs all frozen conversations at one repeat,
one probe and four arms, then all 15 probes on one seeded representative/family.
It keeps work/captures and validates boundaries, three distinct preparation
children, journal identities/budgets, preservation, two-offer limits, source hashes,
host citations/order, exact injection and zero probe upkeep. It emits per-phase
receipts; offline output is never model-quality evidence. Full long-history
replay is intentionally an explicit drill rather than a short CI test.

After separate authorization, the custodian completes the shard's
`authorization-template.json` as a private record. Create the intended output
directory first, then obtain its **canonical** root hash (not the spelling of a
symlink or a nonexistent path):

```bash
mkdir -p /external/run-shard-1
node --input-type=module -e 'import {realpathSync} from "node:fs"; import {createHash} from "node:crypto"; console.log(createHash("sha256").update(realpathSync(process.argv[1])).digest("hex"))' /external/run-shard-1
```

Fill the remaining fields only with explicit approval; the template itself is
not authorization. The output root is chosen before approval, not at claim time:


```json
{
  "planDigest": "CONFIRMED_SHARD_DIGEST",
  "ceilingUSD": 25,
  "authPathFingerprint": "SHA256_OF_THE_ABSOLUTE_AUTH_PATH_NOT_ITS_CONTENTS",
  "outputRootSha256": "SHA256_OF_THE_CANONICAL_OUTPUT_ROOT",
  "approver": "AUTHORIZED_CUSTODIAN",
  "timestamp": "2040-01-01T00:00:00.000Z"
}
```

The controller checks the record against the selected plan, ceiling and canonical
output root, so copying the record to another filename cannot authorize a second
root. Authorization binds the auth **path**, not its contents: OAuth refresh
rewrites that file, so content binding would reject legitimate refreshes. It creates
an exclusive, fsynced sibling `.claim` binding that record to one output root;
keep both files and all run state; never delete/reuse a root or copy a record to
simulate fresh approval. Direct `continuity-benchmark.mjs --real --suite holdout`
still bypasses the controller authorization record. Use the workflow `run`
command; this is an operator-error guard, not a hostile-local-user boundary.

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
Unknown reader usage is visible only at chunk boundaries, not during probes.
Its conservative charge can exceed the ceiling by at most one admitted chunk
before the next-chunk admission stop; it is not live invoice containment.
Killed/lost chunks retain journal-only upkeep spend (deduped against unit
operations) **in addition to** their full planning hold.

A crash leaves the reservation consumed. A still-live session on restart is not
authority to signal a potentially reused PID: it blocks reconciliation/reporting.
After owned workers are confirmed gone, restart records a lost chunk and stops;
it does not readmit it. Do not edit state to resume. Archive verification hashes
all unit/work/capture files and is repeated on restart and join, without a cache.
These hashes detect corruption and inconsistent rewrites, not an adversary who
consistently rewrites the whole output root and all receipts.

`join` rejects mismatched manifest/registration/spec/revision, duplicate units or
shards, unexpected membership, archive corruption, inconsistent accounting or an
unreconciled stop. Missing shards/partial units keep planned denominators and
known failures. Optional `--audit /external/audit.json` uses PR2's bound totals,
but **cannot certify the final entry population**. The intermediate join always
adds `audit-workflow-pending:inconclusive`, even for numerically passing totals.
Standalone real benchmark aggregation is also noncertifying. Only the complete
workflow below can remove the pending gate. Missing audit or incomplete data
can never authorize acceptance.

## Mechanical audit, blinded review and final report

Run → join → audit → report must use **one clean tooling revision**, equal to
`registration.codeRevision`. Register the real freeze at the final merged tooling
revision; older freezes cannot adopt these audit modules. Auditing/reporting make
no provider calls and confer no execution/spending permission. Use fresh external
output directories for every invocation; incomplete outputs are not resumable.

```bash
node scripts/continuity-holdout/workflow.mjs audit-export "${ARGS[@]}" \
  --shard-roots /external/shard-roots.json --joined /external/joined/joined.json \
  --output /external/audit-export
```

The exporter revalidates the exact join against reconciled controllers and rehashes
all archived bytes. It checks every ledger checkpoint publication/captured render,
probe render count/order, final native SQLite ledger, host source and tool binding,
citation geometry, identifier contexts, derived markers, and inherited entry
preservation. Native receipts corroborate relabel/downgrade and D6 counters.
Missing/unreadable/unbindable material is explicit integrity failure, never skipped.
Deduplication uses `(corpus, conversation, repeat, entry.id)` across publications;
same-ID content changes fail, and paraphrases or different repeats never merge.
Counters cover validated checkpoints; incomplete populations cannot certify.

Give each independent auditor **only** `public/export.json` and `public/rubric.json`.
Keep the entire `private/` directory, controller roots, join and probe outcomes
custodian-only. It contains the mechanical population, identity map and recorded
256-bit ordering seed. Default seed generation is cryptographically random;
optional `--seed` accepts exactly 64 lowercase hexadecimal characters to reproduce
an existing export using its private seed. Do not search seeds after review.
Deterministic keyed shuffle/opaque IDs hide source order; only a seed commitment
is public. Giving reviewers the seed could reveal corpus-sorted positions.

Each public item supplies entry kind/value/status/normalization markers and **full
cited spans**, retaining owner/tool evidence but not corpus/model/repeat/checkpoint
identity, paths or probe outcomes. True arm blinding is impossible because ledger
structure reveals treatment; the header discloses this. Story content may itself
be recognizable, so author/tuner isolation and no outcome access remain human
responsibilities. Software validates attestations, not people's actual independence.

The exact shipped narrow-kind/context rubric is frozen and hash-bound. Deliberation,
conditional requests, fulfilled work, reported content and historical cautions are
judged on their evidence, not hard-coded entry/index decisions. Chronology and
historical cautions are recorded separately from acceptance gates. `exportSha256`
hashes canonical JSON **with its trailing newline**, omitting that field itself;
`rubricSha256` hashes raw rubric bytes. The manifest also records raw export-file SHA.

Each auditor supplies this envelope and one judgment for **every** opaque item ID,
without extras/duplicates. The item below illustrates shape, not a reviewed finding;
evaluate all six booleans and provide a nonempty rationale (at most 4,096 characters).
Auditor IDs are distinct 1–80-character ASCII letters/digits/underscore/hyphen.

```json
{
  "schema": "holdout-auditor-v1",
  "auditorId": "independent-auditor-a",
  "exportSha256": "EXPORT_HEADER_SHA",
  "rubricSha256": "RUBRIC_RAW_SHA",
  "attestations": {
    "notAuthor": true, "notTuner": true,
    "independentReview": true, "noOutcomeAccess": true
  },
  "items": [{
    "id": "OPAQUE_ITEM_ID", "label": false, "context": false,
    "chronology": false, "falseSupersession": false, "binding": false,
    "historicalCaution": false, "rationale": "Evidence-specific independent assessment."
  }]
}
```

```bash
node scripts/continuity-holdout/workflow.mjs audit-import "${ARGS[@]}" \
  --shard-roots /external/shard-roots.json --joined /external/joined/joined.json \
  --audit-directory /external/audit-export \
  --auditor-a /external/auditor-a.json --auditor-b /external/auditor-b.json \
  --output /external/audit-disagreements
```

Without adjudication this writes only `disagreements.json` and `status.json`, not
an identity map or certificate. Share these disagreements, both reviewer files
and the public packet with the outcome-blind adjudicator; do not share private
material. The adjudication binds **exact raw byte hashes** of both auditor files,
the export/rubric hashes, and exactly the disagreeing IDs. Each item has all six
booleans and rationale as above. Even zero disagreements requires this envelope
with `items: []` before unmasking:

```json
{
  "schema": "holdout-adjudication-v1", "blinded": true,
  "adjudicatorId": "outcome-blind-adjudicator",
  "exportSha256": "EXPORT_HEADER_SHA", "rubricSha256": "RUBRIC_RAW_SHA",
  "auditorASha256": "EXACT_A_FILE_SHA", "auditorBSha256": "EXACT_B_FILE_SHA",
  "items": []
}
```

```bash
node scripts/continuity-holdout/workflow.mjs audit-import "${ARGS[@]}" \
  --shard-roots /external/shard-roots.json --joined /external/joined/joined.json \
  --audit-directory /external/audit-export \
  --auditor-a /external/auditor-a.json --auditor-b /external/auditor-b.json \
  --adjudication /external/adjudication.json --output /external/audit-certified
node scripts/continuity-holdout/workflow.mjs report "${ARGS[@]}" \
  --shard-roots /external/shard-roots.json --joined /external/joined/joined.json \
  --audit-directory /external/audit-export \
  --auditor-a /external/auditor-a.json --auditor-b /external/auditor-b.json \
  --adjudication /external/adjudication.json \
  --certificate /external/audit-certified/certificate.json --output /external/final-report
```

After validated adjudication, import emits private `unmasked.json` and a certificate,
plus disagreements/status. Certification requires a complete mechanical population,
both complete independent responses and adjudication bound to this exact join.
Totals alone never certify. The unchanged registered gates use unique-entry rates
(label ≤10/363, context ≤5/363) and hard zero for falsely superseded current facts
and binding errors. A numerical pass remains inconclusive without certification;
established statistical or audit failures remain failures.

`report` recomputes the join and mechanical audit, validates all human files and
certificate/import outputs, then writes deterministic `report.json`, `report.md`
and `artifacts.json`. They include gates/intervals/reasons, integrity and audit
counters, controller stops and catalog spend (not an invoice). There are no local
absolute paths or freshly generated timestamps. Identical input bytes give
identical output bytes, including with roots supplied in a different order.

**Raw-file hashes are bound transitively: report → archive-manifest SHA → per-file
SHA.** The artifact section lists each controller and `shards/N/chunks/M/archive.json`
SHA, freeze/registration/spec/rubric, join/export/human/import artifacts and tooling
revision. Report generation reruns `verifyArchive` on every listed chunk; changing
one raw file invalidates it even when its manifest is unchanged. Verification is
chunk-by-chunk, without retaining per-file maps across chunks or duplicating a
multi-million-row raw inventory. Retain those original archive manifests and roots.
The detached manifest hashes report JSON/Markdown but cannot hash itself: pin its
returned SHA externally. Hashes detect corruption, not a hostile custodian rewriting
the complete evidence chain or false human independence attestations.

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
