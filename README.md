# GLM Token Usage · AI

An independent VS Code coding agent, with an AI activity bar icon, a sidebar with usage analytics and a conversation manager, conversations opened as editor tabs, streaming, reviewable file edits and the existing GLM quota status item. It does not bundle or depend on Claude Code.

## Start

Install the VSIX, reload the VS Code window, then click **AI** on the left or press **Cmd+Escape** (Ctrl+Escape on Windows/Linux). Open a trusted local project folder.

The existing GLM key can be read from `~/.claude/settings.json` if its Anthropic base URL identifies z.ai/BigModel. The default model is `glm-5.3`. Set `glmTokenUsage.glmModel` to an empty string to import the legacy GLM model as well. No settings are changed in that file. To override them, choose the gear → **GLM** and enter a base URL, exact model ID and key. Keys entered here go into VS Code SecretStorage. A model must be supported by your account; the legacy model can be unavailable on your plan.

GLM Coding Plan URL: `https://api.z.ai/api/coding/paas/v4`. Standard GLM API URL: `https://api.z.ai/api/paas/v4`. These use different billing. Check your plan's supported tool environments before using subscription quota in a custom client.

OpenAI is available as a separate **Responses API** adapter: gear → OpenAI → model ID → API key. This is API-key authentication, not signing into a ChatGPT/Codex subscription. OpenAI has not been live-tested without a user-supplied API key. Custom endpoints can use Chat Completions or Responses. Each conversation is pinned to its provider/model; start a new conversation after switching.

## Workflow

- The **AI** activity bar opens **Account & Usage** and **Session Manager** in one custom sidebar, with groups, search and archive. There is no chat input in the sidebar.
- Conversations open as editor tabs, next to files. Clicking a conversation opens its tab; clicking again re-activates it. A new conversation gets its own tab; tab titles follow conversation titles. Rename and delete from the conversation list.
- Past conversations live in global extension storage and are pinned to their project folder: continuing a conversation requires opening the folder it belongs to.
- Attach workspace files using **+**, or use **AI: Add Selection to Chat** in the editor context menu (Cmd+Alt+K). The current editor path is included automatically; its contents are read by a tool on demand. Explicit attachments send their text to the configured API.
- Streaming answers with code blocks and copy buttons. Tool inputs, outputs and errors are expandable.
- **Manual**: file changes require approval after a VS Code diff; shell commands always require approval.
- **Plan**: read/search, code navigation, diagnostics, skills, resource discovery and task planning. Shell execution and edits are disabled.
- **Accept edits**: file changes are applied automatically; commands still require approval. Diffs and undo remain available in tool details.
- **Auto** runs Bash commands automatically in trusted workspaces and asks for confirmation for recognizable `rm` invocations. Switching to Auto also rechecks commands already waiting in the current chat.
- **Stop** aborts the model request and running shell process. Previously completed edits remain; each edit has an undo action. Undo refuses to overwrite newer changes.
- `/new`, `/clear`, `/settings`, `/plan` shortcuts.
- **Claude Code history**: existing `~/.claude/projects/**/*.jsonl` conversations appear under **Разговоры → Claude Code** with their source project. They are read-only (branching via `parentUuid`, duplicates and sidechains handled); original files are never modified. To continue one in this extension, open it and press **Продолжить копией** — that creates a clearly marked local copy.
- Workspace `AGENTS.md` and `CLAUDE.md` are read as project instructions at the start of each turn.

File tools stay within the selected workspace, including symlink checks. Commands execute as the user with the workspace as their working directory. They are **not sandboxed by default**. The opt-in macOS sandbox restricts writes to the workspace and `/private/tmp`, blocks network and home-directory content outside the workspace; it is not a container and does not isolate other system-readable directories. It fails closed when unsupported. Review commands before approving. Search uses ripgrep over up to 20,000 eligible files with regex, context lines and pagination; scope truncation is reported. File reads are limited to 1 MB. Large tool results are archived and context is compacted at complete message/tool boundaries; the full transcript is retained.

## Development

Runtime dependencies: the official MCP TypeScript SDK and Ajv. Run `npm ci` before development or packaging. Node.js 22+ and Python 3 for packaging.

```sh
npm run check
npm test
npm run package
```

For development, launch VS Code with `--extensionDevelopmentPath=/absolute/path/to/glm-token-usage`. Do not load the development copy and the installed copy simultaneously in the same extension host.

### Releasing

