---
name: ai-change-validation
description: Design acceptance checks for a behavior change, refactor or recurring failed fix, tying verification to observable outcomes and preserved contracts rather than only compilation or a helper verdict.
---

Identify the original failure and the user's acceptance condition. Select a check that would fail before the change and pass after it. Add the boundary most likely to disprove the proposed invariant: empty/zero/missing values, out-of-order completion, cancellation, duplicate events, reload/persistence or a second consumer, as relevant.

Use the real source → transformation → consumer path. A helper-only test cannot validate missing integration. Preserve existing regression tests and original data. Temporary inputs belong in test setup, not production fixtures. Do not weaken assertions or change defaults to manufacture a green result.

Run focused checks first, then the repository's relevant integration/build checks. Recognized test commands already record receipts; use verify_task for other approved checks. commandPassed means exit zero, not independent task acceptance. A later edit invalidates the earlier receipt. If a behavioral test already imports/compiles all changed files, separate syntax checks add no coverage. Batch independent check calls when useful, and rerun only when code changes, failures or uncovered cases justify it. If a test is unavailable, explain the limit and inspect evidence; do not replace it with a confident claim.

Read the final diff against the original contract: new feature integrated, old consumers preserved, no unrelated data/configuration changes, no temporary probe left behind. A reviewer may find zero issues; evaluate findings by the current task and evidence, not by a demand to criticize.

For architecture changes, probe the next likely extension through a test or design check. Avoid rewarding fewer lines or more abstraction by itself. Prefer the design with a clear owner, fewer independent obligations and preserved behavior under change.
