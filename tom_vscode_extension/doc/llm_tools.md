# LLM Tools — Transport Inventory

This document is the source of truth for every tool available to LLM chat surfaces in the Tom VS Code extension. Tools are grouped by family, and each row carries a per-transport recommendation for default enablement.

## 1. Transports

Four transports call into tools. Each is the `transport` of an Anthropic configuration, chosen through an Anthropic profile (the @CHAT ANTHROPIC/LLM subpanel and the prompt queue):

- **Anthropic Agent SDK** — `transport: 'agentSdk'` on an Anthropic configuration. Wraps `@anthropic-ai/claude-agent-sdk`. When `profile.useBuiltInTools = true`, Claude Code's built-in preset (`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `Bash`/`BashOutput`/`KillBash`, `WebFetch`, `WebSearch`, `NotebookEdit`, `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`, `Task`, `AskUserQuestion`, `ExitPlanMode`, `SlashCommand`, …) is exposed; our extension tools that duplicate a built-in (`DUPLICATES_OF_CLAUDE_CODE_BUILTINS` in `anthropic-handler.ts`) are suppressed to avoid confusion. Our own MCP server runs next to the preset and surfaces the rest.
- **Anthropic API (direct)** — `transport: 'direct'`. `@anthropic-ai/sdk`. No SDK preset — we implement every capability ourselves.
- **Local LLM (Ollama / OpenAI-compatible)** — `transport: 'localLlm'`, an Anthropic profile on a Local LLM configuration; the Anthropic handler runs the tool loop and `LocalLlmManager.callLocalLlmOnce` (`localLlm-handler.ts`) makes each call. Ollama or OpenAI-compatible tool calling. Because smaller open models call tools less reliably, we default to a trimmed, read-only subset (`READ_ONLY_TOOLS` in `src/tools/tool-executors.ts`).
- **VS Code LM** — `transport: 'vscodeLm'`, the **VS Code Language Model API** (`vscode.lm.*`). The VS Code LM API is a programmatic LLM interface comparable to the Anthropic API: the extension hands over messages + tools and receives the model's response. A human is present, so user-interaction tools (`tomAi_askUser`, `tomAi_askUserPicker`, `tomAi_notifyUser`) apply. The same tools are registered as VS Code language-model tools (`registerVsCodeLmTools`, `src/tools/vscodeLmTools.ts`).

A fifth surface — **Copilot Chat (the user-facing VS Code chat panel)** — is *not* one of the transports above. Our extension drives it indirectly via the **prompt-queue / timed-request / template family** (§4.20): those tools stage prompts, orchestrate follow-ups, and manage reminders in the Copilot Chat window. They are called *from* any of the four transports above when the user's workflow needs to send prompts into Copilot Chat.

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
| Anthropic API (direct) | ✅ | ✅ | ✅ | `tomAi_readFile` shows images and PDFs | ❌ not surfaced | ❌ |
| Local LLM (Ollama / OpenAI-compatible) | ✅ | ❌ | ❌ | model-dependent | ❌ | ❌ |
| VS Code LM | ✅ | provider-managed | provider-managed | model-dependent | ❌ | Copilot-side tools invisible to us |

We deliberately **do not** surface Anthropic's server-side `code_execution`, `computer_use`, or `text_editor_20250429` — they run outside the workspace and bypass our approval gate.

## 4. Tools by family

Each table lists every tool in the family with a per-transport default.

### 4.1 Files (read / write / search)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_readFile` | Read file (optional line range, line numbers; 2000 lines / 200 000 characters without a range). On the direct API an image (png, jpg, gif, webp) comes back as an image block and a PDF as a document block the model sees (`executeRich`; up to 3.75 MB / 16 MB); other transports get the text. | 🔁 | ✅ | ✅ | ✅ |
| `tomAi_createFile` | Create a file (approval). | 🔁 | ✅ | ⚪ | ✅ |
| `tomAi_editFile` | Find-replace edit (approval). | 🔁 | ✅ | ⚪ | ✅ |
| `tomAi_multiEditFile` | Batched find-replace (approval). | 🔁 | ✅ | ⚪ | ✅ |
| `tomAi_deleteFile` | Delete a file (approval). | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_moveFile` | Rename / move a file (approval). | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_listDirectory` | List directory entries. | 🔁 | ✅ | ✅ | ✅ |
| `tomAi_findFiles` | Glob file search: skips what git ignores, as the text search does (`includeIgnored` lists it), walks from a glob's fixed folder. | 🔁 | ✅ | ✅ | ✅ |
| `tomAi_findTextInFiles` | Content search (grep): case-insensitive, context lines, follows symlinked folders such as `_ai`, skips what git ignores (`includeIgnored` searches it), 20 s budget. | 🔁 | ✅ | ✅ | ✅ |
| `tomAi_applyEdit` | Transactional multi-file WorkspaceEdit (atomic undo). | ✅ | ✅ | ⚪ | ✅ |

On the direct API these tools, with the shell and git tools of §4.2 and §4.8,
are what a todo walk has in place of Claude Code's built-ins: Read →
`tomAi_readFile`, Edit → `tomAi_editFile` / `tomAi_multiEditFile`, Write →
`tomAi_createFile`, Bash → `tomAi_runCommand` / `tomAi_runCommandStream`, Grep →
`tomAi_findTextInFiles`, Glob → `tomAi_findFiles` / `tomAi_listDirectory`. A
direct profile with `toolsEnabled` gets all of them; only an Agent SDK profile
with `useBuiltInTools` hides them in favour of Claude Code's own
(`DUPLICATES_OF_CLAUDE_CODE_BUILTINS`). Their limits are set for that use: a
read without a range stops at 2000 lines, a command returns its output's head
and tail past 30 000 characters, and a text search reads every file (no file
cap) until it has its matches or 20 s have passed, saying so when it stopped
early (`src/tools/__tests__/direct-tool-coverage.test.ts`, DT-1 – DT-9).

Like Claude Code's Grep and Glob (ripgrep), the text search and `tomAi_findFiles`
skip what git ignores, by the same rules: the
`.gitignore` of every folder, relative to that folder, a deeper one overriding
an outer one and `!` re-including; a repository's `.git/info/exclude`; and the
`.gitignore` files above the workspace root up to its repository's root. Unlike
ripgrep, a folder that is a repository of its own (holds `.git`) is searched
even when the outer `.gitignore` lists it, under its own rules only — the
workspace mounts `_ai` that way and its root `.gitignore` lists `/_ai`, so
ripgrep would never search the quest files. `includeIgnored: true` searches
everything (build output, `ztmp/`, the `_ai` queue files). Files are read
asynchronously, 32 at a time, so a long search does not block the extension
host; a file is checked for a null byte in its first 8 KB before it is read
whole, and split into lines only when the whole text can match
(`src/tools/__tests__/findTextGitignore.test.ts`, GI-1 – GI-6). On the
tom_agent_container root a search through every file takes about 10 s
(76,000 files; with ignored files included it is over 200,000).

