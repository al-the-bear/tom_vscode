# LLM Tools — Transport Inventory

This document is the source of truth for every tool available to LLM chat surfaces in the Tom VS Code extension. Tools are grouped by family, and each row carries a per-transport recommendation for default enablement.

## 1. Transports

Four chat surfaces call into tools:

- **Anthropic Agent SDK** — `transport: 'agentSdk'` on an Anthropic configuration. Wraps `@anthropic-ai/claude-agent-sdk`. When `profile.useBuiltInTools = true`, Claude Code's built-in preset (`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `Bash`/`BashOutput`/`KillBash`, `WebFetch`, `WebSearch`, `NotebookEdit`, `TodoWrite`, `Task`, `AskUserQuestion`, `ExitPlanMode`, `SlashCommand`, …) is exposed; our extension tools that duplicate a built-in (`DUPLICATES_OF_CLAUDE_CODE_BUILTINS` in `anthropic-handler.ts`) are suppressed to avoid confusion. Our own MCP server runs next to the preset and surfaces the rest.
- **Anthropic API (direct)** — `transport: 'direct'`. `@anthropic-ai/sdk`. No SDK preset — we implement every capability ourselves.
- **Local LLM (Ollama)** — `localLlm-handler.ts`. OpenAI-compatible tool calling. Because smaller open models call tools less reliably, we default to a trimmed, read-only subset (`READ_ONLY_TOOLS` in `src/tools/tool-executors.ts`).
- **AI Conversation** — two agents converse with each other through the **VS Code Language Model API** (`vscode.lm.*`). The VS Code LM API is a programmatic LLM interface comparable to the Anthropic API: the extension hands over messages + tools and receives the model's response. It is **not** the Copilot Chat panel. The models surfaced via `vscode.lm.*` happen to be Copilot-provided, but the API itself is model-agnostic and has no chat UI.

A fifth surface — **Copilot Chat (the user-facing VS Code chat panel)** — is *not* one of the transports above. Our extension drives it indirectly via the **prompt-queue / timed-request / template family** (§4.19): those tools stage prompts, orchestrate follow-ups, and manage reminders in the Copilot Chat window. They are called *from* any of the four transports above when the user's workflow needs to send prompts into Copilot Chat.

Every transport reads tool enablement from the active configuration / profile — the recommendations below are *defaults*, not hard-coded behaviour. Flip a tool on or off per-profile via the Global Template Editor.

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
| AI Conversation (VS Code LM) | ✅ | provider-managed | provider-managed | model-dependent | ❌ | Copilot-side tools invisible to us |

We deliberately **do not** surface Anthropic's server-side `code_execution`, `computer_use`, or `text_editor_20250429` — they run outside the workspace and bypass our approval gate.

## 4. Tools by family

Each table lists every tool in the family with a per-transport default.

### 4.1 Files (read / write / search)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_readFile` | Read file (optional line range). | 🔁 | ✅ | ✅ | ✅ |
| `tomAi_createFile` | Create a file (approval). | 🔁 | ✅ | ⚪ | ✅ |
| `tomAi_editFile` | Find-replace edit (approval). | 🔁 | ✅ | ⚪ | ✅ |
| `tomAi_multiEditFile` | Batched find-replace (approval). | 🔁 | ✅ | ⚪ | ✅ |
| `tomAi_deleteFile` | Delete a file (approval). | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_moveFile` | Rename / move a file (approval). | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_listDirectory` | List directory entries. | 🔁 | ✅ | ✅ | ✅ |
| `tomAi_findFiles` | Glob file search. | 🔁 | ✅ | ✅ | ✅ |
| `tomAi_findTextInFiles` | Content search (grep). | 🔁 | ✅ | ✅ | ✅ |
| `tomAi_applyEdit` | Transactional multi-file WorkspaceEdit (atomic undo). | ✅ | ✅ | ❌ | ✅ |

