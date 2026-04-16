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

### Priority shortlist for "full IDE development"

If only five of the above shipped, these would close the biggest gaps:

1. `tomAi_getActiveEditor` + `tomAi_getOpenEditors` — situational awareness.
2. `tomAi_runTerminal` (with streaming stdout + kill handle) — real execution in the user's shell.
3. `tomAi_runTask` — integrate with existing `tasks.json` (tests, build, lint).
4. `tomAi_getOutputChannel` — read TypeScript/ESLint/etc. logs that don't surface in Problems.
5. The `tomAi_vscode` meta-tool + allowlist — one door to every `vscode.commands.executeCommand` behaviour, covering Quick Pick, file open, code actions, rename, etc.

Items 1–4 are concrete executors; item 5 reshapes how we onboard new IDE capabilities so steps 6–10 stop requiring fresh Tom-side work.
