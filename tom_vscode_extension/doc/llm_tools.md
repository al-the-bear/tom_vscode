# LLM Tools — Transport Inventory

This document is the source of truth for every tool available to LLM chat surfaces in the Tom VS Code extension. Tools are grouped by family, and each row carries a per-transport recommendation for default enablement.

## 1. Transports

Four chat surfaces call into tools:

- **Anthropic Agent SDK** — `transport: 'agentSdk'` on an Anthropic configuration. Wraps `@anthropic-ai/claude-agent-sdk`. When `profile.useBuiltInTools = true`, Claude Code's built-in preset (`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `Bash`/`BashOutput`/`KillBash`, `WebFetch`, `WebSearch`, `NotebookEdit`, `TodoWrite`, `Task`, `AskUserQuestion`, `ExitPlanMode`, `SlashCommand`, …) is exposed; our extension tools that duplicate a built-in (`DUPLICATES_OF_CLAUDE_CODE_BUILTINS` in `anthropic-handler.ts`) are suppressed to avoid confusion. Our own MCP server runs next to the preset and surfaces the rest.
- **Anthropic API (direct)** — `transport: 'direct'`. `@anthropic-ai/sdk`. No SDK preset — we implement every capability ourselves.
- **Local LLM (Ollama)** — `localLlm-handler.ts`. OpenAI-compatible tool calling. Because smaller open models call tools less reliably, we default to a trimmed, read-only subset (`READ_ONLY_TOOLS` in `src/tools/tool-executors.ts`).
- **AI Conversation** — two Copilot LLMs converse with each other via the **VS Code Language Model API** (`vscode.lm.*`). Tools are registered with `vscode.lm.registerTool` so participating models see them the way Copilot's own chat does.

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
| AI Conversation (VS Code LM) | model provides — we relay | model provides | provider-managed | model-dependent | ❌ | Copilot-side tools only |

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
| `tomAi_applyEdit` | Transactional multi-file WorkspaceEdit (atomic undo). | ✅ | ✅ | ❌ | ⚪ |

### 4.2 Shell and tasks

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_runCommand` | Fire-and-forget shell command. | 🔁 | ✅ | ⚪ | ✅ |
| `tomAi_runCommandStream` | Spawn, return handle + initial output. | ⚪ | ✅ | ❌ | ⚪ |
| `tomAi_readCommandOutput` | Poll stdout / stderr / exit. | ⚪ | ✅ | ❌ | ⚪ |
| `tomAi_killCommand` | Signal a running handle. | ⚪ | ✅ | ❌ | ⚪ |
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
| `tomAi_vscode` | Execute command ID (typed args, with safe-list hints). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_listCommands` | Discover command IDs (filtered). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_openFile` | `showTextDocument` with optional selection. | ✅ | ✅ | ✅ | ✅ |

### 4.5 Editor and workspace context

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_getWorkspaceInfoFull` | Full workspace + quest + projects + git. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getWorkspaceInfo` | Lightweight workspace context (legacy). | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_getActiveEditor` | Active file, selection, cursor, visible range. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getOpenEditors` | All open tabs with dirty / pinned flags. | ✅ | ✅ | ✅ | ✅ |
| `determineQuest` | Resolve the active quest ID. | ✅ | ✅ | ✅ | ✅ |

### 4.6 Diagnostics

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_getErrors` | Snapshot the Problems panel. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getProblems` | Structured Problems panel (filters). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getOutputChannel` | Read extension-tracked channels (see §9). | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_getTerminalOutput` | Terminal metadata — no scrollback API (see §9). | ⚪ | ⚪ | ⚪ | ⚪ |

### 4.7 Language server (symbols, refactor, rename)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_findSymbol` | Workspace symbol search. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_gotoDefinition` | Resolve definition at a position. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_findReferences` | References to a symbol. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_getCodeActions` | List quick-fixes / refactors (preview only). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_getCodeActionsCached` | Same, but returns cacheable `actionId`s. | ✅ | ✅ | ❌ | ⚪ |
| `tomAi_applyCodeAction` | Apply a cached `actionId` (approval). | ✅ | ✅ | ❌ | ⚪ |
| `tomAi_rename` | LSP-safe workspace rename (approval). | ✅ | ✅ | ❌ | ⚪ |

