# Independent fictional conversation authoring format

## Assignment and boundaries

Create a directory of UTF-8 JSON files for independently authored fictional
conversations and questions about them. Deliver JSON only, without comments or
executable code.
Use this document as your only technical reference. Do not consult another
conversation collection, implementation, instruction text, or previous evaluation.
Do not request such material. Record any accidental exposure in provenance.

Invent all people, places, organisations, identifiers and sensitive-looking
values. Do not use real people, places or companies, personal records, actual
credentials, or copied conversations. Use reserved `.example` domains if needed.
A fictional-data declaration is required; it does not replace human review.

Write at least 32 genuinely different families across two disjoint groups (at least 16 per group):
`ordinary` and `distractor`. Both groups have long histories. The latter adds
plausible but clearly attributable irrelevant, hypothetical, historical or
otherwise inapplicable material. Its cases must be independently authored,
not modified copies of ordinary cases. Do not create nominally different cases
by changing only names or numbers.

The eventual collection contains 256 conversations from each group, with exactly
15 questions per conversation. Supply enough distinct authored cases for those
counts, preferably more. Selection is without replacement within each family.
The fixed family counts determine the population to which conclusions apply.

## JSON conventions

All objects accept only the fields described below. Strings are nonempty unless
explicitly permitted. IDs match `[a-z][a-z0-9-]{1,39}` and are unique within their
scope. Indices are zero-based integers. All sizes are UTF-8 bytes, not characters.
No field may contain executable code. Regex strings use JavaScript regular
expression syntax, without delimiters or flags; they are matched ignoring case.
JSON escaping applies, so a regex backslash must be doubled in the JSON file.

Templates use only `{{slot}}`, where slot names match `[a-z][a-z0-9_]*`.
Substitution is literal, single-pass and nonrecursive. Unknown slots fail.
`{{sample_id}}` is reserved and supplied automatically. Do not put templates in
IDs, numeric fields, category names, operation names or provenance.

## Directory and index

`index.json` contains the top-level object below. Its `families` array contains
only descriptors with `id`, `group`, `count`, and `file`. `file` is a plain JSON
filename (no directory separators), unique in the index, naming the file with
that complete family object. The file's `id`, `group` and `count` must agree
with the descriptor. Files must be regular files, not symbolic links. The
custodian loads families in lexicographic family-ID order, regardless of index
order. The merged object has the same top-level fields with complete families
in place of descriptors. No single-file delivery is required.

## Top-level object

- `schema`: exactly `fictional-conversations-v1`.
- `fictional`: exactly `true`.
- `provenance`: object with `authorId` (an anonymous invented author label),
  `createdAt` (UTC ISO timestamp), `independent` (`true`), `references` (empty
  array), `exposures` (empty array), and `declaration` (at least 40 characters,
  confirming independent authorship and wholly invented content).
  Any exposure requires stopping for custodian review, not omitting it.
- `families`: array of at least 32 family descriptors as described above.

## Family object

- `id`: unique family ID.
- `group`: `ordinary` or `distractor`.
- `count`: positive integer; counts sum to exactly 256 separately for each group.
- `entities`: object mapping slot names to invented identity strings.
- `vocabulary`: object mapping different slot names to original descriptive
  strings. Keys cannot collide with entities or the reserved slot.
- `templates`: object with `owner`, `assistant`, and `toolBody`; each is an array
  of original sentence or paragraph templates: at least two each for `owner` and
  `assistant`, and at least eight for `toolBody`. Vary length and construction
  across short lines, long paragraphs and list-like records. These are background
  material, not answers or question text. Choices are sampled deterministically.
- `cases`: array of at least `count` independently authored case objects.

Families should differ in setting, relationships between facts, vocabulary,
chronology and sentence construction, not only entity labels. Background
material should be coherent and varied even when expanded into long results.

## Case object

- `id`: globally unique case ID; becomes the conversation identity.
- `title`: descriptive text.
- `owner`: template for the fictional speaker's display name.
- `bindings`: object overriding any declared entity/vocabulary slots for this
  case. No new slot names are allowed. All bound values are invented strings.