`tomAi_findFiles` walks the workspace itself (not VS Code's search, which
reads no ignore files), from the glob's fixed folder when it has one:
`tom_ai/vscode/**/*.ts` walks `tom_ai/vscode` only, a folder git ignores lists
nothing unless `includeIgnored`. Measured on the tom_agent_container root: 100
hits of `**/*.md` in about 40 ms, a glob under `tom_ai/vscode/` in about 20 ms,
and a glob that matches nothing anywhere walks every non-ignored folder in
about 1.7 s (VS Code's ripgrep: 0.3 s). Two differences to ripgrep remain:
hidden files and folders (`.github`, `.tom`) are listed, and a tracked file
whose name an ignore pattern matches is skipped, since the walk reads no git
index (`src/tools/__tests__/findFilesGitignore.test.ts`, FG-1 – FG-5).

### 4.2 Shell and tasks

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_runCommand` | Shell command; returns at most 30 000 characters per stream (head and tail). | 🔁 | ✅ | ⚪ | ✅ |
| `tomAi_runCommandStream` | Spawn, return handle + initial output. | ⚪ | ✅ | ⚪ | ✅ |
| `tomAi_readCommandOutput` | Poll stdout / stderr / exit. | ⚪ | ✅ | ⚪ | ✅ |
| `tomAi_killCommand` | Signal a running handle. | ⚪ | ✅ | ⚪ | ✅ |
| `tomAi_runTask` | Execute a task from `tasks.json`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_runDebugConfig` | Launch a `launch.json` debug config. | ✅ | ✅ | ⚪ | ⚪ |

### 4.3 Web

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_fetchWebpage` | HTTP GET + return text. | 🔁 | ✅ | ✅ | ✅ |
| `tomAi_webSearch` | Web search via local backend. | 🔁 | ✅ | ✅ | ✅ |

### 4.4 VS Code commands and IDE navigation

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_runVscodeCommand` | Execute command ID (string args). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_runVscodeCommandTyped` | Execute command ID (typed args, safe-list hints). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_listCommands` | Discover command IDs (filtered). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_openFile` | `showTextDocument` with optional selection. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_closeEditor` | Close every text / diff tab of a file (every group, or the active one) without focusing anything; a tab with unsaved changes is kept and reported, or saved first with `save: true` — never discarded. Approval. | ✅ | ✅ | ✅ | ✅ |

**DartScript commands without `tom_bs`.** A command that needs the Dart bridge
(`tomAi.bridge.restart`, `tomAi.bridge.switchProfile`, `tomAi.executeFile`,
`tomAi.executeScript`, `tomAi.cliServer.start`, `tomAi.cliServer.startCustomPort`,
`tomAi.bridge.toggleDebug`, `tomAi.startProcessMonitor`,
`tomAi.printConfiguration`, `tomAi.runTests`) run through
`tomAi_runVscodeCommand` on a platform without `tom_bs` (neither bundled nor
configured in `bridge.executables`) returns, as its `result`,
`{ok: false, code: "dartScriptUnavailable", error, help, page}`: `error` is
`"<feature> needs DartScript, which is not available on <platform>: the tom_bs binary is missing."`
(the feature's name and the platform filled in), `help` is `Run command tomAi.showDartBinariesHelp`, `page`
the page that command opens. Nothing is started; the user sees the same error
with a **What does this mean?** button. `tomAi_getWorkspaceInfo` (`dartBinaries`)
says beforehand whether `tom_bs` is there.

**The Anthropic transports without their SDK.** No VSIX carries the provider
SDKs: the Provider SDKs page (`tomAi.providerSdks`) installs the Anthropic
provider — the direct API SDK, the Agent SDK and its Claude CLI for this
platform. Without it a prompt on an Anthropic profile fails before it runs,
naming the missing SDK (or the CLI) and the page `tomAi.showAgentSdkCliHelp`
opens; other transports are not affected.

### 4.5 Editor and workspace context

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_getWorkspaceInfo` | Workspace + quest + projects + git + `build` (the build this window runs, the installed one, `reloadNeeded`) + `dartBinaries` (this platform; `tom_bs` and `validate_codespecs` each `configured` / `bundled` / `missing`). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getActiveEditor` | Active file, selection, cursor, visible range. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getOpenEditors` | All open tabs with dirty / pinned flags; an MD Browser tab is `kind: "mdBrowser"` with its file and `panelId`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listMdBrowserPanels` | The open MD Browser panels (static, live, and the tabs restored after a reload — `dormant` until shown, with the file remembered for them): file, live mode, title, column, active / visible, unsaved in-place edits, dormant. Read-only. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_openInMdBrowser` | Open a `.md` file in the MD Browser; `reuse` (default) brings a panel already showing it to the front and renders it again; `live`, `viewColumn`, `preserveFocus`. Answers the panel id. Approval. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_closeMdBrowser` | Close MD Browser panels by `panelId`, `filePath`, or `under` a folder except `exceptFilePath`; a panel with unsaved in-place edits is kept unless `force`. Approval. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getActiveQuest` | Resolve the active quest ID. | ✅ | ✅ | ✅ | ✅ |

### 4.6 Diagnostics

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_getErrors` | Snapshot the Problems panel (legacy, flat). | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_getProblems` | Structured Problems panel with filters. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_readOutputChannel` | Read this window's output channels (the queue's sends, retries and errors; Anthropic turns; the compaction log's `history scope:` lines; every other extension's channels) from the files VS Code writes. Without `channel`: the channels and the extension-host runs. With it: the last `maxLines` lines, filtered by `grep` (text or `regex`), with `context`; `run: 1` reads the run before the last window reload. | ✅ | ✅ | ✅ | ✅ |

> VS Code has no API to read an output channel, but it writes every channel of an extension host to disk as it goes — `<logs>/<launch>/window<N>/exthost/output_logging_<YYYYMMDDTHHMMSS>/<n>-<channel name>.log`, one `output_logging_*` folder per extension-host run (a window reload starts a new one). `tomAi_readOutputChannel` finds its own window's `exthost` folder from `context.logUri` (`src/utils/outputChannelLogs.ts`), so no path is platform-specific. Channels do not share a timestamp format, so it filters by text, not by time. A file name cannot hold a `:`, so VS Code writes `Tom AI: MCP Server` to `…-Tom AI MCP Server.log`; names are compared without such characters, so either spelling finds it, and the extension's own channels are listed under the name they were created with (`OWN_CHANNEL_NAMES`). Terminal scrollback stays out of reach: for captured command output use `tomAi_runCommand` (one-shot) or `tomAi_runCommandStream` + `tomAi_readCommandOutput`.

### 4.7 Language server (symbols, refactor, rename)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_findSymbol` | Workspace symbol search. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_gotoDefinition` | Resolve definition at a position. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_findReferences` | References to a symbol. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_getCodeActions` | List quick-fixes / refactors (preview only). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_getCodeActionsCached` | Same, but returns cacheable `actionId`s. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_applyCodeAction` | Apply a cached `actionId` (approval). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_rename` | LSP-safe workspace rename (approval). | ✅ | ✅ | ⚪ | ✅ |

### 4.8 Git

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_gitRead` | Read-only (status, diff, log, blame). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_gitShow` | `git show <ref>[:path]`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_gitWrite` | Allow-listed git writes (approval). | ⚪ | ✅ | ⚪ | ✅ |

All three run in the workspace root unless given `cwd`: a workspace-relative or
absolute folder inside the root, such as a nested repository (`tom_ai/vscode`,
the `_ai` mount). A `cwd` that leaves the root is refused before git runs
(`src/tools/__tests__/git-tools.test.ts`, gitReadImpl — cwd and the nested
repository test).

### 4.9 Notebook

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_notebookEdit` | Insert / replace / delete cells (approval). | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_notebookRun` | Execute cells or the whole notebook. | ✅ | ✅ | ⚪ | ⚪ |

### 4.10 Guidelines and pattern prompts

Guidelines split into two scopes:

- **Global** — workspace-root `_copilot_guidelines/` (recursive).
- **Project** — `{projectPath}/_copilot_guidelines/` inside each project folder (recursive). Discover projectPath values via `tomAi_listProjects`.

The legacy `_copilot_tomai/` and `_copilot_local/` folders are no longer supported.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_readGlobalGuideline` | Read a single global guideline (workspace root `_copilot_guidelines/`). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_listGlobalGuidelines` | List all global guidelines recursively. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_searchGlobalGuidelines` | Grep inside global `_copilot_guidelines/`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_readProjectGuideline` | Read a single project guideline. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_listProjectGuidelines` | List a project's guidelines recursively. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_searchProjectGuidelines` | Grep inside one project's `_copilot_guidelines/`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_listPatternPrompts` | List workspace `!<name>` pattern prompts. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_readPatternPrompt` | Read a `!<name>` prompt body. | ✅ | ✅ | ✅ | ✅ |

### 4.11 Quest todos (YAML-backed)

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listQuestTodos` | List quest todos (filterable by status / file / tags). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getQuestTodo` | Fetch a single quest todo by id. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createQuestTodo` | Create a new quest todo. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_updateQuestTodo` | Patch fields on a quest todo. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_moveQuestTodo` | Move between YAML files within a quest. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_transferTodos` | Move todos into a quest's own todo file (the same or another quest) or into `workspace.todo.yaml`, from any todo file of a quest (session and topic files included) or from the workspace file. Per-id refusals in `skipped`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_renameTodoPrefix` | Rename a todo group's prefix (everything before its ids' number; a leading number belongs to it, `001_cleanup`) in one step: the group's live todos renamed, every `blocked_by` / `dependencies` reference following (other quests' `<quest>/<id>` too), a cancelled stub per old id committed at HEAD in the `-deleted` sibling so the `_ai` commit guard accepts it (a never committed id gets none); new ids the todo schema's id pattern refuses are refused with the rule named; reports the documents still naming the old prefix; `dryRun` goes through the same steps and answers the same references and stubs | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_renameQuestTodo` | Rename one todo (`questId`, `todoId`, `newId`): every field kept, `[renamed from <old>]` in its notes, every `blocked_by` / `dependencies` reference following (other quests' `<quest>/<id>` too), a cancelled stub under the old id in the `-deleted` sibling when that id was committed at HEAD; `group` also places it at the end of that id group; refuses what the todo panel's ID edit refuses (empty, a space or a path character, an id the todo schema's id pattern refuses — the rule named —, an id the quest has, archived ones too); `dryRun` counts the references and writes nothing | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_deleteQuestTodo` | HARD-delete a quest todo (not recoverable — prefer `tomAi_deleteQuestTodos`). | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_archiveQuestTodos` | Move completed todos to the `-archived` sibling file (`todoIds` or `allCompleted`). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_deleteQuestTodos` | Move non-completed todos to the `-deleted` sibling file (recoverable; `todoIds` or `allCancelled`). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_listWorkspaceQuestTodos` | All `*.todo.yaml` across the workspace. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getCombinedTodos` | Aggregate quest + session in one call. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listQuests` | Enumerate quest folders under `_ai/quests/`. | ✅ | ✅ | ✅ | ✅ |

**Repeated todos.** Create and update take `repeat` (the rule: `manual`,
`after` with `every` and `unit`, `daily`, `weekly` with `weekdays`, `monthly` /
`yearly` with `day` — 1-31 or `last` —, `nth` + `weekday` or `working_day`,
yearly with `month`; optional `time`, `until`, `count`; `null` removes it). A
repeated todo set to `completed` is written as `waiting-for-repeat` with
`next_repeat` and `repeat_count` and a line in its notes (the writers do it,
`utils/todoRepeat.ts`); once its count or `until` is reached it completes. The
Timed Requests list's repeated-todo controller (`TimedRequest.kind:
repeated-todos`) moves due ones back to `not-started`.

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

**Dates are dates.** The todo schema declares `due`, `created`, `updated`,
`completed_date`, `archived` and `deleted` as `format: date`, and the shared
todo model (Worktracker, the Webwork todo-file editor) refuses anything else.
The writers (`src/utils/todoDates.ts`) write a timestamp a caller passes as the
date it names in its own offset (`2026-10-20T12:37:25+0200` → `2026-10-20`),
refuse a value that is not a date with nothing written, stamp `created` /
`updated` / completion / archive dates with the **local** date, and rewrite a
timestamped `created` already on a todo as its date when the todo is updated.

**Orchestration fields.** `tomAi_createQuestTodo` and `tomAi_updateQuestTodo`
take the schema's Worktracker fields `execution_role`, `qa_role`,
`orchestration_role`, `bundle_id`, `derived_from` and `feedback_source`
(optional strings): they are written, read back by every reader, verified after
the write like the other fields, and kept by an update that does not name them;
`''` removes one.

**The user's own todos.** Both write tools take `user_action` (boolean): `true`
marks a todo only the user can do (a review, an answer, a look at a screen). It
is written as `user_action: true`, read back and verified, kept by an update
that does not name it, and removed by `false`. A `prefix*` queue walk passes
such a todo instead of sending it to an agent, and the todo panel marks it 👤.

**Publish conditions.** Both write tools take `blocked_until` (a list of
`<package> >= <x.y.z>` or `<package> > <x.y.z>`, the todo schema's pattern):
the releases a blocked todo waits for, met when pub.dev's latest satisfies them
(`_bin/check_todo_blocks.py`). It is written, read back and verified, kept by an
update that does not name it, replaced by one that does, and removed by `[]`. An
entry in another form is refused (`ok: false`) with nothing written, since no
reader could ever find it met. The queue's unblock reads it too: a todo with a
`blocked_until` stays blocked in a `prefix*` walk.

### 4.11a Id generation

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_generateIdPrefix` | Date-based, letters-only code that makes hand-authored ids collision-free. | ✅ | ✅ | ✅ | ✅ |

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

### 4.11b Skills

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_loadSkill` | Load a skill: its `SKILL.md`, folder, allowed tools and files. | 🔁 | ✅ | ✅ | ✅ |

A skill is Claude Code's `.claude/skills/<name>/SKILL.md`: frontmatter (`name`,
`description`, `allowed-tools`) and a Markdown body, with supporting files
beside it. Skills are found in the workspace's own `.claude/skills/` and in
every parent folder's — the nearest skill of a name wins, a symlinked skill
folder counts — exactly as the panel's `/skill` completion finds them.

On **direct, Local LLM and VS Code LM** the system prompt gets a `## Skills`
section: one line per skill, its name and description (cut at 300
characters), and the instruction to call `tomAi_loadSkill` with the name before
a task a skill matches. It is added only when the send carries
`tomAi_loadSkill` — the tool is in the core set, so it is never deferred, but a
profile with an allow-list gets it (and the section) once it ticks the tool
(category **Skills**). The tool answers the skill's folder, its
`allowed-tools` (shown, not enforced: Tool Approval still decides), its files
(relative, sub-folders included; read them with `tomAi_readFile`) and the
whole `SKILL.md`; an unknown name answers the skills there are.

On the **Agent SDK** the SDK loads skills itself (its Skill tool, the project
setting source): no section is added, and `tomAi_loadSkill` is a duplicate of
a built-in (suppressed with `useBuiltInTools`).

Implementation: `src/services/skills.ts` (discovery, frontmatter, the section,
`loadSkillImpl`; vscode-free), `src/tools/skill-tools.ts`. Tests:
`skill-tools.test.ts` (SK-1..4, a fixture workspace),
`skills-system-prompt.test.ts` (SS-1/2, through `sendMessage`).

### 4.11c Tools of external MCP servers

The extension is also an MCP **client** (`src/services/externalMcp.ts`): the MCP servers Claude Code is configured with give their tools to the **direct** and **Local LLM** tool loops.

- **Configuration**, as Claude Code keeps it: the workspace's `.mcp.json` (project), `~/.claude.json` `mcpServers` (user) and `projects[<workspace>].mcpServers` (local); local wins over project over user. A server is `{command, args, env}` (stdio) or `{type: "http" | "sse", url, headers}`; `${VAR}` and `${VAR:-default}` are expanded.
- **Approval of project servers**, as in Claude Code: a `.mcp.json` server runs only when the settings approve it — `enableAllProjectMcpServers`, or its name in `enabledMcpjsonServers` — and it is not in `disabledMcpjsonServers` (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`). Approving a server in Claude Code writes these settings; until then the status line says it is not approved.
- **Tools** are named `mcp__<server>__<tool>` (characters outside `[A-Za-z0-9_-]` as `_`, at most 64), with the server's description and input schema. A tool with `readOnlyHint` is a reader; every other one is a writer, approved like ours (Tool Approval, Accept edits, plan mode, hooks). A call answers the result's text; an error result is an error.
- **When**: a direct or Local LLM send (not an isolated one — a sub-agent gets only the tools it is given) connects what is configured and not connected yet, before the tool plan — on direct the tools are deferred and found by tool search. Servers stay up; a changed configuration restarts its server; one that does not start is left out with a message in the status line and the Tom Tool Log, and tried again after a minute; deactivation stops them.
- **Elsewhere**: the Agent SDK reads `.mcp.json` and the user's servers itself; VS Code LM gets VS Code's own MCP tools from VS Code.

Tests: `externalMcp.test.ts` (MC-1..4, a fixture stdio server), `external-mcp-transports.test.ts` (EM-1/2, a Local LLM send end to end).

### 4.12 Session todos (per session)

A session todo belongs to the session the call runs in: a step the agent notes
for itself while carrying out a quest todo (work that outlives the session is a
quest todo). Each session keeps them in
`_ai/quests/<quest>/history/sessions/<session>/session-todos.todo.yaml`,
machine-local (not versioned) and deleted with the session. A call that runs in
no session (an MCP client, Copilot) works on the session the SESSION TODOS view
shows, else `default`.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_addSessionTodo` | Add a session self-reminder (persistent per-host file). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listSessionTodos` | List session todos. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getAllSessionTodos` | Counts + all items. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_updateSessionTodo` | Patch fields. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_deleteSessionTodo` | Delete. | ⚪ | ⚪ | ⚪ | ⚪ |

### 4.13 Workspace metadata

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listProjects` | Projects from `tom_master.yaml`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listDocuments` | Files in prompts / answers / notes / roles / guidelines. | ✅ | ✅ | ✅ | ✅ |

### 4.14 Issues (bottom-panel WS tab, Issues subpanel)

Bugs / feature requests / work items tracked via the Issues subpanel.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listIssueRepos` | Discover repos configured for Issues. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listIssues` | List with state / label / substring filters. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getIssue` | Fetch one + optional comments. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listIssueComments` | Comments only. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createIssue` | Open a new issue (approval). | ⚪ | ✅ | ⚪ | ✅ |
| `tomAi_addIssueComment` | Comment on an issue (approval). | ⚪ | ✅ | ⚪ | ✅ |
| `tomAi_setIssueStatus` | Change status — uses statuses from the Issues panel config (approval). | ⚪ | ✅ | ⚪ | ✅ |
| `tomAi_toggleIssueLabel` | Toggle a label; key=value labels replace prior value (approval). | ⚪ | ✅ | ⚪ | ✅ |

### 4.15 Tests (bottom-panel WS tab, Tests subpanel — testkit)

Parallel to §4.14 but scoped to the **Tests** subpanel (test reports, flaky-test tickets). Same `IssueProvider` transport, different repos + different semantics.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listTestRepos` | Discover repos configured for Tests. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listTests` | List test-kit items with filters. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getTest` | Fetch one + optional comments. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listTestComments` | Comments only. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createTest` | File a new test report (approval). | ⚪ | ✅ | ⚪ | ✅ |
| `tomAi_addTestComment` | Comment on a test-kit item (approval). | ⚪ | ✅ | ⚪ | ✅ |
| `tomAi_setTestStatus` | Change status (approval). | ⚪ | ✅ | ⚪ | ✅ |
| `tomAi_toggleTestLabel` | Toggle a label (approval). | ⚪ | ✅ | ⚪ | ✅ |

### 4.16 Chat variables

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_readChatVariable` | Read a chat variable. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_writeChatVariable` | Write a chat variable (own change log — no approval). | ✅ | ✅ | ⚪ | ✅ |

### 4.17 Memory (`_ai/memory/`)

Two-tier: `shared/` (cross-quest, one set of files) and the quest scope, which is per session: `{quest}/{session}/`, the session the running prompt belongs to (`default` the queue's, `chat` the ANTHROPIC/LLM panel's, or a named session). The tools, `${memory}` and background memory extraction all use the running session's quest memory; a Local LLM memory bucket (`facts-<suffix>.md`) reads the `default` session's.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_readMemory` | Read a memory file. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listMemory` | List memory files. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_saveMemory` | Save new memory (approval). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_updateMemory` | Patch-edit memory (approval). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_forgetMemory` | Delete memory (approval). | ⚪ | ⚪ | ⚪ | ⚪ |

### 4.18 User interaction

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_notifyUser` | Notification (the quest's Telegram when set up on this machine, else VS Code). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_askUser` | **THE** way to ask the user and get an answer. Blocking: asks up to 15 questions in a webview + Telegram and returns the user's verbatim reply. Waits **indefinitely** by default — the block *is* the pause, so a prompt running in the queue holds there until the user answers. Pass `timeoutMinutes` to continue automatically instead. `choices` adds buttons — an answer, a move of the quest's process (made by the extension on the click), a branch or subprocess of the current step — at a `{{choice:<id>}}` marker or under their question. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_askUserPicker` | `showQuickPick` selection — requires a human. Same indefinite-by-default wait and optional `timeoutMinutes`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_askInMdBrowser` | Ask through a document: a `.md` file opens in the MD Browser with the agent's `buttons` (`{id, label}`, 1–8) and a *Keep this file* checkbox (`keepFile`, on by default) in its top area. Blocking like `tomAi_askUser` — the queue holds until a button is clicked; one such ask at a time; optional `timeoutMinutes`. Answers `{button, label, keepFile, fileDeleted, file, panelId}` (`button: null` with `timedOut`, `closed` or `cancelled`); an unchecked file is deleted, and its panel closed, when the flow goes on. For questionnaires, choices, confirmations, reviews. `finishReviewRound: true` adds the **Finish review round** button (only at a review, or while the running step leads to one): its click closes that panel, confirms the review, moves the process on and queues the next step's prompt or opens the decision. `reopenDecision: true` adds the decision's own choices (`decide-<n>`; a click takes it, answered as `decisionTaken`) and **Back to the decision** (only at a process decision): its click reopens the decision; the advice notes of Grill me / Explain a decision use it. | ✅ | ✅ | ⚪ | ✅ |

**The picker always allows a free-text answer.** An **"Other…"** entry is appended to `items` automatically (`src/services/free-text-picker.ts`); taking it opens an input box and the typed text becomes the selection, with `label` and `value` both set to it. The entry is pinned (`alwaysShow`), so typing an answer that matches no item cannot filter it away. Pressing Enter then submits the typed text directly. That holds even though the pinned "Other…" row is the highlighted one at that point: a selection made only of pinned rows, with text in the box, counts as the text. The input box only opens for a user who picks "Other…" with nothing typed. A list of options is a guess about what the answer might be, and the real answer is regularly none of them — so `selected.value` may be text that was never among the offered items, and callers must not assume otherwise. The Agent SDK's built-in `AskUserQuestion` interceptor uses the same affordance.

Both log to the quest's **Questions** journal (`questions.<quest>.md`, @WS → Documentation → Questions): the question as asked and the answer as given, or the fact that the wait timed out.

### 4.19 Planning and delegation

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_enterPlanMode` | Enter plan mode: every write tool is refused until the user leaves it. | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_exitPlanMode` | Propose the plan; the user accepts it (plan mode ends) or asks to keep planning. | 🔁 | ✅ | ⚪ | ⚪ |
| `tomAi_spawnSubagent` | Run a nested conversation with a narrower tool set, or as a `.claude/agents` definition (`agent`). | 🔁 | ⚪ | ⚪ | ⚪ |
| `tomAi_askBigBrother` | Delegate to a larger model via the VS Code LM API. | ⚪ | ⚪ | ✅ | ❌ |
| `tomAi_askCopilot` | Bounce a question off the **Copilot Chat panel** (via bridge). | ⚪ | ⚪ | ✅ | ❌ |

**A question ends with the prompt that asked it.** An Anthropic send owns the questions its tool calls ask (`services/askOwners.ts`, `runAsAskOwner` around `AnthropicHandler.sendMessage`): a `tomAi_askUser`, an Agent SDK `AskUserQuestion` with choices or a `tomAi_askInMdBrowser` still open when the send ends — stopped, aborted, failed — is cancelled (the answer says the prompt has ended) and its panel closes (an MD Browser file that is kept keeps its panel, the bar cleared). The pickers end the same way: a `tomAi_askUserPicker` QuickPick, or the QuickPick / input box of an Agent SDK `AskUserQuestion` without choices, still open then closes as on Escape — the tool answers `dismissed: true`, the Agent SDK question falls back to its autonomous answer. A question asked outside a send (an MCP client) ends only by its answer, timeout or cancel. The question panel is kept per question: when a question resolves, its panel and any stale one close; a stale panel that posts an answer closes with a note; a choice the panel cannot carry out still answers (with the error). Tests: `askPanelClose.test.ts` (PC-1..6), `live-user-prompter.test.ts` (the pickers).

**Plan mode** gates writes on every transport (`src/tools/planning-tools.ts`). While it is on, every write tool — a `tomAi_*` tool that is not `readOnly`, and Claude Code's writing built-ins (`Bash`, `Write`, `Edit`, …; an unknown built-in counts as one) — answers "plan mode: read and plan only — present your plan and call tomAi_exitPlanMode" instead of running; reading tools and `tomAi_askUser` / `tomAi_askUserPicker` / `tomAi_notifyUser` still run. On direct, Local LLM and VS Code LM the refusal happens in the extension's own tool loop (`runTool`) before any approval; on the Agent SDK in `canUseTool`, in the MCP tool handlers (which run without `canUseTool` under `bypassPermissions`), and through the SDK's own `plan` permission mode — set at the start of a send while plan mode is on, and passed on with `setPermissionMode` when it changes during one. **Only the user ends it:** `tomAi_exitPlanMode {plan}` (or the SDK's `ExitPlanMode`) shows the plan in the ANTHROPIC/LLM panel with *Accept and leave plan mode* / *Keep planning* (an optional note goes back with Keep planning) and waits; without the panel open, a modal dialog asks. The panel's plan-mode badge leaves it directly. Plan mode is one per window: a queued prompt that enters it waits for the user's decision like `tomAi_askUser`. Tests: `planning-tools.test.ts` (PL-1..4), `plan-mode-tool-loop.test.ts` (PT-1..3), `agent-sdk-plan-mode.test.ts` (SP-1..4).

**Sub-agents and Claude Code's subagent definitions.** `tomAi_spawnSubagent` runs an independent conversation through the Anthropic handler on the default configuration (`isDefault`, else the first), with approval off and, without an allow-list, the read-only tools. `agent: "<name>"` runs it as a Claude Code definition — `.claude/agents/<name>.md` in the workspace or a parent folder, the nearest of a name winning (`src/services/agentDefinitions.ts`): the body is the system prompt; `tools` the allow-list, Claude Code's built-ins mapped to ours (`Read` → `tomAi_readFile`, `Edit` → `tomAi_editFile`, `Write` → `tomAi_createFile`, `Grep` → `tomAi_findTextInFiles`, `Glob` → `tomAi_findFiles`, `Bash` → `tomAi_runCommand`, …; `mcp__tom-ai__…` loses its prefix), the rest named in the answer's `notes`; `model` (alias, id or `inherit`) picks the configuration with that model, the default's transport first — an id no configuration has runs on the default with that model on direct and the Agent SDK, anything else on the default with a note. `systemPrompt` / `enabledTools` passed explicitly win. The answer adds `agent`, `model` and `notes`. Its progress shows in the status line: started, each tool call, done with rounds and calls. On the **Agent SDK** the same definitions go into the SDK's `agents` option (our tools under their `mcp__tom-ai__` names; no `tools` when the file states none, so the SDK gives the parent's), so its own Task tool delegates to them; those sub-agents report started / their tool calls / done in the status line too (`src/utils/subagentProgress.ts`). Tests: `agentDefinitions.test.ts` (AD-1..4), `subagent-definitions.test.ts` (SA-1..5).

### 4.20 Copilot Chat orchestration — prompt queue, pre-prompts, timed requests, templates

These tools drive the **Copilot Chat user-facing panel** via a bridge. They are *not* relevant to how the calling chat (Anthropic / Ollama / VS Code LM) receives its own responses — they stage and dispatch prompts into someone else's chat. The `⚪` across all transports is intentional: whether to surface them is a user-workflow decision, not a per-transport default.

**Queue-item fields now surface the current manager feature set:** per-item `repeatCount` + `repeatPrefix` + `repeatSuffix` (main-prompt repeats with `${repeatNumber}`/`${repeatIndex}` placeholder expansion), `templateRepeatCount` (whole-template re-runs), `answerWaitMinutes` (auto-advance on timeout), pre-prompts (sent before the main prompt), per-follow-up `repeatCount` + `answerWaitMinutes` + reminders, and **chat-variable-driven counters** — any `repeatCount` accepts either a literal number or the name of a chat variable whose value the manager resolves at send time and decrements each iteration — or `<prefix>*`, which walks the quest's todos whose id starts with the prefix (the prefix may hold digits, `p2s2ss3-*`, but must not end in one: such a value is refused with `code: invalidTodoPrefix`; the item's text names the todo each dispatch picked with `${repeatTodoId}`, `${repeatTodoTitle}` and `${repeatNumber}`).

**Sessions.** An item runs in a named session (`session`; `<name>.session.json` in the quest's history folder): unset, the queue default, else the queue's own `default`. On the Agent SDK transport the session holds the SDK conversation; on the direct API transport it chooses the history the send reads and writes (`chat` and `default` share the quest's `history/`, any other session has `history/sessions/<name>/`). A session has a lifetime — `continue`, `per-prompt` (every prompt starts again; `fork-from-base` is the old name) or `per-iteration` (one conversation per repeat round or `<prefix>*` todo, its pre-prompts and follow-ups included) — with or without a base, so a prepared base (spec read, guidelines loaded) serves every todo of an iteration without the todos changing each other's context, and optionally a profile, which its prompts run with unless the item names its own (item → session → queue default). An item's `session` may be a spec `{name, basedOn, mode, profile}`: a missing session is created from it before the first send; a malformed spec or a profile that cannot continue the session's conversation is refused (code `invalidSession` for a malformed spec). **Done notification.** An item may carry a `doneNotificationPrompt` (`tomAi_addQueueItem`, `tomAi_updateQueueItem`, `tomAi_sendItemToQuest`, the CLI's `queue.addVce`): when the item is finished — every pre-prompt, repetition, `<prefix>*` todo, follow-up and template iteration done, or ended in an error that will not recover (no API key, a refused request, an exhausted retry schedule; not a quota or rate limit being waited out) — the prompt is queued ahead of every other pending item, with the item's transport, profile and session, once per run of the item. `${itemOutcome}` in it reads `done` or `error: <message>`; the item's "pause after this" moves to it; `doneNotificationDisabled` keeps the prompt but does not queue it.

**Another quest's queue.** `tomAi_sendItemToQuest` puts a prompt into the queue of another quest's window on this machine: an inbox file in the shared queue folder, which the target window claims (so one window takes it), queues with its own defaults and deletes — at once, or when a window of that quest starts. `anthropicProfileId`, `session` (an existing session of the target quest) or `newSession` (`{basedOn, name?, lifetime?, profile?}`; without a name a temporary session, deleted when the item and its notification are done) override the target's defaults; `${senderQuest}` in the text and the notification prompt is the sending quest. The answer's `targetRunning` says whether a window of that quest has a live heartbeat (written every 30 s into its window-state file). **Before sending,** `tomAi_getQuestWindowStatus` (read-only) says which windows run on this machine and what each is doing — alive by the heartbeat, pid, CLI / MCP server, the subsystems with a prompt out, role, process position, the ANTHROPIC/LLM panel's profile and session, the queue (auto-send, paused, counts per status, default transport / profile / session, the item being sent with its stage, profile and session) — each quest's sessions (the SESSIONS view's list: base, lifetime, profile, last model, whether it has a conversation, temporary `tmp-*` ones, the implicit `default` and `chat`, and the profile an item without its own runs with in each), and the profiles a sent item may name (`isDefault`, `noApiKey`). Every profile is `{id, name, model, transport}`; an id the config no longer holds is `unknownProfile: true`. `quest` narrows it to one quest (an unknown one is refused, a quest with no window still lists its sessions); `includeGone` adds windows without a live heartbeat.

Timed-request entries gained `repeatCount`, `repeatPrefix`, `repeatSuffix`, `sendMaximum` (auto-pause after N sends), and `answerWaitMinutes`; `scheduledTimes` now takes the manager's native `{time:"HH:MM", date?:"YYYY-MM-DD"}` shape.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_addQueueItem` | Stage a prompt; accepts prePrompts, per-item repeat/answer-wait, full follow-up / reminder fields, `session` (the named session it runs in) and `doneNotificationPrompt`. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_addQueueFollowUp` | Append a follow-up; now accepts repeatCount, answerWaitMinutes, reminders. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_addQueuePrePrompt` | Append a pre-prompt (sent before the main prompt). | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updateQueuePrePrompt` | Patch pre-prompt fields by (itemId, index). | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_removeQueuePrePrompt` | Remove a pre-prompt by index. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_sendQueuedPrompt` | Send one staged prompt. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_resendQueueItem` | Send an item's last dispatched stage again (same id, counters untouched). An item stopped for lack of credit carries `outOfBudget` in the answer (and in `tomAi_listQueue`); `profileId` continues it on another Anthropic profile, as the queue editor's Continue on profile does — the out-of-budget prompt, the item's session unless that profile cannot continue it (then `default`), later stages on that profile (`budgetFallback`). | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_listQueue` | List queue items, each with its process run; also `autoSendEnabled`, `queuePerRun` (one lane per run, sending in parallel) and `heldRuns` (runs paused per run). | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updateQueueItem` | Patch item fields incl. repeat / answerWait / reminder / `session` (`''` = the queue default); `doneNotificationPrompt` and `doneNotificationDisabled` also while the item is sending. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_listSessions` | The quest's named sessions: mode, base, whether they have a conversation, how the next prompt in each starts. Reads only. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_createSession` | Create a session, fresh or based on another, with a lifetime (`continue`, `per-prompt`, `per-iteration`) and optionally a `profile` (stored with its model). No approval prompt. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_setQueueItemStatus` | Toggle staged / pending. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_getQuestWindowStatus` | The windows on this machine (alive, servers, role, process position, panel profile and session, queue summary with the item being sent, `build`, `dartBinaries`), each quest's sessions with their profiles, and the Anthropic profiles. Reads only. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_sendItemToQuest` | Queue a prompt in another quest's window on this machine (inbox file), optionally with a profile, an existing or new session of that quest, a done-notification prompt and pause-after; answers `targetRunning`. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_removeQueueItem` | Delete. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updateQueueFollowUp` | Patch follow-up incl. repeat / answerWait. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_removeQueueFollowUp` | Remove a follow-up. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_addTimedRequest` | Create a timed entry (interval) with repeat / sendMaximum / answerWait / reminder. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_listTimedRequests` | List timed entries. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updateTimedRequest` | Patch timed entry; schedule slots use `{time:"HH:MM", date?:...}`. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_removeTimedRequest` | Remove a timed entry. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_setTimerEngineState` | Enable / disable the timer engine. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_listPromptTemplates` | List prompt templates. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_createPromptTemplate` | Create a new prompt template. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updatePromptTemplate` | Patch (optionally rename) a prompt template. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_deletePromptTemplate` | Delete a prompt template. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_listReminderTemplates` | List reminder templates. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_createReminderTemplate` | Create a reminder template. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_updateReminderTemplate` | Patch a reminder template. | ⚪ | ⚪ | ⚪ | ⚪ |
| `tomAi_deleteReminderTemplate` | Delete a reminder template. | ⚪ | ⚪ | ⚪ | ⚪ |

**Missing API key.** The tools that queue, change or send an item answer a `warning` when a stage of it runs on an Anthropic profile whose configuration uses the direct API and whose key variable (`anthropic.apiKeyEnvVar`) is not in this VS Code's environment — one line per cause, naming the stages. The item is queued all the same. See `multi_transport_prompt_queue_revised.md` §4.17a.

**Remaining gaps** (manager features still with no tool): engine-wide `TimerScheduleSlot` (awake/asleep windows with weekday / first-weekday / last-weekday / day-of-month patterns) and reminder-system config (`ReminderSystem.config.enabled`, `defaultTimeoutMinutes`). Add if a workflow needs LLM-driven control of those.

### 4.22 Past tool access (session-scoped history lookup)

Session-scoped pull access to earlier tool calls + their full results. Backed by the Anthropic handler's in-memory `ToolTrail` ring buffer (default 40 entries, 100 kB per entry). The injected `[Tool history — last N calls]` block at the top of every outgoing user message already summarises the most recent calls and includes a **replay key** per line; these tools let the agent look up the full result on demand, or grep across the buffer.

The buffer is **session-scoped** (cleared on `Clear session history`) and **Anthropic-only** — the Local LLM handler maintains its own unrelated conversation state, so these tools return an informative message there instead of wrong data. Read-only; never prompt for approval.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listPastToolCalls` | List recent tool calls with replay keys. Optional filters: `toolName`, `sinceRound`, `limit` (default 20, max 200). | ✅ | ✅ | ⚪ | ⚪ |
| `tomAi_searchPastToolResults` | Regex search across past result bodies; returns snippets with replay keys. Arguments: `pattern`, optional `toolName`, `caseSensitive`, `limit`, `contextChars`. | ✅ | ✅ | ⚪ | ⚪ |
| `tomAi_readPastToolResult` | Return the body of a past tool call by its replay key (e.g. `t14`), paged by `offset` / `length` (default 30,000 chars; the answer gives `resultSize` and `nextOffset`). Its answers are never cut inline. A key the stored results' retention removed (older than `trail.toolResultsMaxAgeDays`, beyond `trail.toolResultsMaxPerSession`) answers `pruned: true` with *pruned by retention*, not *not found*. | ✅ | ✅ | ⚪ | ⚪ |

Tool results are per session: each session keeps them in `history/sessions/<session>/trail/tool_results/`, and its keys continue past the stored ones, so a key never names two results; `tomAi_readPastToolResult` reads the running session's first. `tomAi_listPromptPairs` lists every session's Anthropic pair as subsystem `anthropic:<session>` (the filter `anthropic` matches them all).

**`sessions`.** The tools that read or write per-session storage take an optional `sessions` — a session name, a list of names, or `"all"`; an unknown session is refused (code `unknownSession`) with the sessions there are. Without it they work on the session the call runs in:
- `tomAi_listPromptPairs` / `tomAi_getPromptPair`: those sessions' Anthropic pairs (other subsystems are always included); a call that runs in no session (Copilot, Local LLM, an MCP client) reads every session; the answer names the `sessions` read.
- `tomAi_listPastToolCalls` / `tomAi_searchPastToolResults` / `tomAi_readPastToolResult`: without `sessions` the caller's in-memory ring buffer as before; with them every result the chosen sessions stored on disk (evicted ones included), each entry and hit tagged with its `session` (keys are per session; a read names the session it came from, `alsoIn` the others holding the key).
- `tomAi_saveMemory` / `tomAi_updateMemory` / `tomAi_forgetMemory` / `tomAi_readMemory` / `tomAi_listMemory`: quest memory is per session (`_ai/memory/<quest>/<session>/`); a write goes to each chosen session, a read or list shows each under a `## session <name>` heading; the shared scope ignores `sessions`.

**Every call, every transport: the Tom Tool Log.** Each tool call an agent makes writes one line to the *Tom Tool Log* output channel (`src/utils/toolCallLog.ts`): `<ISO time> [tool-call] <transport> <tool> <ms> ms <chars> chars ok` (or `error: <first line>`). The transport is `direct`, `vscodeLm` or `localLlm` for the Anthropic handler's own tool loop, `agentSdk` for the Agent SDK's in-process MCP server, and `mcp` for the standalone MCP server's clients. `tomAi_readOutputChannel {channel: 'Tom Tool Log', grep: '<tool>'}` answers how long a tool takes and which call failed in any session; `run: 1` reads the run before the last window reload. The ToolTrail (the tools above) covers the ANTHROPIC/LLM panel and the queue on every transport, the Agent SDK's included (with full results); calls of standalone MCP clients are only in the log, since their conversations are not an Anthropic session.

Typical usage: the injected history block shows `14:23:05 [t14] R3 tomAi_readFile(src/foo.ts) → export function foo …`. Past tool N returned content the model now wants verbatim → `tomAi_readPastToolResult({ key: "t14" })` returns the file content it saw earlier, no tool re-run — a result longer than one page (30,000 characters by default) is read on with `offset: nextOffset` until `nextOffset` is null.

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

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_specListDocuments` | The model's document roots, and the SOM documents under a folder (default the workspace) with their root, model-version stamp and editability. Searched with VS Code's file search (`search: "findFiles"`, 1–1.5 s for the whole workspace in the extension host on mbp), else by walking the folders; `timeBudgetMs` (default 10 s, max 120 s) bounds it and `stoppedBy` says why a list is truncated. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specOutline` | The instance tree under a path: kind, section id, headline, codeSpec, filled, item counts; depth-limited and paged. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specGetSection` | One node with its values: a leaf's value, a form's typed fields with enum domains, a list's items, a section's values, forms and children. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specReflect` | The model at a path or class: kinds, types, form fields, annotations, doc comments; with a file, the children `checkAddNode` accepts there now. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specSearch` | Query one document (runtime `SpecQueryEngine`): text or portable pattern, kinds, class, `@SectionId`, path glob, `@MapsTo` / `@DetailedIn`, empty / non-empty, AND-combined. First page + cursor. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specSearchIterate` | The next page of a search cursor; re-runs the query when the file changed since. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specValidate` | Is it valid now? The three tiers of tom_specs' `validate_spec` CLI (decode, DocSpecs schema, instance) in its report shape, each finding with the `path` to fix. `files` validates fragments of one document as one; `path` scopes the findings. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specRender` | The document, or one subtree, as the DocSpecs Markdown a reader sees; `withoutAnnotations` renders it as it reads once reviewed (every inline mark accepted, every comment and question removed). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specAnnotations` | The review annotations (SOM §11.9) of the document or a subtree: comments (id, author, change time, text, the paragraph they follow), questions (topic, options, recommended, answer, open), inline marks (`M-<n>`, old / new text, change time), with counts, the `marksRevision` and the runtime's annotation findings. With `dir` instead of `file`: every SOM document under the folder with its counts and number of findings, and the totals — no lists (`maxResults`, `timeBudgetMs`, `truncated` as for `tomAi_specListDocuments`). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specExtractAnswers` | A review round's `answers.md` (SOM §11.9.7) from one or more documents: the answered questions and the comments, each with its section-id chain and rendition line; the open questions (`includeOpen`) and inline marks (`includeMarks`) on request; counts per document and in total. The text tom_specs' `extract_answers` CLI writes; writes nothing. | ✅ | ✅ | ⚪ | ✅ |

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
`dryRun` (returns a `diff`, writes nothing). A YAML file keeps its own layout:
only the values an edit changes (and the `modelVersion` stamp) are written
anew; every other key keeps its place and every other value its text and scalar
style, even in a file another encoder wrote. Large documents work the same: on
the 16 MB Tom UAM Blueprint a write tool takes a few seconds.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_specCreateDocument` | A new, empty document for one model root, in the format its file name says. Refuses an existing file. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specSetContent` | A content or scalar value; null or `""` clears it. A value a typed leaf cannot read is refused as `wrongValue` with the leaf's name, type and enum domain, as `tomAi_specSetFormField` answers (the batch's `setContent` and `addNode`'s `content` alike). `marked: true` writes text as a change the reviewer accepts or rejects (see *Review annotations*), attributed (`{@author}`) to `author` — by default the user's review member id when one is set; `""` to nobody. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specSetFormField` | One form field, typed by its declaration: int, double, bool or enum name. A wrong value comes back with the field's type and domain. `marked: true` on a String field writes the new text as a marked change. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specSetHeadline` | A section's stored headline; null returns it to its default title. One line: a line break is refused (`invalidHeadline`), since it would end the Markdown heading. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specSetCodeSpec` | The heading-level `codeSpec=` routing marker. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specAddNode` | A child or a list item (id generated from the pattern, or given), optionally populated with `content`, form `fields` and its `headline` in the same call (a refused value or headline refuses the whole add). A refusal lists the legal children. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specSetItemSectionId` | Rename a list item's section id; the pattern prefix and list uniqueness are checked. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specMoveListItem` | Reorder within a list or move to a list of the same element class; returns the `renamed` map, and YAML review entries follow their items. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specRemoveListItem` | Remove a list item and everything under it. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specClearSection` | Remove every value under a path. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specConvert` | Write the other format (`*.docspecs.yaml` ↔ `*.md`) beside or over the source. Refuses unfaithful Markdown; a YAML source's review entries need `dropReview`, since Markdown has none. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specApplyEdits` | **The preferred way to make more than one change:** up to 200 of the edits above (`{op, …}`), in order, on one document. One approval, one write, one undo step, all or nothing. `addNode` can bind `as: "req"` for later `$req/…` paths; a move re-points bound names and refuses a stale literal path. The approval prompt shows the op counts and paths. | ✅ | ✅ | ⚪ | ✅ |

**Review annotations.** Questions, reviewer comments and inline marks live in
content and form-field values (SOM §11.9): `> ⬆️ **C-12** (author, time): text`,
`> **❓ BQ-81 — topic:** …` with options and `> **Answer:**`, and the CriticMarkup
marks `{++…++}`, `{--…--}`, `{~~old~>new~~}`, `{==…==}{>>…<<}`, `{>>…<<}`. Every
comment or inline comment the tools write or edit records its change time (SOM
§11.9.10, e.g. `2026-11-07T14:05+01:00`, minutes in the writer's offset) — in a
comment block's header, or in the attribution token after an inline comment
(`{@agent_spec_author 2026-11-07T14:05+01:00}`); so do a question's header, a
team answer's marker and a marked change's token. Each writer takes `at` to
record another time than the call's (a change made earlier); a malformed one is
refused. These
tools read and edit them through the runtime's `SpecReviewAnnotations`, never by
parsing the Markdown, in YAML and Markdown documents alike. The writers share the
edit cycle above (revision, dry run with diff, validation) and are batch ops of
`tomAi_specApplyEdits` under the same names (`insertComment`, `insertQuestion`,
`setAnswer`, `editComment`, `assignCommentIds`, `resolveAnnotation`,
`decideMarks`, `removeAllAnnotations`). Paragraphs are the blank-line separated
blocks of a value, counted from 0 (-1: the start).

**Marked writes.** `tomAi_specSetContent` and `tomAi_specSetFormField` (and the
batch's `setContent` / `setFormField`) take `marked: true`: the new text is
written with its differences against the value there now as inline marks
(`SpecReviewAnnotations.setMarked`), so accepting every mark gives the new text
and rejecting every mark the old one. A value that already holds marks is
compared from its original, so editing a passage again updates its mark. Only
text takes marks — a typed or enum value is refused as `notText`. The answer
carries `exact`: false when a difference sat in fenced code or the text holds
mark delimiters, and the new text was written unmarked.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_specInsertComment` | A comment block after a paragraph of a value — by number (`afterParagraph`) or by its text (`afterTextStart` / `afterTextContains`, refused when no or several paragraphs match); the next free `C-<n>` unless `id` is given. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specInsertQuestion` | A question block directly after a comment (`afterComment`) or after a paragraph (by number or by its text, as insertComment); the recommended option bold. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specSetAnswer` | Write a question's answer after `**Answer:**`; `""` reopens it. `author` writes a review member's individual answer `**Answer (<id>):**` (SOM §11.9.8) — by default the user's member id when one is set (Status Page, Team review); `""` writes the team answer. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specEditComment` | Replace a comment's text; id and author stay, the change time becomes the edit's. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specAssignCommentIds` | Give every comment without an id the next free one; answers them as `assigned`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specResolveAnnotation` | Remove one comment or question by id once it has been applied (a qualified `SBP C-12` too). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specDecideMarks` | Accept / reject / leave marks by `M-<n>` id at a `marksRevision` (a stale one is refused), or `all` under a path. Deciding a change with a comment keeps the comment and records `accepted` / `rejected` in its quote. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCommentChange` | Comment on a change mark by its `M-<n>` id (SOM §11.9.3): a change comment `{>> [~~ old ~> new ~~] why? <<}` right after the change, quoting it so it stays understandable once the change is decided; answers its `commentId`. One per change; `author` and the change time are written in the attribution token after it. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specEditMarkComment` | Replace the comment of an inline mark by id — a `{>> comment <<}`, a change comment (its quote kept) or a commented highlight; the change time becomes the edit's. Comment blocks (`C-<n>`) are `tomAi_specEditComment`'s. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specRemoveAllAnnotations` | Every inline mark accepted, every conflict's decision applied, every comment, question and conflict block removed, in the whole document — the document once a round is integrated. Answers what it `removed` (counted before); refused (`conflictUndecided`) while a conflict is undecided. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specWriteAnswers` | Write `tomAi_specExtractAnswers`' text to a step folder's `answers.md` (`output`): `status` new / changed / unchanged; other text is refused without `overwrite`; annotations the runtime cannot read are refused (`annotationsMalformed`); `dryRun` returns the diff. Not a batch op. | ✅ | ✅ | ⚪ | ✅ |

**Team review rounds** (SOM §11.9.8, §11.9.9). A round is files only: the
round folder holds `round.yaml` (document, base, date, author, team, guests,
the last merge), `base.<ext>` (the document as sent out), one copy per member
named by member id (`alice.docspecs.yaml`, `alice.md`; nothing is written into
a copy) and `merged/` (the merged document and `merge-report.json`). They work
on TomSpecs documents and on plain annotated Markdown through the runtime's
`mergeReviews`; a plain Markdown copy is matched by heading path.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_specReviewRoundCreate` | The round folder for a document: base, one copy per member, `round.yaml`. The team is `members`, else the document's own review team, else the solution blueprint's team for its document type, else its default team (approval). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specReviewRoundStatus` | Per member: `exists`, `returned` (differs from the base), `valid` (reads, structure fits the base — else its `problem`), annotation `counts`; guests' copies. Read-only. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specMergeReviews` | Merge the returned copies into `merged/` with the report: attributed marks and votes, individual answers, conflicts, unanimous decisions applied, guest questions, a draft revision entry (approval). | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specDecideConflicts` | Write conflict decisions after `**Decision:**`: a letter `(a)`, `(base)` or rewritten text; `""` reopens (approval). TomSpecs documents and plain Markdown. | ✅ | ✅ | ⚪ | ✅ |

`tomAi_specAnnotations` lists the conflicts (`conflicts`: base, alternatives
with their members, decision), each question's individual answers (`answers`)
and each mark's `authors` and `votes`; its counts include `conflicts`,
`openConflicts` and `unresolvedQuestions`. `tomAi_specExtractAnswers` adds each
document's `individualAnswers` and an *Individual answers* section to
`answers.md`. `tomAi_specRemoveAllAnnotations` applies the conflict decisions
and is refused (`conflictUndecided`) while one is undecided.

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

### 4.23a TomSpecs process checks (`spec_checks`)

The checks a TomSpecs project runs at a gate beyond the three validation tiers,
one tool per check of tom_specs_clitool's `spec_checks` (its
`doc/process_checks.md`). The binary is compiled from
`tom_ai/ai_build/tom_specs_clitool/bin/spec_checks.dart` into
`<extension>/bin/<platform>/` by `npm run codespecs:build`, beside
`validate_codespecs` (the install scripts run it; a Dart SDK is needed at build
time only); the binaries layer carries it for darwin-arm64, linux-x64 and
win32-x64. A check reads the project's data from `<spec root>/checks/`: the
spec root is the nearest folder above the document holding `checks/`, else the
document folder's parent; `specRoot` names it.

Every answer is `{ok, check, outcome, exitCode, findingCount, findings: [{kind,
text}], summary}`: one finding per line the check reports, `kind` the line's
tag; `summary` the check's counts. `outcome` is `clean` (exit 0) or `findings`
(exit 1), both `ok: true`; `usageError` (exit 2: wrong arguments, or the
project lacks the data a check requires — the error names the file) and
`refused` (exit 2 with `REFUSED` lines: an import refused) are `ok: false`, as
is `binaryMissing` (no `spec_checks` for this platform and none configured as
`bridge.executables.spec_checks`; with `expected`, `help` and `page`, like
`tomAi_specCodeSpecsValidate`).

| Tool | Description | Agent SDK | Direct | VS Code LM | Local LLM |
| ---- | ----------- | --------- | ------ | ---------- | --------- |
| `tomAi_specImportAnswers` | The answers typed into a document's rendition (`*.md`), into its YAML in place and verified, the rendition regenerated (`import-answers`). A rendition that differs in more than answers is `refused` unless `allowOtherEdits`. The check runs on copies; the changed files are written through the store — refused when dirty in an editor or changed since read (`expectedRevision` for the YAML), `dryRun` answers the diffs. `summary.imported` lists each answer (question id, id path, first line), `files` what changed and was written. Approval. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specRequiredFields` | Every form holds the fields the model marks required; int, bool and enum fields hold values of their type. Findings `MISSING` / `TYPE`; `summary` {forms, missing, badTypes}. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specQuestionRegister` | A question index file against the document's question blocks (`checks/question_register.yaml`: prefixes, count columns, statuses; defaults without it). Findings `REGISTER`; `summary` {indexRows, blocks, waiting, waitingStarred, findings, answeredNotApplied}. `write: true` rewrites the index's counts, the sentence below them and the id range, through the store (`expectedRevision`, `dryRun`). Approval. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specFeatureRegister` | Every functional requirement linked by exactly one feature; every linked id and prototype feature resolving; the stated total matching. Findings `FEATURES`; `summary` {features, functionalRequirements, prototypeFeatures, findings}. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specProjectIdeaCoverage` | Every Project Idea id cited by a requirement's source, carried by a covered id, or excluded by a record (`checks/project_idea_coverage.yaml`, or `exclusions`). Findings: `uncovered` ids, `UNKNOWN` exclusions; `summary.entries` the ids not plainly covered (`all`: every id), `summary.classes` the count per class. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specAuthorizationCheck` | Operations, the role matrix, screens and use cases agree (`checks/authorization_cross_check.yaml`, required). One finding per item, `kind` the check (A … F); `summary.checks` the count per check, `summary.notes` the consistent other-actor steps and the steps waiting for an open question. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCoverage` | How much of the model the document fills, per configured row, against a full-model sample, and the class of every empty section (`checks/coverage_rows.yaml`, `checks/coverage_reasons.yaml`, required). `summary.table` the report's lines; `tsv: true` adds the TSV. | ✅ | ✅ | ⚪ | ✅ |

`spec_checks validate` and `accept-marks` have no tools: `tomAi_specValidate`
runs the same tiers, and `tomAi_specDecideMarks` with `all: "accept"` accepts
every mark (on a 16 MB YAML too). On Tom UAM's Blueprint the tools give the
results `dart pub global run tom_specs_clitool:spec_checks` gives (the tool
test SK-6 compares them with the bundled binary's own run).

### 4.24 Plain DocSpecs Markdown

Markdown that declares a DocSpecs schema (`<!-- docspec: <id>/<version> -->`)
but is not a SOM spec: quest documents, project specifications. Parsing,
validation and the section replace are the runtime's (`DocSpecsDocument`,
`DocSpecsSchema`, `DocSpecsValidator`). Files go through the same store as the
spec tools, so the text is read from an open editor's buffer, and a write is
refused when the file is dirty or has changed since it was read.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_docspecsValidate` | Check the document against its declared schema. A declared schema found nowhere (`unknownSchema`), a declaration below the title (`headerNotFirst`) and a missing header (`noSchemaDeclared`) are findings. Schema keys the runtime ignores are listed (`ignoredByRuntime`): their constraints are not checked. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_docspecsOutline` | The section tree with line ranges; with a schema, the required sections and those missing. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_docspecsGetSection` | One section's own body (up to its first subsection), by id. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_docspecsReplaceSection` | Replace one section's own body (approval). Every other byte is kept, and fenced blocks are respected. A body that would add a heading or leave a fence open is refused. Answers the validation it introduced or resolved; `dryRun` returns a diff. | ✅ | ✅ | ⚪ | ✅ |

The schema is looked up in this order:
1. an explicit `schema` argument (`<id>/<version>` or a schema file);
2. `.tom/docspecs-schema/<id>/<id>.<version>.docspecs-schema.yaml`, or the
   same file in a suffixed folder `<id>.<suffix>/` (`schema-test.sct/`), in the
   document's folder or the nearest folder above it, up to the workspace root;
3. the schemas generated from the SOM model, so SOM-rendered Markdown validates
   too.

`docspec: none` declares no schema.

**The current form and the legacy one.** The runtime reads the current DocSpecs
form: `<!-- docspec: <id>/<major>.<minor> -->` on the first line and an
`<!--[ID]-->` id on every heading (the DocSpecs specification, Schema
Declaration). The workspace's documents and `.tom/docspecs-schema/` schemas are
in that form. A document still in the legacy form — `# [id] Title` headings, a
`<!-- schema=name-1.0 -->` field — reads as all `malformedHeading`, and a
declaration written below the title is not read at all (`headerNotFirst`); both
answers carry a `migrationHint` naming the conversion,
`_bin/migrate_docspecs.py doc <file> --assign-ids --write`.
`_bin/check_docspecs_documents.py` validates every declaring document of the
workspace with the same rules.

### 4.24a Questions in plain Markdown

Any Markdown document written in the review syntax — the quest's completions
and clarification documents, a questionnaire opened with
`tomAi_askInMdBrowser` — not only TomSpecs specs. A question block is
`> **❓ CC-125 — topic:** text` (in a block of several, the later ones
`> **CC-126 — topic:** text`), its options `> - (a) …` (the recommended one
bold, `**(b)**`, else the one saying "recommended", else the letter of a
`*Recommendation:* (c)` line), and `> **Answer:**` with the answer after it.
The tools read and write on the MD Browser's own parser,
`media/shared/mdQuestions.js`: the browser loads it as a script, the host runs
the same file in a `vm` context (`src/utils/mdQuestions.ts`), so a question
reads the same in both. Fenced code is not read, so an example of the syntax in
a code block is no question. Writes take the save path of every edit: the text
of an open editor, refused when the file is dirty there or changed since
`expectedRevision`; `dryRun` returns the diff. For TomSpecs documents the
`tomAi_spec*` annotation tools read the questions with the runtime.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_mdQuestions` | Every question block of a Markdown file: `id`, `topic`, `text`, `line`, `options`, `recommended`, `answer`, `open`, `answerLine` (null without an Answer line) and `proposed` (a proposed answer under it). `id` / `openOnly` narrow it; `revision` for the writers. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_mdSetAnswer` | Write a question's answer after its `**Answer:**` (approval): `option` writes the letter first (`(b) because …`), `answer` the text; `""` clears it. A duplicate id needs `line`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_mdProposeAnswer` | Write a proposal under the question, after its answer and a bare `>` line, as `> **Proposed answer** (<source>, <date>): …` (approval); the answer stays open for the user to accept, edit or discard it. A proposal already there is replaced. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_mdInsertQuestion` | Insert a question block — the agent's proposal question in a plain Markdown review — after the paragraph holding `afterTextContains`, after line `afterLine`, or at the end: header with its change time, options (the recommended one bold), `*Recommendation:*`, `*Assumption:*`, an empty `> **Answer:**` (approval). An id the file has, or an anchor missing or there twice, is refused. For TomSpecs documents `tomAi_specInsertQuestion`. | ✅ | ✅ | ⚪ | ✅ |

### 4.25 CodeSpecs (Phase 4: a filled spec becomes code-generation inputs)

These tools run the runtime's `CodeSpecsExtractor` over one TomSpecs document
and the CodeSpecs area catalogue. `npm run som:pack` copies the catalogue from
`tom_specs_model`, tom_code_specs' `vocabulary.dart` (the hook catalogue of
validate's checks 40 and 41), and the derivation contract from
`tom_core_codespecs`, into `resources/codespecs/`, together with the two
workflow guides (`codespecs_prompt.md` from `tom_specs_model`,
`codespecs_mapping.md` from `tom_core_codespecs`); all of them ship in the VSIX. The checks over generated code
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

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_specCodeSpecsAreas` | The catalogue: areas, slices, authoring steps; one area (projects, citable areas, steps) or one slice in detail. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsRouting` | Gate A3, readable: every class node's verdict, with the unrouted ones and their fix; filter by verdict or path. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsExtract` | One area's extract as Markdown with each entry's provenance, or a per-area summary. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsGate` | The Stage-A gate in one report (runtime `CodeSpecsGate`): A1 schema completeness, A2 valid values, A3 routing, A4 required marker sources, A5 carriers the model still offers. Per check: passed, findings with the document path to fix (A5 findings are model-level), and the fix; plus `gateOpen`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsVerdicts` | The Stage-B gate record (`gate.verdicts.yaml` beside the extracts): each area's verdict, resolution and note, the active areas still missing, and whether record and extracts agree. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsSetVerdict` | Record one area's verdict (approval), validated by the runtime's record rules (`resolution: descoped` only on insufficient). The record's leading comments are kept, and an unchanged verdict rewrites it byte-identically. An insufficient verdict comes with what is owed next. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsQueryExtracts` | Entries of a written run (by this tool or the Dart CLI), filtered by area, token, path or text, each with its provenance and verbatim value. An extract in an unknown format is listed as unreadable, never misread. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsTrace` | Spec path, token, code location or declaration to the other end, by section-id token (the unit `@CodeSpec` / `@DocSpec` back-links cite), plus the heading `codeSpec=` forward links. With back-links it adds `agreement`, the uncited and dangling tokens (the shape of `validate_codespecs` checks 35 and 36). Without `validate_codespecs` on this platform, `codeDirs` gives no back-links: no `agreement`, `warnings` and `help` instead. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsValidate` | The 41 `codespecs_derivation_contract.md` §6 checks over a generated trio (shared, client, server; client and server default to the shared folder's siblings), through the bundled `validate_codespecs --json`. `outcome` keeps `clean`, `violations` (each with check number and title, defining section, file, line, token or area, message), `usageError` and `binaryMissing` (no binary for this platform; with `expected`, `help` and `page`) apart; `notRun` names each check whose corroborating input was not given. tom_code_specs' vocabulary — the hook catalogue checks 40 and 41 (protocol-feature hooks, reserved protocol paths) need — ships with the extension and is passed by default; `csVocabulary` overrides it. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsStepContext` | Everything authoring step `csgen<n>` (1–31) may read (§2.9): its title, slice, placement and areas; those areas' extracts, entry by entry; the §3 contract entries for the markers they emit, with text; §2's section list (or its text); the output project. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsStatus` | Where a document is in Phase 4, in one call: every stage in order — `gate` (Stage A), `extraction` (are the extracts current?), `verdicts` (Stage B), `todoTree` (Stage C, in `questId`, default the active quest), `authoring` (the tree's todos done, and the next), `validation` (with `shared`) — each `done`, `notStarted`, `outdated`, `incomplete`, `failing`, `blocked` or `notChecked`, with a summary, its tool and details; and `next`. Built from each stage tool's own dry run. Without `validate_codespecs` on this platform the validation stage is `notChecked` and the answer carries `warnings`, `help` and `page`; `next` is the same as without `shared`. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsGuide` | The workflow guides packaged with the extension — `prompt` (codespecs_prompt.md) and `mapping` (codespecs_mapping.md) — as an overview, an outline, or one numbered section with its subsections; and the stage runbooks (`runbook`, with `file` / `questId` / `step` / `shared` filled in). The MCP server serves the same as resources and prompts. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsPlanTodos` | Stage C: propose (`dryRun`) or create the todo tree from the gate record (approval). `csopen<n>` (decision-needed) per insufficient area not descoped, carrying its gate note; `csproj1`, the trio scaffolding (decision-needed without `appName`); `csgen1`–`csgen31`, one per authoring step, each naming its areas and verdicts, extracts, output project and the step-context call. Refused without a verdict for every active area, or, with `file`, when Stage A fails. Idempotent per item. | ✅ | ✅ | ⚪ | ✅ |
| `tomAi_specCodeSpecsWriteExtracts` | Write every area's `.extract.yaml` / `.extract.md` to `<document folder>/generated-doc/codespecs_extracts/` (approval). Unchanged files are left alone; `dryRun` reports the file statuses. | ✅ | ✅ | ⚪ | ✅ |

**Tracing.** The back-links come from the generated trio itself (`codeDirs`),
read by the bundled `validate_codespecs --backlinks`, or from a JSON index that
command wrote (format `codespecs-backlinks`/1), passed as `backlinks`. Tracing is
by token, as checks 35 and 36 are. Which declaration *should* carry a token is
the authoring step's judgement, and the tools do not decide it.

**Validation.** The binary is built by `npm run codespecs:build`
(`scripts/build-validate-codespecs.cjs`, which `install_extension.sh` /
`.ps1` run when they find a Dart SDK). It needs a Dart SDK at build time only.
A VSIX carries it for the platform it was built on; on another platform, or
from a build without Dart, it is missing unless one is configured
(`bridge.executables.validate_codespecs`, per platform; a configured file that
exists is used before the bundled one). Without it:

- `tomAi_specCodeSpecsValidate` answers `{ok: false, outcome: "binaryMissing",
  error, expected, help, page}`; the error names the platform, the
  configuration key, the build command and the page;
- `tomAi_specCodeSpecsTrace` with `codeDirs` traces from the extracts without
  back-links: no `agreement`, and `warnings: ["validate_codespecs missing on
  <platform>: no back-link agreement (checks 35, 36)"]` with `help` and `page`
  (an explicit `backlinks` index still works; tracing from `codeFile` or
  `declaration` answers `binaryMissing`, as it has nothing to start from);
- `tomAi_specCodeSpecsStatus` with `shared` reports the validation stage
  `notChecked`, with `warnings`, `help` and `page`.

`help` is `Run command tomAi.showDartBinariesHelp`, `page` the page that
command opens. The user sees `"CodeSpecs validation skipped: validate_codespecs is not available on <platform>."`
once per tool and window session when Trace
or Status skipped it. The runbook `codespecs-validate` says what a process step
does then: record "validation not run" and carry on; gate G4 is not passed
until validation has run on a host that has the binary. The build writes `validate_codespecs.build.json` beside the binary — a hash of the
tom_specs_clitool source it was built from (and of the siblings its
`pubspec_overrides.yaml` resolves by path); `npm run codespecs:check` and the
test CV-8 compare it with the source as it is now and name the rebuild when it
moved on.

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
`phase-prompt`, `step-prompt`, `substep-prompt`, `session` (the Agent SDK session the step runs in), and as the
`${process-context}` block every Anthropic profile's system prompt carries
(empty without a process). `tomAi_writeChatVariable` refuses those keys:
moving the quest goes through `tomAi_setProcessState`, which checks every name
against the definition. A move to a step or sub-step that names a role also sets
the `role` chat variable. The user sees and sets the same state in the @TOM
**PROCESS** view and edits the definitions in the process editor; the view's
Proceed button queues the prompt of the current position (built from the
Proceed template) and a process-move marker after it; when the queue reaches
the marker with that prompt and everything it queued done, the state moves on
(a `tomAi_setProcessState` call removes the marker) — after a gate, a phase's end or a
repeatable level to the decision after it, where the user decides (Repeat,
Go on, Gate passed / failed; a failed gate goes to the gate's `onFail` step) —
while its other buttons only move the state. `tomAi_getProcessState` reports a
decision in its context block, and an agent leaves it to the user. A prompt queued by Proceed — and every
prompt queued while it runs — carries its position, so its role and *Current
process* section stay those of that position. A step or sub-step marked
`userAction: true` is the user's (reviewing, answering questions): it has no
prompt, Proceed asks the user to confirm it is done instead of queuing
anything, and the *Current process* section tells the agent not to do its work
and not to move past it.

A phase or step (not a gate) may be `optional: true` and carry a `when:`
condition. `when: {var, equals | notEquals | in | set}` is decided by the
extension from the chat variables (and a subprocess's `input.<name>`): every
forward move passes a phase or step whose test fails and records it in the
state (`skipped`: phase, step, reason, by `condition` / `user` / `agent`).
`when: {judge: text}` — and a variable test whose variable is not set — is
the agent's: the *Current process* section states the condition at the
position it applies to, and when it does not hold the agent does none of the
work and calls `tomAi_setProcessState {leaveOut: "<why>"}` (alone). Inside a
Proceed run the marker stays and the run ends by leaving the phase or step
out; without one it is left out at once. Where nothing has a condition to
judge, `leaveOut` is refused. The user leaves an optional or conditional phase
or step out with **Leave out** in the PROCESS view. `tomAi_listProcesses`
shows `optional` and `when` in each outline.

A quest may hold several **runs**, each a process position of its own — another
change worked on in parallel, another process in the same window. A run is the
state file `process-state.<quest>.<run>.yaml` beside the quest's own, a stack of
levels like it, of any process; the quest's own file is the run `default`,
always there and never deleted. A window works on one run at a time (its
current run, kept per window and quest, the chat variable `run`): the process
chat variables, the `${process-context}` block, the PROCESS view and the
process tools without `run` follow it. A Proceed prompt and its process-move
marker carry their run, so the marker moves the run it was queued for whichever
run the window works on when the queue reaches it. A run other than `default` has its own
custom chat variables (`<workspace>.<host>.<run>.chatvariable.yaml`) and its
own sessions: a session the process names, and one an item of the run names,
is `<session>@<run>` there (`default`, `chat` and temporary sessions stay
shared), so two runs of one process never continue each other's conversation.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_listProcesses` | Every process with its outline (phases, steps with `kind` step / gate / post-gate, sub-steps, roles, repeat flags); invalid ones with their errors; the quest's current process. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getProcess` | One process in full: definition, Markdown description, file paths (default: the quest's process). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getProcessState` | The quest's state, the role its step names, and the `${process-context}` block; `level` reads another level of the process stack (0 the quest's own process, -1 the running level, the default) — a lower level's answer says it waits and carries its own context; `run` reads another run of the quest. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getProcessStack` | Every level of the quest's process stack, bottom to top: kind (process, subprocess, branch), process, position, the step it was started from, its follow-up and start, inputs, outputs, handed-back outputs, open suggestions. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listSubprocessCandidates` | The processes the running step lists (`subprocesses:`, `branches:` — closed lists): kind, name, summary, the step's description, where it starts, the inputs the step fills, whether suggested. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_suggestSubprocess` | Suggest listed processes with a reason and optionally a recommended follow-up — as the last thing of a step; starts nothing. Kept with the step; when the step's queue items are done (at once when nothing runs) the process branching editor opens and the step's move waits for the user (Start, or Dismiss — then the move is made). An unlisted process, a missing reason, an ambiguous kind are refused. No approval prompt. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_getSubprocessRuns` | What was started from a level (default the running one) — from its current step and iteration, or `all` steps: finished or aborted, when, the follow-up, where it was left, the outputs handed back. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_listProcessRuns` | The quest's runs, the last changed first: run, process, position, levels, when changed, which one this window works on. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_createProcessRun` | A new run (`run` a name, `process` the process it follows from its first position; selected unless `select: false`). | ✅ | ✅ | ✅ | ✅ |
| `tomAi_selectProcessRun` | Work on another run in this window: the view, the process variables, the system prompt's process context and the tools follow it. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_deleteProcessRuns` | Delete runs (their state files and chat-variable sets); `default` and an unknown run are refused, then nothing is deleted. The runs' sessions (`<session>@<run>`) go with `deleteSessions: true`, else they are kept and named in `sessionsKept`. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_setProcessState` | Move the quest: `process` (`""` clears), `phase`, `step`, `substep`, the three iterations (a gate can always be run again; a step that already ran in this phase iteration is entered at its next iteration) and `completed` (the process finished; any other change opens it again); in a subprocess or branch, `outputs` sets its process's declared outputs (merged; an outputs-only call moves nothing and keeps a running step's marker), and a subprocess finishes only once its required outputs are set; checked against the definition, no approval prompt (visible live in the PROCESS view); `leaveOut` (alone) leaves out the running phase or step whose `when:` the agent judges false; `run` moves another run of the quest. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_validateProcess` | Check a draft definition (`yaml` text or a `file`) before writing it: YAML, `process.schema.json`, the process editor's rules (a gate ends every phase, `onFail` inside its phase, no prompt on a user-action step, unique ids, profiles that exist, a `followUps:` entry's process, phase and step that exist) and the roles (existing under `_ai/roles/` or listed in `draftRoles`). Answers every finding with its source and path. Read-only. | ✅ | ✅ | ✅ | ✅ |
| `tomAi_writeProcess` | Create a process: writes `_ai/processes/<id>/<id>.process.yaml` and `<id>.md` (`description`) only when the draft passes tomAi_validateProcess's checks; an existing id is refused unless `replace: true`; opens the result in the process editor (`open: false` not to). Approval. | ✅ | ✅ | ⚪ | ✅ |

### 4.27 Tool help

Tool descriptions are short: purpose, arguments and the one trap, each at most 1,250 characters (test `TD-3`). The long form of a shortened description is in §10; this tool answers it on every transport.

| Tool | Purpose | Agent SDK | Anthropic API | Local LLM | VS Code LM |
| --- | --- | :-: | :-: | :-: | :-: |
| `tomAi_describeTool` | One tool in full: its description, every argument (type, required, description, enum) and its documentation here — its §10 section (`documentation`) and every other line naming it (`mentions`). Read-only; reads the `doc/llm_tools.md` bundled with the extension. | ✅ | ✅ | ✅ | ✅ |

## 5. Transport-specific recommendations

### 5.1 Anthropic Agent SDK (`transport: 'agentSdk'`)

- Default to **`profile.useBuiltInTools = true`** for full-development mode. The SDK supplies `Read`/`Write`/`Edit`/`MultiEdit`/`Glob`/`Grep`/`Bash`/`BashOutput`/`KillBash`/`WebFetch`/`WebSearch`/`NotebookEdit`/`TaskCreate`…`TaskList`/`Task`/`AskUserQuestion`/`ExitPlanMode`; our 🔁 tools are suppressed automatically.
- The built-ins go through the profile's **Tool Approval** like the `tomAi_*` tools: under *Always* the writers (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `KillShell`) ask, with the command or the file in the approval bar, and *Allow All (session)* covers one tool for the session; the readers (`Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `BashOutput`, the task-list tools, `Task`, …) never ask; a built-in neither list knows asks. Under *Accept edits* the file edits (`Edit`, `Write`, `MultiEdit`, `NotebookEdit` and the `tomAi_*` editors) go through unasked and the send runs in the SDK's `acceptEdits`; `Bash` and the other writers still ask (tests PM-7..9, AE-1..3). A configured `permissionMode` of `acceptEdits` or `auto` would let edits through without asking, so with the built-ins on and *Always* it runs as `default` (`src/utils/agentSdkPermissionMode.ts`; tests PM-5/6, BA-1..4). Queued prompts never ask.
- Plan mode: `tomAi_enterPlanMode` puts the send in the SDK's own `plan` permission mode and gates the writers (§4.19); the SDK's `ExitPlanMode` is then a proposal the user accepts, like `tomAi_exitPlanMode`.
- `tomAi_spawnSubagent` is redundant when `Task` is available; keep off.
- Keep all the ✅-rows on — they're VS Code specific and have no SDK equivalent (editor context, problems, symbols, code actions, git writes, tasks/debug, issues/tests, quest/session todos, chat variables, memory, pattern prompts, guidelines, user interaction).

### 5.0 Tools a request carries

The **core set** is always sent in full: `tomAi_readFile`, `tomAi_editFile`, `tomAi_multiEditFile`, `tomAi_createFile`, `tomAi_listDirectory`, `tomAi_findFiles`, `tomAi_findTextInFiles`, `tomAi_runCommand`, `tomAi_runCommandStream`, `tomAi_readCommandOutput`, `tomAi_gitRead`, `tomAi_gitWrite`, `tomAi_getQuestTodo`, `tomAi_updateQuestTodo`, `tomAi_createQuestTodo`, `tomAi_generateIdPrefix`, `tomAi_askUser`, `tomAi_readPastToolResult`, `tomAi_notifyUser`, `tomAi_describeTool`, `tomAi_loadSkill` (`DEFAULT_CORE_TOOLS`, `src/utils/toolSelection.ts`), plus the profile's **Core Tools (added)** (`coreTools`).

A prompt names more tools with a line in its text — in a user-message template, a process step's prompt or the typed prompt:

```text
<!-- tools: tomAi_specApplyEdits, TomSpecs (edit), tomAi_specCodeSpecs* -->
```

Entries are tool names, tool families (the groups of the profile editor's tool picker, any case) or a `prefix*`; only the profile's own tools are chosen, and entries that name none are listed in the payload dump. The line is removed from the text sent.

| Transport | What the request carries |
| --- | --- |
| Direct API | Every tool of the profile. The core set and the prompt's tools in full; the others with `defer_loading: true`, after the server-side BM25 tool search (`tool_search_tool_bm25_20251119`), which loads a deferred schema when the model looks for it. The cache breakpoint sits on the last tool sent in full. A profile with **Tool Search (direct)** off (`toolSearch: false`) sends everything in full. |
| Local LLM, VS Code LM | No tool search: with a directive, the core set plus the prompt's tools are the whole list; without one, the profile's list. |
| Agent SDK | Unchanged: it defers the tools itself. |

The raw trail's payload file marks each tool `deferred` or `named by the prompt`. Measured with every tool on (195): the model reads 26,334 characters of tool schemas instead of 227,719; the request body still carries the deferred schemas.

### 5.2 Anthropic API direct (`transport: 'direct'`)

- All ✅-rows are on by default; no preset exists. Outside the core set they are deferred and found by tool search (§5.0).
- Working hints for this transport go into the profile's system prompt with a file placeholder, after `${claudeMd}` (every CLAUDE.md as Claude Code loads it): `${file-CLAUDE-direct.md}` in this workspace (how to read, search, batch calls and recover cut results). Its direct todo profiles also set **Effort** `high` (`output_config.effort`); the raw trail's payload file shows both.
- `tomAi_runCommandStream`/`tomAi_readCommandOutput`/`tomAi_killCommand` are the only way to stream long-running commands on this transport — leave them on when test-running or building.

### 5.3 Local LLM (Ollama)

- Default to **read-only** tools only (`READ_ONLY_TOOLS`). Open-source models misbehave more frequently with tool-calling — every mutation tool is approval-gated anyway.
- Keep `tomAi_askBigBrother` and `tomAi_askCopilot` on: delegating hard questions out of Ollama to a stronger model or to the Copilot Chat panel is the whole point.
- LSP-heavy tools (`findSymbol`, `gotoDefinition`, `findReferences`, `getCodeActions`) work but consume a lot of tokens for small models — leave off by default.

### 5.4 VS Code LM (`transport: 'vscodeLm'`)

Structurally similar to Anthropic API direct — same "hand the model messages + tools, get a response" loop — but via `vscode.lm.*` so the model selection flows from a VS Code LM configuration rather than an Anthropic API key. Enable roughly the same tool set as Anthropic API direct.

- All user-interaction tools are on by default — a human is present, `askUser` / `askUserPicker` / `notifyUser` make sense.
- LSP + editor-context + files + git + tasks + memory + chat vars — all ✅ by default.
- Copilot Chat orchestration tools (§4.20) are ⚪ — useful if the user wants to stage prompts into Copilot Chat from a VS Code LM profile, off otherwise.
- `tomAi_askBigBrother` is ❌ — the profile *is* on the VS Code LM surface, so delegating out is circular.
- `tomAi_askCopilot` is ⚪ — the user can reasonably bounce a specific question to the Copilot Chat panel.

## 6. Stubs pending host integration

None: `tomAi_spawnSubagent` is wired at activation (`registerSubagentSpawner(spawnAnthropicSubagent)`, `extension.ts`); on the Agent SDK the SDK's `Task` tool is the native equivalent.

## 7. Deferred / future

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
| `output-channel-tools.ts` | `readOutputChannel`: this window's output channels, read from disk |
| `quest-process-tools.ts` | Processes: list and read definitions, read and move the quest's process state |
| `describe-tool.ts` | `describeTool`: a tool's full description, arguments and section of this document |
| `issue-tools.ts` | Issues subpanel (read + write) |
| `test-tools.ts` | Tests subpanel / testkit (read + write) |
| `codespecs-tools.ts`, `codespecs-gate-tools.ts`, `codespecs-trace-tools.ts` | CodeSpecs: area catalogue, routing, extract, write extracts; the Stage-A gate and the Stage-B gate record; query and trace |
| `docspecs-tools.ts` | Plain DocSpecs Markdown: validate, outline, get and replace a section |
| `spec-tools.ts`, `spec-search-tools.ts`, `spec-edit-tools.ts`, `spec-validate-tools.ts` | TomSpecs (SOM) documents: read and reflect, search with a cursor, edits and the batch, validate / render / convert (`spec-tool-common.ts` holds what they share) |
| `chat-enhancement-tools.ts` | Notify, quest/session todos, queue, timed, templates, reminders |
| `skill-tools.ts` | `tomAi_loadSkill`: a `.claude/skills` SKILL.md and its files (`services/skills.ts`) |
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
10. For a tool that can show the model more than text, an `executeRich(input)` beside `execute`: content blocks (text, image, document) plus a stand-in `text` for the trails and logs, or `undefined` to let `execute` answer. Only the direct transport calls it (`AnthropicHandler.runTool`); the tool-trail retention leaves a fresh media result whole and stubs it once it is past `toolTrailKeepRounds`. `tomAi_readFile` uses it for images and PDFs (`readFileMediaImpl`, the bytes decide the type).

Steps 4 and 5 are enforced by `src/tools/__tests__/tool-registry-parity.test.ts`.
It asserts that `ALL_SHARED_TOOLS` equals `AVAILABLE_LLM_TOOLS` plus
`DELIBERATELY_UNSELECTABLE_TOOLS` exactly, that nothing is selectable without
being registered, and that every selectable tool carries a `CATEGORY_MAP` entry.
Forgetting step 4 or 5 now fails the suite instead of silently producing a tool
that works under `toolsEnabled: true` and is invisible everywhere else.

### Deliberately unselectable tools

None: every registered tool is selectable, and
`DELIBERATELY_UNSELECTABLE_TOOLS` (`src/utils/constants.ts`) is empty. The
mechanism stays, so a tool can be held behind `toolsEnabled: true` on purpose —
with its reason beside the entry, and only a write tool: a `readOnly` tool in
the list fails the suite.

The queue and timer **control plane** has its own picker category,
**Queue & Timers (control)**: the twelve queue mutators and dispatch entry
points (`tomAi_addQueueItem`, `tomAi_updateQueueItem`,
`tomAi_removeQueueItem`, `tomAi_setQueueItemStatus`, the three follow-up and
three pre-prompt tools, `tomAi_sendQueuedPrompt`, `tomAi_resendQueueItem`)
plus `tomAi_addTimedRequest`, `tomAi_updateTimedRequest`,
`tomAi_removeTimedRequest` and `tomAi_setTimerEngineState`. A profile that
holds them can enqueue and dispatch its own prompts and switch the timer engine
— what a planning process step needs to queue its todo walks
(`_ai/processes/tom_specs/tom_specs.md` § Orchestration). The read side
(`tomAi_listQueue`, `tomAi_listTimedRequests`, the session tools) is
**Queue & Timers (read)**.

## 9. Scripting-API access and gating

The four transports in §1 are not the only way to reach the registry above. A
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

## 10. Tool details (the long forms)

A tool's description says what the model needs to call it: its purpose, its arguments and its one trap; a test caps its length (`TD-3`). The rest is here, one section per tool, and `tomAi_describeTool` answers a tool's section with its full description and arguments. Each section gives the tool's complete behaviour; where an argument's description is shorter in the schema, its full text follows.

### `tomAi_addQueueFollowUp`

Append a follow-up to an existing queue item. **Follow-ups run AFTER the main prompt**, in insertion order — the manager sends follow-up #1, waits for its answer, sends #2, etc., until done. All follow-ups are auto-wrapped with the Answer Wrapper. `repeatCount`/`answerWaitMinutes` are accepted here (they're applied to the new follow-up via an internal update call, since the manager's create form doesn't take them). Pass `queueItemId` (preferred) or `requestId` to target the item. Transport override available per follow-up. The answer carries `warning` when a stage of the item runs on an Anthropic profile whose configuration uses the direct API and whose key variable is not in this VS Code's environment: every send of that stage would fail. The item is kept; pick another profile (an Agent SDK one) or have the key set and VS Code restarted.

**Arguments:**

- `repeatCount`: Literal number, chat-variable name, or `<prefix>*`: walk the quest's todos whose id starts with `<prefix>`, lowest number first (the number is the first digit run after the prefix; a group named with a leading number is walked the same way, `001_cleanup*` → `001_cleanup1`, `001_cleanup2`). The prefix may hold digits (`p2s2ss3-*`) but must not end in one (refused with code invalidTodoPrefix). The text names the todo each dispatch picked with `${repeatTodoId}` (its id), `${repeatTodoTitle}` and `${repeatNumber}`, filled in when it is sent; the picked todo is set in-progress, and a todo the work creates with the next free number joins the walk. An item whose main prompt walks over nothing (no todo of the prefix, or none not-started, blocked or decision-needed) and that has no pre-prompt (which could create the todos) is held in `error` at once, its reason in `warning`; it is staged again when an edit or a pre-prompt gives it work, or when its status is set once the todos are there.

### `tomAi_addQueueItem`

Stage a new prompt-queue item with optional pre-prompts, main-prompt config, and follow-ups all in one call. **Default `deferSend: true`** — the item is created in the `staged` state, NOT sent immediately. Call `tomAi_sendQueuedPrompt` afterwards to start the lifecycle (manager auto-chains through pre-prompts → main → follow-ups, waiting on each answer). `repeatCount`/`templateRepeatCount` accept a literal number or a chat-variable name (resolved at send time, decremented per iteration). `transport` defaults to `copilot`; pass `anthropic` for unattended Anthropic dispatch (requires `anthropicProfileId`; falls back to the default profile when omitted). The canonical add → addFollowUp → sendQueuedPrompt workflow is documented in detail on the Prompt Queue spec — this tool is step 1. `todoIdPattern` names the todos the item runs — a todo id, `<prefix>*`, or several, comma-separated; a `<prefix>*` `repeatCount` gives it when omitted — and the todo panel marks those todos as queued (with the item's number) until the item has finished; `tomAi_listQueue` shows it per item. The answer carries `warning` when a stage of the item runs on an Anthropic profile whose configuration uses the direct API and whose key variable is not in this VS Code's environment: every send of that stage would fail. The item is kept; pick another profile (an Agent SDK one) or have the key set and VS Code restarted.

**Arguments:**

- `repeatCount`: Literal number, chat-variable name, or `<prefix>*`: walk the quest's todos whose id starts with `<prefix>`, lowest number first (the number is the first digit run after the prefix; a group named with a leading number is walked the same way, `001_cleanup*` → `001_cleanup1`, `001_cleanup2`). The prefix may hold digits (`p2s2ss3-*`) but must not end in one (refused with code invalidTodoPrefix). The text names the todo each dispatch picked with `${repeatTodoId}` (its id), `${repeatTodoTitle}` and `${repeatNumber}`, filled in when it is sent; the picked todo is set in-progress, and a todo the work creates with the next free number joins the walk. An item whose main prompt walks over nothing (no todo of the prefix, or none not-started, blocked or decision-needed) and that has no pre-prompt (which could create the todos) is held in `error` at once, its reason in `warning`; it is staged again when an edit or a pre-prompt gives it work, or when its status is set once the todos are there.
- `session`: The named session the item runs in: a `<name>.session.json` of the quest's history folder (tomAi_listSessions). A name, or a spec `{name, basedOn?, mode?, profile?}`: a session that does not exist when the item is dispatched is created before its first send — from the spec (fresh, or based on `basedOn`, a missing base being created plainly; `mode` continue / per-prompt / per-iteration; `profile` the Anthropic profile, else the item's own anthropicProfileId), or for a bare name as a fresh `continue` session. Unset: the queue default, else the queue's own `default`. On the Agent SDK transport it is the SDK conversation; on the direct API transport the session's own history (`chat` and `default` share the quest's). A prompt runs with the stage's or item's profile, else the session's, else the queue default. Refused when queued (code invalidSession): a malformed spec, an unknown profile, or a profile that keeps its conversation elsewhere than the session's existing one (an Agent SDK session continued with our own history, or the reverse).
- `doneNotificationPrompt`: A prompt queued right after the item, ahead of every other pending item, when the item is finished: all its pre-prompts, repetitions (or `<prefix>*` todos), follow-ups and template iterations done, or ended in an error that will not recover (no API key, a request the API refused, an exhausted retry schedule; not a quota or rate limit being waited out). It runs with the item's transport, profile and session, takes over its "pause after this", and is queued once per run. `${itemOutcome}` in it reads `done` or `error: <message>`.
- `run`: The process run of the quest the item belongs to (tomAi_listProcessRuns; an unknown one is refused). Default: the run of the Proceed prompt it is queued from, else the window's run. Its sessions are the run's (`<session>@<run>`); tomAi_listQueue shows each item's `run`.

### `tomAi_addQueuePrePrompt`

Append a pre-prompt to an existing staged/pending queue item. **Pre-prompts run BEFORE the main prompt**, in insertion order, each waiting for its own answer (or `answerWaitMinutes`) before the next fires. Use `tomAi_updateQueuePrePrompt` to add `repeatCount`/`answerWaitMinutes`/reminder settings after creation. Transport defaults to the item's transport; override per pre-prompt with the `transport` field. The answer carries `warning` when a stage of the item runs on an Anthropic profile whose configuration uses the direct API and whose key variable is not in this VS Code's environment: every send of that stage would fail. The item is kept; pick another profile (an Agent SDK one) or have the key set and VS Code restarted.

### `tomAi_askBigBrother`

Query a VS Code language model (GitHub Copilot, Claude, GPT-4, …) from the local-LLM tool loop. **Two operations**: `"list"` returns the model catalogue + recommendations; `"query"` runs a bounded tool-use loop against the chosen model. **Model selection** is a fallback chain: exact id → family → case-insensitive substring on name OR id; the first hit wins. **Tool loop**: when `enableTools: true`, the model may call up to `maxIterations` rounds of tools before returning its final answer (default from config); when `enableTools: false`, exactly one round runs. **Timeout**: configured via `responseTimeoutMs`; on expiry the response is `{ok: false, error: "Response timed out.", cancelled: true, reason: "timeout", iterationsUsed, toolCallsMade}` so the caller can tell how far the conversation got. **Response chunking**: responses longer than the summarisation threshold are passed through a second model (when `summarisationEnabled`); the envelope reports `summarised: true` when this fired. Network-bound — typical latency is several seconds, well above the local-tool budget.

### `tomAi_askCopilot`

Send a prompt to GitHub Copilot Chat and (by default) block until Copilot writes an answer file. **How it works**: (1) render the prompt through the configured template chain — an optional user template wraps `${originalPrompt}`, then the required `__answer_file__` wrapper instructs Copilot to dump its final answer to a JSON file; (2) clear any stale answer file; (3) open Copilot Chat via the VS Code command; (4) poll the answer-file path at `pollInterval` until it appears or `timeoutMs` elapses. **Response formats**: when the answer file is JSON with a `response` string, the envelope returns `{format: "json", response, requestId, elapsedMs}` and any sibling `responseValues` object is forwarded to the chat-variable store. Plain-text answers come back as `{format: "text", response}`. **Timeout** returns `{ok: false, timedOut: true, timeoutMs, answerFile}` — Copilot may still finish processing in the chat window after the tool gives up. **Set `waitForAnswer: false`** for fire-and-forget (response returns immediately with the answer-file path). Network-bound — expect multi-second latency.

### `tomAi_askUser`

THE way to ask the user something and actually receive an answer. Whenever you need a decision, clarification, missing information, or approval from the user, call this tool — do NOT just write the question in your text reply, because that reply is not surfaced to the user as a prompt and nothing will answer it (the run will stall or you will be forced to guess). Syntax: call `tomAi_askUser` with `questions` (an array of 1–15 strings), an optional `title`, and an optional `timeoutMinutes`. Example: `{ "questions": ["Which database should I target?", "Is a destructive migration acceptable?"], "title": "Migration plan" }`. It pauses the prompt queue and **waits**: **BLOCKING** — the call does not return until the user answers (from the VS Code question panel OR from Telegram). This works the same for a prompt running in the prompt queue. By default it waits **indefinitely** — there is no deadline unless you set `timeoutMinutes`, so only set it when you genuinely have a sensible default to fall back on and would rather proceed than stall. The questions are numbered (1..n) for display; the user types a single free-form reply and that reply is returned to you **verbatim** as the tool result — structure your questions so a numbered, free-form answer makes sense. If a timeout does fire, the result is the configured fallback prompt instead (default: ask the model to follow its own recommendations). Only **one** ask may be in flight at a time (the queue is blocked on it). Every exchange is logged to the quest questions journal.

**Choices.** `choices` adds buttons to the questions, each `{id, label, kind, target?, question?}`. A choice is placed where a `{{choice:<id>}}` marker stands in a question's text, else in a row under question `question` (1-based; default the last). Kinds: `answer` — the click **selects** it for its question (shown selected; a second click clears it, another answer choice of the question replaces it), and each question with answer choices gets a field for the user's own words; nothing is sent until **Send answers**, which answers once with every question: `The answers, numbered like the questions:` then `1. chose "<label>" (id <id>[, answer: <target>])[ and wrote: <words>]`, `2. <words>` or `3. (no answer)`, and after a blank line what the user typed in the general box (`composeChoiceAnswers`; `readSingleAnswer` reads a one-question reply back); `move` — moves the quest's current process to `target`, written `step` (the current phase first, else the one phase that has it), `phase/step` or `phase/step/substep`: the extension makes the move on the click, as the PROCESS view does, and the answer says where the process is now (do not move it yourself); `branch` / `subprocess` — an entry of the current step's `branches:` / `subprocesses:` list: on the click the extension starts it as the PROCESS view does (the user picks what the step does when it ends; the list is checked again — an entry gone since the ask is refused —, the depth confirmation, the inputs the entry fills), and the answer says what started, with its inputs and follow-up, or why nothing started. Everything is checked when the ask is made: an unknown id in a marker, a position outside the current process (or no process set), a branch or subprocess the step does not list — the call answers `askUser error: …` and asks nothing. A `move` / `branch` / `subprocess` click answers at once: `The user clicked the choice "<label>" (id <id>, <kind>). …`. Without answer choices the panel answers with its text box as before. Telegram shows the choices' labels. The Agent SDK's built-in `AskUserQuestion` takes the same `choices` beside its `questions`; with them (and interactive questions on) it goes to this question panel instead of the QuickPicks. Rules: `src/utils/askChoices.ts`.

### `tomAi_askUserPicker`

Show a VS Code QuickPick and let the user choose one or more items. An "Other…" entry is appended to your list automatically — do NOT add one yourself. Taking it opens a free-text box, so the user can always answer in their own words; the entry never filters away, and typing an answer that matches no item and pressing Enter submits it directly. Consequence: `selected.value` may be text that is not among the `items` you offered (for a free-text answer `label` and `value` are both the typed text). Never assume the answer is one of your options. **BLOCKING** — awaits the user, and by default waits **indefinitely**; this works the same for a prompt running in the prompt queue. Set the optional `timeoutMinutes` to give up after a while and continue on your own — only do that when you have a sensible default to fall back on. `ignoreFocusOut: true` is set (clicking outside does NOT cancel). Items may be plain strings (label = value) or objects `{label, description?, detail?, value?}` (when `value` is omitted it falls back to `label`). Response: `{ok, dismissed, timedOut, multiSelect, selected}`. Shape of `selected`: (1) `canPickMany: false` (default) and user picked → `selected: {label, value}`; (2) `canPickMany: true` and user pressed OK → `selected: [{label, value}, ...]` (array — possibly empty, which is distinct from dismissal); (3) cancelled (Escape) → `selected: null` with `dismissed: true`; (4) deadline elapsed → `selected: null` with `timedOut: true`. Treat (3) and (4) differently: dismissed means the user saw the question and declined, timed out means nobody was there. `matchOnDescription` controls whether the typed filter matches against the description column too (default true). Every exchange is logged to the quest questions journal.

### `tomAi_askInMdBrowser`

Ask the user through a document. Write the Markdown file first (a questionnaire, a set of choices, a confirmation, review results), then call `tomAi_askInMdBrowser` with `filePath` (a `.md` file inside the workspace), `buttons` (1–8 `{id, label}`, e.g. `[{"id": "continue", "label": "Continue"}, {"id": "cancel", "label": "Cancel"}]`), and optionally `title` (a line beside the buttons), `keepFile` (the initial state of the *Keep this file* checkbox, default `true`) and `timeoutMinutes`. The file opens in the MD Browser — a static panel already showing it is reused — with the buttons and the checkbox in a bar above the action bar; the first button is the primary one. **BLOCKING** like `tomAi_askUser`: the call returns when a button is clicked, so a prompt in the queue holds there; by default it waits **indefinitely** (`timeoutMinutes`, capped by the user's *maximum wait*, sets a deadline). Only **one** such ask is open at a time; a second call meanwhile is refused with an error. The answer is `{button, label, keepFile, fileDeleted, file, panelId}`: `button` is the id clicked; it is `null` with `timedOut: true`, `closed: true` (the user closed the panel) or `cancelled: true`. When the checkbox is unchecked as the flow goes on — a click, the timeout, the panel closed — the file is deleted and its panel closed (`fileDeleted: true`); otherwise the panel stays open with the answer in place of the bar. What the user wrote into the document meanwhile (answers in the MD Browser) is in the file: read it after the answer. **Finish review round:** `finishReviewRound: true` adds the button `finish` (*Finish review round*; `buttons` may then be left out). It is offered only while the quest's process is at a review — a user-action step — or while the step running now (whose closing item is asking) leads to one; otherwise the call is refused, and the document is to be opened with `tomAi_openInMdBrowser` instead. The click is the extension's: it closes that panel only (other panels stay), completes the running step if the review has not started yet, confirms the review as Proceed does, then queues the next step's prompt — or opens the decision dialog when the next position is a decision (nothing queued), or queues nothing when the next step is the user's again. The answer carries `review` (`{ok, confirmed, next: queued | decision | userAction | finished, where, decided?}`) and a one-line `summary`; the agent reports it and moves nothing itself. A process step's prompt uses it through `${finish-review-round}`, the *Finish review round* Assist prompt (Status Page). Logic: `src/services/finishReviewRound.ts`. **Back to the decision:** `reopenDecision: true` adds one button per option of the decision the process is at — ids `decide-1`, `decide-2`, …, labelled as in the Decide… dialog (*Go on to …*, *Repeat …*, *Gate passed …*) — then the button `decide` (*Back to the decision*), only while the process is at a decision; the agent's own buttons may not use these ids. An option's click takes that choice as the dialog would (the answer names it in `decisionTaken`; the agent moves nothing); the click on `decide` opens the Decide… dialog again (`decisionReopened: true`). Either way the panel stays open with the answer in place of the bar. The decision helpers (Grill me / Explain a decision in the Decide… dialog, `src/services/decisionHelpers.ts`) show their advice note this way. Every exchange is logged to the quest questions journal. Implementation: `src/tools/ask-in-md-browser-tool.ts` (the slot and the answer), the panel side in `src/handlers/markdownBrowser-handler.ts` (`mdBrowserAskDeps`), the bar in `media/markdownBrowser/askBar.js`.

### `tomAi_createQuestTodo`

Create a new persistent quest todo in a YAML file. **There are NO auto-id rules** — the model picks `todo.id` (convention: lowercase, hyphen-separated, stable, e.g. `add-auth-flow`). An id the todo schema's id pattern (`_ai/schemas/yaml/todo.schema.json`) refuses is refused with `ok: false` naming the rule; every other path that creates or renames an id (the todo panel's rename, Rename group and move with renumbering, tomAi_renameQuestTodo, tomAi_renameTodoPrefix) checks the same pattern, read from the schema. Collisions are rejected with a pointer to `tomAi_updateQuestTodo`. **A reused id STEM is WARNED about, not rejected**: creating `scc5_aict-x` while `scc5_agnd-y` exists in the same quest succeeds and returns a `warning` field naming the others, because a `scc5*` iteration then dispatches both. Read it — it usually means a batch restarted its numbering and should be renumbered before work is dispatched by prefix. Ids with no `<stem><number>_<datecode>` shape are not checked. `file` defaults to the persistent `todos.<questId>.todo.yaml`; pass a different `*.todo.yaml` filename to target a per-topic file. **Status enum**: `not-started` (default) / `in-progress` / `blocked` / `decision-needed` / `completed` / `cancelled`. **Priority enum**: `low` / `medium` / `high` / `critical`. **Before creating a todo, work out what the user still has to decide**: list each open question in `decisions` (`summary` + `decision_needed`, leaving `decision` empty) and set `status: "decision-needed"` instead of `not-started`, so nobody starts the todo on a guess. Optional fields (`scope`, `references`, `dependencies`, `blocked_by`, `notes`) are persisted verbatim. Each `references` entry is an OBJECT, the shape the schema defines: `{path}` for a workspace file, `{url}` for a link or `{description}` for a note, optionally with `type` and `lines`. A bare string is rejected with `ok: false` (send `{"path": "…"}` instead). YAML formatting in existing files is preserved across the create. **`ok: true` is verified, not assumed**: the file is re-read after the write, the id confirmed present AND every field you sent confirmed readable back, so a write lost to another writer of the same file — or a field this code path does not persist — comes back as `ok: false` naming what differs, instead of a success response for data that is on no disk anywhere. You do not need to grep the YAML afterwards to check it landed. **Dates are dates:** `completed_date` (and every other date field of the schema) is written as YYYY-MM-DD; a timestamp is accepted and written as the date it names, anything else is refused with nothing written. `created` / `updated` are stamped by the writer (local date). The Worktracker orchestration fields `execution_role`, `qa_role`, `orchestration_role`, `bundle_id`, `derived_from`, `feedback_source` (optional strings) are written, read back and kept by updates that do not name them. `user_action: true` marks a todo that is the user's to do: a `<prefix>*` queue walk passes it and goes on with the next todo. `blocked_until` lists publish conditions (`<package> >= <x.y.z>`) that keep a blocked todo blocked until pub.dev has the release; an entry in another form is refused with nothing written.

**Arguments:**

- `todo.decisions`: Decisions the user has to make before this todo can be started. Pair with `status: "decision-needed"` while any `decision` is still empty.
- `todo.decisions[].decision_needed`: The full question, its context and the options.
- `todo.decisions[].decision`: What the user decided. Leave out until they've answered.
- `todo.references[].type`: Reference type, e.g. file, url, doc.
- `todo.references[].path`: Workspace-relative file path.
- `todo.references[].url`: External URL.
- `todo.references[].description`: What the reference contains.
- `todo.references[].lines`: Line range or location hint, e.g. '45-60'.
- `todo.completed_date`: A date, YYYY-MM-DD. A timestamp is accepted and written as the date it names (2026-10-20T12:37:25+0200 → 2026-10-20); anything else is refused.
- `todo.execution_role`: The role that carries the todo out when execution is agent-driven (Worktracker).
- `todo.qa_role`: The role that checks the todo's result (Worktracker).
- `todo.orchestration_role`: The role that orchestrates the execution bundle the todo belongs to (Worktracker).
- `todo.bundle_id`: The execution bundle the todo is grouped into (Worktracker).
- `todo.derived_from`: The todo this one was derived from (Worktracker).
- `todo.feedback_source`: The feedback that raised this todo (Worktracker).
- `todo.user_action`: true: the todo is the user's to do (a review, an answer, a look at a screen). A `<prefix>*` queue walk passes it instead of sending it to an agent, and the todo panel marks it 👤. false removes the mark.
- `todo.blocked_until`: Publish conditions that block the todo, each `<package> >= <x.y.z>` (or `>`): met when pub.dev's latest release satisfies it. Keep the prose in `notes`. [] removes the field.

### `tomAi_docspecsGetSection`

One section of a DocSpecs Markdown document by its id: title, level, heading line, its own body (the lines up to its first subsection) and its subsections. An unknown or repeated id is refused with the ids there are. The runtime reads the current DocSpecs form: `<!-- docspec: <id>/<version> -->` on the first line and `<!--[ID]-->` heading ids. A document in the legacy form (`# [id] Title`, `<!-- schema=… -->`) or with its declaration below the title is answered with a `migrationHint` naming `_bin/migrate_docspecs.py doc <file> --assign-ids --write`. For SOM specs (`*.docspecs.yaml`, SOM Markdown) prefer the tomAi_spec* tools.

### `tomAi_docspecsOutline`

The section tree of a DocSpecs Markdown document, in document order: id, title, level, line range of the whole subtree, own text length, children. With a schema: the section types it requires and the required sections missing (as the validator reports them). Section ids are what tomAi_docspecsGetSection and tomAi_docspecsReplaceSection take. The runtime reads the current DocSpecs form: `<!-- docspec: <id>/<version> -->` on the first line and `<!--[ID]-->` heading ids. A document in the legacy form (`# [id] Title`, `<!-- schema=… -->`) or with its declaration below the title is answered with a `migrationHint` naming `_bin/migrate_docspecs.py doc <file> --assign-ids --write`. For SOM specs (`*.docspecs.yaml`, SOM Markdown) prefer the tomAi_spec* tools.

### `tomAi_docspecsReplaceSection`

Replace the body of one section of a DocSpecs Markdown document: the lines between its heading and its first subsection. The heading and every other byte stay as they are; a `#` line inside a fenced block is never taken for a heading. Refused (nothing written): an unknown or repeated id, and a body that would change the structure (a heading outside a fence, an unclosed fence). Written like every edit: refused when the file is dirty in an editor or has changed since `expectedRevision`; through the editor when open. Answers `{written, revision, validation: {introduced, resolved, total}}` against the schema; `dryRun` adds the diff and writes nothing. The runtime reads the current DocSpecs form: `<!-- docspec: <id>/<version> -->` on the first line and `<!--[ID]-->` heading ids. A document in the legacy form (`# [id] Title`, `<!-- schema=… -->`) or with its declaration below the title is answered with a `migrationHint` naming `_bin/migrate_docspecs.py doc <file> --assign-ids --write`. For SOM specs (`*.docspecs.yaml`, SOM Markdown) prefer the tomAi_spec* tools.

### `tomAi_docspecsValidate`

Check a DocSpecs Markdown document against its schema. The schema is the one its `<!-- docspec: <id>/<version> -->` header declares, looked up in `.tom/docspecs-schema/<id>/<id>.<version>.docspecs-schema.yaml` (or a suffixed folder `<id>.<suffix>/`) in the document's folder or the nearest one above it (up to the workspace root), else among the schemas generated from the SOM model. A declared schema found nowhere is a finding (`unknownSchema`), a declaration below the title too (`headerNotFirst`: no runtime reads it there), and a missing header (`noSchemaDeclared`); `docspec: none` means no schema. Answers `{passed, findings: [{rule, line, sectionId, message}], schema: {ref, source, file, ignoredByRuntime}}`; `ignoredByRuntime` lists schema keys the runtime does not support, whose constraints are therefore not checked. The runtime reads the current DocSpecs form: `<!-- docspec: <id>/<version> -->` on the first line and `<!--[ID]-->` heading ids. A document in the legacy form (`# [id] Title`, `<!-- schema=… -->`) or with its declaration below the title is answered with a `migrationHint` naming `_bin/migrate_docspecs.py doc <file> --assign-ids --write`. For SOM specs (`*.docspecs.yaml`, SOM Markdown) prefer the tomAi_spec* tools.

### `tomAi_getQuestWindowStatus`

The VS Code windows running on THIS machine and what is active in each, the sessions of each quest, and the Anthropic profiles — what to look up before tomAi_sendItemToQuest. `windows`: per window its workspace, quest, `alive` (a heartbeat within 90 s) and the heartbeat's age, pid, CLI and MCP server (running, port), the subsystems with a prompt out, the role, the process position, the ANTHROPIC/LLM panel's profile and session, the queue (auto-send, paused, counts per status, default transport / profile / session, the item being sent with its stage, profile and session), `build` (the extension build the window runs and the one installed, each `{commit, dirty, builtAt}`; `reloadNeeded: true` when a newer build is installed and the window still runs the older one), `dartBinaries` (the window's platform, `tom_bs` and `validate_codespecs` each `configured` / `bundled` / `missing`, and the `missing` list) and `isThisWindow`; windows without a live heartbeat are left out unless `includeGone`. `quests`: per quest with a live window, and the `quest` asked for even when none runs, its sessions (base, lifetime, profile, last model, whether it has a conversation, temporary `tmp-*` ones flagged, the implicit `default` and `chat`) with the profile an item without its own runs with in each (session, else queue default), and the queue's default session. `profiles`: the profiles a sent item may name (`isDefault`, `noApiKey`). Every profile is `{id, name, model, transport}`; an id the config no longer holds is `unknownProfile: true`. `quest` narrows the answer to that quest; an unknown quest is refused. Reads only.

### `tomAi_listPromptPairs`

List past prompt+answer pairs for a quest, with metadata (requestId, ISO timestamp, sequence, subsystem, prompt/answer character counts, previews). Newest first.

Reads the summary trail pairs: each Anthropic session's own `_ai/quests/<quest>/history/sessions/<session>/<quest>.anthropic.{prompts,answers}.md` (listed as subsystem `anthropic:<session>`; the filter `anthropic` matches them all) and the other subsystems' `_ai/quests/<quest>/history/<quest>.<subsystem>.{prompts,answers}.md` — the same source a history rebuild reads. Pairs are matched by `requestId`.

**Inputs (all optional):**

- questId      — defaults to the current quest
- subsystem    — e.g. "anthropic", "copilot", "`localllm-<configName>`", or a prefix like "localllm" or "localllm-*". Omit to scan every subsystem the quest has files for.
- limit        — page size (default 50, max 500)
- offset       — page offset (default 0; newest=0)
- previewChars — preview length per body (default 120; set 0 to disable)
- sessions     — the Anthropic sessions whose pairs to include: a name, a list, or "all"; default the session this call runs in (every session when it runs in none). Other subsystems are always included. An unknown session is refused (code unknownSession) with the sessions there are.

Use the returned `requestId` (or the merged-list `index`) with `tomAi_getPromptPair` to fetch full bodies.

### `tomAi_readChatVariable`

Read chat variables. **Built-in keys**: `quest` (active quest id), `role` (active role name), `activeProjects` (string[]), `todo` (selected todo id), `todoFile` (selected file name or `"all"`). **Process keys** (the active quest's process, kept per quest in the quest folder): `process`, `phase`, `step`, `substep`, `phase-iteration`, `step-iteration`, `substep-iteration` and the descriptions `process-description`, `phase-description`, `step-description`, `substep-description`, the prompts `phase-prompt`, `step-prompt`, `substep-prompt`, and `session` (the Agent SDK session the step runs in) — all `""` when no process is set; change them with `tomAi_setProcessState`. **Custom keys** are stored under the `custom.*` namespace; you can address them as `custom.myKey` or just `myKey` — both forms resolve to the same value. Omit `key` to return the full snapshot (`{quest, role, activeProjects, todo, todoFile, process: {...}, custom}`); pass `key` to get `{key, value, exists, isBuiltIn}` for one variable — `exists: false` distinguishes an unknown custom key from one with an empty value. **Persistence**: per workspace (one window per workspace), written to `_ai/chat_variables/<workspace>.<host>.chatvariable.yaml`; kept across a window reload, an extension install and a restart — a custom variable stays until it is written again or deleted. **Runs**: custom variables are a process run's parameters, so every run of the quest has its own set — the `default` run's in that file, another run's in `<workspace>.<host>.<run>.chatvariable.yaml` (deleted with the run). Reads and writes go to the active run: a queued Proceed's run while it is sent, else the window's run (the PROCESS view's run list); `run` names another (an unknown one is refused). The built-in keys are one per window.

### `tomAi_readOutputChannel`

Read this VS Code window's output channels (the Output panel), from the files VS Code writes them to — the extension's own (Tom Prompt Queue: sends, retries, errors; Tom AI Anthropic Chat: turns; Tom AI Compaction and Memory Extraction: `history scope:` lines; Tom Extension Debug Log; Tom Tool Log; …) and every other extension's. **Without `channel`**: the channels of the run with their size and last write, and the runs there are. **With `channel`** (its name, any case; else the one name containing it; or its file name such as `12-Tom Prompt Queue.log` when two channels share a name; a `:` in a name may be given or left out, as VS Code leaves it out of the file: `Tom AI: MCP Server` and `Tom AI MCP Server` find the same channel): its lines as `<line>: <text>`, the last `maxLines` (default 200, max 2000) of them; `grep` keeps lines containing the text (any case) or, with `regex: true`, matching the JavaScript regular expression (case-insensitive); `context` adds up to 20 lines around each match, `--` separating groups. `run` picks the extension-host run: 0 (default) is this one, 1 the run before the last window reload, and so on — what an earlier session logged. Channels do not share a timestamp format (ISO, `[HH:MM:SS]`, none), so filter by text, not by time. `truncated: true` when more lines matched than were returned (the earliest left out); `readFromEnd: true` when the file was over 32 MB and only its end was read (line numbers then count from there). Read-only.

### `tomAi_readPastToolResult`

Return the full result body for a past tool call by its replay key. **Key format**: `t<n>` (e.g. `t14`). **Bare numerics are normalised**: passing `key: "14"` resolves the same as `key: "t14"` — the response echoes both `rawKey` (input) and `key` (normalised). **Lookup order**: (1) in-memory ring buffer (fast, session-scoped, ~40 most recent); (2) disk store at `${ai}/trail/<subsystem>/<quest>/tool_results/<key>.json` (tried for `anthropic` then `localLlm` subsystems, survives ring eviction + window reload). Response reports `source: "memory" | "disk"` so the caller knows which layer answered. Stub blocks in the conversation like `[Past tool call tX — …]` remain resolvable here even after eviction. **`sessions`** (a name, a list, or `"all"`): read the key from those sessions' stored results instead (keys are per session); the answer names the `session` it came from, and `alsoIn` the other chosen sessions holding the same key. **Paging**: `offset` (default 0) and `length` (characters, default 30000, at most 200000) pick a page of the result; the answer says `resultSize` (the whole length), `offset`, `length`, `nextOffset` (where the next page starts; null at the end) and `complete` (the whole result in this answer). Read on with `offset: nextOffset` until it is null. This tool's answers are never cut by the inline tool-trail retention.

### `tomAi_searchPastToolResults`

Regex-search across the bodies of past tool results in the ring buffer for this session. **Regex syntax**: JavaScript regex with the `g` flag (always) and `i` flag when `caseSensitive: false` (default). Invalid regex returns `{ok: false, error}`. Each match becomes one snippet with up to `contextChars` (default 120, capped 1000) of surrounding text; whitespace inside the snippet is collapsed to single spaces for readability; `…` markers indicate truncation at either end. Zero-width matches are guarded against. Filters: `toolName` (exact match), `limit` (default 20, capped 200). Response: `{ok, pattern, caseSensitive, entriesScanned, hitCount, hits: [{key, toolName, round, matchIndex, snippet}]}`. Pass any `key` to `tomAi_readPastToolResult` for the full body. **`sessions`** (a name, a list, or `"all"`): instead of this session's ring buffer, every result the chosen sessions stored on disk (evicted ones included), each with its `session`; an unknown session is refused (code `unknownSession`) naming the sessions there are.

### `tomAi_sendItemToQuest`

Put a prompt into the queue of ANOTHER quest's VS Code window on this machine (for this window's own quest use tomAi_addQueueItem). The item is written as an inbox file into the shared queue folder; the target window takes it up at once (or when a window of that quest starts) and queues it with ITS OWN defaults (transport, profile, session, template, auto-send) — `anthropicProfileId` (the Anthropic profile, and so the model; transport `anthropic`), `session` or `newSession` override them. `session`: an existing session of the TARGET quest. `newSession`: `{basedOn, name?, lifetime?, profile?}` — a new session of the target quest based on an existing one (lifetime continue / per-prompt / per-iteration, default continue; profile default the base's, else the item's); without `name` it is temporary and deleted once the item and its notification are done. `doneNotificationPrompt`: queued in the TARGET queue, right after the item, when the item is done or ends in an error that will not recover — typically a prompt that sends back to this quest with this tool. `${senderQuest}` in the text and the notification prompt is this quest, `${itemOutcome}` in the notification prompt `done` or `error: <message>`. `pauseAfter`: the target queue pauses after the item (after its notification, if any). Refused: an unknown quest, this window's own quest, an unknown profile, a missing session or base, a taken session name. Answers `{delivered, targetRunning, targetWindows}`: `targetRunning` is whether a window of that quest has a live heartbeat.

### `tomAi_sendQueuedPrompt`

Hand a staged or pending queue item to the manager's run loop — the **canonical lifecycle entry point**. The manager will then: send pre-prompts → wait → send main → wait → send follow-up #1 → wait → … → mark sent. All follow-ups are auto-wrapped with the Answer Wrapper. Pass `queueItemId` (preferred) or `requestId` (when id is unknown). The answer carries `warning` when a stage of the item runs on an Anthropic profile whose configuration uses the direct API and whose key variable is not in this VS Code's environment: every send of that stage would fail. The item is kept; pick another profile (an Agent SDK one) or have the key set and VS Code restarted.

### `tomAi_setProcessState`

Move the active quest in its process. Give any of `process` (an id from `tomAi_listProcesses`; another process starts at its first phase and step; `""` clears the state), `phase`, `step`, `substep` (applied in that order: a new phase starts at its first step, a step with sub-steps at its first sub-step; a step that already ran in this phase iteration starts at its next iteration), and `phaseIteration` / `stepIteration` / `substepIteration` (set as given; only on a repeatable level, at most its maxIterations; a gate can always be run again). `completed: true` marks the process finished; any other change opens it again. A step's id may be its phase's gate or post-gate step. Every name is checked against the definition; a refusal returns `{ok:false, error}` and changes nothing. On success: `{ok, state, role, roleChanged}` — moving to a step that names a role also sets the `role` chat variable, so the role description in the system prompt follows the process. Record each move as the work moves on. A step started by the PROCESS view's Proceed moves on by itself when its queued items are done (a process-move marker in the queue); setting the state removes that marker (`processMoveMarkersRemoved`). Another process given without a position starts past the phases and steps its `when:` conditions exclude. `leaveOut` (a text, the reason; given alone): the running phase or step whose `when:` the agent judges does not hold is left out — inside its Proceed run the marker stays and the run ends by leaving it out, without one at once; recorded in the state's `skipped` as the agent's; refused where nothing has a condition to judge.

### `tomAi_specAddNode`

Add a child under `parentPath` through the runtime's SpecNodeCreator: for a list segment (e.g. `FRE-REQU-LST`) a new item, whose section id is generated from the list's @SectionIdPattern (dated `month`/`day`, default today) or taken from `itemId` (it must keep the pattern prefix and be unique); for a single child its path. Optionally populate it in the same call: `content` sets the new node's value (or its `content` leaf), `fields` sets forms `{ "<form segment relative to the new node, '' for the node itself>": { "<field>": value } }`, `headline` its headline (one line, e.g. `FR-07 — Archive closed orders`), so one call adds a filled, headlined item. Answers the new `path`, `kind`, `sectionId` and `headline`. A refused add returns the runtime's code (unknownChild, patternMismatch, duplicateSectionId, cardinalityExceeded, notAContainer) and the parent's `addable` children; nothing is written. Editor counterparts: doc_add_node, doc_add_list_item. Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `parentPath`: A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specAnnotations`

The review annotations of a TomSpecs document (`*.docspecs.yaml` or SOM `*.md`), read by the runtime's SpecReviewAnnotations: `comments` (id, qualifiedId `SBP C-12`, author, changedAt, text, `context` = the paragraph the comment follows, path, field, line), `questions` (id, topic, text, options with the bold one, recommended letter, answer, open, `changedAt` the header's change time, `answerChangedAt` the team answer's) and `marks` (`M-<n>`, markKind, oldText, newText, comment, markup, context, changedAt when it has one), with `counts` (questions, openQuestions, answeredQuestions, comments, marks), `marksRevision` (what tomAi_specDecideMarks checks mark ids against) and `findings` (annotation problems the runtime reports). `path` keeps those at or below it; `kinds` and `openOnly` narrow the lists; at most `limit` (default 200) of each, `truncated` when more. Lines are 0-based within the value. With `dir` instead of `file`: every SOM document under the folder (found as tomAi_specListDocuments finds them) with its `counts` and its number of `findings`, and the `totals` (documents, withAnnotations, the counts, findings) — no lists; which documents still have open questions, unapplied comments or marks, in one call. `maxResults` / `timeBudgetMs` bound it; `truncated` with `stoppedBy` when they did. Annotations (SOM §11.9) live in content values and form-field values: a comment block `> ⬆️ **C-12** (author, 2026-11-07T14:05+01:00): text` (id, author and change time optional), a question block `> **❓ BQ-81 — topic:** question`, options `> - (a) …` with the recommended one bold `> - **(b)** …`, and `> **Answer:**`; inline marks `{++added++}`, `{--removed--}`, `{~~old~>new~~}`, `{==text==}{>>comment<<}`, `{>>comment<<}`; a change comment `{~~old~>new~~}{>>[~~old~>new~~] why?<<}` quotes the change it is about, and records `| accepted` / `| rejected` in its quote when the change is decided; a comment written or edited records its change time (§11.9.10), in a block's header or in the attribution token after an inline comment (`{@2026-11-07T14:05+01:00}`, `{@alice 2026-11-07T14:05+01:00}`). Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path).

**Arguments:**

- `path`: Only annotations at or below this path. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specApplyEdits`

Apply several edits to one TomSpecs document as ONE change: one approval, one write, one undo step, all or nothing. The preferred way to make more than one change (add an item, then fill it). `edits` is an ordered list of up to 200 entries, each `{op, …}` with the same arguments as the single tool, minus `file`: setContent {path, text, marked?}, setFormField {path, field, value, marked?}, setHeadline {path, headline}, setCodeSpec {path, codeSpec}, addNode {parentPath, childSegment, itemId?, month?, day?, content?, fields?, headline?, as?}, setItemSectionId {itemPath, sectionId}, moveListItem {itemPath, toIndex, toList?}, removeListItem {itemPath}, clearSection {path}; and the review annotations: insertComment {path, field?, afterParagraph | afterTextStart | afterTextContains, text, author?, id?}, insertQuestion {question, afterComment? | path + afterParagraph | afterTextStart | afterTextContains}, setAnswer {questionId, answer}, editComment {commentId, text}, assignCommentIds {floor?}, resolveAnnotation {id}, decideMarks {decisions + marksRevision? | all + path?} (mark ids are those of the document as the entry finds it), commentChange {markId, text, author?, marksRevision?} (a change comment quoting the change), editMarkComment {markId, text, marksRevision?}, removeAllAnnotations {}. addNode can bind its new path with `as: "req"`; later entries write `$req` or `$req/FRED` in path, parentPath, itemPath or toList, so an item can be added and filled without knowing its generated id. A move re-points bound names; a later entry that names a path a move changed is refused (`stalePath`) with the new path. Names, ops and the cap are checked before anything runs (`invalidBatch`). Any failing entry aborts the whole batch and writes nothing: `{ok:false, failedOp: {index, op}, code, error, completed}`. On success: `{written, revision, applied, results: [{index, op, …}], bindings, validation: {introduced, resolved, underPath, total}}`, the validation compared before and after the whole batch. `dryRun` returns all of it plus the `diff`, writing nothing. Creating a document is tomAi_specCreateDocument. `validation` is the instance tier only; tomAi_specValidate gives the full picture, the DocSpecs schema tier included. Paths are document paths as in the single tools, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path).

### `tomAi_specAssignCommentIds`

Give every comment block without an id the next free `C-<n>`, in document order, so each can be cited and resolved (SpecReviewAnnotations.assignCommentIds). Answers the ids as `assigned` ([] when every comment has one); nothing else changes. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

### `tomAi_specClearSection`

Remove every value under a path (content, form fields, headlines, codeSpecs, list items). The node itself stays part of the model. Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `path`: A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specCodeSpecsGuide`

The CodeSpecs (Phase 4) workflow guides and stage runbooks, packaged with the extension. Without arguments: the two guides — `prompt` (codespecs_prompt.md: Stage A, the extraction run, Stage B, Stage C) and `mapping` (codespecs_mapping.md: concepts, the Phase-4 contract and run procedure §1.1, the todo tree, the parts catalogue, slices and authoring order §4.4, DocSpecs ↔ CodeSpecs linking §9) — with their main sections, and the runbooks. `guide` alone: its full outline. `guide` + `section` (a number such as `6.2` or `1.1.2`): that section with its subsections (a very long one answers its own text and lists its children). `runbook` (codespecs-next-step, -stage-a, -extraction, -stage-b, -stage-c, -authoring-step, -validate): the stage's instructions with `file` / `questId` / `step` / `shared` filled in and its guide sections appended. The same guides are MCP resources (`codespecs-guide://prompt`, `codespecs-guide://mapping`) and the runbooks MCP prompts.

### `tomAi_specCodeSpecsTrace`

Trace between a specification and the code generated from it, by section-id TOKEN — the unit the generated code's back-links (`@CodeSpec(source: […])`, `@DocSpec([DocRef(token)])`) cite. Start from exactly one of: `specPath` (its entries' tokens, the declarations citing them, and with `file` the heading `codeSpec=` forward links of the node and its ancestors), `token`, `codeFile` + `line` (the declaration at or above that line) or `declaration` (a @CodeSpec id or a name) — each token with its extract entries (spec path, verbatim value). With back-links, `agreement` lists the tokens the two ends disagree on: extracted but cited by no declaration (uncited) and cited but held by no in-scope extract (dangling) — the shape of validate_codespecs checks 35 and 36. Which declaration should carry a token is not decided. The back-links come from `codeDirs` (the generated trio, read by the validate_codespecs binary bundled with the extension) or from `backlinks`, a JSON index `validate_codespecs --backlinks` wrote. Without validate_codespecs on this platform, `codeDirs` gives none: the trace from `specPath` or `token` goes on from the extracts, without `agreement`, and carries `warnings` (`validate_codespecs missing on <platform>: no back-link agreement (checks 35, 36)`) and `help`; from `codeFile` or `declaration` it answers `binaryMissing`.

### `tomAi_specCodeSpecsValidate`

Run the 41 codespecs_derivation_contract.md §6 checks over a generated CodeSpecs trio (shared, client, server packages), through the validate_codespecs binary bundled with the extension (no Dart SDK needed) or configured (`bridge.executables.validate_codespecs`). `outcome` is `clean` or `violations` (both ok: the checks ran) or, with ok false, `usageError` (the input was refused: a missing folder, a partial regenerated trio) or `binaryMissing` (no binary for this platform: `expected` is where the bundled one would be, `help` and `page` say how to get or configure one). Each violation: check number and title, the section that defines it, file and line, section-id token or area, message. `notRun` names each check whose corroborating input was not given (extracts for 19 and 32–36, migrations for 13, coreSource for 9, regenerated for 31) — a check that did not run is not a pass. tom_code_specs' vocabulary, whose hook catalogue checks 40 and 41 (protocol-feature hooks, reserved protocol paths) need, ships with the extension and is passed unless `csVocabulary` names another; `inputs` then shows it as `(bundled) resources/codespecs/vocabulary.dart`.

### `tomAi_specCommentChange`

Comment on a change mark by its `M-<n>` id (SpecReviewAnnotations.commentChange, SOM §11.9.3): a change comment is written right after the change, quoting it (`{~~ 30 ~> 15 ~~}{>> [~~ 30 ~> 15 ~~] why shorter? <<}`), so it stays understandable once the change is decided — deciding the change keeps the comment and records the outcome in its quote. Answers the new comment's id (`commentId`). Refused, nothing changed: an unknown id or a stale `marksRevision`, a mark that is not a change, a change that has its comment already, an empty text or one holding a mark delimiter or a blank line, an `author` that is not a member id. Edit it later with tomAi_specEditMarkComment; remove it with tomAi_specDecideMarks (either decision). Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

### `tomAi_specDecideMarks`

Accept or reject inline marks (SOM §11.9.3): accepting takes the change (an insertion's text, nothing for a deletion, a substitution's new text) and removes a highlight's or comment mark's comment; rejecting undoes it. `decisions` names marks by their `M-<n>` id from tomAi_specAnnotations, each "accept", "reject" or "leave", checked against `marksRevision` (default: the document as it is now) — a stale one is refused (`annotationRefused`) and nothing changes. Or `all`: "accept" / "reject" every mark under `path` (default the whole document). Answers `applied` (id, decision, markup, result) and `malformed` marks left as written. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `path`: With `all`: only marks at or below this path. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specEditComment`

Replace the text of a comment block; its marker, id and author stay as written, its change time becomes the edit's (SpecReviewAnnotations.editComment). A qualified id (`SBP C-12`) is accepted; an unknown one is refused (`annotationRefused`). Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

### `tomAi_specEditMarkComment`

Replace the comment of an inline mark by its `M-<n>` id (SpecReviewAnnotations.editMarkComment): a `{>> comment <<}`, a change comment (its quote, outcome included, stays as written) or a commented highlight; an attribution token keeps its authors and takes the edit's change time. Refused, nothing changed: an unknown id or a stale `marksRevision`, a mark holding no comment, an empty text or one holding a mark delimiter or a blank line. Comment blocks (`C-<n>`) are edited with tomAi_specEditComment. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

### `tomAi_specExtractAnswers`

The answers of a review round (SOM §11.9.7), as a step folder's `answers.md`: per document (labelled by its file name without the format suffix, e.g. `tom_uam.sbp`) the answered questions and the reviewer comments, each with its section-id chain, its line in the document's Markdown rendition, the question and its answer verbatim or the comment and its author; `includeOpen` adds the open questions, `includeMarks` the inline marks. Read through the runtime's extractAnswers / renderAnswers — the text tom_specs' `extract_answers` CLI writes. `files` lists several documents in the order answers.md shows them; fragments of one root are assembled into one document. `path` keeps the subtree at that path. The annotations stay in the documents (tomAi_specRemoveAllAnnotations removes them). Counts: answered, open, comments, marks. Answers `{counts, documents: [{label, root, files, counts}], findings, markdown}` and writes nothing; tomAi_specWriteAnswers writes the file. `findings` lists annotations the runtime cannot read (malformed, misplaced, duplicate id) — the extraction misses them, so `complete: false`. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path).

**Arguments:**

- `path`: Only the subtree at this document path. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specGetSection`

One node of a TomSpecs document with its values. A value leaf (content, scalar, enum, scalar list item) returns `value`; a form returns `fields`, each with its declared type, enum domain, required flag and typed value; a list returns its `items` (path, section id, headline); a section returns its own `values`, its `forms` (every field, value or null) and its structural `children` with list items. Always: kind, section id, headline, codeSpec. A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Editor counterparts: doc_get_content, doc_get_form_field, doc_section_meta.

**Arguments:**

- `path`: A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specInsertComment`

Insert a reviewer comment block `> ⬆️ **C-<n>** (author, time): text` after a paragraph of a value (`afterParagraph`, or `afterTextStart` / `afterTextContains`), through SpecReviewAnnotations.insertComment. The id is `id` when given, else the next free one (the highest `C-<n>` in the document plus one); answers it as `id`. Paragraphs are the blank-line separated blocks of the value (an annotation block is one; a blank line inside fenced code does not end one), counted from 0 as tomAi_specGetSection shows the value; -1 is the start. Instead of the number, name the paragraph by its text: `afterTextStart` (the paragraph that begins with it, trimmed, case-sensitive) or `afterTextContains` (anywhere in it) — annotation blocks are not matched; no match is refused (`anchorNotFound`, with the paragraphs), more than one (`anchorAmbiguous`, with the candidates and their numbers). A missing paragraph is refused (`annotationRefused`). Annotations (SOM §11.9) live in content values and form-field values: a comment block `> ⬆️ **C-12** (author, 2026-11-07T14:05+01:00): text` (id, author and change time optional), a question block `> **❓ BQ-81 — topic:** question`, options `> - (a) …` with the recommended one bold `> - **(b)** …`, and `> **Answer:**`; inline marks `{++added++}`, `{--removed--}`, `{~~old~>new~~}`, `{==text==}{>>comment<<}`, `{>>comment<<}`; a change comment `{~~old~>new~~}{>>[~~old~>new~~] why?<<}` quotes the change it is about, and records `| accepted` / `| rejected` in its quote when the change is decided; a comment written or edited records its change time (§11.9.10), in a block's header or in the attribution token after an inline comment (`{@2026-11-07T14:05+01:00}`, `{@alice 2026-11-07T14:05+01:00}`). Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Signing and marking.** Without `author` the comment is signed `agent_<role>` — the role of the process position the prompt runs for, else the `role` chat variable (`agent` without one; `src/utils/reviewAuthors.ts`); review member ids are `[a-z0-9_]` only, hence the underscore. Give `author` only to write down what the user said in their name. A comment that especially needs the reviewer starts with `___check here___` and says why it is there; the MD Browser draws the marker as a badge and its navigation steps through *Marked: check here* and *Agent comments* and filters by author. tomAi_specCommentChange signs the same way (`{@agent_<role> time}` after the comment), as do both ops in tomAi_specApplyEdits.

**Arguments:**

- `path`: The value: a content path (`…/content`), or a form with `field`. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specInsertQuestion`

Insert a question block (SOM §11.9.2): directly after a comment (`afterComment`, its id — how to ask about a comment), or after a paragraph of the value at `path` (`afterParagraph`, `afterTextStart` or `afterTextContains`). The block is written by the runtime: the header `> **❓ <id> — <topic>:** <text>`, the options one per line with the recommended one bold, an optional `*Recommendation:*` and working assumption, and an empty `> **Answer:**`. Paragraphs are the blank-line separated blocks of the value (an annotation block is one; a blank line inside fenced code does not end one), counted from 0 as tomAi_specGetSection shows the value; -1 is the start. Instead of the number, name the paragraph by its text: `afterTextStart` (the paragraph that begins with it, trimmed, case-sensitive) or `afterTextContains` (anywhere in it) — annotation blocks are not matched; no match is refused (`anchorNotFound`, with the paragraphs), more than one (`anchorAmbiguous`, with the candidates and their numbers). Annotations (SOM §11.9) live in content values and form-field values: a comment block `> ⬆️ **C-12** (author, 2026-11-07T14:05+01:00): text` (id, author and change time optional), a question block `> **❓ BQ-81 — topic:** question`, options `> - (a) …` with the recommended one bold `> - **(b)** …`, and `> **Answer:**`; inline marks `{++added++}`, `{--removed--}`, `{~~old~>new~~}`, `{==text==}{>>comment<<}`, `{>>comment<<}`; a change comment `{~~old~>new~~}{>>[~~old~>new~~] why?<<}` quotes the change it is about, and records `| accepted` / `| rejected` in its quote when the change is decided; a comment written or edited records its change time (§11.9.10), in a block's header or in the attribution token after an inline comment (`{@2026-11-07T14:05+01:00}`, `{@alice 2026-11-07T14:05+01:00}`). Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `path`: The value: a content path (`…/content`), or a form with `field`. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specMergeReviews`

Merge a team review round's returned copies (SOM §11.9.9) through the runtime's `mergeReviews` into `merged/<document>` in the team notation of §11.9.8, and write the report to `merged/merge-report.json`. A copy is returned when it differs from the base; one identical to it is left out unless `includeUnchanged`. What the merge writes: a change one or several members made becomes an inline mark naming them (`{~~ 100 ~> 200 ~~}{@alice}`); a member's decision on a base mark becomes a vote on it, and a base mark every copy decided the same way is applied (`unanimous`); a member's answer becomes an individual answer `**Answer (alice, bob):**` above the team's empty `**Answer:**`; new comments are numbered on; an item a copy added is added; where members changed one passage differently, a conflict block `> ⚖️ **X-<n> — <topic>:**` lists the base and each member's alternative with an empty `> **Decision:**` (tomAi_specDecideConflicts). A copy whose file name is nobody on the team is a guest's: the merge writes a question proposing them for the next round's team, and needs their name and role (`guests`, kept in round.yaml; refused as `guestUnnamed` until given). A TomSpecs document gets a draft revision entry (the next minor version, the round's date and author, the team and the reviewers). Refused, nothing written: `guestUnnamed`, `structureMismatch` (a copy that does not fit the base, named with its problem), `nothingReturned`. Answers the report as `report` (reviewers with `guest`, conflicts with path, field, paragraph and members, votes, unanimous, answers, comments, additions, guestQuestions, revision), a `summary` of the counts, `mergedCopies`, `notReturned` and what to do next; `dryRun` answers `mergedText` and writes nothing.

### `tomAi_specMoveListItem`

Move a list item to `toIndex` (0-based) within its list, or into `toList` (a list of the same element class; the item's id must fit the destination's pattern). The section id is the identity and the path the position: the list is renumbered and values travel with their item. Answers `renamed` (old → new item path for every item that moved — any path you hold below the list may have changed) and `pinnedIds`. In YAML files the `review:` entries follow their items. Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `itemPath`: A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specOutline`

The instance tree of a TomSpecs document under `path` (default: the root), pre-order, `depth` levels deep (default 2, max 12). Per node: path, kind (root/complex/section/list/listItemComplex/listItemScalar/form/content/scalar/enumValue), section id, headline, codeSpec, filled, and the item count for lists. Every declared child appears, filled or not, so the outline also shows where content can go; `filledOnly: true` leaves empty subtrees out. Paged: `limit` (default 200) and `offset`; `nextOffset` is set when more follow. Also returns the document's format, stamp, editability, readOnlyReason and revision. A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. Editor counterpart: doc_outline.

**Arguments:**

- `path`: Start node. Default: the document root. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specReflect`

What the TomSpecs model says, no document needed. By `path`: the node kind, its field (kind, type, section-id pattern, form fields with types and enum domains, headline, doc comment, annotations such as @MapsTo, @DetailedIn and @CodeSpecKind) and its class with every child field; for a list, the item class. By `className`: that class. With `file`, also `addable` / `notAddable`: the child segments the runtime's add rule (checkAddNode) accepts under `path` in that document now, and why the others are refused (e.g. a single child already present). `brief: true` drops doc comments and annotations. A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. Editor counterparts: doc_reflect, model_get_section, model_children.

**Arguments:**

- `path`: A model path. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them. Exactly one of path / className.

### `tomAi_specRemoveAllAnnotations`

Remove every review annotation of the document and write it back (SpecReviewAnnotations.removeAllAnnotations): every inline mark accepted, every comment and question block removed, answered or not — the document as it reads once a review round is integrated (step 05, Result). The whole document; for part of it use tomAi_specDecideMarks with `all` and tomAi_specResolveAnnotation. Answers `removed` (comments, questions, openQuestions, marks, counted before), `applied` (each mark accepted) and `malformed` marks left as written. Collect the answers first (tomAi_specWriteAnswers): what is removed here is gone from the document. `dryRun` shows the diff. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

### `tomAi_specRemoveListItem`

Remove a list item and every value under it. The other items keep their paths. Editor counterpart: doc_remove_list_item. Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `itemPath`: A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specRender`

A TomSpecs document as the DocSpecs Markdown a reader sees — how to read a YAML-stored spec as prose. With `path`, only that subtree, under its ancestors' headings. The header keeps the document's own model version. `withoutAnnotations`: as the document reads once reviewed — every inline mark accepted, every comment and question block removed (the runtime's SpecReviewAnnotations.stripped; tomAi_specAnnotations lists them). Answers `{document, markdown, lines}`. Writes nothing; tomAi_specConvert writes a file. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path).

**Arguments:**

- `path`: Render only this subtree. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specResolveAnnotation`

Remove one comment or question by id once it has been applied to the document (SpecReviewAnnotations.resolve); a qualified comment id (`SBP C-12`) is accepted. A question of a combined block takes only its own lines. The surrounding text stays. Inline marks are decided with tomAi_specDecideMarks instead. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

### `tomAi_specSearch`

Search one TomSpecs document (`*.docspecs.yaml` or SOM `*.md`) with the runtime's query engine. All given filters are AND-combined: `text` over content, form values and headlines (a node's stored headline, else its model doc comment), `kinds`, `className` (a list item's or section's model class), `sectionIdExact` / `sectionIdPrefix` (a node's section id; a list item's is its own — the stored id, else the list's pattern with its position, as its heading shows — so `FRE-REQU-ORDER-CAPTURE` finds that item, while the list's id `FRE-REQU-LST` finds only the list), `pathGlob` (`*` within one segment, `**` across), `mapsTo` / `detailedIn` (a root type such as `D03InformationModel`), and `state` (`empty` / `nonEmpty`; review state is not searchable). Returns `total`, the first page of matches `{path, kind, classId, headline, snippet, matchSpans}` and, when more remain, a `cursorId` for tomAi_specSearchIterate. A snippet longer than 320 characters is a window around the first match, with `snippetOffset` and `valueLength`; spans are relative to the snippet. With `regex: true`, `text` is a pattern: The pattern language is the runtime's portable subset, identical in every SOM runtime: `.` any character, `*` `+` `?` greedy quantifiers, `[...]` / `[^...]` classes with ranges, `^` / `$` anchoring the whole value, `\` + punctuation for that character. There is no alternation, grouping or `{n}`: `(`, `)`, `|`, `{`, `}` match themselves. `\d`, `\w`, `\s`, `\b` and any other `\` + letter or digit are rejected. A rejected pattern returns `code: "patternError"`. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Editor counterpart: doc_search.

### `tomAi_specSetAnswer`

Write the answer of a question after its `**Answer:**` (SpecReviewAnnotations.setAnswer): the option letter first when it picks one, `(b) because …`; several lines stay inside the quote. "" clears it and reopens the question. An unknown question id is refused (`annotationRefused`). Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

### `tomAi_specSetCodeSpec`

Set the heading-level `codeSpec=` routing marker of a section (the CodeSpecs mapping reads it, e.g. `CsOrder,CsOrder.captureFromEdi`); null or "" removes it. Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `path`: A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specSetContent`

Set the value of a content or scalar leaf (a `…/content` path, or a scalar list item) through the runtime's SpecEditor. `text` null or empty clears it. A typed leaf takes a number or boolean, or a string it can read; a value its type cannot read (an int leaf given "lots" or 2.5, an enum leaf a name outside its domain) is refused as `code: "wrongValue"` with the leaf's `field` (name, type, enum domain), as tomAi_specSetFormField answers. For form fields use tomAi_specSetFormField. Editor counterpart: doc_set_content. With `marked: true` the new text is written as a change the reviewer can accept or reject (SOM §11.9.3, through SpecReviewAnnotations.setMarked): its differences against the value there now become inline marks (`{++added++}`, `{--removed--}`, `{~~old~>new~~}`), so accepting every mark gives the new text and rejecting every mark the old one. A value already holding marks is compared from its original, so a second edit of a passage updates its mark instead of nesting one. Text only: a typed or enum value is refused (`notText`). Answers `marked: true` and `exact` (false when a difference could not be marked — inside fenced code, or text holding mark delimiters — and the new text was written unmarked). Read and decide the marks with tomAi_specAnnotations and tomAi_specDecideMarks. Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `path`: A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specSetFormField`

Set one field of a form, typed by its declaration: an `int` field takes a whole number (2.5 is refused), a `double` a number, a `bool` true/false, an enum one of its names; a string is stored as written and must read back as the declared type. A wrong value returns `code: "wrongValue"` with the field's type and enum domain; an unknown field returns the form's fields. null or "" clears it. tomAi_specGetSection shows each form's fields. Editor counterpart: doc_set_form_field. With `marked: true` the new text is written as a change the reviewer can accept or reject (SOM §11.9.3, through SpecReviewAnnotations.setMarked): its differences against the value there now become inline marks (`{++added++}`, `{--removed--}`, `{~~old~>new~~}`), so accepting every mark gives the new text and rejecting every mark the old one. A value already holding marks is compared from its original, so a second edit of a passage updates its mark instead of nesting one. Text only: a typed or enum value is refused (`notText`). Answers `marked: true` and `exact` (false when a difference could not be marked — inside fenced code, or text holding mark delimiters — and the new text was written unmarked). Read and decide the marks with tomAi_specAnnotations and tomAi_specDecideMarks. Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `path`: The form's path. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specSetHeadline`

Set the stored headline of a section, list item or the root; null or "" returns it to its default title. A headline is one line (a line break is refused as `invalidHeadline`: it would end the Markdown heading). A new item can get its headline in tomAi_specAddNode already. Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `path`: A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specSetItemSectionId`

Rename a list item's section id. The id must keep the list's @SectionIdPattern prefix and be unique in the list; a refusal names the pattern. Paths do not change (the path is the position). Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by the runtime's validateDocument, compared before and after the edit across the whole document (a stated count that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must be editable (see readOnlyReason in tomAi_specOutline). A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths. For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.

**Arguments:**

- `itemPath`: A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specValidate`

Is a TomSpecs document valid? Runs the three tiers tom_specs' validate_spec CLI runs and answers in its report shape (`spec-validation`/1): decode (Markdown parse rejections; with `files`, fragments of different roots and values written by more than one fragment, each overlap naming every writer), schema (the DocSpecs schema of the root, generated from the model, over the document's Markdown rendition), and instance (typed values, enum domains, references, stated counts). Answers `{passed, summary, root {type, schemaId, schemaVersion}, tiers, notRun, violations: [{tier, code, severity, file, line, location, path, message}]}`; `path` is the document path to fix, as the edit tools take it (for a schema finding, the section its line falls under). `files` validates fragments of one document as one, so references between them resolve. `path` keeps only findings at or below it. Known limit: on a few rare shapes the schema and instance tiers still disagree (tom_specs vsctsa32), and the schema tier has not been checked against every model shape (qrb3); schema findings name the schema id and version so such a case can be traced. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path).

**Arguments:**

- `path`: Keep only findings at or below this path. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_specWriteAnswers`

The answers of a review round (SOM §11.9.7), as a step folder's `answers.md`: per document (labelled by its file name without the format suffix, e.g. `tom_uam.sbp`) the answered questions and the reviewer comments, each with its section-id chain, its line in the document's Markdown rendition, the question and its answer verbatim or the comment and its author; `includeOpen` adds the open questions, `includeMarks` the inline marks. Read through the runtime's extractAnswers / renderAnswers — the text tom_specs' `extract_answers` CLI writes. `files` lists several documents in the order answers.md shows them; fragments of one root are assembled into one document. `path` keeps the subtree at that path. The annotations stay in the documents (tomAi_specRemoveAllAnnotations removes them). Counts: answered, open, comments, marks. Writes it to `output` (inside the workspace; folders are created). Answers `{written, file, status (new / changed / unchanged), counts, documents}`; an unchanged file is not touched. An existing file with other text is refused (`exists`) unless `overwrite: true`; `dryRun` returns the `diff` and the text and writes nothing. Annotations the runtime cannot read are refused (`annotationsMalformed`, with the findings): the file would miss them. Read the counts and the text first with tomAi_specExtractAnswers. Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path).

**Arguments:**

- `path`: Only the subtree at this document path. A document path: the root section id, then field segments (a field's @SectionId, else its name) and list items `<LIST>-<n>`, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.

### `tomAi_updateQuestTodo`

Update fields of an existing quest todo. **Every field you pass REPLACES the stored value as a whole; nothing is merged or appended.** `notes` and `description` are overwritten, never appended to: to add a paragraph, read the todo with `tomAi_getQuestTodo` and send the old text plus the new. `tags`, `dependencies`, `blocked_by`, `blocked_until`, `references` and `decisions` replace the whole list. `blocking` (the todos this one blocks, the reverse of their `blocked_by`) is derived and kept in step by every write; passing it is refused, and so is `last_answer` (the queue run's answer, written by the queue). `scope` replaces the whole object, so keys you leave out are dropped. An empty string or empty list removes the field. **Fields you do NOT pass are kept verbatim**, including `scope`, `references`, `created` timestamps, `_sourceFile` and unknown fields an earlier hand-edit added. YAML formatting is preserved. When a `notes` or `description` replacement keeps less than half of the previous text (clearing included), the update is still applied and the response carries a `warning` quoting what was replaced, so an accidental overwrite can be undone at once. Each `references` entry is an object (`{path}`, `{url}` or `{description}`, optionally with `type` and `lines`); a bare string is rejected with `ok: false`, nothing applied. Status enum: `not-started`/`in-progress`/`blocked`/`decision-needed`/`completed`/`cancelled`. Priority enum: `low`/`medium`/`high`/`critical`. To close a `decision-needed` todo, write the user's answers into `decisions[].decision` and move the status back to `not-started` in the same call. Missing id surfaces structured `{ok: false, error: "..."}`. For id changes or moving across files, use `tomAi_moveQuestTodo` or delete+create. **Dates are dates:** `completed_date` (and every other date field of the schema) is written as YYYY-MM-DD; a timestamp is accepted and written as the date it names, anything else is refused with nothing written. `created` / `updated` are stamped by the writer (local date). The Worktracker orchestration fields `execution_role`, `qa_role`, `orchestration_role`, `bundle_id`, `derived_from`, `feedback_source` (optional strings) are written, read back and kept by updates that do not name them. `user_action: true` marks a todo that is the user's to do: a `<prefix>*` queue walk passes it and goes on with the next todo. `blocked_until` lists publish conditions (`<package> >= <x.y.z>`) that keep a blocked todo blocked until pub.dev has the release; an entry in another form is refused with nothing written.

**Arguments:**

- `updates.decisions`: Decisions the user has to make before this todo can be started. Pair with `status: "decision-needed"` while any `decision` is still empty.
- `updates.decisions[].decision_needed`: The full question, its context and the options.
- `updates.decisions[].decision`: What the user decided. Leave out until they've answered.
- `updates.completed_date`: A date, YYYY-MM-DD. A timestamp is accepted and written as the date it names (2026-10-20T12:37:25+0200 → 2026-10-20); anything else is refused.
- `updates.references[].type`: Reference type, e.g. file, url, doc.
- `updates.references[].path`: Workspace-relative file path.
- `updates.references[].url`: External URL.
- `updates.references[].description`: What the reference contains.
- `updates.references[].lines`: Line range or location hint, e.g. '45-60'.
- `updates.execution_role`: The role that carries the todo out when execution is agent-driven (Worktracker).
- `updates.qa_role`: The role that checks the todo's result (Worktracker).
- `updates.orchestration_role`: The role that orchestrates the execution bundle the todo belongs to (Worktracker).
- `updates.bundle_id`: The execution bundle the todo is grouped into (Worktracker).
- `updates.derived_from`: The todo this one was derived from (Worktracker).
- `updates.feedback_source`: The feedback that raised this todo (Worktracker).
- `updates.user_action`: true: the todo is the user's to do (a review, an answer, a look at a screen). A `<prefix>*` queue walk passes it instead of sending it to an agent, and the todo panel marks it 👤. false removes the mark.
- `updates.blocked_until`: Publish conditions that block the todo, each `<package> >= <x.y.z>` (or `>`): met when pub.dev's latest release satisfies it. Keep the prose in `notes`. [] removes the field.

### `tomAi_updateQueueFollowUp`

Update fields on an existing follow-up by its id: text, template, reminder config, repeat/wait, transport. **Targeted by `followUpId`** (NOT by index — follow-ups have stable ids the manager generates). Get follow-up ids from the `followUps[].id` array in a queue item inspection.

**Arguments:**

- `repeatCount`: Literal number, chat-variable name, or `<prefix>*`: walk the quest's todos whose id starts with `<prefix>`, lowest number first (the number is the first digit run after the prefix; a group named with a leading number is walked the same way, `001_cleanup*` → `001_cleanup1`, `001_cleanup2`). The prefix may hold digits (`p2s2ss3-*`) but must not end in one (refused with code invalidTodoPrefix). The text names the todo each dispatch picked with `${repeatTodoId}` (its id), `${repeatTodoTitle}` and `${repeatNumber}`, filled in when it is sent; the picked todo is set in-progress, and a todo the work creates with the next free number joins the walk. An item whose main prompt walks over nothing (no todo of the prefix, or none not-started, blocked or decision-needed) and that has no pre-prompt (which could create the todos) is held in `error` at once, its reason in `warning`; it is staged again when an edit or a pre-prompt gives it work, or when its status is set once the todos are there.

### `tomAi_updateQueueItem`

Update an editable queue item: text, template, answer-wrapper, reminder config, main-prompt repetition (count/prefix/suffix), templateRepeatCount, answerWaitMinutes, transport, anthropic target. **Only editable in `staged` / `pending` states** — items in `sending`/`sent`/`error` are frozen. `repeatCount`/`templateRepeatCount` accept literal numbers or chat-variable names. To change pre-prompts use `tomAi_updateQueuePrePrompt`; for follow-ups use `tomAi_updateQueueFollowUp`. `doneNotificationPrompt` ('' removes it) and `doneNotificationDisabled` can be changed until the item is finished, also while it is sending.

**Arguments:**

- `repeatCount`: Literal number, chat-variable name, or `<prefix>*`: walk the quest's todos whose id starts with `<prefix>`, lowest number first (the number is the first digit run after the prefix; a group named with a leading number is walked the same way, `001_cleanup*` → `001_cleanup1`, `001_cleanup2`). The prefix may hold digits (`p2s2ss3-*`) but must not end in one (refused with code invalidTodoPrefix). The text names the todo each dispatch picked with `${repeatTodoId}` (its id), `${repeatTodoTitle}` and `${repeatNumber}`, filled in when it is sent; the picked todo is set in-progress, and a todo the work creates with the next free number joins the walk. An item whose main prompt walks over nothing (no todo of the prefix, or none not-started, blocked or decision-needed) and that has no pre-prompt (which could create the todos) is held in `error` at once, its reason in `warning`; it is staged again when an edit or a pre-prompt gives it work, or when its status is set once the todos are there.
- `session`: The named session the item runs in: a `<name>.session.json` of the quest's history folder (tomAi_listSessions). A name, or a spec `{name, basedOn?, mode?, profile?}`: a session that does not exist when the item is dispatched is created before its first send — from the spec (fresh, or based on `basedOn`, a missing base being created plainly; `mode` continue / per-prompt / per-iteration; `profile` the Anthropic profile, else the item's own anthropicProfileId), or for a bare name as a fresh `continue` session. Unset: the queue default, else the queue's own `default`. On the Agent SDK transport it is the SDK conversation; on the direct API transport the session's own history (`chat` and `default` share the quest's). A prompt runs with the stage's or item's profile, else the session's, else the queue default. Refused when queued (code invalidSession): a malformed spec, an unknown profile, or a profile that keeps its conversation elsewhere than the session's existing one (an Agent SDK session continued with our own history, or the reverse).
- `doneNotificationPrompt`: A prompt queued right after the item, ahead of every other pending item, when the item is finished: all its pre-prompts, repetitions (or `<prefix>*` todos), follow-ups and template iterations done, or ended in an error that will not recover (no API key, a request the API refused, an exhausted retry schedule; not a quota or rate limit being waited out). It runs with the item's transport, profile and session, takes over its "pause after this", and is queued once per run. `${itemOutcome}` in it reads `done` or `error: <message>`.

### `tomAi_updateQueuePrePrompt`

Patch fields on an existing pre-prompt by **zero-based index** within the item's pre-prompt array. Same field surface as the create form plus repeat/wait/reminder. Reordering is NOT supported — remove and re-add.

**Arguments:**

- `repeatCount`: Literal number, chat-variable name, or `<prefix>*`: walk the quest's todos whose id starts with `<prefix>`, lowest number first (the number is the first digit run after the prefix; a group named with a leading number is walked the same way, `001_cleanup*` → `001_cleanup1`, `001_cleanup2`). The prefix may hold digits (`p2s2ss3-*`) but must not end in one (refused with code invalidTodoPrefix). The text names the todo each dispatch picked with `${repeatTodoId}` (its id), `${repeatTodoTitle}` and `${repeatNumber}`, filled in when it is sent; the picked todo is set in-progress, and a todo the work creates with the next free number joins the walk. An item whose main prompt walks over nothing (no todo of the prefix, or none not-started, blocked or decision-needed) and that has no pre-prompt (which could create the todos) is held in `error` at once, its reason in `warning`; it is staged again when an edit or a pre-prompt gives it work, or when its status is set once the todos are there.

### `tomAi_writeChatVariable`

Update one or more custom chat variables. Keys are stored under the `custom.*` namespace; passing `myKey` or `custom.myKey` is equivalent (the `custom.` prefix is stripped idempotently). **Built-in keys** (`quest`, `role`, `activeProjects`, `todo`, `todoFile`) are rejected with `reason: "built-in keys are user-only..."` — set those from the Chat Variables panel. The process keys (`process`, `phase`, `step`, `substep`, the iterations and descriptions) are rejected too — set them with `tomAi_setProcessState`. **Empty-string value DELETES the variable** when the key currently exists; writing an empty string to an unknown key is rejected as "would set/delete nothing" so the model knows nothing was persisted. **Coercion rules**: strings pass through; null/undefined → empty string (= delete); numbers/booleans → `String(value)`; objects → `String(value)` (usually `"[object Object]"` — JSON-stringify yourself first if you want the JSON form). Response is `{ok, accepted: {created, updated, deleted}, rejected: [{key, reason}, ...]}`. No approval required — every write is visible live in the Chat Variables Editor.