### 4.8 Git

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_git` | Read-only (status, diff, log, blame). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_gitShow` | `git show <ref>[:path]`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_gitExec` | Allow-listed git writes (approval). | ⚪ | ✅ | ❌ | ⚪ |

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

Pre-existing tools — **no duplicates introduced**. Lists, gets, creates, updates, moves and deletes live in `chat-enhancement-tools.ts`.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listTodos` | List quest todos (filterable). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getAllTodos` | Aggregate quest + session in one call. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getTodo` | Fetch a single quest todo by id. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createTodo` | Create a new quest todo. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_updateTodo` | Patch fields on a quest todo. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_moveTodo` | Move between files within a quest. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_deleteTodo` | Delete a quest todo. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_workspaceTodo_list` | All `*.todo.yaml` across the workspace. | ✅ | ✅ | ✅ | ✅ |

### 4.12 Session todos (per window)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_sessionTodo_add` | Add a window-scoped self-reminder. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_sessionTodo_list` | List session todos. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_sessionTodo_getAll` | Counts + all items. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_sessionTodo_update` | Patch fields. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_sessionTodo_delete` | Delete. | ⚪ | ⚪ | ❌ | ⚪ |
| `tomAi_manageTodo` | Simple chat-session todo manager (distinct from `sessionTodo_*`; Tom AI Chat only). | ⚪ | ⚪ | ⚪ | ✅ |

### 4.13 Workspace metadata

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listQuests` | All quest IDs under `_ai/quests/`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listProjects` | Projects from `tom_master.yaml`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listDocuments` | Files in prompts / answers / notes / roles / guidelines. | ✅ | ✅ | ✅ | ✅ |

### 4.14 Issues and testkit (bottom-panel WS tab)

Wraps the `IssueProvider` abstraction used by the Issues and Tests subpanels. Both panels share the provider; only the repo scope differs.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listIssueRepos` | Discover repos / projects. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listIssues` | List items (filters: state, labels, substring query). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getIssue` | Fetch a single item + optional comments. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listIssueComments` | Just the comments. | ✅ | ✅ | ✅ | ✅ |

### 4.15 Chat variables

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_chatvar_read` | Read a chat variable. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_chatvar_write` | Write a chat variable (has its own change log — no approval). | ✅ | ✅ | ⚪ | ✅ |

### 4.16 Memory (`_ai/memory/`)

Two-tier: `shared/` (cross-quest) and `{quest}/` (per-quest).

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_memory_read` | Read a memory file. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_memory_list` | List memory files. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_memory_save` | Save new memory (approval). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_memory_update` | Patch-edit memory (approval). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_memory_forget` | Delete memory (approval). | ⚪ | ⚪ | ❌ | ⚪ |

### 4.17 User interaction

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_notifyUser` | Notification (Telegram if configured, else VS Code). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_askUser` | Free-form `showInputBox`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_askUserPicker` | `showQuickPick` selection (single/multi). | ✅ | ✅ | ⚪ | ✅ |

### 4.18 Planning and delegation

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_enterPlanMode` | Signal planning; disables mutations (host-enforced). | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_exitPlanMode` | Leave plan mode, attach final plan. | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_spawnSubagent` | Run a nested conversation with a narrower tool set. | 🔁 | 🔌 | ❌ | ❌ |
| `tomAi_askBigBrother` | Delegate to a larger local LLM profile. | ⚪ | ⚪ | ✅ | ⚪ |
| `tomAi_askCopilot` | Bounce a question off Copilot Chat via the bridge. | ⚪ | ⚪ | ✅ | ❌ |

### 4.19 Prompt queue, timed requests, templates (orchestration for Copilot Chat)

These tools manage the **Copilot chat queue**, the **timed-request engine**, and the two template families (prompt templates, reminder templates). They control how prompts are staged, dispatched and repeated when the user is driving Copilot Chat — not when the LLM itself answers. Most chat surfaces leave them off.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | AI Conv. |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_queue_add` | Stage a prompt with optional follow-ups. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_queue_addFollowUp` | Append a follow-up to a staged item. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_queue_sendNow` | Send one staged prompt. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_queue_sendNowById` | Send a specific item. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_queue_list` | List queue items + status. | ⚪ | ⚪ | ⚪ | ✅ |
| `tomAi_queue_updateItem` | Patch text / template / reminder. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_queue_setStatus` | Toggle staged / pending. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_queue_removeItem` | Delete a queue item. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_queue_updateFollowUp` | Patch a follow-up. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_queue_removeFollowUp` | Remove a follow-up. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_timed_add` | Create a timed request. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_timed_list` | List timed entries. | ⚪ | ⚪ | ⚪ | ✅ |
| `tomAi_timed_updateEntry` | Patch a timed entry. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_timed_removeEntry` | Remove a timed entry. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_timed_setEngineState` | Enable / disable timer engine. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_templates_manage` | CRUD prompt templates. | ⚪ | ⚪ | ❌ | ✅ |
| `tomAi_reminders_manage` | CRUD reminder templates. | ⚪ | ⚪ | ❌ | ✅ |

## 5. Transport-specific recommendations

### 5.1 Anthropic Agent SDK (`transport: 'agentSdk'`)