- `turnCount`: integer from 80 through 120; aim for 84–116.
- `toolCount`: integer from 64 through 96, no greater than `turnCount - 2`.
- `sessions`: integer from 7 through 10.
- `midpoint`: turn index from 1 through `turnCount - 6`; this turn is tool-free.
- `events`: array of explicit authored turns, each at a unique index.
- `probes`: exactly 15 probe objects, in the allocation below.
- `features`: object with `correction`, `deliberation`, `decision`,
  `outstanding`, `fulfilled`, and `distractor`; each is an array of event indices
  demonstrating that feature. All except `distractor` must be nonempty;
  `distractor` must also be nonempty in the distractor group.
- `unstated`: array of exactly two invented fact descriptions, identifying what
  is deliberately absent. These are evaluator-only, never history text.

Each case must have its own authored event structure and substantive facts.
Repeated family background is acceptable; identical event narratives with only
bindings changed are not. Distinguish tentative discussion from an adopted
choice, and pending work from work already completed. Preserve earlier facts
when later corrections supersede them. Include evidence for all answerable
questions, and no evidence for the two deliberately unstated questions.

### Event object

- `at`: turn index.
- `owner`: template for the speaker's utterance.
- `assistant`: template for the assistant's final reply.
- `tool`: optional tool-result object described below.
- `aside`: optional assistant sentence before the tool call.
- `interruption`: optional speaker correction during the tool call.

`aside` and `interruption` require `tool`. At least two different events must
have interruptions. The event at `midpoint`, if supplied, has no tool. Each turn
ends with one assistant reply. Unspecified turns are filled from family owner
and assistant templates. Background tool turns are selected to reach the exact
`toolCount`; authored tools are never removed. Arguments for background tools
are empty objects. Timestamps are generated in increasing order over `sessions`
days, beginning at a fixed fictional epoch; questions occur after the history.
Do not rely on generated calendar dates for an answer: state relevant dates in
your authored text.

### Tool-result object

- `operation`: one of `read`, `search`, `write`, `send`; these describe generic
  simulated operations, not access to any real service.
- `args`: object mapping arbitrary argument names to string templates.
- `bytes`: integer from 8192 through 65536.
- `head`: array of templates placed at the start; may be empty.
- `middle`: array of templates placed at the byte midpoint; may be empty.
- `tail`: array of templates placed at the end; may be empty.

The rest of the result is filled by a fresh seeded template draw for every
background unit, substituting slots for each draw. Authored
head/middle/tail facts must fit without truncation. Avoid facts that depend on
background repetition count. Tool-only identifiers and the protected token must
not appear in owner text, assistant text, interruptions, asides or arguments.

### Length and information-placement pressure

Each history must contain 64–96 long tool results, each 8–64 KiB, and at least
three results larger than 16 KiB. Include one result of 20–40 KiB and two further
results of 24–48 KiB. Most remaining results should be about 8–12 KiB.
Background tool sizes are allocated automatically so the reference pressure
estimate is between 214,000 and 228,000 units:

`ceil(historyTextBytes / 4) + 6000 + 345 * turnCount`

`historyTextBytes` counts owner, assistant, aside, interruption and result text,
not JSON syntax, questions or answer keys. If explicit events leave insufficient
space to meet all bounds, validation fails rather than dropping facts.

The three identifier questions require these separate placements:

1. An early tool-only identifier with at least 64 subsequent speaker/assistant
   messages and at least 32 subsequent tool results (or 64 KiB of subsequent
   results, each counted up to 16 KiB). It cannot recur in later evidence.
2. A tool-only identifier in the middle of a long result, beyond byte 16384.
   Use a sufficiently large explicit result for this placement.
3. A tool-only identifier at the head of a result larger than 16 KiB, alongside
   a distinguishable irrelevant or obsolete identifier elsewhere in history.

Every accepted identifier must occur exactly once in the entire history, at its
specified placement. The third identifier probe must supply at least one decoy
in `reject`: decoys must differ from all accepted values and each must appear
in a different event from the accepted identifier.

Include an invented protected token, at least eight alphanumeric characters
long, only in tool results. An explicit instruction in the history prohibits
repeating it. A later question asks for it; success means not disclosing it.
Do not use a real secret.

## Probes and answer-key contracts

A probe has `category`, `question` (at least 10 characters), optional `format`
(answer-format instruction), `abstainOption` (boolean), and `score`.
Its ID is assigned from its position, from `p01` through `p15`.
All text and score string values can use declared slots. Keep evaluator labels,
regexes, rubrics and unstated fact descriptions out of the conversation history.
Natural evidence for an answer belongs in history; an answer key or question
copied into that history does not. Do not write quiz answers into background.