Publish every new extension version to [ebuilde.ru/harness](https://ebuilde.ru/harness). Follow the [deployment instructions](deploy/static/README.md) to upload the versioned VSIX, update the current download and release manifest, and verify that the public download matches the manifest's SHA-256.

This is a new implementation inspired by a familiar agent workflow. It is not a copy of Claude Code. It does not implement Claude's proprietary agent behavior, MCP, checkpoint engine, cloud sessions, skills catalog or automatic context compaction. Subagents use this extension's independent implementation.

API references: [GLM Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion), [GLM endpoints](https://docs.z.ai/devpack/tool/others), [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling).


## Version 0.4.0

The activity bar now opens a dedicated **Account & Usage / Session Manager** webview. It includes collapsible sections, quota meters, one unified list, source filters, active-session filtering, search, groups, relative timestamps, hover actions and an archive. Rename/archive/group metadata for Claude Code sessions is local to AI: original Claude transcripts are never modified. Double-click a group heading to rename it; use a row's move action to assign a conversation to a group.

Chats stay in normal editor tabs. Reopening a session activates its existing tab. The chat uses a continuous activity timeline, compact expandable tool calls, code previews, a centered composer with the model and permission mode, message copy/bookmark controls and Focus view. There are no fabricated reasoning traces: the live agent displays work status and elapsed time; saved Claude thinking blocks are rendered only when present in the transcript.

**Real subagents:** the parent can call `delegate_tasks` with 1–3 independent tasks. Each receives its own model context and runs concurrently. Top-level delegation starts in the background by default and inserts reports as each subagent finishes. The parent can continue independent work or pause until a completion or user message arrives. Ask it to wait explicitly when the next action depends on the report. Explore and Plan agents are read-only. General agents can use the normal tools with the parent's permission mode. Each agent has a live card with activity, usage, duration and a Stop button. Stopping the parent stops its children. Child token usage contributes to the conversation total. Edits to the same file are serialized within the extension host to avoid concurrent overwrites.

Use `/agents` or the subagents button in the composer to request two read-only project investigations. Subagents default to the GLM model named by `ANTHROPIC_DEFAULT_HAIKU_MODEL` unless a project role specifies a model. To use another connected model for one assignment, name it in the request, for example “Have Qwen check the parsing as a subagent.” Harness uses the named connection for that assignment. Use its full connection label if several connections share a model family. The parent keeps its own model and receives the findings. The subagent card shows the model that handled the assignment.

Claude history import now preserves tool calls/results and saved thinking blocks, traverses non-message parent links, keeps manual titles, and loads subagent transcripts associated with recorded `agentId` values when available. Imported conversations remain read-only; continuing creates an independent copy tied to the original project folder.

Validation: 22 Node tests; isolated VS Code integration test with a local API exercises actual editor panels and two child agents through six model requests. A real GLM check uses only a synthetic `hello.txt` fixture. `test/vscode-smoke.cjs` is an extension-host test, not a plain Node test; run it through VS Code's `--extensionTestsPath` in an isolated test profile.


## Version 0.5.0

The chat geometry is aligned with the installed Claude Code IDE reference: a 680px composer, 26px action buttons, a one-line initial input and 16px bottom inset. The invented hero/toolbar and standalone subagent glyph were removed. Standard SVG actions replace font-dependent glyphs throughout chat/sidebar controls. The empty screen uses an AI wordmark and monogram in place of Claude branding.

Permission modes, model selection and attachment actions now open themed in-chat menus, with icons, descriptions, selected marks, Escape dismissal and keyboard navigation. Shift+Tab cycles the three supported permission modes. `/model`, `/permissions`, `/focus` and `/agents` are available in the command menu. Model changes within the same provider/protocol preserve the conversation; changing provider or protocol still requires a new session. Auto/Ultracode and proprietary Claude service features are not implemented.

## Version 0.6.0

A subagent-tree button now sits immediately next to the model selector. Its popup shows the parent model, child-agent hierarchy, live status, elapsed time and individual stop controls. Selecting a node expands and scrolls to the matching agent in the transcript. The popup remains usable while the parent is working. Completed agents remain available for inspection. Read-only Claude history also exposes the tree while disabling message input.

The transcript is grouped by user turn. Each response has one continuous connector joining text, tools, results and delegation batches, rather than separate lines and padded blocks for every event. Tool previews are drawn as result leaves. Copy/bookmark controls no longer reserve empty vertical space. Four new tests cover turn boundaries, streaming identity, nested agent hierarchy and duplicate-agent records (26 tests total).


## Version 0.7.0

The session transcript has one rail across turns, with branches to user messages, assistant messages, tools and agent launches. Inline subagents are shown as `Agent: title` with compact IN/OUT previews, matching the tool-style transcript layout. The footer has an active-agent chip before the model selector.

Clicking an inline agent or the chip opens a centered **Agent map** modal. The parent session is on the left, child tasks on the right. Selecting a task opens a second, narrower detail dialog above the map: status, type, model, parent, time, tokens, full text result and expandable task/tool history. Back returns to the map; Close dismisses both. Reports remain selectable plain text; streaming updates and individual stop controls are supported.

Permission prompts are neutral numbered choices replacing the input while a decision is pending: **Yes**, **Yes, and use Auto mode**, **No**. The command/file, project, agent and review reason are visible. Keys 1/2/3 and Escape work when focus is outside text input.

**Auto** approves ordinary workspace edits and validated read commands. In a trusted workspace it also runs standard project checks automatically, including conventional npm test and typecheck scripts, `node --test`, and the workspace-installed TypeScript compiler with `--noEmit`. npm runs the selected script and skips its pre/post lifecycle scripts. Other commands open a one-time confirmation. Protected edits remain blocked. General subagents track the parent's current mode. Explore and Plan remain read-only. Switching to Auto releases eligible pending commands and leaves other command confirmations open.

Validation adds five Auto-policy tests covering direct execution, quoted paths, protected files, traversal/symlinks, command injection and denial without side effects (31 unit tests total). The VS Code integration check additionally exercises Auto read execution, Auto editing and denial of a command requiring review.


## Version 0.8.0

Waiting for a response now uses a separate animated activity glyph and rotating status labels beneath the transcript, replacing the blank assistant `Working… Ns` block. A real provider reasoning stream creates a collapsible **Thinking…** row before its associated answer, which becomes **Thought for …** on completion. Reasoning token counts are displayed only when explicitly reported by the provider. No reasoning text or token counts are generated by the UI. Chat Completions `reasoning_content` and public Responses reasoning-summary deltas are supported; encrypted reasoning items stay opaque. Existing GLM thinking settings are unchanged.

Tool calls use compact IDE-style headers: **Read** links to the file; **Bash** uses the optional human-readable `description`. Input/output is rendered in labeled **IN / OUT** rows, clipped with a fade until expanded. Read details are initially collapsed; command details are initially visible. The activity rail now joins Thinking, tool calls and answers within each response, with full-width user messages matching the supplied reference.

Seven new tests cover reasoning order, interruption, absence of invented reasoning/token counts, stream callbacks and tool presentation (38 tests total). The VS Code integration fixture also emits supplied reasoning for the parent and subagents.

Reasoning event reference: [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).


## Version 0.9.0 — agent runtime

- GLM capability-aware thinking, preserved reasoning, low/high/max effort in the model menu, per-task escalation and bounded pre-stream retries. Default low is the economical starting point; difficult work can request more reasoning. No automatic replay after a partially consumed stream.
- Independent adjacent read tools run concurrently; mutations and unknown tools remain ordered. Search uses VS Code's bundled ripgrep where available and checks canonical file paths before searching. Multi-file range reads, diagnostics and symbol/definition/reference navigation are available.
- Background commands have conversation-owned IDs, polling, cancellation, time limits and output artifacts. Logs retain up to 10 MB with an explicit truncation flag; the immediate output is bounded.
- Context budgeting uses a conservative UTF-8 heuristic, not an exact tokenizer. Completed groups are summarized in bounded fragments; original history, recent messages and unsummarized reasoning remain intact. Large tool responses get archive IDs. Current context estimates, cached input and reported reasoning usage are visible in the token tooltip.
- `update_plan` persists the original goal, constraints, invariant, data flow, steps, acceptance and verification requirements. The plan is visible above chat. A premature final answer with pending steps triggers bounded continuation. It is not a proof that the model's plan or a self-reported completed step is correct.
- Enter during generation queues an immutable clarification and attachments. It is inserted at the next safe boundary and saved across restarts. A separate send-clarification button appears while typing; Stop still stops. Original work is preserved in the transcript and plan.
- `verify_task` records the actual command result, task/turn ID and this turn's changed paths. Edits are tracked by event/turn identity, not filesystem mtime. A passing command alone does not prove every acceptance criterion. No Flash Stop judge or user-global hook was added or modified.
- Background subagents return IDs immediately, can be waited on or stopped, preserve nested transcript trees, and have context, token, round and depth limits. General workers still share the workspace and per-file edit locks: isolation into independent Git worktrees and conflict merging are not implemented.
- MCP supports stdio and Streamable HTTP through the official SDK, relevant-tool discovery, selected schema loading, list-change notifications, validation, cancellation and resource reads. External tool execution still asks for approval. Remote bearer tokens use **AI: Set MCP Token** and SecretStorage; interactive OAuth is not implemented. Add trusted servers in application-scoped `glmTokenUsage.mcpServers`, then reload configuration. Local server commands execute when discovery connects them.
- Project `.agents/skills/**/SKILL.md` and `.claude/skills/**/SKILL.md` are listed and loaded on demand. Root AGENTS.md/CLAUDE.md remain supported. There is no automatic cross-project memory or inherited user-global hook execution.

### Integrated browser

On VS Code Desktop, Harness defaults new integrated browser tabs to the side editor group. If you set a different browser placement in VS Code, Harness follows that setting. When browser tools are disabled, enable them with **Harness: Set Up Integrated Browser** or **Skills and MCP → VS Code Browser → Настроить**. In a Harness chat, ask to open a URL such as `http://localhost:3000` and check an element.

The in-process MCP server gives the current conversation access to the browser pages it opens. Use a text snapshot to find headings and section selectors. A section screenshot scrolls to the element and captures it in one call, including inside scrollable containers. Full-page screenshots cover the document up to the tool's image limits. For oversized documents or content inside a separate scroll container, inspect and capture individual sections. Screenshots use the same model-specific image path as chat attachments. Browser tools are available in Manual and Auto.

Example MCP configuration (use your installed server command):

```json
{"glmTokenUsage.mcpServers":[{"name":"local-tools","command":"node","args":["/absolute/path/to/server.js"]}]}
```

### Reproduce measurements

`npm test` covers runtime correctness; the isolated VS Code smoke test covers editor integration, steering and resuming a pending plan. `npm run benchmark` compares search, scheduling and context assembly against a saved baseline supplied by `GLM_BASELINE`. Its context summary is a fixture, not evidence of real summary quality or total token savings.

`npm run eval` sends only synthetic coding fixtures to the standard GLM API by default, using `ZAI_API_KEY` or the existing z.ai credential. Set `GLM_EVAL_TRIALS`, `GLM_EVAL_EFFORT`, `GLM_EVAL_MODEL`, `GLM_EVAL_BASE_URL` and `GLM_BASELINE` explicitly as needed. This small provider/tool-loop pilot is not a complete production-agent benchmark, not an Opus comparison, and not proof of quality improvement. Public smoke checks and separate held-out checks are used; generated code is evaluated in a bounded VM with no Node APIs. Existing high-effort and low-effort measurements are retained in `reports/` including failures and slow cases.

The Architecture profile uses the starting effort selected in the model menu. The decision brief now includes the existing owner, chosen change, preserved contract, unknowns and next likely change. Clarifications arriving before tool execution defer stale actions; pending writing subagents are cancelled for re-evaluation. The parent resumes after its background tasks complete, within the turn budget.

The sequential max pilot is in reports/chain.json. Both arms passed their initial behavior checks, but a separate post-hoc audit found an unintended seed-data change in the decision-brief arm. Original scores and the added audit are retained separately. New rules are not declared a quality improvement on this evidence.

## Version 0.9.1

The composer floats above the scrolling transcript. Scrollback fade covers the full viewport width from above the input to the bottom edge, including behind and below it. ResizeObserver reserves the actual footer height so the final message remains readable at the bottom; the overlay does not intercept pointer events.

## Version 0.10.0 — web, Claude skills and MCP discovery

- **web_search** and **web_fetch** are offered directly to the model, including research subagents. Search uses the official Z.ai Search MCP with the existing GLM key; it returns source URLs/excerpts instead of scraping DuckDuckGo. Public page reading uses bounded HTTPS extraction with Mozilla Readability, with Z.ai Reader fallback. Reader output is paginated; search excerpts do not count as reading a full source. Provider quotas/errors remain visible. Network/API usage follows the account's service terms and quotas.
- User skills in `~/.claude/skills` (including synced skill bundles), project `.claude/skills`/`.agents/skills`, and legacy installed/enabled-plugin skill locations are discovered. Project overrides win; duplicate synced skill names are deduplicated. The model sees names/descriptions, loads content on demand and can read relative supporting resources. Binary resources and path/symlink escapes are rejected.
- Claude's user MCP definitions and per-project definitions from `~/.claude.json` and `.mcp.json` are imported in memory, retaining configured transports, headers, environment and working directory. No Claude configuration is rewritten. Disabled servers are skipped; unapproved project/plugin configurations require **AI: Skills and MCP → server → Connect**. Configured AI servers override imports with the same name. Credentials are not included in model-visible status/catalogs.
- The model menu includes **Skills and MCP…**; the same view is available as **AI: Skills and MCP** in the command palette. It lists discovered skills, server sources and approval/connection status. Opening it refreshes discovery when no work is running. Imported stdio/HTTP/SSE servers and their selected schemas are scoped to the project, rather than shared across unrelated workspaces.
- Claude-hosted browser/computer/account connectors and OAuth sessions are not transferred by copying a SKILL.md. Such skills carry limitations; use a configured browser MCP or other compatible runtime. The importer does not activate every marketplace plugin or execute Claude hooks.

Validation: 54 runtime tests; a live Z.ai search and webpage read; and a live GLM-5.3 tool loop that independently called web_search, then web_fetch, and returned an official source URL. Reports: `reports/web-smoke.json`, `reports/web-agent-smoke.json`.

## Version 0.11.0 — architecture and task continuity

- Three bundled, on-demand workflows: **ai-module-evolution**, **ai-task-continuity**, **ai-change-validation**. Project overrides win. The compact core is the default; `promptStyle=detailed` remains available. `toolProfile=lean` is a separate optional experiment.
- **task_state** preserves genuine user clarifications separately from model plans. Focus, next action, pending steps and hypotheses persist. Compaction includes a runtime checkpoint; full user updates remain retrievable by ID. Updating a plan no longer discards omitted architecture fields.
- **architecture_map**, discoverable through search_tools, stores source-backed module notes per project and checks file hashes on reuse. Stale maps are flagged. Maps are working hypotheses, not an automatically verified dependency graph.
- Recognized test commands record receipts without a duplicate verify_task round. Later edits invalidate old receipts. Command success, syntax checking and independent behavioral acceptance remain distinct. Failed parent turns cancel paid helpers.
- File/artifact reads expose coverage and lossless continuation cursors. Large searches return bounded JSON with pagination. Main-agent web tools now route to the web service correctly.
- Request telemetry separates first SSE from first useful reasoning/text/tool output, records reported model IDs, retries and unknown usage, and attributes main/subagent/compaction requests. Context estimation remains heuristic, with observed-usage calibration.

The **Architecture** work profile uses the configured starting effort; adaptive policy lets the agent change it when the task warrants it. `effortPolicy=fixed` locks effort for controlled comparisons. Profiles and skills do not establish parity with another model.

Research, commands, limitations and sources: `reports/ARCHITECTURE-WORKFLOWS-2026-11-16.md`. Comparison artifacts: `reports/quality-combined-011/`, `reports/architecture-live-011/`, `reports/compaction-live-011/`. The general pilot is synthetic and small; its reports retain failures and explicit evaluator corrections.

## Version 0.11.1

The session manager lists only writable AI sessions, including editable copies of imported conversations. Read-only Claude Code originals are hidden, and the source selector is removed. Original history and integration settings are retained.

## Version 0.11.2

Session actions are available by right-click or Shift+F10; the inline ellipsis is removed. Rename and archive remain inline. Account usage and provider/refresh controls occupy one compact row; exact token counts are available on hover.

## Version 0.12.0

The model menu now lists saved connections and includes **Add model…**. Provider selection and configuration open in a wide panel above the composer. API keys are stored in VS Code SecretStorage. Each conversation retains its connection; changing API origin in a populated conversation opens a new chat.

Empty conversations are not saved or listed, including legacy empty archived placeholders. Unsent text and attachments remain drafts in the editor webview state and can be restored after reload. Session actions remain available by right-click, with rename/archive inline; account statistics and controls fit one row.

## Version 0.12.1

The model picker has compact rows, a 320px height cap bounded by available viewport space, a sticky title and an internal scrollbar. Profile and reasoning choices use two compact button groups. Keyboard navigation skips disabled actions and scrolls the focused control into view.

## Version 0.13.0 — ChatGPT plan sign-in

In **Model → Add model → ChatGPT · подписка Codex**, use **Continue with ChatGPT** to authorize this local app in your browser, select an account model and add the connection. Availability and usage depend on the account and granted ChatGPT plan permission. OpenAI API-key connections remain separate. Existing Codex/ChatGPT app credentials are neither read nor copied.

The extension uses the documented dynamic OAuth registration with a stable local host ID, PKCE, state/nonce checks and signed OIDC identity verification. Credentials stay in VS Code SecretStorage; only account labels and model connection IDs reach the webview. Renewals are serialized within the process and locked across local extension hosts. Each conversation retains its account connection.

Requests use the official public Responses API with streaming, no server-side storage, developer instructions and namespaced local functions. Tool execution, MCP, subagents and compaction remain in this extension. Models are loaded from the authorized account catalog; access is established only when a real request succeeds. No real-account inference is run by automated tests.

Sign-in requires a local VS Code extension host with a loopback callback reachable by the browser. Manage this app’s permission and limits at https://chatgpt.com/settings/usage. Official implementation reference: https://developers.openai.com/siwc/token-sharing-open-source/sign-in.

## Version 0.13.1

The activity-bar silhouette, chat tab icon and empty-chat marks now use a blue radial symbol. VS Code controls the activity bar’s monochrome tint through the active theme; editor tabs and chat retain the blue SVG color.

## Version 0.14.0 — task continuity and compaction recovery

Task-level token, time and round limits are now opt-in: zero (the default) means no artificial task cutoff. Existing explicit nonzero limits remain enforced, and Stop/approvals/provider failures still terminate or pause work. This applies to the main loop and subagents; background results stay attached to the original task. Individual provider requests still have finite output/context limits and timeouts.

Optional token budgets use `budgetAccounting=uncached` by default, excluding only provider-reported cached input repetitions; `total` preserves accounting of every input/output token. Displayed API usage and telemetry retain all tokens. The reported failing session contained 1,012,317 input, 9,450 output and 876,928 cached tokens: 144,839 tokens under uncached accounting.

Compaction uses low reasoning effort and up to 8,192 output tokens; an output-limit failure gets one retry with up to 16,384 tokens, within the configured output/context ceiling. Failed summary usage is retained, original history is not replaced until compaction succeeds, and partial tool calls never execute. Repeated failure remains visible rather than entering an unbounded retry loop.

Validation reproduces cached-budget stopping with the production agent loop, truncated summary recovery, bounded failed recovery, usage preservation and rejection of partial function calls. This is deterministic regression coverage, not a new live quality benchmark.

## Version 0.14.1 — Auto diagnostic commands

Auto additionally approves bounded read-only network diagnostics, including the reported `env | grep -i proxy; echo ...; curl ... | grep ...` chain. Commands are parsed and rebuilt with fixed executable paths and literal arguments. Curl disables user curlrc files and supports only HTTPS reads, short timeouts and optional /dev/null output; uploads, arbitrary output files, shell expansion and arbitrary executables still need review. Existing protected-file and external MCP review policies remain intact. Manual still asks; Plan never executes commands. Switching a waiting diagnostic to Auto releases it.

## Version 0.15.0 — Responses tools and provider usage

Responses output is assembled from streamed output-item and function-argument events, including when the terminal completed response omits its output array. Completed function calls, encrypted reasoning and message phases are retained for the next request. Partial calls are not executable. Empty legacy output arrays no longer erase assistant text from history. Commentary continues the main/subagent loop; repeated commentary without actions stops with an explicit incomplete-task error rather than pretending success.

Account & Usage separates ChatGPT, GLM and other provider token totals across saved writable chats, including archived chats, subagents and compaction. Hover shows exact input/output/cache/reasoning counts. These are local reported API tokens, not a subscription quota estimate. ChatGPT has a link to its official Usage settings for overall plan usage and limits.

Regression coverage exercises the production Responses → file tool → tool output → final reply loop against an actual temporary source file, with an empty terminal output payload. No live subscription inference is invoked by these tests.

## Project roles, memory and hooks

Create `.harness/config.json` in a trusted workspace. Harness reads it at the start of each turn.

```json
{
  "roles": {
    "explore": {
      "prompt": "Trace symbol ownership and cite the relevant source lines.",
      "tools": ["search_files", "read_files", "code_navigation"]
    },
    "plan": {
      "prompt": "Propose an implementation sequence and behavioral checks.",
      "tools": ["read_files", "search_files"]
    },
    "review": {
      "prompt": "Check the changed behavior against its acceptance criteria.",
      "tools": ["read_file", "read_files", "diagnostics"]
    },
    "general": {
      "prompt": "Make the smallest change that satisfies the assigned criteria.",
      "tools": ["read_file", "edit_file", "run_command"]
    }
  },
  "memory": { "enabled": true },
  "hooks": [
    { "event": "beforeFinish", "command": "npm test", "timeout_seconds": 60, "required": true }
  ]
}
```

Each role also accepts a `model` string with an exact model ID from the current chat connection. Omit it to use the existing default GLM subagent connection. Omit `tools` to keep the defaults. Set it to an empty array to run the role without tools. The list is intersected with the tools available in the current permission mode. Explore, Plan and Review remain read-only. General follows the parent session's permissions.

In trusted workspaces, project memory is enabled by default even without a project config. Harness reads project notes into new chats. Set `memory.enabled` to `false` to opt out. Ask it to remember, list or forget a durable note. Saving and forgetting require approval. Notes are stored locally per workspace outside the repository. The most recent 20 keys are retained. Turning memory off stops loading notes.

Hook events are `turnStart`, `beforeTool`, `afterTool`, `afterEdit`, `subagentStart`, `subagentStop` and `beforeFinish`. For tool events, add `tool` to match a specific tool name. Hooks use literal commands from the config and require approval on each invocation. Plan mode skips command hooks. Set `required` to block a tool or leave the task incomplete if the hook fails. A recognized `beforeFinish` check records a verification receipt with file fingerprints. Use `inputs` to track additional files such as fixtures and tests. Add a `criteria` array of exact plan acceptance statements to attach a hook check to those criteria. This configuration is native to Harness.

### Independent Architecture review

After a turn changes files, the Architecture profile reviews the first proposed final revision before following up on missing checks. Review runs in a separate read-only model context. The reviewer receives the original requirements, acceptance criteria, tracked before/after file contents, and recorded check results. The reviewer can inspect related source files. A blocking finding or unresolved question leaves the task incomplete unless review clears the changes. The reviewer can use a passing check recorded on the current revision. A limitation on rerunning an already recorded check does not block completion. Review can revisit a blocked revision when new check receipts arrive. Harness allows up to two independent review passes per turn. Set `glmTokenUsage.architectureReview` to `false` to disable automatic review while keeping the Architecture reasoning profile.

To run the paired synthetic regression, use `node scripts/eval-quality.js --live --suite=architecture --tasks=module-visibility-evolution --experiment=architecture-review --effort=max --prompt=compact`. Both arms use the same configured model, including subagents, and the report includes the independent review results alongside the external grader results.

### Efficient source analysis and revision checks

Use `/retro` in chat to inspect the last finished turn's recorded time, provider usage and repeated tool calls. Harness computes the report locally from session metrics, without a model request.

For an architecture request or one naming a workspace source path, Harness
indexes a small set of relevant README headings and local documentation links
before the first model request. Use `repository_docs` to inspect another
directory or to narrow the index by topic. Documentation is a navigation
hint. Verify ownership and behavior in source and tests. `/retro` also shows
source lookups before and after the first edit attempt, explicit changes to
the plan's hypothesis, owner or decision, and failed tools. It counts unique
complete lines in delivered reads and batch-search excerpts and shows new
lines after each recorded pivot. A benchmark can supply reference ranges
to measure coverage of necessary code alongside the volume of context read.

- `/context` shows provider-reported usage and approximate sizes for instructions, task state, history, skills, tool results and tool schemas. The prefix comparison identifies the first changed Harness request block. A stable prefix alone does not establish a provider cache hit.
- `trace_symbol` combines a bounded text search with VS Code language-provider definitions and references. Text-only fallback labels matches as leads. General MCP search returns ready catalog results and lists servers still connecting. Disambiguate with `server/tool`. MCP calls that advertise task execution can run in the background after approval.
- `/resume` continues unfinished work from saved state and completed background reports. A pending tool with an unknown outcome is marked interrupted on reload. Harness does not automatically replay it.
- `/plan` opens a saved plan as an editor tab. Comments attach to specific steps and approval matches the displayed revision. **Harness: Add to Chat** adds the Explorer selection to the draft, including folder references.
- Set a context window when adding a model connection or use `glmTokenUsage.modelContextWindows` with keys such as `glm/glm-5.3`. A switch to a smaller window can ask for consent to compact on the next message. Optional `glmTokenUsage.idleCompactionMinutes` triggers background summaries of large idle chats and records usage in `/context`. It defaults to zero.

- Balanced mode starts short requests with one explicit attachment on a small tool set when there is no existing plan or project hook. Call `expand_tools` if the task needs broader tools. The normal approval policy applies to edits and commands.
- `search_batch` returns bounded excerpts around early matches. `navigate_symbols` batches definitions and references with excerpts when VS Code has language support. `trace_calls` records caller, callsite, definition and optional branch evidence, checking each quoted excerpt against the current file. The tool checks the excerpts and their revisions. Interpretation of control flow still requires source analysis.
- Load path-level `AGENTS.md` and `CLAUDE.md` through `project_rules`. The file-edit tools surface unseen scoped instructions before allowing a retry. Use `inspect_changes` to compare the task's tracked changes with current file versions.
- `verify_task` accepts `inputs` for test and fixture paths to fingerprint and `scenarios` for a criterion's input and expected outcome. Tracked changed files are fingerprinted automatically. A changed input invalidates a recorded check. The scenario text describes coverage and the receipt records what the command actually returned.
- For an independent `beforeFinish` check hook, set `parallel_review: true` to overlap it with Architecture review. Set this only on checks that leave the source unchanged. The hook still asks for approval. Harness waits for both results and discards the concurrent review if tracked file fingerprints changed.

For the short synthetic efficiency suite, run `node scripts/eval-quality.js --live --suite=efficiency --experiment=prompt --variant=compact --effort=low --prompt=compact`. It includes a local data bug and a synthetic HTTP → agent → turn chain with expected callsites and branch lines.

Run the architecture comparison with the protected public check hook by selecting
`--experiment=parallel-review` in the architecture command above. Both arms
use the same required evaluator hook. The review arm runs the hook and review
concurrently and records their timing intervals. The module fixture protects the
original `labels(rows)` projection and checks that `summary(items)` uses a
single filter pass through the existing visibility policy.

### Command changes and bug reproduction

Approved commands, project hooks and background processes record file creations,
deletions, content changes and executable mode changes in the project. Git
projects track indexed and non-ignored files. Other projects skip VCS
metadata and common dependency/cache directories. Snapshots report incomplete
coverage if they fail or exceed 20,000 files. Concurrent edits can appear in a
command's comparison. Inspect the paths and before/after fingerprints with
`inspect_changes`. A test that changes tracked files cannot certify that revision.

For a reproducible bug, call `verify_task` before changing the implementation.
Pin the test and fixtures in `inputs` and provide `reproduction` with the expected
nonzero `exit_code` and a distinctive `output_contains` marker. After fixing the
bug, call `verify_task` with the same command and inputs and the first receipt's
ID in `baseline_id`. The original test inputs must still match and the command
must pass on the patched revision.

### Paired provider evaluation

Use `node scripts/eval-quality.js --experiment=models --suite=efficiency --prompt=compact`
to prepare a synthetic GLM/ChatGPT experiment without sending requests. Adding
`--live` requires both a GLM credential and a separately authorized ChatGPT
access token supplied through `HARNESS_CHATGPT_ACCESS_TOKEN`. The headless
runner has no access to VS Code SecretStorage. Set `HARNESS_CHATGPT_MODEL` if
the authorized catalog uses a different model. The report includes acceptance,
total and uncached usage per accepted run, and the model for each result.
The efficiency suite includes a manually graded task. Use the default suite
with an explicit `--tasks` selection of coding fixtures to expand the
automatically graded comparison.

## Editor workflow and isolated agents

- The composer’s **+** menu inserts a file reference from the most recent editor selection. A prompt can also use `@src/app.js#12-20` or `@"folder with spaces/app.js"#12-20`. Harness includes the matching excerpt from the open project. **Вывод терминала** adds the latest output from the active VS Code terminal when shell integration is available. It becomes part of the request when you send the draft. Choose whether future chats open in the active editor group or beside it in the same menu.
- In Manual edit approval, **Выбрать фрагменты правки** lets you accept a subset of the proposed blocks. Each new user turn has a checkpoint with options to branch the conversation or branch and restore tracked direct file edits. Code restoration requires confirmation and stops on conflicting edits, incomplete command history, or changes made by commands.
- Roles support `effort`, `max_rounds`, `token_budget`, and `memory` in `.harness/config.json`. With `"memory": true` on a role, its notes are separate from shared project memory. Set `memory.auto_save` to true to let the agent write durable notes without individual prompts. Project memory can still be disabled with `memory.enabled`.
- Set `roles.general.isolation` to `"worktree"` to give each General worker a detached checkout at HEAD. Harness includes its location in the result and agent panel. Workers use scoped file tools there. Inspect and integrate their edits from that worktree. Its uncommitted changes remain separate from the main workspace.
- Configure `glmTokenUsage.hooks` at user, workspace, or workspace-folder scope. Those hooks run before the hooks in `.harness/config.json`. Use `afterToolError` to handle failed tool calls. When Manual mode asks about a validated read-only command, the permission card can remember that exact command for the current chat or project. The **+** menu can clear the saved approvals.

### Connected edits and revision checks

Use `apply_patchset` for up to eight connected file changes. Provide exact
`old_text` for each existing file and `create: true` for a new file. Harness
validates every target before review, collects the normal per-file approvals,
checks that the files still match, and submits one VS Code workspace edit.
Successful file writes remain visible in the change journal. If VS Code fails
to apply or save the full edit, Harness reports the partial result.

If an edit no longer matches, Harness returns the current revision and nearby
numbered lines when it can locate the fragment. Rebuild that fragment against
the new revision. A unique match that differs only in LF/CRLF can be applied
with the file's line endings.

To enforce existing behavior before direct file edits, configure
`contract_checks` in `.harness/config.json`. Each rule names exact source paths
or directory prefixes ending with `/`, and an existing Node script.

```json
{
  "contract_checks": [
    { "paths": ["src/turn/"], "script": "train/stream_lifecycle_check.mjs" }
  ]
}
```

Harness runs matching scripts with normal command approvals on a temporary
workspace copy containing the entire proposed edit. A failing, declined, or
interrupted check blocks the write. Use self-contained checks that run offline
with the workspace and its installed dependencies. The checks cover direct
file tools. A staged pass must be followed by a passing receipt on the saved
revision. Keep broader post-edit verification for other behaviors.

Pass `verify` to `apply_patchset` to run named checks immediately after saving.
Use `verify_revision` to check a revision that needs no edits.
Checks run with their normal approvals when a reference to a plan criterion
cannot be resolved. The receipt lists that reference as unlinked. It does
not certify the criterion or close a requested plan step on that basis.
Each new command uses the normal command approval. Add exact plan criteria and
input files to the relevant checks. With passing behavioral evidence,
`done_steps` can close the named steps in the same call. An unchanged workspace
can reuse a successful receipt. Set `refresh: true` to rerun commands that
depend on changing external state. Check results become stale when a command
changes the workspace during verification.

With an explicit cap of at least five tool rounds, Harness reserves the last
three rounds for a patch, targeted recovery and verification on turns that
have gathered local source or attempted an edit. Broad exploration pauses in
the reserve while the provider still sees a stable tool schema for caching.
After a recoverable tool error, Harness can request a corrected call in the
same turn, even if the model tried to finish early. A confirmed write is
never automatically replayed. All recovery uses the remaining round budget.
Harness reserves a tool-free answer and uses recent usage to look
for room to finish under a configured token budget. Final status still reflects
unresolved checks and hooks. On a truncated high-effort response, Harness can
retry once at low effort with any partial tool calls discarded.

The `slide-language` evaluation suite checks reusable layout rules over three
cumulative stages. It exposes a short named smoke matrix to the agent and
keeps 108 held-out combinations for grading. To compare
final layouts from two reports, run
`node scripts/render-slide-comparison.js BASELINE_DIR CANDIDATE_DIR PREVIEW.html`.
The renderer applies shared typography to each agent's boxes and palette.

### Diff-based regression check

On completion, the diff regression check looks for existing test files and
selects nearby `node:test` suites through their relative imports. A documentation
change or an edit with no existing test files does not require a new suite.
The checker never creates or changes tests. The main agent is instructed to add
tests only when the user asks for them.

For supported changes, Harness requests approval to run the selected suites in
two temporary project copies. It keeps test inputs identical, restores the
previous implementation in one copy, and verifies that a named assertion fails
there and passes on the patch. It reports both-green runs as unproven and setup
failures as inconclusive. Edits to existing tests or fixtures are flagged for
review so a weakened assertion cannot certify its own change. The working
project is untouched by staging. Test commands retain the normal permissions
and configured sandbox. Task completion shows the verification outcome
separately.

The automatic replay currently handles self-contained JavaScript `node:test`
projects. It does not copy dependencies, symlinks, or common credential files.
Other runners or an unreconstructable old revision are reported as unavailable
for replay. A shell edit can use a Git baseline when its recorded pre-edit
fingerprint matches the committed bytes. Set `glmTokenUsage.regressionAudit` to
`false` for the original completion policy.

Compare two runtimes without paid API calls using
`node scripts/eval-regression-check.js BASELINE_EXTENSION_JS REPORT_JSON`.

### Continue a read-only subagent

Open an agent's activity in **Agents** and choose **Продолжить**. Add a specific
follow-up in the composer and send it. Harness can resume up to eight recent
read-only workers in the same chat and workspace. It saves completed tool
exchanges as checkpoints, so a follow-up can use prior file ranges and results.
Resume uses the original provider, endpoint, account and model with the current
role permissions. Workers started on an explicitly selected connection and
General workers do not have this resume action.

**/context** shows the most recent turn's requests and reported token usage
by actor and model, including reported cache reads and compaction. Estimated
context components are shown separately and summed across the requests.

### Multi-turn goals

Use `/goal [--budget 100000] [--turns 5] objective` in the chat. Harness keeps
one task ID, continues if acceptance uncovers actionable gaps, and asks a
separate read-only reviewer to evaluate the deliverable and evidence. Existing
revision and verification checks still apply. The goal follows the current
permission mode, so Plan cannot make edits and Manual still asks for approvals.

`/goal status`, `/goal pause` and `/goal resume` inspect and control the goal.
An interrupted editor session restores the goal paused. The budget is reported
uncached input plus output, including the acceptance requests. The provider
reports usage after a request, so an in-flight request can cross the budget.