### 4.2 Shell and tasks

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_runCommand` | Fire-and-forget shell command. | 🔁 | ✅ | ⚪ | ✅ |
| `tomAi_runCommandStream` | Spawn, return handle + initial output. | ⚪ | ✅ | ❌ | ✅ |
| `tomAi_readCommandOutput` | Poll stdout / stderr / exit. | ⚪ | ✅ | ❌ | ✅ |
| `tomAi_killCommand` | Signal a running handle. | ⚪ | ✅ | ❌ | ✅ |
| `tomAi_runTask` | Execute a task from `tasks.json`. | ✅ | ✅ | ❌ | ✅ |
| `tomAi_runDebugConfig` | Launch a `launch.json` debug config. | ✅ | ✅ | ❌ | ⚪ |

### 4.3 Web

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_fetchWebpage` | HTTP GET + return text. | 🔁 | ✅ | ✅ | ✅ |
| `tomAi_webSearch` | Web search via local backend. | 🔁 | ✅ | ✅ | ✅ |

### 4.4 VS Code commands and IDE navigation

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_runVscodeCommand` | Execute command ID (string args). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_vscode` | Execute command ID (typed args, safe-list hints). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_listCommands` | Discover command IDs (filtered). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_openFile` | `showTextDocument` with optional selection. | ✅ | ✅ | ✅ | ✅ |

### 4.5 Editor and workspace context

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_getWorkspaceInfo` | Workspace + quest + projects + git. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getActiveEditor` | Active file, selection, cursor, visible range. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getOpenEditors` | All open tabs with dirty / pinned flags. | ✅ | ✅ | ✅ | ✅ |
| `determineQuest` | Resolve the active quest ID. | ✅ | ✅ | ✅ | ✅ |

### 4.6 Diagnostics

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_getErrors` | Snapshot the Problems panel (legacy, flat). | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_getProblems` | Structured Problems panel with filters. | ✅ | ✅ | ✅ | ✅ |

> `tomAi_getOutputChannel` and `tomAi_getTerminalOutput` have been removed — VS Code has no API to read third-party output channels or terminal scrollback. For captured command output use `tomAi_runCommand` (one-shot) or `tomAi_runCommandStream` + `tomAi_readCommandOutput`.

### 4.7 Language server (symbols, refactor, rename)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_findSymbol` | Workspace symbol search. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_gotoDefinition` | Resolve definition at a position. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_findReferences` | References to a symbol. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_getCodeActions` | List quick-fixes / refactors (preview only). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_getCodeActionsCached` | Same, but returns cacheable `actionId`s. | ✅ | ✅ | ❌ | ✅ |
| `tomAi_applyCodeAction` | Apply a cached `actionId` (approval). | ✅ | ✅ | ❌ | ✅ |
| `tomAi_rename` | LSP-safe workspace rename (approval). | ✅ | ✅ | ❌ | ✅ |

### 4.8 Git

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_git` | Read-only (status, diff, log, blame). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_gitShow` | `git show <ref>[:path]`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_gitExec` | Allow-listed git writes (approval). | ⚪ | ✅ | ❌ | ✅ |

### 4.9 Notebook

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_notebookEdit` | Insert / replace / delete cells (approval). | 🔁 | ✅ | ❌ | ⚪ |
| `tomAi_notebookRun` | Execute cells or the whole notebook. | ✅ | ✅ | ❌ | ⚪ |

### 4.10 Guidelines and pattern prompts

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_readGuideline` | Read a file in `_copilot_tomai/`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_readLocalGuideline` | Read a file in `_copilot_local/`. | ⚪ | ⚪ | ✅ | ⚪ |
| `tomAi_listGuidelines` | List `_copilot_guidelines/*.md` recursively. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_searchGuidelines` | Grep inside `_copilot_guidelines/`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listPatternPrompts` | List workspace `!<name>` pattern prompts. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_readPatternPrompt` | Read a `!<name>` prompt body. | ✅ | ✅ | ✅ | ✅ |

### 4.11 Quest todos (YAML-backed)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listQuestTodos` | List quest todos (filterable by status / file / tags). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getQuestTodo` | Fetch a single quest todo by id. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createQuestTodo` | Create a new quest todo. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_updateQuestTodo` | Patch fields on a quest todo. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_moveQuestTodo` | Move between YAML files within a quest. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_deleteQuestTodo` | Delete a quest todo. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_listWorkspaceQuestTodos` | All `*.todo.yaml` across the workspace. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getAllTodos` | Aggregate quest + session in one call. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listQuests` | Enumerate quest folders under `_ai/quests/`. | ✅ | ✅ | ✅ | ✅ |