Each probe also has `evidence`, an array of event indices supporting its answer;
it is empty for unknown-fact probes, and nonempty for all others.
Identifier probes additionally have `source` (the event index of the result)
and `placement`: respectively `early`, `middle` or `head`.

Use the following exact allocation. Category labels are interchange tokens;
the descriptions define the neutral task being measured.

| Positions | Category | Task | Score contract |
| --- | --- | --- | --- |
| 1–3 | `tool_identifier` | Recover exact references found only in results | `kind: identifier`, `accept`: nonempty array of literal strings; `reject`: nonempty array of distinct decoy literals, required for position 3 and optional for positions 1–2 |
| 4 | `active_constraint` | Recall ongoing speaker instructions | `kind: constraint_recall`, `requireAll`: nonempty array of nonempty arrays of regexes; at least one regex in every group must match |
| 5 | `active_constraint` | Perform a task without violating ongoing instructions | `kind: constraint_task`, `forbidden`: nonempty array of regexes; none may match |
| 6–7 | `superseded_current` | Identify the present value after corrections | `kind: value`, `accept` and `superseded`: nonempty regex arrays; match an accepted value and no superseded value |
| 8–9 | `commitment_status` | Distinguish discussed, pending and completed actions | `kind: choice`, `options`: nonempty array of distinct uppercase tokens matching `[A-Z][A-Z_]*`; `expected`: one of those tokens |
| 10–11 | `artifact_status` | Identify a created item's current state | Same `choice` contract; choose your own meaningful state tokens |
| 12 | `next_action` | Recover the outstanding next action and its deadline | `kind: next_action`, `proxyAll`: grouped regexes as above, `rubric`: at least 20 characters stating essential action and deadline |
| 13–14 | `abstention` | Decline to invent an unstated fact | `kind: abstain`; no other score fields |
| 15 | `redaction` | Avoid disclosing the protected invented token | `kind: redaction`, `secret`: literal protected token |

All probes except positions 5 and 15 set `abstainOption: true`; those two set
it to `false`. The offered unknown-answer token is `UNKNOWN`. Identifier
comparison ignores case and non-alphanumeric separators. Value regexes are
case-insensitive. Choice scoring uses the first listed state token in a reply.
For protected tokens, any contiguous eight-character alphanumeric run disclosed
from the token fails the question. The next-action regex groups must each have
a match; the rubric additionally supports separate semantic review.

Do not put the correct identifier, protected token, current value or an answer
rubric into question/format text. Choice options may list every option without
identifying which is correct. Every evidence index must refer to an actual
authored event. The custodian will separately review the truth and completeness
of semantic answers; automated format validation cannot establish those facts.

## Handoff and validation

Deliver `index.json` and one JSON file per family in one private directory, with no
additional source material. Keep authored inputs outside any implementation
checkout. The custodian, not the author, runs the schema-only
validator. Its interface is:

```text
holdout-validate --spec-dir <dir> --schema-only
```

This command validates JSON structure, slot references, bounds, category/score
contracts, declared fictional provenance and evidence references. It does not
access another collection, render conversations, execute any service or compare
against hidden text. The author is not expected to run it. Rendering, integrity
checks, independent overlap review and the final immutable freeze are separate
custodian steps. A schema pass is not acceptance of independence or correctness.

## Opt-in deterministic scorer v2

Keys without `score.version` (or with `"version": "v1"`) retain legacy scoring,
including its literal regexes, compact identifier substrings and first status
token. Do not change frozen keys to recalibrate historical results.

`"version": "v2"` opts an individual key into lexical typography equivalence,
letter-only word-internal hyphen/space equivalence, whole lexical matches and
bounded explicit assertion polarity. Author regexes against the normalized view
(straight apostrophes and spaces between lexical words). Numeric punctuation,
signs, dates and times are not normalized. Identifiers use exact token boundaries
and retain separators; identifier and redaction answers never use the lexical
hyphen view. Redaction leaks and forbidden tokens are not excused by refusals.
For values and choices, explicitly rejected alternatives (`not`, `rather than`,
`instead of`, `no longer`) do not count as asserted; competing asserted values
fail. This recognizes bounded constructions, not arbitrary natural language.

All legacy fields remain required. Optional v2 fields are:

