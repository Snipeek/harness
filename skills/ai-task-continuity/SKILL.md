---
name: ai-task-continuity
description: Resume substantial unfinished work after a user interruption, context compaction, restart or background research, preserving the original goal and recording evidence without restarting exploration.
---

In the coordinating agent, use task_state to recover the original user goal, subsequent clarifications, pending steps, current focus, changed paths and check receipts. Those records distinguish user instructions from model plans and tool evidence. A summary or helper report cannot create a new task or turn an unverified claim into a successful check.

Choose the next unresolved dependency that advances the user's outcome. Keep update_plan compact: focus, next_action, pending/running/done steps, blockers, hypotheses and evidence pointers. Record decisions and the reason when they change; don't keep narrating the same plan each turn. Preserve full details in artifacts or the original journal, and retrieve only the source needed to resolve a decision.

A user message during work normally refines that work. Answer a status question briefly and resume. Incorporate corrections into the pending step; invalidate assumptions and stale proposed edits affected by the correction. Preserve unaffected work. Replace the task only when the user clearly cancels or requests an incompatible objective. Defer optional improvements instead of silently expanding scope.

Before handing off independent research, give its question, relevant paths, constraints, expected evidence and stop condition. The main agent keeps architecture and integration ownership. When a helper finishes, inspect its evidence, integrate what changes the decision, and resume the pending action. A helper's “done” status does not close the parent task.

After compaction, restart or a long pause, check freshness of architecture_map and changed files before relying on remembered code. Reuse valid findings instead of repeating the entire investigation. If evidence is missing, mark it unknown and read its source. Do not overwrite a checkpoint with unsupported certainty.

Finish when requested behavior and preserved contracts are checked, or report a concrete remaining blocker. Distinguish tested behavior, command success and unavailable checks. Do not mark all plan steps done merely to stop a continuation reminder.
