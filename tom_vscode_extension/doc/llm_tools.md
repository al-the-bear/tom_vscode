# LLM Tools — Inventory + Roadmap

This document inventories the tools available to Claude / Anthropic models when driven through the Tom VS Code extension, and proposes additions that would let the chat do full end-to-end development work inside the IDE.

It covers three surfaces:

1. **Anthropic Messages API (direct transport)** — what Claude knows how to *call* out of the box, without any plug-ins.
2. **Claude Agent SDK (`agentSdk` transport)** — what Claude Code's own SDK ships, most of which we currently disable.
3. **Tom extension custom tools** — the `ALL_SHARED_TOOLS` registry in `src/tools/tool-executors.ts`, exposed to the model via MCP on the Agent SDK path and directly on the Messages API path.

A configuration's `enabledTools` picks a subset from #3. #1 is always available. #2 is currently suppressed (`tools: []` in `agent-sdk-transport.ts` line 287) so the model only sees our own MCP-registered tools.

## 1. Anthropic Messages API — native capabilities (direct transport)

On `transport: 'direct'` (via `@anthropic-ai/sdk`), Claude has access to:

| Capability | Always on? | Notes |
| --- | --- | --- |
| Text generation | yes | Core completion. |
| Tool use (function calling) | yes, opt-in per tool | The model emits `tool_use` blocks; we implement the execution loop in `AnthropicHandler.sendMessage`. Our custom tools ride this channel. |
| Vision (image blocks in user messages) | yes | We don't send images yet. |
| Documents (PDF input blocks) | yes | We don't send documents yet. |
| Extended thinking / reasoning | yes, opt-in | Config field not yet exposed in our `AnthropicConfiguration`. |
| Server-side tools: `web_search` | opt-in per request | We have a *custom* `tomAi_webSearch` that proxies to a local implementation; Anthropic also offers a first-party `web_search_20250305` tool that runs server-side. |
| Server-side tools: `code_execution` | opt-in per request | Runs Python in an Anthropic-managed sandbox. **We do not surface this.** |
| Server-side tools: `computer_use` | opt-in per request | Desktop-level automation (clicks, keystrokes). **We do not surface this.** |
| Server-side tools: `text_editor_20250429` | opt-in per request | File view/create/edit/undo, also server-side. **We do not surface this** — we implement equivalent ourselves (`tomAi_readFile`, `tomAi_editFile`, …). |
| Prompt caching (`cache_control`) | opt-in per config | We support via `promptCachingEnabled`. |

> We currently use only: text, tool use, and prompt caching.

## 2. Claude Agent SDK — built-in tool preset (`agentSdk` transport)

When `transport: 'agentSdk'`, the SDK ships a large built-in toolset (the same tools `claude` CLI uses). We disable them by passing `tools: []` so the model only sees our MCP tools. If we flipped to `tools: { type: 'preset', preset: 'claude_code' }`, the model would additionally get:

| SDK tool | What it does |
| --- | --- |
| `Read` | Read any file in the workspace. |
| `Write` | Create / overwrite a file. |
| `Edit` | String-replace edit in a file. |
| `MultiEdit` | Batched string-replaces. |
| `Glob` | File-name pattern search. |
| `Grep` | Ripgrep-backed content search. |
| `Bash` | Run shell commands (with sandbox support). |
| `BashOutput` | Stream stdout/stderr of background Bash tasks. |
| `KillBash` | Stop a background Bash task. |
| `NotebookEdit` | Jupyter notebook cell edits. |
| `WebFetch` | Fetch a URL. |
| `WebSearch` | Web search. |
| `Task` / `Agent` | Spawn a subagent. |
| `ExitPlanMode` / `EnterPlanMode` | Planning-mode transitions. |
| `TodoWrite` | The Claude-side todo list. |
| `ToolSearch` | Lazy-fetch deferred tool schemas. |
| `AskUserQuestion` | Interactive elicitation. |
| `SlashCommand` | Run a `/command`. |

We currently re-implement most of these (Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch, TodoWrite). The remaining gaps — `BashOutput`/`KillBash`, `NotebookEdit`, `Task`, `AskUserQuestion`, `SlashCommand`, `EnterPlanMode`/`ExitPlanMode` — are noted below.

## 3. Tom extension custom tools (`ALL_SHARED_TOOLS`)