### 4.12 Session todos (per window)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_sessionTodo_add` | Add a window-scoped self-reminder. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_sessionTodo_list` | List session todos. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_sessionTodo_getAll` | Counts + all items. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_sessionTodo_update` | Patch fields. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_sessionTodo_delete` | Delete. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_manageTodo` | Chat-session todo manager — separate from quest / window todos. | ⚪ | ⚪ | ⚪ | ⚪ |

### 4.13 Workspace metadata

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listProjects` | Projects from `tom_master.yaml`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listDocuments` | Files in prompts / answers / notes / roles / guidelines. | ✅ | ✅ | ✅ | ✅ |

### 4.14 Issues (bottom-panel WS tab, Issues subpanel)

Bugs / feature requests / work items tracked via the Issues subpanel.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listIssueRepos` | Discover repos configured for Issues. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listIssues` | List with state / label / substring filters. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getIssue` | Fetch one + optional comments. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listIssueComments` | Comments only. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createIssue` | Open a new issue (approval). | ⚪ | ✅ | ❌ | ✅ |
| `tomAi_addIssueComment` | Comment on an issue (approval). | ⚪ | ✅ | ❌ | ✅ |
| `tomAi_setIssueStatus` | Change status — uses statuses from the Issues panel config (approval). | ⚪ | ✅ | ❌ | ✅ |
| `tomAi_toggleIssueLabel` | Toggle a label; key=value labels replace prior value (approval). | ⚪ | ✅ | ❌ | ✅ |

### 4.15 Tests (bottom-panel WS tab, Tests subpanel — testkit)

Parallel to §4.14 but scoped to the **Tests** subpanel (test reports, flaky-test tickets). Same `IssueProvider` transport, different repos + different semantics.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listTestRepos` | Discover repos configured for Tests. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listTests` | List test-kit items with filters. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getTest` | Fetch one + optional comments. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listTestComments` | Comments only. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createTest` | File a new test report (approval). | ⚪ | ✅ | ❌ | ✅ |
| `tomAi_addTestComment` | Comment on a test-kit item (approval). | ⚪ | ✅ | ❌ | ✅ |
| `tomAi_setTestStatus` | Change status (approval). | ⚪ | ✅ | ❌ | ✅ |
| `tomAi_toggleTestLabel` | Toggle a label (approval). | ⚪ | ✅ | ❌ | ✅ |

### 4.16 Chat variables

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_chatvar_read` | Read a chat variable. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_chatvar_write` | Write a chat variable (own change log — no approval). | ✅ | ✅ | ⚪ | ✅ |

### 4.17 Memory (`_ai/memory/`)

Two-tier: `shared/` (cross-quest) and `{quest}/` (per-quest).

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_memory_read` | Read a memory file. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_memory_list` | List memory files. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_memory_save` | Save new memory (approval). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_memory_update` | Patch-edit memory (approval). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_memory_forget` | Delete memory (approval). | ⚪ | ⚪ | ❌ | ⚪ |

### 4.18 User interaction

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_notifyUser` | Notification (Telegram if configured, else VS Code). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_askUser` | Free-form `showInputBox`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_askUserPicker` | `showQuickPick` selection (single/multi). | ✅ | ✅ | ⚪ | ✅ |