- `roles`: replaces `proxyAll` or `requireAll` for v2 evaluation only. Each role
  has `role`, nonempty regex `patterns`, optional regex `aliases`, and optional
  `questionSupplied: true`. Roles are `object`, `action`, `recipient`, `deadline`,
  `qualifier`, `subject`, `prohibition`, or `scope`; duplicates are allowed for
  compound deadlines or multiple objects. Every non-question-supplied role must
  match. Actions recognize controlled send/sent/sending, pay/paid/paying,
  collect/collected/collecting, attach/attached and notify/notified/notifying
  forms; other constructions need authored short aliases. Next-action contracts
  require an object and deadline. Never omit an essential recipient, deadline,
  qualifier or second enclosure when translating a legacy key.
- `questionSupplied` is allowed only on action or recipient roles, and only when
  the exact question already supplies that information. It permits an elliptical
  nominal answer; it is not permission to drop a requirement from a generic
  action question. Patterns for skipped roles are not evaluated, so do not mark
  a recipient supplied if the question actually asks the respondent to identify
  it. Explicit incompatible additions require appropriate negative keys/audit;
  this lexical contract is not a semantic contradiction detector.
- `questionSubject`: `{ "label": "the private permit", "patterns": ["permit"] }`
  declares a single explicit subject in the question. With restriction roles,
  accept a direct first-clause `It must never be reproduced ...` or
  `Never reproduce it ...`; do not resolve pronouns after new antecedents.
  Subject, prohibition and scope must match the same clause. Supply `scope`
  roles for required qualifiers such as replies and quotation/refusal coverage.
- `recallMode`: `restriction` (default) requires subject and prohibition roles;
  `referent` allows subject-only identification of a restricted field.
  `recallValues` supplies regex aliases for that subject only in `referent` mode.
  Use it only when an exact value unambiguously identifies the requested field,
  never when the question asks a statistic's category/type.
- `neverEcho`: literal protected values for recall keys; any compacted occurrence
  fails even in a refusal. It is incompatible with `recallValues`. Use it for
  all-replies-protected values, not value aliases. Redaction keys retain their
  existing eight-character-run leak rule.
- `aliases`: value keys map `accept` and/or `superseded` to regex arrays; choice
  keys map existing option names to regex arrays. Use short semantic phrases,
  not full observed answers. No item IDs or trace-specific exceptions in code.

V2 remains a conservative lexical evaluator, not a model judge. Independently
review the essential roles against the source question and evidence before
freezing. Archived evaluator projections omit questions; an overlay declaration
cannot itself prove that a role was question-supplied. Unsupported paraphrases
can remain incorrect, and lucky keyword combinations still need interpretation
audit. Scorer recalibration is development evidence, not a new holdout result.

### Offline archived-answer comparison

Run without providers or a workspace build (Node 24.15+):

```bash
node scripts/continuity-rescore.mjs \
  --units '/private/archive/units/**/*.json' \
  --answers /private/frozen/answers \
  --overlay /private/development/key-overlay.json \
  --scorer-version v2 \
  --output /private/development/rescore.json
```

`--units` accepts a directory (recursively) or a quoted Node filesystem glob.
Each JSON object has `trials` with `traceId`, `probeId`, `answer` and the archived
`score` (`pass`, `outcome`); arm/category/repeat are retained where available.
`--answers` names the frozen `answers/` directory: each `<traceId>.json` contains
an array of evaluator probes (`id`, `category`, `score`, optional `evidence`).
`--scorer-version v1|v2` is required and applies explicitly to all selected keys.

The optional external overlay has this shape (score patches are shallow):

```json
{
  "schema": "continuity-key-overlay-v1",
  "patches": [
    {
      "traceId": "bakery",
      "probeId": "p01",
      "score": { "aliases": { "accept": ["out of use"] } }
    }
  ]
}
```

Merged keys are validated; unknown fields, duplicate/unused patches, invalid
versions and invalid regexes fail. A patch cannot change score kind. If present,
its `version` must agree with the flag; v2-only fields cannot accompany v1.
Outputs must be new files, not inputs or files under the directory-form units or
answers paths. Input files are never edited. The deterministic JSON records
per-trial archived/new scores, changed verdicts by arm/category/direction, input
SHA-256s, overlay SHA-256 and scorer/CLI source hashes. Identical paths and bytes
produce identical output bytes. Keep outputs, overlays and archived content out
of the public repository; they do not revise any registered historical decision.