Defined in `src/tools/tool-executors.ts`, canonical name list in `src/utils/constants.ts` (`AVAILABLE_LLM_TOOLS`). Each tool has `readOnly` (does it mutate state) and `requiresApproval` (does the panel gate it behind an approval bar). Tools are included in a request iff their name is in `configuration.enabledTools`.

### Read-only file and workspace

| Tool | Purpose | Approval |
| --- | --- | --- |
| `tomAi_readFile` | Read file content (optional line range). | none |
| `tomAi_listDirectory` | List directory entries. | none |
| `tomAi_findFiles` | Glob-based file search. | none |
| `tomAi_findTextInFiles` | Grep-style content search. | none |
| `tomAi_fetchWebpage` | HTTP GET a URL and return text/HTML. | none |
| `tomAi_webSearch` | Web search via a local/CLI search backend. | none |
| `tomAi_getErrors` | Snapshot the VS Code *Problems* panel for the workspace. | none |
| `tomAi_readGuideline` | Read a `_copilot_guidelines/*` file by name. | none |
| `tomAi_readLocalGuideline` | Read a project-scoped guideline. | none |

### Ask-AI / delegation

| Tool | Purpose | Approval |
| --- | --- | --- |
| `tomAi_askBigBrother` | Delegate a question to a larger local LLM profile. | none |
| `tomAi_askCopilot` | Bounce a question off GitHub Copilot Chat via the bridge. | none |

### Write / mutating file tools

| Tool | Purpose | Approval |
| --- | --- | --- |
| `tomAi_createFile` | Create a new file. | required |
| `tomAi_editFile` | String-replace edit (reads required first). | required |
| `tomAi_multiEditFile` | Batched string-replaces in one file. | required |
| `tomAi_deleteFile` | Delete a file. | required |
| `tomAi_moveFile` | Rename / move a file. | required |

### Shell / VS Code

| Tool | Purpose | Approval |
| --- | --- | --- |
| `tomAi_runCommand` | Run an arbitrary shell command (workspace cwd). | required |
| `tomAi_runVscodeCommand` | Execute a registered VS Code command. | required |
| `tomAi_git` | Structured read-only git (`status`, `diff`, `log`, `blame`). | none |

### Todo / task management

| Tool | Purpose | Approval |
| --- | --- | --- |
| `tomAi_manageTodo` | Add/update/remove entries in the chat todo session manager. | none |

### Chat variables

| Tool | Purpose | Approval |
| --- | --- | --- |
| `tomAi_chatvar_read` | Read a chat variable (role, quest, custom.*). | none |
| `tomAi_chatvar_write` | Write a chat variable (exempt from approval — has its own change-log). | none |

### Memory (`_ai/memory/`)

Two tiers: `shared/` (cross-quest) and `{quest}/` (per-quest). Approval only on writes.

| Tool | Purpose | Approval |
| --- | --- | --- |
| `tomAi_memory_read` | Read one memory file. | none |
| `tomAi_memory_list` | List memory files in a scope. | none |
| `tomAi_memory_save` | Write a new memory file. | required |
| `tomAi_memory_update` | Patch-style edit of a memory file. | required |
| `tomAi_memory_forget` | Delete a memory file. | required |

## 4. Gaps — proposed additions

Grouped by the user's goal: *"do full development work on my machine, especially in the VS Code workspace."*

### 4.1 Workspace awareness (read-only, low risk)

| Proposed tool | Returns | Why |
| --- | --- | --- |
| `tomAi_getWorkspaceInfo` | `{ name, folders[], codeWorkspaceFile, questId, role, activeProjects[], branch, dirty }` | Today the model has to read `${workspaceFolder}`, git, and chat vars piecemeal. One call unblocks "where am I working?" every turn. |
| `tomAi_getActiveEditor` | `{ file, language, selection { startLine, endLine, text }, cursor { line, column }, dirty, visibleRange }` | The model can't see what the user is looking at. This is the single biggest context-gap. |
| `tomAi_getOpenEditors` | `[{ file, language, active, pinned, dirty }]` | Lets the model ask "what are you working on right now?" without guessing. |
| `tomAi_getProblems` | `[{ file, severity, line, message, source }]` | Richer than `tomAi_getErrors` (which is already workspace-wide). Filters by severity/file, returns code actions. |

### 4.2 Execution + observability (required approval)

