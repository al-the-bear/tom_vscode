# LLM Tools — Transport Inventory

This document is the source of truth for every tool available to LLM chat surfaces in the Tom VS Code extension. Tools are grouped by family, and each row carries a per-transport recommendation for default enablement.

## 1. Transports

Five chat surfaces call into tools:

- **Anthropic Agent SDK** — `transport: 'agentSdk'` on an Anthropic configuration. Wraps `@anthropic-ai/claude-agent-sdk`. When `profile.useBuiltInTools = true`, Claude Code's built-in preset (`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `Bash`/`BashOutput`/`KillBash`, `WebFetch`, `WebSearch`, `NotebookEdit`, `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`, `Task`, `AskUserQuestion`, `ExitPlanMode`, `SlashCommand`, …) is exposed; our extension tools that duplicate a built-in (`DUPLICATES_OF_CLAUDE_CODE_BUILTINS` in `anthropic-handler.ts`) are suppressed to avoid confusion. Our own MCP server runs next to the preset and surfaces the rest.
- **Anthropic API (direct)** — `transport: 'direct'`. `@anthropic-ai/sdk`. No SDK preset — we implement every capability ourselves.
- **Local LLM (Ollama)** — `localLlm-handler.ts`. OpenAI-compatible tool calling. Because smaller open models call tools less reliably, we default to a trimmed, read-only subset (`READ_ONLY_TOOLS` in `src/tools/tool-executors.ts`).
- **Tom AI Chat** — the user's single-conversation surface via the **VS Code Language Model API** (`vscode.lm.*`). The VS Code LM API is a programmatic LLM interface comparable to the Anthropic API: the extension hands over messages + tools and receives the model's response. Tom AI Chat is a **user-facing** single-turn-or-multi-turn chat with a `.md` conversation format. A human is present, so user-interaction tools (`tomAi_askUser`, `tomAi_askUserPicker`, `tomAi_notifyUser`) apply.
- **AI Conversation** — two LLM agents converse with each other via the same VS Code LM API, orchestrated by the extension. There is **no human** in the loop — interactive prompting tools don't apply. Used for bot-to-bot review / critique / planning.

A sixth surface — **Copilot Chat (the user-facing VS Code chat panel)** — is *not* one of the transports above. Our extension drives it indirectly via the **prompt-queue / timed-request / template family** (§4.20): those tools stage prompts, orchestrate follow-ups, and manage reminders in the Copilot Chat window. They are called *from* any of the five transports above when the user's workflow needs to send prompts into Copilot Chat.

Every transport reads tool enablement from the active configuration / profile — the recommendations below are *defaults*, not hard-coded behaviour. Flip a tool on or off per-profile via the Global Template Editor.