- Default to **`profile.useBuiltInTools = true`** for full-development mode. The SDK supplies `Read`/`Write`/`Edit`/`MultiEdit`/`Glob`/`Grep`/`Bash`/`BashOutput`/`KillBash`/`WebFetch`/`WebSearch`/`NotebookEdit`/`TodoWrite`/`Task`/`AskUserQuestion`/`ExitPlanMode`; our 🔁 tools are suppressed automatically.
- Leave `tomAi_enterPlanMode` / `tomAi_exitPlanMode` off — the SDK ships its own plan-mode state.
- `tomAi_spawnSubagent` is redundant when `Task` is available; keep off.
- Keep all the ✅-rows on — they're VS Code specific and have no SDK equivalent (editor context, problems, symbols, code actions, git writes, tasks/debug, issues/testkit, quest/session todos, chat variables, memory, pattern prompts, guidelines, user interaction).

### 5.2 Anthropic API direct (`transport: 'direct'`)

- All ✅-rows are on by default; no preset exists.
- `tomAi_runCommandStream`/`tomAi_readCommandOutput`/`tomAi_killCommand` are the only way to stream long-running commands on this transport — leave them on when test-running or building.
- Wire `tomAi_spawnSubagent` by calling `registerSubagentSpawner()` in `anthropic-handler.ts`; until then it returns an instructive error.

### 5.3 Local LLM (Ollama)

- Default to **read-only** tools only (`READ_ONLY_TOOLS`). Open-source models misbehave more frequently with tool-calling — every mutation tool is approval-gated anyway.
- Keep `tomAi_askBigBrother` and `tomAi_askCopilot` on: delegating hard questions out of Ollama to a stronger model is the whole point.
- LSP-heavy tools (`findSymbol`, `gotoDefinition`, `findReferences`, `getCodeActions`) work but consume a lot of tokens for small models — leave off by default.

### 5.4 AI Conversation (VS Code LM)

- Both participants use Copilot-managed LLMs. Copilot's own toolset already covers file I/O, so extension-only tools (editor context, LSP, quests, memory, issues, pattern prompts, prompt queue) give the most marginal value here.
- **The queue + timed-request family** is uniquely relevant here: AI Conversation is the transport that actually drives Copilot Chat, so tools to orchestrate that chat belong on.
- `tomAi_spawnSubagent` is N/A — use the VS Code LM primitives directly.

## 6. Partial implementations (VS Code API limits)

Two tools carry caveats documented in their descriptions:

- **`tomAi_getOutputChannel`** — VS Code does not expose third-party Output channels across extensions. The tool reads only channels the Tom extension explicitly tracks (currently: none at module scope; the global registry is a scaffold). Result: the tool surfaces a channel list and a note steering callers to `tomAi_runCommand` when scrollback matters.
- **`tomAi_getTerminalOutput`** — VS Code has no terminal scrollback API. The tool returns terminal metadata (name, exit status, shell-integration presence) and a note steering callers to `tomAi_runCommand` or `tomAi_runCommandStream` for captured output.

## 7. Stubs pending host integration

- **`tomAi_spawnSubagent`** — the Anthropic handler must call `registerSubagentSpawner(fn)` from `advanced-agent-tools.ts`. Until wired, the tool returns an instructive error. On the Agent SDK transport, prefer the SDK's `Task` tool.

## 8. Deferred / future

- **Plan-mode enforcement** — `isPlanModeActive()` is read by the host. Full behaviour (refuse approval-gated tools while active) is deferred to `anthropic-handler.ts` / `tool-execution-context.ts`.
- **Code-action cache persistence** — `tomAi_getCodeActionsCached` returns `actionId`s backed by an in-process Map with a 5-minute TTL. Consider cross-session persistence if the user wants to apply actions after a window reload.
- **Output-channel registry** — the scaffold in `tomAi_getOutputChannel` reads `globalThis.__tomAiOutputChannelRegistry`; populate it from the extension's own output channels (Tom Log, Ollama, bridge, etc.) to make the tool useful.
- **Structured approval previews** — current approval bar renders raw JSON. Upgrade to human-readable previews (unified diff for edits, command preview for runs, URL for fetches). Lower friction → user enables more tools.
- **Tool-result truncation envelope** — a standard `{ content, truncated, continuationToken }` shape would let every tool stream results without bespoke code.

## 9. Adding new tools

Every new tool needs:

1. A `SharedToolDefinition` in `src/tools/<family>.ts`.
2. Entry in the family's master list, then in `ALL_SHARED_TOOLS` (`src/tools/tool-executors.ts`).
3. Entry in `AVAILABLE_LLM_TOOLS` (`src/utils/constants.ts`).
4. For Agent SDK duplicates: add to `DUPLICATES_OF_CLAUDE_CODE_BUILTINS` in `anthropic-handler.ts`.
5. A row in the right family table in this document.
