# LLM Tools — Transport Inventory

This document is the source of truth for every tool available to LLM chat surfaces in the Tom VS Code extension. Tools are grouped by family, and each row carries a per-transport recommendation for default enablement.

## 1. Transports

Five chat surfaces call into tools:

- **Anthropic Agent SDK** — `transport: 'agentSdk'` on an Anthropic configuration. Wraps `@anthropic-ai/claude-agent-sdk`. When `profile.useBuiltInTools = true`, Claude Code's built-in preset (`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `Bash`/`BashOutput`/`KillBash`, `WebFetch`, `WebSearch`, `NotebookEdit`, `TodoWrite`, `Task`, `AskUserQuestion`, `ExitPlanMode`, `SlashCommand`, …) is exposed; our extension tools that duplicate a built-in (`DUPLICATES_OF_CLAUDE_CODE_BUILTINS` in `anthropic-handler.ts`) are suppressed to avoid confusion. Our own MCP server runs next to the preset and surfaces the rest.
- **Anthropic API (direct)** — `transport: 'direct'`. `@anthropic-ai/sdk`. No SDK preset — we implement every capability ourselves.
- **Local LLM (Ollama)** — `localLlm-handler.ts`. OpenAI-compatible tool calling. Because smaller open models call tools less reliably, we default to a trimmed, read-only subset (`READ_ONLY_TOOLS` in `src/tools/tool-executors.ts`).
- **Tom AI Chat** — the user's single-conversation surface via the **VS Code Language Model API** (`vscode.lm.*`). The VS Code LM API is a programmatic LLM interface comparable to the Anthropic API: the extension hands over messages + tools and receives the model's response. Tom AI Chat is a **user-facing** single-turn-or-multi-turn chat with a `.md` conversation format. A human is present, so user-interaction tools (`tomAi_askUser`, `tomAi_askUserPicker`, `tomAi_notifyUser`) apply.
- **AI Conversation** — two LLM agents converse with each other via the same VS Code LM API, orchestrated by the extension. There is **no human** in the loop — interactive prompting tools don't apply. Used for bot-to-bot review / critique / planning.

A sixth surface — **Copilot Chat (the user-facing VS Code chat panel)** — is *not* one of the transports above. Our extension drives it indirectly via the **prompt-queue / timed-request / template family** (§4.20): those tools stage prompts, orchestrate follow-ups, and manage reminders in the Copilot Chat window. They are called *from* any of the five transports above when the user's workflow needs to send prompts into Copilot Chat.

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
| `tomAi_deleteQuestTodo` | Delete a quest todo. | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_listWorkspaceQuestTodos` | All `*.todo.yaml` across the workspace. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getCombinedTodos` | Aggregate quest + session in one call. | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listQuests` | Enumerate quest folders under `_ai/quests/`. | ✅ | ✅ | ✅ | ✅ | ✅ |

### 4.12 Session todos (per window)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | Tom AI | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `tomAi_addSessionTodo` | Add a window-scoped self-reminder. | ✅ | ✅ | ✅ | ✅ | ⚪ |
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
| `tomAi_askUser` | Free-form `showInputBox` — requires a human. | ✅ | ✅ | ⚪ | ✅ | ⚪ |
| `tomAi_askUserPicker` | `showQuickPick` selection — requires a human. | ✅ | ✅ | ⚪ | ✅ | ⚪ |

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
