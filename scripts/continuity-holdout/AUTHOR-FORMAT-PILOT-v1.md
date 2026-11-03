# Fictional conversation authoring — pilot population v1

This is a population-only delta to [AUTHOR-FORMAT.md](./AUTHOR-FORMAT.md).
Use its identical authoring rules from “Assignment and boundaries” through
“Probes and answer-key contracts”, except for the counts replaced below.
All JSON conventions, provenance, independence, fictional-data boundaries,
lengths, placements, question allocations, answer keys and evidence rules
remain unchanged.

- Write exactly **eight** genuinely different families: **four ordinary** and
  **four distractor** families. Distractor cases must be independently authored,
  not modified ordinary cases.
- Supply exactly **one conversation per family**, giving **four conversations
  per group** and **eight conversations total**.
- In the top-level object, `families` contains eight descriptors.
- In each family object, `count` is exactly `1`, and `cases` contains one
  independently authored case. Counts sum to four separately for each group.
- Each conversation has exactly **15 questions**, with the identical allocation,
  question/evidence and answer-key rules in “Probes and answer-key contracts”.

Do not obtain apparent diversity by changing only names or numbers. Deliver
`index.json` and one JSON file per family in a private directory.