| Proposed tool | What it does | Notes |
| --- | --- | --- |
| `tomAi_runTerminal` | Create or reuse a VS Code terminal, run a command, return captured stdout/stderr (streaming) with a handle for follow-up. | Mirrors Agent SDK's `Bash`/`BashOutput`/`KillBash` but runs in the user's actual terminal so environment vars, venv, nvm are the real thing. |
| `tomAi_runTask` | Run a VS Code task (`tasks.json`) and stream its output. | Integrates with the user's existing build/test/lint tasks. |
| `tomAi_runDebugConfig` | Launch a debug config (`launch.json`), monitor for breakpoints, return final state. | High value for "fix this failing test" loops. |
| `tomAi_getOutputChannel` | Read the last N lines from a named Output-panel channel (e.g. `"TypeScript"`, `"ESLint"`). | The current `tomAi_getErrors` only sees Problems; compilation/language-server logs live in Output. |
| `tomAi_getTerminalOutput` | Dump the scrollback of a named terminal. | Lets the model inspect something the user ran manually. |

### 4.3 IDE operations (approval, limited scope)

| Proposed tool | What it does | Why |
| --- | --- | --- |
| `tomAi_runVscodeCommandWithArgs` | Extend `tomAi_runVscodeCommand` to accept a JSON-typed args array and return the command's result. | Current tool is string-only; many useful commands (`editor.action.*`, `workbench.action.*`) need args. |
| `tomAi_showQuickPick` | Ask the user to pick from N options (wrapper over `vscode.window.showQuickPick`). | Interactive elicitation without dropping out of the chat — parallel to Agent SDK's `AskUserQuestion`. |
| `tomAi_openFile` | Open a file in the active editor, optionally at a line/selection. | Currently the model cites file:line but can't bring the file into focus. |
| `tomAi_applyEdit` | Use `vscode.workspace.applyEdit` for transactional multi-file edits (atomic undo). | Safer than N separate `tomAi_editFile` calls for refactors. |
| `tomAi_getCodeActions` | Return the list of code actions (quick fixes, refactors) available for a position. | Lets the model say "ESLint suggests X, apply it." |
| `tomAi_applyCodeAction` | Execute a specific code action. | Pair with the above. |

### 4.4 Extended VCS

| Proposed tool | What it does |
| --- | --- |
| `tomAi_gitExec` | Currently `tomAi_git` is read-only. A write variant (`add`, `commit`, `push`, `branch`, `checkout`) under approval. |
| `tomAi_gitShow` | `git show <ref>[:path]` so the model can compare against history. |

### 4.5 Notebook support