A Dart **script** can also reach the exact same tool registry over the bridge (`TomToolsApi`) — see [§9 Scripting-API access and gating](#9-scripting-api-access-and-gating). It is gated by the same active-profile rule described there.

## 2. Legend

| symbol | meaning |
| --- | --- |
| ✅ | recommended active by default for this transport |
| ⚪ | available, off by default — enable per-profile when needed |
| 🔁 | prefer the Agent SDK built-in equivalent (suppressed automatically when `useBuiltInTools = true`) |
| ❌ | not applicable on this transport |
| 🔌 | stub — requires host handler integration before it works |

## 3. Native capabilities (what the model brings to the table)

| Transport | Native text / tool-use | Extended thinking | Prompt caching | Vision / docs | Server-side tools (`web_search`, `code_execution`, `computer_use`, `text_editor_20250429`) | Preset built-in toolset |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Anthropic Agent SDK | ✅ | ✅ | ✅ | available but unused | ❌ not surfaced | ✅ Claude Code preset (opt-in) |
| Anthropic API (direct) | ✅ | ✅ | ✅ | available but unused | ❌ not surfaced | ❌ |
| Local LLM (Ollama) | ✅ | ❌ | ❌ | model-dependent | ❌ | ❌ |
| Tom AI Chat (VS Code LM) | ✅ | provider-managed | provider-managed | model-dependent | ❌ | Copilot-side tools invisible to us |
| AI Conversation (VS Code LM) | ✅ | provider-managed | provider-managed | model-dependent | ❌ | Copilot-side tools invisible to us |

We deliberately **do not** surface Anthropic's server-side `code_execution`, `computer_use`, or `text_editor_20250429` — they run outside the workspace and bypass our approval gate.

## 4. Tools by family

Each table lists every tool in the family with a per-transport default.

### 4.1 Files (read / write / search)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_readFile` | Read file (optional line range). | 🔁 | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createFile` | Create a file (approval). | 🔁 | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_editFile` | Find-replace edit (approval). | 🔁 | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_multiEditFile` | Batched find-replace (approval). | 🔁 | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_deleteFile` | Delete a file (approval). | 🔁 | ✅ | ⚪ | ⚪ | ⚪ |
| `tomAi_moveFile` | Rename / move a file (approval). | 🔁 | ✅ | ⚪ | ⚪ | ⚪ |
| `tomAi_listDirectory` | List directory entries. | 🔁 | ✅ | ✅ | ✅ | ✅ |
| `tomAi_findFiles` | Glob file search. | 🔁 | ✅ | ✅ | ✅ | ✅ |
| `tomAi_findTextInFiles` | Content search (grep). | 🔁 | ✅ | ✅ | ✅ | ✅ |
| `tomAi_applyEdit` | Transactional multi-file WorkspaceEdit (atomic undo). | ✅ | ✅ | ⚪ | ✅ | ⚪ |

### 4.2 Shell and tasks

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_runCommand` | Fire-and-forget shell command. | 🔁 | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_runCommandStream` | Spawn, return handle + initial output. | ⚪ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_readCommandOutput` | Poll stdout / stderr / exit. | ⚪ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_killCommand` | Signal a running handle. | ⚪ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_runTask` | Execute a task from `tasks.json`. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_runDebugConfig` | Launch a `launch.json` debug config. | ✅ | ✅ | ⚪ | ⚪ | ⚪ |

### 4.3 Web

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_fetchWebpage` | HTTP GET + return text. | 🔁 | ✅ | ✅ | ✅ | ✅ |
| `tomAi_webSearch` | Web search via local backend. | 🔁 | ✅ | ✅ | ✅ | ✅ |

### 4.4 VS Code commands and IDE navigation

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_runVscodeCommand` | Execute command ID (string args). | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_runVscodeCommandTyped` | Execute command ID (typed args, safe-list hints). | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_listCommands` | Discover command IDs (filtered). | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_openFile` | `showTextDocument` with optional selection. | ✅ | ✅ | ✅ | ✅ | ✅ |

### 4.5 Editor and workspace context

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_getWorkspaceInfo` | Workspace + quest + projects + git. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getActiveEditor` | Active file, selection, cursor, visible range. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getOpenEditors` | All open tabs with dirty / pinned flags. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getActiveQuest` | Resolve the active quest ID. | ✅ | ✅ | ✅ | ✅ | ✅ |

### 4.6 Diagnostics

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_getErrors` | Snapshot the Problems panel (legacy, flat). | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_getProblems` | Structured Problems panel with filters. | ✅ | ✅ | ✅ | ✅ | ✅ |

> `tomAi_getOutputChannel` and `tomAi_getTerminalOutput` have been removed — VS Code has no API to read third-party output channels or terminal scrollback. For captured command output use `tomAi_runCommand` (one-shot) or `tomAi_runCommandStream` + `tomAi_readCommandOutput`.

### 4.7 Language server (symbols, refactor, rename)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_findSymbol` | Workspace symbol search. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_gotoDefinition` | Resolve definition at a position. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_findReferences` | References to a symbol. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_getCodeActions` | List quick-fixes / refactors (preview only). | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_getCodeActionsCached` | Same, but returns cacheable `actionId`s. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_applyCodeAction` | Apply a cached `actionId` (approval). | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_rename` | LSP-safe workspace rename (approval). | ✅ | ✅ | ⚪ | ✅ | ⚪ |

### 4.8 Git

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_gitRead` | Read-only (status, diff, log, blame). | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_gitShow` | `git show <ref>[:path]`. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_gitWrite` | Allow-listed git writes (approval). | ⚪ | ✅ | ⚪ | ✅ | ⚪ |

### 4.9 Notebook

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_notebookEdit` | Insert / replace / delete cells (approval). | 🔁 | ✅ | ⚪ | ⚪ | ⚪ |
| `tomAi_notebookRun` | Execute cells or the whole notebook. | ✅ | ✅ | ⚪ | ⚪ | ⚪ |

### 4.10 Guidelines and pattern prompts

Guidelines split into two scopes:

- **Global** — workspace-root `_copilot_guidelines/` (recursive).
- **Project** — `{projectPath}/_copilot_guidelines/` inside each project folder (recursive). Discover projectPath values via `tomAi_listProjects`.

The legacy `_copilot_tomai/` and `_copilot_local/` folders are no longer supported.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_readGlobalGuideline` | Read a single global guideline (workspace root `_copilot_guidelines/`). | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_listGlobalGuidelines` | List all global guidelines recursively. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_searchGlobalGuidelines` | Grep inside global `_copilot_guidelines/`. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_readProjectGuideline` | Read a single project guideline. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_listProjectGuidelines` | List a project's guidelines recursively. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_searchProjectGuidelines` | Grep inside one project's `_copilot_guidelines/`. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_listPatternPrompts` | List workspace `!<name>` pattern prompts. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_readPatternPrompt` | Read a `!<name>` prompt body. | ✅ | ✅ | ✅ | ✅ | ✅ |

### 4.11 Quest todos (YAML-backed)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_listQuestTodos` | List quest todos (filterable by status / file / tags). | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getQuestTodo` | Fetch a single quest todo by id. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createQuestTodo` | Create a new quest todo. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_updateQuestTodo` | Patch fields on a quest todo. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_moveQuestTodo` | Move between YAML files within a quest. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_transferTodos` | Move todos into a quest's own todo file (the same or another quest) or into `workspace.todo.yaml`, from any todo file of a quest (session and topic files included) or from the workspace file. Per-id refusals in `skipped`. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_deleteQuestTodo` | HARD-delete a quest todo (not recoverable — prefer `tomAi_deleteQuestTodos`). | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_archiveQuestTodos` | Move completed todos to the `-archived` sibling file (`todoIds` or `allCompleted`). | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_deleteQuestTodos` | Move non-completed todos to the `-deleted` sibling file (recoverable; `todoIds` or `allCancelled`). | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_listWorkspaceQuestTodos` | All `*.todo.yaml` across the workspace. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getCombinedTodos` | Aggregate quest + session in one call. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listQuests` | Enumerate quest folders under `_ai/quests/`. | ✅ | ✅ | ✅ | ✅ | ✅ |

Archive/delete naming rule: the sibling file is derived by suffixing the
**first dot-segment** of the source name (`todos.myquest.todo.yaml` →
`todos-archived.myquest.todo.yaml` / `todos-deleted.myquest.todo.yaml`).
Archive moves only `status: completed` todos (stamped `archived:`); delete
moves only non-completed todos (stamped `deleted:`). Files whose first
segment already ends in `-archived`/`-deleted` are terminal and refuse both
operations. Both moves are **idempotent by id**: archiving a todo already
present in the target replaces it in place rather than adding a second copy,
and the result reports those ids under `replaced`. See
`_copilot_guidelines/todo_files_and_panel.md`.

### 4.11a Id generation

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_generateIdPrefix` | Date-based, letters-only code that makes hand-authored ids collision-free. | ✅ | ✅ | ✅ | ✅ | ✅ |

Hand-authored ids used to collide: two sessions — or two machines — inventing
`vex1` on different days produced the same id for unrelated work, and because
the `_ai` layer is shared fleet-wide the clash surfaced only after a merge. The
tool takes no input and stamps a 4-letter code derived from the **local** clock,
which the model appends to the base id the user supplied:
`<baseId>_<prefix>-<short-description>` (e.g. `vex1_agäo-add-retry-backoff`).

| Position | Field | Mapping |
| --- | --- | --- |
| 1 | Year | `a`=2026 … `z`=2051 |
| 2 | Month | `a`=January … `l`=December |
| 3 | Day of month | `a`=1 … `z`=26, then `ä`=27, `ñ`=28, `ö`=29, `ß`=30, `ü`=31 |
| 4 | Hour | `a`=0 … `x`=23 (24-hour clock) |

The code is **deterministic within a clock hour** — two calls in the same hour
return the same code by design, so re-running a step reproduces the id instead
of minting a second one. Uniqueness across time comes from the hour changing;
uniqueness within an hour comes from the base id. Years outside `a`–`z` and
invalid dates are rejected with an error envelope rather than emitting
`undefined` letters. The five extended day letters are single UTF-16 code units,
which keeps the code exactly four characters and safe to index positionally.

Implementation: `src/tools/id-prefix-tools.ts` (pure `buildIdPrefix` /
`describeIdPrefixParts` encoder plus the tool wrapper). The workspace-wide rule
that this tool must be called before inventing **any** id lives in `CLAUDE.md` /
`.github/copilot-instructions.md`.

The tool is reachable under both profile shapes: it is in `ALL_SHARED_TOOLS`
(so `toolsEnabled: true` profiles get it) and in `AVAILABLE_LLM_TOOLS` under the
**Ids** category, so allow-list profiles can tick it in every picker.

### 4.12 Session todos (per host + quest)

Session todos live in one stable, git-tracked file per host+quest:
`_ai/quests/<quest>/session-todo.<host>.<quest>.todo.yaml`. They persist
across window reloads (legacy per-window files are migrated on first access).

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_addSessionTodo` | Add a session self-reminder (persistent per-host file). | ✅ | ✅ | ✅ | ✅ | ⚪ |
| `tomAi_listSessionTodos` | List session todos. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getAllSessionTodos` | Counts + all items. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_updateSessionTodo` | Patch fields. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_deleteSessionTodo` | Delete. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_manageTodo` | Chat-session todo manager — separate from quest / window todos. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |

### 4.13 Workspace metadata

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_listProjects` | Projects from `tom_master.yaml`. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listDocuments` | Files in prompts / answers / notes / roles / guidelines. | ✅ | ✅ | ✅ | ✅ | ✅ |

### 4.14 Issues (bottom-panel WS tab, Issues subpanel)

Bugs / feature requests / work items tracked via the Issues subpanel.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_listIssueRepos` | Discover repos configured for Issues. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listIssues` | List with state / label / substring filters. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getIssue` | Fetch one + optional comments. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listIssueComments` | Comments only. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createIssue` | Open a new issue (approval). | ⚪ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_addIssueComment` | Comment on an issue (approval). | ⚪ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_setIssueStatus` | Change status — uses statuses from the Issues panel config (approval). | ⚪ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_toggleIssueLabel` | Toggle a label; key=value labels replace prior value (approval). | ⚪ | ✅ | ⚪ | ✅ | ⚪ |

### 4.15 Tests (bottom-panel WS tab, Tests subpanel — testkit)

Parallel to §4.14 but scoped to the **Tests** subpanel (test reports, flaky-test tickets). Same `IssueProvider` transport, different repos + different semantics.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_listTestRepos` | Discover repos configured for Tests. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listTests` | List test-kit items with filters. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getTest` | Fetch one + optional comments. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listTestComments` | Comments only. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createTest` | File a new test report (approval). | ⚪ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_addTestComment` | Comment on a test-kit item (approval). | ⚪ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_setTestStatus` | Change status (approval). | ⚪ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_toggleTestLabel` | Toggle a label (approval). | ⚪ | ✅ | ⚪ | ✅ | ⚪ |

### 4.16 Chat variables

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_readChatVariable` | Read a chat variable. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_writeChatVariable` | Write a chat variable (own change log — no approval). | ✅ | ✅ | ⚪ | ✅ | ⚪ |

### 4.17 Memory (`_ai/memory/`)

Two-tier: `shared/` (cross-quest) and `{quest}/` (per-quest).

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_readMemory` | Read a memory file. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listMemory` | List memory files. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_saveMemory` | Save new memory (approval). | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_updateMemory` | Patch-edit memory (approval). | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_forgetMemory` | Delete memory (approval). | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |

### 4.18 User interaction

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_notifyUser` | Notification (Telegram if configured, else VS Code). | ✅ | ✅ | ✅ | ✅ | ⚪ |
| `tomAi_askUser` | **THE** way to ask the user and get an answer. Blocking: asks up to 15 questions in a webview + Telegram and returns the user's verbatim reply. Waits **indefinitely** by default — the block *is* the pause, so a prompt running in the queue holds there until the user answers. Pass `timeoutMinutes` to continue automatically instead. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_askUserPicker` | `showQuickPick` selection — requires a human. Same indefinite-by-default wait and optional `timeoutMinutes`. | ✅ | ✅ | ⚪ | ✅ | ⚪ |

**The picker always allows a free-text answer.** An **"Other…"** entry is appended to `items` automatically (`src/services/free-text-picker.ts`); taking it opens an input box and the typed text becomes the selection, with `label` and `value` both set to it. The entry is pinned (`alwaysShow`), so typing an answer that matches no item cannot filter it away. Pressing Enter then submits the typed text directly. That holds even though the pinned "Other…" row is the highlighted one at that point: a selection made only of pinned rows, with text in the box, counts as the text. The input box only opens for a user who picks "Other…" with nothing typed. A list of options is a guess about what the answer might be, and the real answer is regularly none of them — so `selected.value` may be text that was never among the offered items, and callers must not assume otherwise. The Agent SDK's built-in `AskUserQuestion` interceptor uses the same affordance.

Both log to the quest's **Questions** journal (`questions.<quest>.md`, @WS → Logs → Questions): the question as asked and the answer as given, or the fact that the wait timed out.

### 4.19 Planning and delegation

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_enterPlanMode` | Signal planning; disables mutations (host-enforced). | 🔁 | ✅ | ⚪ | ⚪ | ⚪ |
| `tomAi_exitPlanMode` | Leave plan mode, attach final plan. | 🔁 | ✅ | ⚪ | ⚪ | ⚪ |
| `tomAi_spawnSubagent` | Run a nested conversation with a narrower tool set. | 🔁 | 🔌 | ⚪ | ❌ | ⚪ |
| `tomAi_askBigBrother` | Delegate to a larger model via the VS Code LM API. | ⚪ | ⚪ | ✅ | ❌ | ⚪ |
| `tomAi_askCopilot` | Bounce a question off the **Copilot Chat panel** (via bridge). | ⚪ | ⚪ | ✅ | ❌ | ⚪ |

### 4.20 Copilot Chat orchestration — prompt queue, pre-prompts, timed requests, templates

These tools drive the **Copilot Chat user-facing panel** via a bridge. They are *not* relevant to how the calling chat (Anthropic / Ollama / VS Code LM) receives its own responses — they stage and dispatch prompts into someone else's chat. The `⚪` across all transports is intentional: whether to surface them is a user-workflow decision, not a per-transport default.

**Queue-item fields now surface the current manager feature set:** per-item `repeatCount` + `repeatPrefix` + `repeatSuffix` (main-prompt repeats with `${repeatNumber}`/`${repeatIndex}` placeholder expansion), `templateRepeatCount` (whole-template re-runs), `answerWaitMinutes` (auto-advance on timeout), pre-prompts (sent before the main prompt), per-follow-up `repeatCount` + `answerWaitMinutes` + reminders, and **chat-variable-driven counters** — any `repeatCount` accepts either a literal number or the name of a chat variable whose value the manager resolves at send time and decrements each iteration. Timed-request entries gained `repeatCount`, `repeatPrefix`, `repeatSuffix`, `sendMaximum` (auto-pause after N sends), and `answerWaitMinutes`; `scheduledTimes` now takes the manager's native `{time:"HH:MM", date?:"YYYY-MM-DD"}` shape.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_addQueueItem` | Stage a prompt; now accepts prePrompts, per-item repeat/answer-wait, and full follow-up / reminder fields. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_addQueueFollowUp` | Append a follow-up; now accepts repeatCount, answerWaitMinutes, reminders. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_addQueuePrePrompt` | Append a pre-prompt (sent before the main prompt). | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updateQueuePrePrompt` | Patch pre-prompt fields by (itemId, index). | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_removeQueuePrePrompt` | Remove a pre-prompt by index. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_sendQueuedPrompt` | Send one staged prompt. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_sendQueueItem` | Send a specific item immediately. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_listQueue` | List queue items. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updateQueueItem` | Patch item fields incl. repeat / answerWait / reminder. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_setQueueItemStatus` | Toggle staged / pending. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_removeQueueItem` | Delete. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updateQueueFollowUp` | Patch follow-up incl. repeat / answerWait. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_removeQueueFollowUp` | Remove a follow-up. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_addTimedRequest` | Create a timed entry (interval) with repeat / sendMaximum / answerWait / reminder. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_listTimedRequests` | List timed entries. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updateTimedRequest` | Patch timed entry; schedule slots use `{time:"HH:MM", date?:...}`. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_removeTimedRequest` | Remove a timed entry. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_setTimerEngineState` | Enable / disable the timer engine. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_listPromptTemplates` | List prompt templates. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_createPromptTemplate` | Create a new prompt template. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updatePromptTemplate` | Patch (optionally rename) a prompt template. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_deletePromptTemplate` | Delete a prompt template. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_listReminderTemplates` | List reminder templates. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_createReminderTemplate` | Create a reminder template. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updateReminderTemplate` | Patch a reminder template. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_deleteReminderTemplate` | Delete a reminder template. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |

**Remaining gaps** (manager features still with no tool): engine-wide `TimerScheduleSlot` (awake/asleep windows with weekday / first-weekday / last-weekday / day-of-month patterns) and reminder-system config (`ReminderSystem.config.enabled`, `defaultTimeoutMinutes`). Add if a workflow needs LLM-driven control of those.

### 4.21 AI Conversation result document

A shared markdown document per conversation that both participants read + write so the bot-to-bot exchange can produce a durable outcome. Stored at `_ai/ai_conversation/{conversationId}.result.md` (default id: `"current"`). This is the **only mutation tool** enabled for AI Conversation in the default seed config — every other mutating tool is off.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_readConversationResult` | Read current content of the conversation's result document. | ⚪ | ⚪ | ⚪ | ⚪ | ✅ |
| `tomAi_writeConversationResult` | Write (replace) or append to the conversation's result document. | ⚪ | ⚪ | ⚪ | ⚪ | ✅ |

### 4.22 Past tool access (session-scoped history lookup)

Session-scoped pull access to earlier tool calls + their full results. Backed by the Anthropic handler's in-memory `ToolTrail` ring buffer (default 40 entries, 100 kB per entry). The injected `[Tool history — last N calls]` block at the top of every outgoing user message already summarises the most recent calls and includes a **replay key** per line; these tools let the agent look up the full result on demand, or grep across the buffer.

The buffer is **session-scoped** (cleared on `Clear session history`) and **Anthropic-only** — the Local LLM handler maintains its own unrelated conversation state, so these tools return an informative message there instead of wrong data. Read-only; never prompt for approval.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_listPastToolCalls` | List recent tool calls with replay keys. Optional filters: `toolName`, `sinceRound`, `limit` (default 20, max 200). | ✅ | ✅ | ⚪ | ⚪ | ⚪ |
| `tomAi_searchPastToolResults` | Regex search across past result bodies; returns snippets with replay keys. Arguments: `pattern`, optional `toolName`, `caseSensitive`, `limit`, `contextChars`. | ✅ | ✅ | ⚪ | ⚪ | ⚪ |
| `tomAi_readPastToolResult` | Return the full body of a past tool call by its replay key (e.g. `t14`). | ✅ | ✅ | ⚪ | ⚪ | ⚪ |

Typical usage: the injected history block shows `14:23:05 [t14] R3 tomAi_readFile(src/foo.ts) → export function foo …`. Past tool N returned content the model now wants verbatim → `tomAi_readPastToolResult({ key: "t14" })` returns the whole file content it saw earlier, no tool re-run.

### 4.23 TomSpecs (SOM) documents

The order an agent uses these tools in, as a recipe, is
[tomspecs_agent_workflow.md](tomspecs_agent_workflow.md). Every reader is on the
MCP read-only floor and every writer needs approval; a test holds both halves
(`spec-tools-surface.test.ts`). The pickers group them as TomSpecs, TomSpecs
(edit), DocSpecs and CodeSpecs.

Read and reflect on TomSpecs documents — `*.docspecs.yaml` and SOM-rendered
`*.md` (headings carry `<!--[SECTIONID]-->`) — through the bundled SOM runtime,
instead of reading the raw file and guessing at paths. Each call loads the file
(a file open in an editor is read from its buffer); the model is parsed once per
extension host. All are read-only, so the MCP server's unauthenticated floor
includes them.

Paths are document paths: the root section id, then field segments (a field's
`@SectionId`, else its name) and list items `<LIST>-<n>`, e.g.
`SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`.
Take them from `tomAi_specOutline` rather than composing them. A path that does
not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind,
children}}`, the nearest node that does, so the agent can correct itself. In a
document, a list item resolves only when the list holds it.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_specListDocuments` | The model's document roots, and the SOM documents under a folder with their root, model-version stamp and editability. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specOutline` | The instance tree under a path: kind, section id, headline, codeSpec, filled, item counts; depth-limited and paged. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specGetSection` | One node with its values: a leaf's value, a form's typed fields with enum domains, a list's items, a section's values, forms and children. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specReflect` | The model at a path or class: kinds, types, form fields, annotations, doc comments; with a file, the children `checkAddNode` accepts there now. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specSearch` | Query one document (runtime `SpecQueryEngine`): text or portable pattern, kinds, class, `@SectionId`, path glob, `@MapsTo` / `@DetailedIn`, empty / non-empty, AND-combined. First page + cursor. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specSearchIterate` | The next page of a search cursor; re-runs the query when the file changed since. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specValidate` | Is it valid now? The three tiers of tom_specs' `validate_spec` CLI (decode, DocSpecs schema, instance) in its report shape, each finding with the `path` to fix. `files` validates fragments of one document as one; `path` scopes the findings. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specRender` | The document, or one subtree, as the DocSpecs Markdown a reader sees. | ✅ | ✅ | ⚪ | ✅ | ✅ |

**Validation.** `tomAi_specValidate` answers in the report shape of tom_specs'
`validate_spec --json` (`spec-validation`/1): `{passed, summary, root {type,
sectionId, title, schemaId, schemaVersion}, tiers [{tier, ran, findings}],
notRun, violations [{tier, code, severity, file, line, location, message}]}`.
The extension adds `path` to each violation: the document path to fix, in the
form the edit tools take. An instance finding states its path. A schema finding
names a line of the rendition; its path is the section that line falls under,
from the heading map the runtime renders with (a section id alone would not do,
since it repeats: every requirement has a FRED form). The edit tools'
`validation` is the instance tier only.

**Edits.** These tools write files: `readOnly: false` and `requiresApproval: true`,
so they pass the approval gate and the MCP server offers them only to
authenticated clients. Every change goes through the runtime's `SpecEditor`,
`SpecNodeCreator` and `SpecDocument`. A wrong path, a value of the wrong type, an
enum name outside its domain, a child the model does not allow, or a section id
that breaks its pattern or collides is refused, and a refused edit writes
nothing. Each call loads, edits and saves the file in its own format. It takes
`expectedRevision` (refused when the file changed since it was read) and
`dryRun` (returns a `diff`, writes nothing).

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_specCreateDocument` | A new, empty document for one model root, in the format its file name says. Refuses an existing file. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specSetContent` | A content or scalar value; null or `""` clears it. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specSetFormField` | One form field, typed by its declaration: int, double, bool or enum name. A wrong value comes back with the field's type and domain. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specSetHeadline` | A section's stored headline; null returns it to its default title. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specSetCodeSpec` | The heading-level `codeSpec=` routing marker. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specAddNode` | A child or a list item (id generated from the pattern, or given), optionally populated with `content` and form `fields`. A refusal lists the legal children. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specSetItemSectionId` | Rename a list item's section id; the pattern prefix and list uniqueness are checked. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specMoveListItem` | Reorder within a list or move to a list of the same element class; returns the `renamed` map, and YAML review entries follow their items. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specRemoveListItem` | Remove a list item and everything under it. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specClearSection` | Remove every value under a path. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specConvert` | Write the other format (`*.docspecs.yaml` ↔ `*.md`) beside or over the source. Refuses unfaithful Markdown; a YAML source's review entries need `dropReview`, since Markdown has none. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specApplyEdits` | **The preferred way to make more than one change:** up to 200 of the edits above (`{op, …}`), in order, on one document. One approval, one write, one undo step, all or nothing. `addNode` can bind `as: "req"` for later `$req/…` paths; a move re-points bound names and refuses a stale literal path. The approval prompt shows the op counts and paths. | ✅ | ✅ | ⚪ | ✅ | ⚪ |

Every edit answers `{ok, written, revision, …, validation}`. `validation` compares
the runtime's `validateDocument` before and after the edit across the whole
document: `introduced`, `resolved`, the errors `underPath`, and the `total`. It is
document-wide because a stated count (`countOf`) usually sits outside the list
that changed. For YAML, the answer also lists `staleReviewPaths`, review entries
left without a node.

A document with no values is written with its root key
(`document:\n  SBP D00SolutionBlueprint: {}`), so the file still says which
document it is.

Every document answer carries the document's `format`, `stamp`, `editability`,
`readOnlyReason` and `revision`. A Markdown file whose import does not reproduce
it loads read-only and says so, because a save would rewrite it: a hand-formatted
file, or one hitting an import defect. The revision is what a later edit passes
as `expectedRevision`.

One limit remains: the Markdown import keeps a list item's section id only when it
differs from the id its pattern would generate (tom_specs vsctasb10). The Markdown
does not show the difference. Converting such a file to YAML, or moving items in
it, can therefore change those items' ids.

The TomSpecs editor ships the same capabilities on its own MCP servers under
other names. The extension keeps its `tomAi_spec*` convention; each tool
description names its counterpart:

| Extension | TomSpecs editor |
| --- | --- |
| `tomAi_specListDocuments` | `model_list_documents` |
| `tomAi_specOutline` | `doc_outline` |
| `tomAi_specGetSection` | `doc_get_content`, `doc_get_form_field`, `doc_section_meta` |
| `tomAi_specReflect` | `doc_reflect`, `model_get_section`, `model_children` |
| `tomAi_specSearch` | `doc_search` |
| `tomAi_specSearchIterate` | `doc_search_iterate` |
| `tomAi_specSetContent` | `doc_set_content` |
| `tomAi_specSetFormField` | `doc_set_form_field` |
| `tomAi_specAddNode` | `doc_add_node`, `doc_add_list_item` |
| `tomAi_specValidate` | `validate_spec` (tom_specs_clitool CLI), same tiers and report |
| `tomAi_specRemoveListItem` | `doc_remove_list_item` |

**Search specifics.** The `text` dimension searches stored values (content,
scalar list items, every form field) and the node's headline, which is the
stored headline or, when the document sets none, the model's doc comment, so
model prose can match too. `sectionIdExact` / `sectionIdPrefix` match a node's
section id: the model's `@SectionId`, and for a list item its own id — the
stored one, else the list's `@SectionIdPattern` with the 1-based position, the
id its heading and `tomAi_specOutline` show. `FRE-REQU-ORDER-CAPTURE` finds that
item; the list's id `FRE-REQU-LST` finds only the list. With `regex: true` the
pattern is the runtime's portable subset (`.` `*` `+` `?` `[...]` `^` `$`,
`\` + punctuation). `(`, `)`, `|`, `{`, `}` are literals; `\d`, `\w` and any
other `\` + letter are rejected with `code: "patternError"`. A cursor is the
only state in the spec tools: at most 32 stay open, each closes after 10 minutes
without use, and one that has returned every match closes at once. Each cursor
remembers the file revision its matches come from, and iterating after the file
changed runs the query again (`rerun: true`) and starts over.

### 4.24 Plain DocSpecs Markdown

Markdown that declares a DocSpecs schema (`<!-- docspec: <id>/<version> -->`)
but is not a SOM spec: quest documents, project specifications. Parsing,
validation and the section replace are the runtime's (`DocSpecsDocument`,
`DocSpecsSchema`, `DocSpecsValidator`). Files go through the same store as the
spec tools, so the text is read from an open editor's buffer, and a write is
refused when the file is dirty or has changed since it was read.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_docspecsValidate` | Check the document against its declared schema. A declared schema found nowhere (`unknownSchema`) and a missing header (`noSchemaDeclared`) are findings. Schema keys the runtime ignores are listed (`ignoredByRuntime`): their constraints are not checked. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_docspecsOutline` | The section tree with line ranges; with a schema, the required sections and those missing. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_docspecsGetSection` | One section's own body (up to its first subsection), by id. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_docspecsReplaceSection` | Replace one section's own body (approval). Every other byte is kept, and fenced blocks are respected. A body that would add a heading or leave a fence open is refused. Answers the validation it introduced or resolved; `dryRun` returns a diff. | ✅ | ✅ | ⚪ | ✅ | ⚪ |

The schema is looked up in this order:
1. an explicit `schema` argument (`<id>/<version>` or a schema file);
2. `.tom/docspecs-schema/<id>/<id>.<version>.docspecs-schema.yaml` in the
   document's folder, or the nearest folder above it, up to the workspace root;
3. the schemas generated from the SOM model, so SOM-rendered Markdown validates
   too.

`docspec: none` declares no schema.

**Two DocSpecs forms.** The runtime reads headings that carry `<!--[ID]-->` ids
under a `<!-- docspec: id/version -->` header. The DocSpecs specification also
shows an older form, `# [id] Title` headings and a `<!-- schema=name-1.0 -->`
field, and the workspace's own documents and `.tom/docspecs-schema/` files use
that form. Measured 2026-10-13:
- no quest document carries `<!--[ID]-->` headings;
- the quest-overview, quest-notes and webwork schemas that quest documents
  declare exist nowhere in the workspace;
- the nine workspace schemas load with 5–21 runtime warnings each, chiefly
  `max-count-in-document`, whose limits are then not checked.

So on today's workspace documents these tools mostly report `unknownSchema`, or
`malformedHeading` with a `dialect` note. They work fully for documents in the
runtime's form, including SOM-rendered Markdown. tom_specs vsctasb7 settles
which form is current.

### 4.25 CodeSpecs (Phase 4: a filled spec becomes code-generation inputs)

These tools run the runtime's `CodeSpecsExtractor` over one TomSpecs document
and the CodeSpecs area catalogue. `npm run som:pack` copies the catalogue from
`tom_specs_model`, and the derivation contract from `tom_core_codespecs`, into
`resources/codespecs/`; both ship in the VSIX. The checks over generated code
run the `validate_codespecs` binary (tom_specs_clitool, compiled with
`dart compile exe`), which ships in `bin/<platform>/` beside `tom_bs`.

The concepts:
- An **area** (`CE-…`, 27 in all) is one kind of generated artefact.
- A **slice** (7) is a group of areas emitted into one project.
- An **authoring step** (31) is a place in the order artefacts are written.
- **Routing:** every class node is routed by its model annotations:
  - `@CodeSpecKind`: it feeds code;
  - `@FollowUpKind`: a process delivers it, and routing does not descend
    further;
  - `@NoArtifact`: it feeds nothing;
  - `@Document`: it is the root.

  A class with none of these is **unrouted**, and extraction refuses the
  document (ROUTE-TOTAL, gate A3). Only the model routes a class: a heading
  `codeSpec=` names artefacts, and an unrouted class is fixed in the model.
- **Extract:** one area's entries, each with its section id, path, class,
  field, verbatim value and the routing that placed it.

The CodeSpecs projection document (a root with `@CodeSpecsProjection`: D13,
CGP) defines what generation reaches. It is not filled and not extracted, so
these tools refuse it rather than return 27 empty extracts.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_specCodeSpecsAreas` | The catalogue: areas, slices, authoring steps; one area (projects, citable areas, steps) or one slice in detail. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specCodeSpecsRouting` | Gate A3, readable: every class node's verdict, with the unrouted ones and their fix; filter by verdict or path. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specCodeSpecsExtract` | One area's extract as Markdown with each entry's provenance, or a per-area summary. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specCodeSpecsGate` | The Stage-A gate in one report (runtime `CodeSpecsGate`): A1 schema completeness, A2 valid values, A3 routing, A4 required marker sources, A5 carriers the model still offers. Per check: passed, findings with the document path to fix (A5 findings are model-level), and the fix; plus `gateOpen`. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specCodeSpecsVerdicts` | The Stage-B gate record (`gate.verdicts.yaml` beside the extracts): each area's verdict, resolution and note, the active areas still missing, and whether record and extracts agree. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specCodeSpecsSetVerdict` | Record one area's verdict (approval), validated by the runtime's record rules (`resolution: descoped` only on insufficient). The record's leading comments are kept, and an unchanged verdict rewrites it byte-identically. An insufficient verdict comes with what is owed next. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specCodeSpecsQueryExtracts` | Entries of a written run (by this tool or the Dart CLI), filtered by area, token, path or text, each with its provenance and verbatim value. An extract in an unknown format is listed as unreadable, never misread. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specCodeSpecsTrace` | Spec path, token, code location or declaration to the other end, by section-id token (the unit `@CodeSpec` / `@DocSpec` back-links cite), plus the heading `codeSpec=` forward links. With back-links it adds `agreement`, the uncited and dangling tokens (the shape of `validate_codespecs` checks 35 and 36). | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specCodeSpecsValidate` | The 41 `codespecs_derivation_contract.md` §6 checks over a generated trio (shared, client, server; client and server default to the shared folder's siblings), through the bundled `validate_codespecs --json`. `outcome` keeps `clean`, `violations` (each with check number and title, defining section, file, line, token or area, message) and `usageError` apart; `notRun` names each check whose corroborating input was not given — checks 40 and 41 (protocol-feature hooks) need tom_code_specs' hook catalogue, which the tool does not pass yet, so they are always listed there. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specCodeSpecsStepContext` | Everything authoring step `csgen<n>` (1–31) may read (§2.9): its title, slice, placement and areas; those areas' extracts, entry by entry; the §3 contract entries for the markers they emit, with text; §2's section list (or its text); the output project. | ✅ | ✅ | ⚪ | ✅ | ✅ |
| `tomAi_specCodeSpecsPlanTodos` | Stage C: propose (`dryRun`) or create the todo tree from the gate record (approval). `csopen<n>` (decision-needed) per insufficient area not descoped, carrying its gate note; `csproj1`, the trio scaffolding (decision-needed without `appName`); `csgen1`–`csgen31`, one per authoring step, each naming its areas and verdicts, extracts, output project and the step-context call. Refused without a verdict for every active area, or, with `file`, when Stage A fails. Idempotent per item. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_specCodeSpecsWriteExtracts` | Write every area's `.extract.yaml` / `.extract.md` to `<document folder>/generated-doc/codespecs_extracts/` (approval). Unchanged files are left alone; `dryRun` reports the file statuses. | ✅ | ✅ | ⚪ | ✅ | ⚪ |

**Tracing.** The back-links come from the generated trio itself (`codeDirs`),
read by the bundled `validate_codespecs --backlinks`, or from a JSON index that
command wrote (format `codespecs-backlinks`/1), passed as `backlinks`. Tracing is
by token, as checks 35 and 36 are. Which declaration *should* carry a token is
the authoring step's judgement, and the tools do not decide it.

**Validation.** The binary is built by `npm run codespecs:build`
(`scripts/build-validate-codespecs.cjs`, which `install_extension.sh` /
`.ps1` run; a from-source install fails without it). It needs a Dart SDK at
build time only. When it is absent, validation answers `binaryMissing` and the
trace with `codeDirs` answers `binaryMissing`, both naming that command.

**The todo tree.** The tree follows `codespecs_prompt.md` §7 and
`codespecs_mapping.md` §1.1.3. All 31 `csgen` todos are created, even for a step
whose areas are all out of the pass: that step completes with an empty L3 rung,
which records that it had nothing to author. The order lives in the numbering
and the statuses. The queue walks `csopen*`, then `csproj*`, then `csgen*`,
lowest number first, and pauses on a decision-needed todo. `dependencies`
records the order for the reader; nothing is `blocked`. Each todo carries a
run tag (`codespecs-run:<extract folder>`) and an item tag (`codespecs-open:<area>`,
`codespecs-proj`, `codespecs-step:<n>`). A rerun recognises those tags on any
todo of the quest, archived ones included, and creates only what is missing. A
new `csopen` continues the quest's `csopen` numbering. L3 todos are never
created here.

**Step context.** A step is handed the §3 entries of its own slice that name one
of its areas' markers (`@CsTable`) or codes (`CE-DB`), plus §3.0 (the
collaborator, across every slice). An area whose marker follows its host into a
later slice (CE-AZ, CE-LG, CE-NT, CE-TX, CE-UP in some steps) gets its marker's
entries from any slice; `matchedBy` says which rule found each area's entries.

For the Meridian sample, the written extracts equal the conformance corpus
(`tom_som_conformance/generated-doc/codespecs_extracts`) byte for byte.

### 4.26 Processes (the process a quest follows)

A process is defined in `_ai/processes/<id>/`: `<id>.process.yaml` holds the
structure (schema: `src/config/process.schema.json`) and `<id>.md` its
description. It has phases of steps; a step may group sub-steps (it is then no
action of its own), and a step or sub-step may name the role doing it. Every
phase ends with a quality-gate step and may have a post-gate step, whose todos —
listed in the YAML, plus the quest todos with its `todoPrefix` — are done after
the gate passed and before the next phase starts. Phases, steps and sub-steps
can be repeatable, optionally with a `maxIterations`.

The active quest's position — process, phase, step, sub-step and their
iterations — is kept in `_ai/quests/<quest>/process-state.<quest>.yaml`, the
same in every window and on every machine. It reaches the model as the chat
variables `process`, `phase`, `step`, `substep`, `phase-iteration`,
`step-iteration`, `substep-iteration`, `process-description`,
`phase-description`, `step-description`, `substep-description`,
`phase-prompt`, `step-prompt`, `substep-prompt`, and as the
`${process-context}` block every Anthropic profile's system prompt carries
(empty without a process). `tomAi_writeChatVariable` refuses those keys:
moving the quest goes through `tomAi_setProcessState`, which checks every name
against the definition. A move to a step or sub-step that names a role also sets
the `role` chat variable. The user sees and sets the same state in the @TOM
**PROCESS** view and edits the definitions in the process editor; the view's
action bar (Next, Repeat, Gate passed, …) moves the state and queues the
prompt built from that action's template.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_listProcesses` | Every process with its outline (phases, steps with `kind` step / gate / post-gate, sub-steps, roles, repeat flags); invalid ones with their errors; the quest's current process. | ✅ | ✅ | ✅ | ✅ | ⚪ |
| `tomAi_getProcess` | One process in full: definition, Markdown description, file paths (default: the quest's process). | ✅ | ✅ | ✅ | ✅ | ⚪ |
| `tomAi_getProcessState` | The quest's state, the role its step names, and the `${process-context}` block. | ✅ | ✅ | ✅ | ✅ | ⚪ |
| `tomAi_setProcessState` | Move the quest: `process` (`""` clears), `phase`, `step`, `substep`, the three iterations (a gate can always be run again) and `completed` (the process finished; any other change opens it again); checked against the definition, no approval prompt (visible live in the PROCESS view). | ✅ | ✅ | ✅ | ✅ | ⚪ |

## 5. Transport-specific recommendations

### 5.1 Anthropic Agent SDK (`transport: 'agentSdk'`)

- Default to **`profile.useBuiltInTools = true`** for full-development mode. The SDK supplies `Read`/`Write`/`Edit`/`MultiEdit`/`Glob`/`Grep`/`Bash`/`BashOutput`/`KillBash`/`WebFetch`/`WebSearch`/`NotebookEdit`/`TaskCreate`…`TaskList`/`Task`/`AskUserQuestion`/`ExitPlanMode`; our 🔁 tools are suppressed automatically.
- Leave `tomAi_enterPlanMode` / `tomAi_exitPlanMode` off — the SDK ships its own plan-mode state.
- `tomAi_spawnSubagent` is redundant when `Task` is available; keep off.
- Keep all the ✅-rows on — they're VS Code specific and have no SDK equivalent (editor context, problems, symbols, code actions, git writes, tasks/debug, issues/tests, quest/session todos, chat variables, memory, pattern prompts, guidelines, user interaction).

### 5.2 Anthropic API direct (`transport: 'direct'`)

- All ✅-rows are on by default; no preset exists.
- `tomAi_runCommandStream`/`tomAi_readCommandOutput`/`tomAi_killCommand` are the only way to stream long-running commands on this transport — leave them on when test-running or building.
- Wire `tomAi_spawnSubagent` by calling `registerSubagentSpawner()` in `anthropic-handler.ts`; until then it returns an instructive error.

### 5.3 Local LLM (Ollama)

- Default to **read-only** tools only (`READ_ONLY_TOOLS`). Open-source models misbehave more frequently with tool-calling — every mutation tool is approval-gated anyway.
- Keep `tomAi_askBigBrother` and `tomAi_askCopilot` on: delegating hard questions out of Ollama to a stronger model or to the Copilot Chat panel is the whole point.
- LSP-heavy tools (`findSymbol`, `gotoDefinition`, `findReferences`, `getCodeActions`) work but consume a lot of tokens for small models — leave off by default.

### 5.4 Tom AI Chat (VS Code LM)

The user's single-conversation surface. Structurally similar to Anthropic API direct — same "hand the model messages + tools, get a response" loop — but via `vscode.lm.*` so the model selection flows from a VS Code LM configuration rather than an Anthropic API key. Enable roughly the same tool set as Anthropic API direct.

- All user-interaction tools are on by default — a human is present, `askUser` / `askUserPicker` / `notifyUser` make sense.
- LSP + editor-context + files + git + tasks + memory + chat vars — all ✅ by default.
- Copilot Chat orchestration tools (§4.20) are ⚪ — useful if the user wants to stage prompts into Copilot Chat from inside Tom AI Chat, off otherwise.
- `tomAi_askBigBrother` is ❌ — Tom AI Chat *is* the VS Code LM surface, so delegating out is circular.
- `tomAi_askCopilot` is ⚪ — the user can reasonably bounce a specific question to the Copilot Chat panel.

### 5.5 AI Conversation (VS Code LM)

Two agents converse via the VS Code LM API, orchestrated without a human in the loop. **This mode is experimental.** Until it is proven reliable, the default seed config restricts AI Conversation to a **read-only tool subset** plus the two `tomAi_{read,write}ConversationResult` tools that let the bots produce an outcome document.

Default enabled tools (seed config `default-conversation-llm`):

- **Read-only file / workspace**: `readFile`, `listDirectory`, `findFiles`, `findTextInFiles`, `getWorkspaceInfo`, `getActiveEditor`, `getOpenEditors`.
- **Diagnostics**: `getErrors`, `getProblems`.
- **Git read**: `git`, `gitShow`.
- **Web research**: `fetchWebpage`, `webSearch`.
- **Guidelines + pattern prompts**: `readGuideline`, `readLocalGuideline`, `listGuidelines`, `searchGuidelines`, `listPatternPrompts`, `readPatternPrompt`.
- **Result document**: `readConversationResult`, `writeConversationResult` (the only mutation allowed).

Explicitly off (even though they'd technically work):

- **No human** — `askUser` / `askUserPicker` are ❌ (no one to ask). `notifyUser` is ⚪ (informational only).
- `tomAi_askCopilot` is ❌ — the conversation has no way to read Copilot's answer back.
- `tomAi_askBigBrother` is ❌ — same VS Code LM surface; delegation is circular.
- `tomAi_spawnSubagent` is ❌ — use the VS Code LM primitives to spawn another conversation participant instead.
- **All file writes, shell, VS Code command execution, git writes, queue orchestration** — deliberately excluded while the mode is experimental. Enable per-profile only when you have a specific reason.
- `tomAi_enterPlanMode` / `tomAi_exitPlanMode` are ⚪ — less useful for a bounded two-party exchange, but harmless.

## 6. Stubs pending host integration

- **`tomAi_spawnSubagent`** — the Anthropic handler must call `registerSubagentSpawner(fn)` from `planning-tools.ts`. Until wired, the tool returns an instructive error. On the Agent SDK transport, prefer the SDK's `Task` tool.

## 7. Deferred / future

- **Plan-mode enforcement** — `isPlanModeActive()` is read by the host. Full behaviour (refuse approval-gated tools while active) is deferred to `anthropic-handler.ts` / `tool-execution-context.ts`.
- **Code-action cache persistence** — `tomAi_getCodeActionsCached` returns `actionId`s backed by an in-process Map with a 5-minute TTL. Consider cross-session persistence if the user wants to apply actions after a window reload.
- **Structured approval previews** — current approval bar renders raw JSON. Upgrade to human-readable previews (unified diff for edits, command preview for runs, URL for fetches). Lower friction → user enables more tools.
- **Tool-result truncation envelope** — a standard `{ content, truncated, continuationToken }` shape would let every tool stream results without bespoke code.
- **Engine-wide timer schedule** — LLM-driven control of `TimerEngine._schedule` (weekday / first-weekday / last-weekday / day-of-month awake windows). No tool today.

## 8. Adding new tools

Tools are grouped by functional family, one file per family under `src/tools/`:

| File | Family |
| --- | --- |
| `editor-context-tools.ts` | Active editor, open editors, workspace info |
| `diagnostics-tools.ts` | Problems panel |
| `language-service-tools.ts` | Symbol search, navigation, refactor, rename, code actions |
| `guideline-tools.ts` | Guideline + guideline-index access |
| `pattern-prompts-tools.ts` | `!<name>` workspace pattern prompts |
| `vscode-command-tools.ts` | `openFile`, `listCommands`, typed-args meta-tool |
| `user-interaction-tools.ts` | `askUser`, `askUserPicker` |
| `workspace-edit-tools.ts` | Transactional multi-file edits (`applyEdit`) |
| `task-debug-tools.ts` | `runTask`, `runDebugConfig` |
| `process-tools.ts` | Streaming command spawn / read / kill |
| `git-tools.ts` | Git read (`git`), `gitShow`, allow-listed `gitExec` |
| `planning-tools.ts` | Plan-mode signals + sub-agent delegation |
| `notebook-tools.ts` | Jupyter `notebookEdit`, `notebookRun` |
| `id-prefix-tools.ts` | Date-based prefix for collision-free hand-authored ids |
| `quest-process-tools.ts` | Processes: list and read definitions, read and move the quest's process state |
| `issue-tools.ts` | Issues subpanel (read + write) |
| `test-tools.ts` | Tests subpanel / testkit (read + write) |
| `codespecs-tools.ts`, `codespecs-gate-tools.ts`, `codespecs-trace-tools.ts` | CodeSpecs: area catalogue, routing, extract, write extracts; the Stage-A gate and the Stage-B gate record; query and trace |
| `docspecs-tools.ts` | Plain DocSpecs Markdown: validate, outline, get and replace a section |
| `spec-tools.ts`, `spec-search-tools.ts`, `spec-edit-tools.ts`, `spec-validate-tools.ts` | TomSpecs (SOM) documents: read and reflect, search with a cursor, edits and the batch, validate / render / convert (`spec-tool-common.ts` holds what they share) |
| `chat-enhancement-tools.ts` | Notify, quest/session todos, queue, timed, templates, reminders |
| `tool-executors.ts` | File I/O primitives, shell, web, memory, chat vars, ask-AI bridges |

Every new tool needs:

1. A `SharedToolDefinition` in the appropriate `src/tools/<family>-tools.ts`.
2. Added to the family file's exported list (e.g. `NOTEBOOK_TOOLS`).
3. The family list spread into `ALL_SHARED_TOOLS` in `src/tools/tool-executors.ts`.
4. Entry in `AVAILABLE_LLM_TOOLS` (`src/utils/constants.ts`) — a tool absent here is invisible to every picker (status page, Anthropic profile editor, global-template editors, MCP server card), so allow-list profiles can never enable it even though it is registered and callable. If the tool is meant to stay behind `toolsEnabled: true`, put it in `DELIBERATELY_UNSELECTABLE_TOOLS` instead, with a reason.
5. A category in `CATEGORY_MAP` (`src/utils/toolCategories.ts`) — unmapped names would fall through to "Other", which the parity guard rejects.
6. At least one `withTiming('<toolName>:<case>', …)` call in the family's test file, conventionally `:typical`. `npm run audit:tools` fails the build without it and enforces a 5 s ceiling.
7. For Agent SDK duplicates: add to `DUPLICATES_OF_CLAUDE_CODE_BUILTINS` in `anthropic-handler.ts`.
8. A row in the right family table in this document.
9. For a write tool whose raw input would not let a person decide at the approval prompt, an `approvalSummary(input)` on its definition (`tomAi_specApplyEdits` summarises its batch as op counts and paths). Both Anthropic transports show it through `summarizeToolInput`; without it the prompt shows the input as JSON cut to 200 characters.

Steps 4 and 5 are enforced by `src/tools/__tests__/tool-registry-parity.test.ts`.
It asserts that `ALL_SHARED_TOOLS` equals `AVAILABLE_LLM_TOOLS` plus
`DELIBERATELY_UNSELECTABLE_TOOLS` exactly, that nothing is selectable without
being registered, and that every selectable tool carries a `CATEGORY_MAP` entry.
Forgetting step 4 or 5 now fails the suite instead of silently producing a tool
that works under `toolsEnabled: true` and is invisible everywhere else.

### Deliberately unselectable tools

Of the 173 registered tools, **157 are selectable** and **16 are withheld from
the pickers on purpose** (`DELIBERATELY_UNSELECTABLE_TOOLS` in
`src/utils/constants.ts`): the twelve queue mutators and dispatch entry points
(`tomAi_addQueueItem`, `tomAi_updateQueueItem`, `tomAi_removeQueueItem`,
`tomAi_setQueueItemStatus`, the three follow-up and three pre-prompt tools,
`tomAi_sendQueuedPrompt`, `tomAi_resendQueueItem`) plus
`tomAi_addTimedRequest`, `tomAi_updateTimedRequest`,
`tomAi_removeTimedRequest` and `tomAi_setTimerEngineState`.

These are the queue and timer **control plane**. A model that can tick them in
its own profile can enqueue and dispatch its own prompts and switch the timer
engine on or off — a reasonable capability to grant an autonomous agent
deliberately, but not one an allow-list profile should acquire by accident. They
remain fully available under `toolsEnabled: true`. Their read-only counterparts
`tomAi_listQueue` and `tomAi_listTimedRequests` **are** selectable, under the
**Queue & Timers (read)** category: observing the queue carries no such risk.
The guard enforces that split — a `readOnly` tool appearing in the exclusion
list fails the suite.

## 9. Scripting-API access and gating

The five chat surfaces in §1 are not the only way to reach the registry above. A
Dart **script** running over the CLI bridge can invoke the same tools through
`TomToolsApi` (in `tom_vscode_scripting_api`):

| Method | Wire op | Returns |
| --- | --- | --- |
| `invokeTool(name, [args])` | `tools.invokeVce` | the tool's string result |
| `getToolsJson()` | `tools.getJsonVce` | Anthropic-shaped `{name, description, input_schema}` for the active profile |
| `listAllowedToolNames()` | (same `getJsonVce`) | just the permitted tool **names** |

### The gate (active profile, enforced server-side)

Both listing and invocation are scoped to the **currently active Anthropic
profile**:

- The available tools are exactly the profile's tool set
  (`toolsEnabled` / `enabledTools`) — the same `resolveProfileTools` primitive
  the chat transports and the standalone MCP server use.
- When the **Send-to-Chat target is Copilot**, *no* tools are available: the
  list is empty and every `invokeTool` is refused.

**The gate lives inside the extension, never in the Dart client.** `TomToolsApi`
is a thin pass-through that does no client-side filtering: a tool the active
profile hides is refused by the extension *before* the executor runs (returning
an error string), so a buggy or malicious client cannot widen its own access.
This is the same "security-in-extension-not-Dart" boundary the Agent SDK mirror
([agent_sdk_scripting_mirror.md](agent_sdk_scripting_mirror.md) §8) and the
standalone MCP server ([mcp_server.md](mcp_server.md)) state.

### `listAllowedToolNames()` is a convenience, not a security check

It returns the names from `getToolsJson()` purely so a script can pre-validate a
name before calling `invokeTool`. Because the extension **re-checks on every
invoke**, skipping the pre-check is always safe — `listAllowedToolNames()`
exists for ergonomics and diagnostics, not enforcement.

> The standalone MCP server resolves its effective set from its **own** picker
> (`enabledTools` when `toolsEnabled === false`), *not* the active chat profile —
> see `mcp_server.md`. `TomToolsApi` is the path that follows the active
> **Anthropic profile**.