### 4.19 Planning and delegation

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_enterPlanMode` | Signal planning; disables mutations (host-enforced). | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_exitPlanMode` | Leave plan mode, attach final plan. | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_spawnSubagent` | Run a nested conversation with a narrower tool set. | 🔁 | 🔌 | ❌ | ❌ |
| `tomAi_askBigBrother` | Delegate to a larger model via the VS Code LM API. | ⚪ | ⚪ | ✅ | ❌ |
| `tomAi_askCopilot` | Bounce a question off the **Copilot Chat panel** (via bridge). | ⚪ | ⚪ | ✅ | ❌ |

### 4.20 Copilot Chat orchestration — prompt queue, pre-prompts, timed requests, templates

These tools drive the **Copilot Chat user-facing panel** via a bridge. They are *not* relevant to how the calling chat (Anthropic / Ollama / VS Code LM) receives its own responses — they stage and dispatch prompts into someone else's chat. The `⚪` across all transports is intentional: whether to surface them is a user-workflow decision, not a per-transport default.

**Queue-item fields now surface the current manager feature set:** per-item `repeatCount` + `repeatPrefix` + `repeatSuffix` (main-prompt repeats with `${repeatNumber}`/`${repeatIndex}` placeholder expansion), `templateRepeatCount` (whole-template re-runs), `answerWaitMinutes` (auto-advance on timeout), pre-prompts (sent before the main prompt), per-follow-up `repeatCount` + `answerWaitMinutes` + reminders, and **chat-variable-driven counters** — any `repeatCount` accepts either a literal number or the name of a chat variable whose value the manager resolves at send time and decrements each iteration. Timed-request entries gained `repeatCount`, `repeatPrefix`, `repeatSuffix`, `sendMaximum` (auto-pause after N sends), and `answerWaitMinutes`; `scheduledTimes` now takes the manager's native `{time:"HH:MM", date?:"YYYY-MM-DD"}` shape.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_queue_add` | Stage a prompt; now accepts prePrompts, per-item repeat/answer-wait, and full follow-up / reminder fields. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_addFollowUp` | Append a follow-up; now accepts repeatCount, answerWaitMinutes, reminders. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_addPrePrompt` | Append a pre-prompt (sent before the main prompt). | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_updatePrePrompt` | Patch pre-prompt fields by (itemId, index). | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_removePrePrompt` | Remove a pre-prompt by index. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_sendNow` | Send one staged prompt. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_sendNowById` | Send a specific item immediately. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_list` | List queue items. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_queue_updateItem` | Patch item fields incl. repeat / answerWait / reminder. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_setStatus` | Toggle staged / pending. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_removeItem` | Delete. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_updateFollowUp` | Patch follow-up incl. repeat / answerWait. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_queue_removeFollowUp` | Remove a follow-up. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_timed_add` | Create a timed entry (interval) with repeat / sendMaximum / answerWait / reminder. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_timed_list` | List timed entries. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_timed_updateEntry` | Patch timed entry; schedule slots use `{time:"HH:MM", date?:...}`. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_timed_removeEntry` | Remove a timed entry. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_timed_setEngineState` | Enable / disable the timer engine. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_templates_manage` | CRUD prompt templates. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_reminders_manage` | CRUD reminder templates. | ⚪ | ⚪ | ❌ | ⚪ |

**Remaining gaps** (manager features still with no tool): engine-wide `TimerScheduleSlot` (awake/asleep windows with weekday / first-weekday / last-weekday / day-of-month patterns) and reminder-system config (`ReminderSystem.config.enabled`, `defaultTimeoutMinutes`). Add if a workflow needs LLM-driven control of those.

## 5. Transport-specific recommendations

### 5.1 Anthropic Agent SDK (`transport: 'agentSdk'`)

- Default to **`profile.useBuiltInTools = true`** for full-development mode. The SDK supplies `Read`/`Write`/`Edit`/`MultiEdit`/`Glob`/`Grep`/`Bash`/`BashOutput`/`KillBash`/`WebFetch`/`WebSearch`/`NotebookEdit`/`TodoWrite`/`Task`/`AskUserQuestion`/`ExitPlanMode`; our 🔁 tools are suppressed automatically.
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

### 5.4 AI Conversation (VS Code LM)

Two agents converse via the VS Code Language Model API. Because the API is a programmatic LLM interface (not the Copilot Chat UI), the enabled-tool profile should look similar to the Anthropic API profile — all the workspace-awareness, LSP, file, git, and task tools belong on.

- Leave `tomAi_askCopilot` **off**: it posts into the Copilot Chat panel via a bridge, which the conversation has no way to read back.
- The Copilot Chat orchestration family (§4.20) is **not** on by default either — those tools target the Copilot Chat panel, not the VS Code LM API. Turn them on only when the conversation's job is to drive Copilot Chat (e.g. an AI Conversation that stages prompts for a later human Copilot session).
- `tomAi_spawnSubagent` is not applicable; use the VS Code LM primitives to spawn another conversation if needed.

## 6. Stubs pending host integration

- **`tomAi_spawnSubagent`** — the Anthropic handler must call `registerSubagentSpawner(fn)` from `planning-tools.ts`. Until wired, the tool returns an instructive error. On the Agent SDK transport, prefer the SDK's `Task` tool.

## 7. Deferred / future

- **Plan-mode enforcement** — `isPlanModeActive()` is read by the host. Full behaviour (refuse approval-gated tools while active) is deferred to `anthropic-handler.ts` / `tool-execution-context.ts`.
- **Code-action cache persistence** — `tomAi_getCodeActionsCached` returns `actionId`s backed by an in-process Map with a 5-minute TTL. Consider cross-session persistence if the user wants to apply actions after a window reload.
- **Structured approval previews** — current approval bar renders raw JSON. Upgrade to human-readable previews (unified diff for edits, command preview for runs, URL for fetches). Lower friction → user enables more tools.
- **Tool-result truncation envelope** — a standard `{ content, truncated, continuationToken }` shape would let every tool stream results without bespoke code.
- **Engine-wide timer schedule** — LLM-driven control of `TimerEngine._schedule` (weekday / first-weekday / last-weekday / day-of-month awake windows). No tool today.

## 8. Naming consistency — suggestions

The current name set has grown organically. Below are the inconsistencies and suggested renames. These are **suggestions**, not applied yet.

### 8.1 Verb-first vs noun-first

Most tools are `tomAi_<verb><Object>` (`getActiveEditor`, `listIssues`, `applyEdit`). A few are noun-first or mixed:

| Current | Issue | Suggested |
| --- | --- | --- |
| `tomAi_git` | Bare noun; no verb. | `tomAi_gitRead` (paired with `tomAi_gitExec`) — or keep as-is and rename `tomAi_gitExec` → `tomAi_gitWrite`. |
| `tomAi_vscode` | Bare noun meta-tool; meaning unclear from name. | `tomAi_runVscodeCommandTyped` (explicit pairing with existing `tomAi_runVscodeCommand`). |
| `determineQuest` | Missing `tomAi_` prefix (legacy). | `tomAi_getActiveQuest`. |
| `tomAi_manageTodo` | Single tool hides 5 operations (list/add/update/remove/clear). | Either keep as a deliberate simplified API for chat-session todos (current justification) **or** split into `tomAi_chatTodo_{add,list,update,remove,clear}` to mirror the session-todo family. Keep since chat-session todos are ephemeral. |

### 8.2 Underscore vs camelCase delimiters

The codebase uses two separator conventions inside the name:

- **camelCase** — `tomAi_listIssues`, `tomAi_createQuestTodo`, `tomAi_runCommand`.
- **snake_case-after-family** — `tomAi_sessionTodo_add`, `tomAi_queue_add`, `tomAi_timed_list`, `tomAi_chatvar_read`, `tomAi_memory_save`.

Pick one. The camelCase form is more consistent with the majority. Suggested renames:

| Current | Suggested |
| --- | --- |
| `tomAi_sessionTodo_add` | `tomAi_addSessionTodo` |
| `tomAi_sessionTodo_list` | `tomAi_listSessionTodos` |
| `tomAi_sessionTodo_getAll` | `tomAi_getAllSessionTodos` |
| `tomAi_sessionTodo_update` | `tomAi_updateSessionTodo` |
| `tomAi_sessionTodo_delete` | `tomAi_deleteSessionTodo` |
| `tomAi_queue_add` | `tomAi_addQueueItem` |
| `tomAi_queue_addFollowUp` | `tomAi_addQueueFollowUp` |
| `tomAi_queue_addPrePrompt` | `tomAi_addQueuePrePrompt` |
| `tomAi_queue_updateItem` | `tomAi_updateQueueItem` |
| `tomAi_queue_updateFollowUp` | `tomAi_updateQueueFollowUp` |
| `tomAi_queue_updatePrePrompt` | `tomAi_updateQueuePrePrompt` |
| `tomAi_queue_setStatus` | `tomAi_setQueueItemStatus` |
| `tomAi_queue_sendNow` | `tomAi_sendQueuedPrompt` |
| `tomAi_queue_sendNowById` | `tomAi_sendQueueItem` |
| `tomAi_queue_list` | `tomAi_listQueue` |
| `tomAi_queue_removeItem` | `tomAi_removeQueueItem` |
| `tomAi_queue_removeFollowUp` | `tomAi_removeQueueFollowUp` |
| `tomAi_queue_removePrePrompt` | `tomAi_removeQueuePrePrompt` |
| `tomAi_timed_add` | `tomAi_addTimedRequest` |
| `tomAi_timed_list` | `tomAi_listTimedRequests` |
| `tomAi_timed_updateEntry` | `tomAi_updateTimedRequest` |
| `tomAi_timed_removeEntry` | `tomAi_removeTimedRequest` |
| `tomAi_timed_setEngineState` | `tomAi_setTimerEngineState` |
| `tomAi_chatvar_read` | `tomAi_readChatVariable` |
| `tomAi_chatvar_write` | `tomAi_writeChatVariable` |
| `tomAi_memory_read` | `tomAi_readMemory` |
| `tomAi_memory_list` | `tomAi_listMemory` |
| `tomAi_memory_save` | `tomAi_saveMemory` |
| `tomAi_memory_update` | `tomAi_updateMemory` |
| `tomAi_memory_forget` | `tomAi_forgetMemory` |
| `tomAi_templates_manage` | Split: `tomAi_listPromptTemplates` / `tomAi_createPromptTemplate` / `tomAi_updatePromptTemplate` / `tomAi_deletePromptTemplate` |
| `tomAi_reminders_manage` | Split: `tomAi_listReminderTemplates` / `tomAi_createReminderTemplate` / … |

### 8.3 `manage` single-tool vs split-per-operation

`tomAi_templates_manage` and `tomAi_reminders_manage` hide four operations (list/create/update/delete) behind one tool with an `operation` enum. Matches the `tomAi_manageTodo` pattern but inconsistent with `tomAi_sessionTodo_*` / `tomAi_queue_*` / `tomAi_memory_*` which all split per-operation.

Suggestion: **split all `*_manage` tools** into per-op tools (see §8.2 table) unless the API is genuinely simplified (chat-session todos, where ephemerality justifies the collapse).

### 8.4 Inconsistent plural forms

Mostly singular = "one", plural = "many". A few drift:

| Current | Issue | Suggested |
| --- | --- | --- |
| `tomAi_getAllTodos` | Returns session + quest aggregate. Name doesn't reveal which kinds. | `tomAi_getAllTodosAggregated` or `tomAi_getCombinedTodos` — or keep if called out in description. |
| `tomAi_listWorkspaceQuestTodos` | Long but clear. | Keep. |

### 8.5 `determineQuest` outlier

Only tool in the registry missing the `tomAi_` prefix. Rename to `tomAi_getActiveQuest` to align.

### 8.6 Recommended action

Before renaming, decide on the convention (camelCase separator) and commit in a single batch with updates to:

1. Each tool's `name:` field.
2. `AVAILABLE_LLM_TOOLS` in `src/utils/constants.ts`.
3. Every `languageModelTools[].name` and `toolReferenceName` in `package.json`.
4. Seed configs under `.tom/tom_vscode_extension.json` (workspace `enabledTools` lists).
5. This document.
6. Any hard-coded references in `DUPLICATES_OF_CLAUDE_CODE_BUILTINS` (`anthropic-handler.ts`).

## 9. Adding new tools

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
| `issue-tools.ts` | Issues subpanel (read + write) |
| `test-tools.ts` | Tests subpanel / testkit (read + write) |
| `chat-enhancement-tools.ts` | Notify, quest/session todos, queue, timed, templates, reminders |
| `tool-executors.ts` | File I/O primitives, shell, web, memory, chat vars, ask-AI bridges |

Every new tool needs:

1. A `SharedToolDefinition` in the appropriate `src/tools/<family>-tools.ts`.
2. Added to the family file's exported list (e.g. `NOTEBOOK_TOOLS`).
3. The family list spread into `ALL_SHARED_TOOLS` in `src/tools/tool-executors.ts`.
4. Entry in `AVAILABLE_LLM_TOOLS` (`src/utils/constants.ts`).
5. For Agent SDK duplicates: add to `DUPLICATES_OF_CLAUDE_CODE_BUILTINS` in `anthropic-handler.ts`.
6. A row in the right family table in this document.