| Proposed tool | What it does |
| --- | --- |
| `tomAi_notebookEdit` | Add/remove/replace Jupyter cells (parallel to Agent SDK's `NotebookEdit`). |
| `tomAi_notebookRun` | Execute a cell or the whole notebook and return outputs. |

### 4.6 Language / symbol tools

| Proposed tool | What it does |
| --- | --- |
| `tomAi_findSymbol` | `vscode.executeWorkspaceSymbolProvider` — workspace-wide symbol search. |
| `tomAi_gotoDefinition` | Resolve a symbol at a position to its definition(s). |
| `tomAi_findReferences` | All references to a symbol. |
| `tomAi_rename` | Workspace-wide rename via language server (safer than text replace). |

### 4.7 User interaction

| Proposed tool | What it does |
| --- | --- |
| `tomAi_askUser` | Elicit free-form input (wrapper over `showInputBox`). |
| `tomAi_notifyUser` | Show an information/warning/error notification. |
| `tomAi_exitPlanMode` | Parallel to Agent SDK's plan-mode transition — signals that planning is done and execution can start. |

## 5. What would make this *easier* to reach?

The heaviest source of friction right now is **one-tool-at-a-time boilerplate** — every new capability means a new `SharedToolDefinition`, JSON schema, executor, entry in `AVAILABLE_LLM_TOOLS`, Zod adapter wiring for Agent SDK transport, and an approval-gate decision. Suggestions:

1. **Adopt the Agent SDK built-in preset selectively.** Instead of re-implementing Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch, pass `tools: { type: 'preset', preset: 'claude_code' }` on the Agent SDK path and **deny-list** only the tools that conflict with our UI (e.g., we keep our own approval gate). One commit deletes ~1000 lines of executor code.
2. **Introduce a `tomAi_vscode` meta-tool** that takes `{ command: string, args?: unknown[] }` and executes any VS Code command. Most of §4.1, §4.3, §4.6, and §4.7 above reduce to "tell the model the command id to call." Pair with `tomAi_listCommands` (filtered) so the model can discover what's available.
3. **Terminal/Task/Debug abstraction** — one `tomAi_runProcess` tool that encapsulates "start a process (terminal | task | debug), wait for it to settle, return the output" with a consistent input/output shape.
4. **Structured approval prompts** — the current approval gate says "approve *tomAi_editFile*?" with raw JSON input. Upgrade the UI to render per-tool previews (unified diff for edits, command preview for runs, URL for fetches). Lower friction → user enables more tools.
5. **Tool-result truncation + follow-up** — the model often gets back a gigabyte-size Output panel log and has to re-call with narrower parameters. A standard `{ content, truncated, continuationToken }` envelope would let every tool stream results.
6. **Session logs → retrievable context** — currently trail files live in `_ai/trail/` but there's no `tomAi_readPreviousExchange` tool. Letting the model look back at its own history across sessions is cheaper than re-explaining context.
7. **`_copilot_guidelines/` as first-class tool scope** — `tomAi_readGuideline` exists, add a `tomAi_listGuidelines` and `tomAi_searchGuidelines` so the model can proactively find relevant conventions before writing code.

## 6. Concrete tool lists per transport (for implementation)

Two target lists — one for each transport — that together give the chat "full development mode." For each tool we list whether it is **new** (to build) or **existing** (already in `ALL_SHARED_TOOLS`), plus its approval category.

### 6.1 Agent SDK transport (`transport: 'agentSdk'`)

With `profile.useBuiltInTools = true` (the recommended default going forward), the Agent SDK supplies the file / shell / search layer natively; our extension tools add only what is VS Code specific or Tom specific.

**From Claude Code built-in preset (pass `tools: { type: 'preset', preset: 'claude_code' }`):**

| SDK tool | Category | Replaces custom tool |
| --- | --- | --- |
| `Read` | read | `tomAi_readFile` |
| `Write` | write | `tomAi_createFile` |
| `Edit` | write | `tomAi_editFile` |
| `MultiEdit` | write | `tomAi_multiEditFile` |
| `Glob` | read | `tomAi_findFiles` |
| `Grep` | read | `tomAi_findTextInFiles` |
| `Bash` / `BashOutput` / `KillBash` | write | `tomAi_runCommand` (plus streaming & cancel, which we lack) |
| `WebFetch` | read | `tomAi_fetchWebpage` |
| `WebSearch` | read | `tomAi_webSearch` |
| `NotebookEdit` | write | (no existing equivalent) |
| `TodoWrite` | read/write | `tomAi_manageTodo` |
| `Task` (spawn subagent) | — | (no existing equivalent) |
| `AskUserQuestion` | user | (no existing equivalent) |
| `ExitPlanMode` | — | (no existing equivalent) |
| `SlashCommand` | — | (no existing equivalent) |

The 12 extension tools listed in `DUPLICATES_OF_CLAUDE_CODE_BUILTINS` are automatically suppressed when `useBuiltInTools` is on.

**Extension tools to keep on the Agent SDK path** (no SDK equivalent):

| Tool | Category | Status |
| --- | --- | --- |
| `tomAi_getErrors` | read | existing |
| `tomAi_git` (read subcommands) | read | existing |
| `tomAi_readGuideline` | read | existing |
| `tomAi_readLocalGuideline` | read | existing |
| `tomAi_askBigBrother` | read | existing |
| `tomAi_askCopilot` | read | existing |
| `tomAi_chatvar_read` | read | existing |
| `tomAi_chatvar_write` | write | existing |
| `tomAi_memory_read` | read | existing |
| `tomAi_memory_list` | read | existing |
| `tomAi_memory_save` | write | existing |
| `tomAi_memory_update` | write | existing |
| `tomAi_memory_forget` | write | existing |

**New extension tools to add for the Agent SDK path** (VS Code specific — no SDK equivalent):

| Tool | Category | Purpose |
| --- | --- | --- |
| `tomAi_getWorkspaceInfo` | read | Workspace folders, `.code-workspace` filename, quest id, role, active projects, git branch/dirty. |
| `tomAi_getActiveEditor` | read | Active file path, language, selection text + range, cursor, dirty, visible range. |
| `tomAi_getOpenEditors` | read | All open tabs with active/dirty/pinned flags. |
| `tomAi_getProblems` | read | Replaces/extends `tomAi_getErrors` with severity filtering, source, related code-actions. |
| `tomAi_runTask` | write | `vscode.tasks.executeTask` + stream output + return exit code. |
| `tomAi_runDebugConfig` | write | `vscode.debug.startDebugging` + watch for termination. |
| `tomAi_getOutputChannel` | read | Read our own output channels (Tom Log, Ollama, etc.). Third-party channels are not exposed by VS Code. |
| `tomAi_getTerminalOutput` | read | Shell-integration `execution.read()` for the active terminal / selected terminal id. |
| `tomAi_openFile` | write (no approval) | `vscode.window.showTextDocument(uri, { selection })`. Purely navigational. |
| `tomAi_applyEdit` | write | Multi-file transactional edit via `vscode.workspace.applyEdit`. Atomic undo. |
| `tomAi_getCodeActions` | read | `vscode.executeCodeActionProvider` at a position. |
| `tomAi_applyCodeAction` | write | Execute a specific code action by id + args. |
| `tomAi_findSymbol` | read | `vscode.executeWorkspaceSymbolProvider` — workspace-wide symbol search. |
| `tomAi_gotoDefinition` | read | `vscode.executeDefinitionProvider` at a position. |
| `tomAi_findReferences` | read | `vscode.executeReferenceProvider` at a position. |
| `tomAi_rename` | write | `vscode.executeDocumentRenameProvider` — LSP-safe rename. |
| `tomAi_notebookEdit` | write | Add/remove/replace notebook cells (complementary to `NotebookEdit`, VS Code surface). |
| `tomAi_notebookRun` | write | Execute a cell via `notebook.cell.execute`. |
| `tomAi_gitExec` | write | `git add/commit/push/branch/checkout` via `execFile('git')`. Approval gated. |
| `tomAi_gitShow` | read | `git show <ref>[:path]`. |
| `tomAi_askUser` | user | `vscode.window.showInputBox` when we want free-form text (vs the SDK's picker-style `AskUserQuestion`). |
| `tomAi_notifyUser` | user (no approval) | `showInformationMessage` / `showWarningMessage` / `showErrorMessage`. |
| `tomAi_listGuidelines` | read | List `_copilot_guidelines/*.md` entries so the model can discover conventions. |
| `tomAi_searchGuidelines` | read | Grep inside the guidelines folder. |

**Meta / infrastructure:**

| Tool | Category | Purpose |
| --- | --- | --- |
| `tomAi_vscode` | variable | Thin wrapper around `vscode.commands.executeCommand({ command, args })`. Approval required for any command not on an allow-list. Pair with `tomAi_listCommands` for discovery. Covers any future VS Code feature without a new tool. |
| `tomAi_listCommands` | read | Filtered `vscode.commands.getCommands()` so the model can find the right command id before calling `tomAi_vscode`. |

### 6.2 Direct Anthropic SDK transport (`transport: 'direct'`)

Without the SDK preset, we implement every capability ourselves. This list = 6.1's "new tools" **plus** everything from `DUPLICATES_OF_CLAUDE_CODE_BUILTINS` (already built) **plus** the shared extension-specific tools from §3.

Additional tools specific to the direct path — these are the capability gaps relative to the Agent SDK path:

| Tool | Category | Why needed on direct path |
| --- | --- | --- |
| `tomAi_runCommandStream` | write | Equivalent of `Bash` + `BashOutput` — run a shell command, stream stdout/stderr, optionally kill. Our current `tomAi_runCommand` is fire-and-forget. |
| `tomAi_killCommand` | write | Cancel a running `tomAi_runCommandStream`. |
| `tomAi_spawnSubagent` | — | Equivalent of SDK's `Task`: call `messages.create` with a different system prompt and a restricted tool set, return the summary. Lets the model delegate research tasks. |
| `tomAi_askUserPicker` | user | Picker-style elicitation (`showQuickPick`) — mirrors the SDK's `AskUserQuestion`. |
| `tomAi_enterPlanMode` / `tomAi_exitPlanMode` | — | Explicit "I'm planning, don't execute tools" state, since no SDK equivalent exists. |
| `tomAi_searchNotebookCells` | read | Notebook-aware search — SDK's `NotebookEdit` has context we'd otherwise miss. |
| `tomAi_editNotebook` | write | Already covered by `tomAi_notebookEdit`; on direct path this is the only way. |

Everything else is shared with the Agent SDK list (§6.1). The Agent SDK path is strictly a superset via its preset.

### 6.3 Implementation status

Waves A–D are landed. Status legend: ✅ implemented, ⚠️ partial (API limitation documented), 🔌 stub awaiting host integration.

**Wave A — situational awareness** (`src/tools/workspace-awareness-tools.ts`)

1. ✅ `tomAi_getWorkspaceInfoFull` (enhanced successor to `tomAi_getWorkspaceInfo`)
2. ✅ `tomAi_getActiveEditor`
3. ✅ `tomAi_getOpenEditors`
4. ✅ `tomAi_getProblems`
5. ⚠️ `tomAi_getOutputChannel` — VS Code has no cross-extension API for reading third-party output channels. The tool reads only channels the Tom extension tracks and documents the limitation.
6. ⚠️ `tomAi_getTerminalOutput` — VS Code exposes terminal metadata but no scrollback API. The tool returns terminal state and steers callers to `tomAi_runCommand` for captured output.
7. ✅ `tomAi_findSymbol`
8. ✅ `tomAi_gotoDefinition`
9. ✅ `tomAi_findReferences`
10. ✅ `tomAi_getCodeActions`
11. ✅ `tomAi_listGuidelines`
12. ✅ `tomAi_searchGuidelines`

**Wave B — IDE navigation** (`src/tools/ide-navigation-tools.ts`)

1. ✅ `tomAi_openFile`
2. ✅ `tomAi_notifyUser` (already existed in `chat-enhancement-tools.ts`)
3. ✅ `tomAi_listCommands`
4. ✅ `tomAi_askUser`
5. ✅ `tomAi_askUserPicker`

**Wave C — IDE execution** (`src/tools/ide-execution-tools.ts`)

1. ✅ `tomAi_applyEdit` (multi-file WorkspaceEdit, atomic undo)
2. ✅ `tomAi_getCodeActionsCached` (companion to `getCodeActions` that returns cacheable actionIds)
3. ✅ `tomAi_applyCodeAction` (apply by actionId; 5-minute TTL)
4. ✅ `tomAi_rename` (LSP-safe rename)
5. ✅ `tomAi_vscode` (typed-args executeCommand; safe-list prefix hints included)
6. ✅ `tomAi_runTask`
7. ✅ `tomAi_runDebugConfig`
8. ✅ `tomAi_runCommandStream` + `tomAi_readCommandOutput` + `tomAi_killCommand` (in-process registry; `readCommandOutput` added to the plan)
9. ✅ `tomAi_gitExec` (allow-listed git write subcommands)
10. ✅ `tomAi_gitShow`

**Wave D — notebook + advanced agent ops** (`src/tools/advanced-agent-tools.ts`)

1. ✅ `tomAi_notebookEdit` (insert/replace/delete cells via `NotebookEdit` + `WorkspaceEdit`)
2. ✅ `tomAi_notebookRun` (dispatches `notebook.execute` / `notebook.cell.execute` — output streams asynchronously)
3. 🔌 `tomAi_spawnSubagent` — stub. The Anthropic handler must call `registerSubagentSpawner(fn)` to wire it up; until then the tool returns an instructive error. On the Agent SDK transport, prefer the built-in `Task` tool.
4. ✅ `tomAi_enterPlanMode` / `tomAi_exitPlanMode` — module-level flag readable by host handlers via `isPlanModeActive()`. Full enforcement (blocking approval-gated tools while active) is deferred to the handler.

**Deferred / follow-ups.**

- Sub-agent wiring: add a `registerSubagentSpawner` call in `anthropic-handler.ts` that reuses the current `AnthropicConfiguration` to run a nested tool-use loop with a restricted tool set and returns the final text.
- Plan-mode enforcement: in `anthropic-handler.ts` / `tool-execution-context`, refuse approval-gated tool calls while `isPlanModeActive()` unless the user explicitly overrides.
- Code-action cache: consider a cross-session key or persistence so `actionId`s survive a handler restart.

**Prerequisite infrastructure (reusable across tools):**

- **Streaming result envelope** `{ content, truncated, continuationToken }` in `shared-tool-registry.ts` so large outputs paginate without bespoke code.
- **Structured approval preview** in `chatPanel-handler.ts` so edits/commands/fetches render human-readable previews (unified diff, command preview).
- **Claude Code built-in tool policy** — `useBuiltInTools` works end-to-end: feature-flagged via the profile editor, duplicates suppressed, trail entries for SDK tools labelled clearly.

### 6.4 Non-goals

- We deliberately do **not** surface Anthropic's server-side `code_execution`, `computer_use`, or `text_editor_20250429` — they run outside the workspace and bypass our approval gate.
- `ExitPlanMode` / `EnterPlanMode` on the Agent SDK path come from the SDK; we only need custom versions on the direct transport.
