---
name: flaky-tests
description: Tell a flaky test from one that fails every time.
---

# Flaky tests

1. Follow the triage notes to rerun the failing test.
2. When a failed test passes, run it twice more on the same commit with the same inputs.
3. List flakes separately. A pass on rerun isn’t a fix.
4. Name the owner from `CODEOWNERS`, or say you couldn’t find one.
