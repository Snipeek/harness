---
name: ai-module-evolution
description: Understand and extend an existing module or design a new module within a repository, preserving ownership, dependency boundaries and existing contracts. Use for substantive architecture, refactoring or cross-layer features; ordinary small edits need no architecture ceremony.
---

Build an evidence-backed working model of the affected module, then make the smallest coherent change that accommodates the requested behavior.

Start from the user's observable outcome. Use task_state when available; a subagent follows its self-contained assignment rather than the coordinator's whole plan. Search entry points and their actual callers before reading entire directories. Use code_navigation symbols/references when available; search_files is the fallback. Read implementation, one representative consumer, persistence/transport boundary if present, and relevant tests. Stop exploration once you can identify the owner, invariant, data path and remaining uncertainty that could change the decision.

Look for an existing architecture_map for the affected area. Check its freshness; a map is a model-authored hypothesis, not proof. Follow source pointers and revalidate changed files. Update the map only after reading its sources. Keep it specific: responsibility, public API, owner of state, inbound/outbound dependencies, key contracts, lifecycle and test seams. Do not map the whole repository for a local change.

Before writing, record a concise update_plan: invariant; existing owner; source → transformation → consumer → observable effect; preserved contracts; chosen seam and why. Consider the next likely extension as a design probe, not an invitation to implement speculative requirements. Prefer a representation that makes invalid states difficult over extra synchronizers, flags and duplicate state. Compare alternatives only when the choice materially affects correctness, scaling or future changes.

For a new module, locate its real caller and integration point first. Define its input/output, failure/cancellation contract and dependencies. Reuse repository conventions and existing infrastructure. Avoid a standalone abstraction with no integrated consumer, or generic frameworks for one use case.

Scale reasoning to the task. Use high/max for ambiguous invariants, concurrency and architecture decisions. Once the seam and contracts are settled, set_reasoning_effort can lower effort for mechanical execution when the policy permits; raise it again when evidence disproves the design. A substantial independent uncertainty may go to an explore/plan subagent with a bounded question, relevant paths and stop condition. Ask for sources, counterexamples and uncertainty, not a required negative verdict. Keep one writer for a connected change. Accept helper findings by inspecting critical artifacts; do not copy their whole transcript into the main context.

Implement a vertical slice through the real data path. Preserve old inputs, seed data and API contracts. Verify the requested case, a boundary/failure case and a regression case at the consumer. For refactors, verify behavior before/after; for new fields, check serialization/normalization and every affected consumer. Inspect the final diff for unrelated changes and temporary verification data. A passing command is not an acceptance oracle.

Keep the focus and next action in update_plan. Use task_state after an interruption or compaction; unfinished work remains pending. If the user disproves a fix, reproduce the actual counterexample before another patch.
