# VS Code Extension Overview

Canonical high-level map of `tom_vscode_extension` as it is today. Start here when you need to know *where* something lives before opening source files.

## 1. Runtime summary

Activated on VS Code startup. Contributes:

- Command suite under `tomAi.*`.
- Bottom-panel webviews: `@CHAT` (`tomAi.chatPanel`) and `@WS` (`tomAi.wsPanel`).
- `@TOM` sidebar tree views (notes, todos, log, window status).
- Custom editors: `yamlGraph.editor`, `questTodo.editor`, trail viewer, Markdown Browser, and several specialised editors (trail, templates, context, queue, timed requests, raw/summary trails, etc.).
- AI toolchain: five chat subsystems (Anthropic direct SDK, Agent SDK, Copilot, Local LLM, AI Conversation) plus a shared MCP/tool registry.
- Bridge/CLI/process-monitor integrations (optional; fail-soft).

## 2. Source layout

```text
src/
  extension.ts                  activation, command registration
  handlers/                     UI entry points + webview providers
    chatPanel-handler.ts          @CHAT webview with 5 subpanels
    anthropic-handler.ts          direct-SDK Anthropic loop, profiles, live trail
    agent-sdk-transport.ts        @anthropic-ai/claude-agent-sdk bridge
    tomAiChat-handler.ts          Tom AI Chat subpanel routing
    aiConversation-handler.ts     AI Conversation subpanel
    localLlm-handler.ts           Local LLM (Ollama-compatible)
    markdownBrowser-handler.ts    MD Browser custom editor
    statusPage-handler.ts         @Tom configuration / health page
    questTodoPanel-handler.ts     quest todo custom editor + panel
    trailViewer-handler.ts        *.prompts.md / *.answers.md viewer
    [globalTemplateEditor, issuesPanel, memoryPanel, contextSettingsEditor,
     queueEditor, timedRequests-editor, sidebarNotes, etc.]
  managers/                     session state (queue, todos, reminders, variables)
  services/                     persistence
    trailService.ts               raw trail file writer
    live-trail.ts                 live-trail markdown (rolling 5 blocks)
    tool-trail.ts                 in-memory ring buffer + replay keys
    memory-service.ts             two-tier memory + Agent SDK session id
    history-compaction.ts         trim_and_summary, full, summary modes
  tools/                        tools exposed to the model
    tool-executors.ts             dispatcher + write/exec tools
    chat-enhancement-tools.ts     file/search/guideline/memory tools
    past-tool-access-tools.ts     tomAi_list/search/readPastToolResult
    [diagnostics, editor-context, git, issue, language-service, …]
  utils/                        config, schema, path + variable resolution
  config/                       JSON Schema for configuration
```

Layer rule: handlers talk to services/managers; services own persistence; tools are pure dispatch + services. Nothing below `handlers/` should import VS Code webview APIs directly.

## 3. Bottom panels

### `@CHAT` (`tomAi.chatPanel`)

One webview, accordion layout, five chat subpanels. See [tom_ai_chat.md](tom_ai_chat.md) for routing details.

| Subpanel | Transport | Config key | Backing handler |
| --- | --- | --- | --- |
| Anthropic | Direct Anthropic SDK **or** Agent SDK (per-profile) | `anthropic` | `anthropic-handler.ts` (+ `agent-sdk-transport.ts`) |
| Tom AI Chat | Anthropic handler | `tomAiChat` | `tomAiChat-handler.ts` |
| AI Conversation | Anthropic SDK or `vscode.lm` | `conversation` | `aiConversation-handler.ts` |
| Copilot | VS Code Copilot Chat (via answer file) | `copilot` | `chatPanel-handler.ts` + copilot helpers |
| Local LLM | Ollama-compatible HTTP | `localLlm` | `localLlm-handler.ts` |

Shared features: document picker, prompt-queue side panel, live trail button (Anthropic subpanel), session-history button, memory/config buttons, shortcut chords (see [keybindings_and_commands.md](keybindings_and_commands.md)). Accordion/pin/rotate behavior lives in [bottom_panel_accordion.md](bottom_panel_accordion.md) and [tab_navigation.md](tab_navigation.md).

Note: AI Conversation is **not queue-compatible** (each turn is a fresh chat); the other four subpanels are.

### `@WS` (`tomAi.wsPanel`)

Workspace operations surface. Sections: Guidelines, Documentation, Logs, Settings, Issues, Tests, Quest TODO. Links into `_copilot_guidelines/` and `_ai/notes/`; embeds the quest todo panel with a refresh watcher.

## 4. `@TOM` sidebar tree views

- VS CODE NOTES
- QUEST NOTES
- QUEST TODOS
- SESSION TODOS
- TODO LOG (session-scoped execution log)
- WINDOW STATUS
- WORKSPACE NOTES
- WORKSPACE TODOS

See [explorer_notes.md](explorer_notes.md).

## 5. AI + tool ecosystem

### Profile system (Anthropic)

Curated profiles cover 3 models × 3 modes: Sonnet 4.6 / Opus 4.7 / Opus 4.6 × {Direct, Agent SDK trim-and-summary, Agent SDK SDK-managed}. Each profile carries model id, `transport` (`direct | agentSdk | vscodeLm`), `historyMode` (`sdk-managed | full | summary | trim_and_summary | llm_extract`), and optional `userPromptWrapper` with `${wrappedPrompt}` placeholder for caching-friendly memory injection.

### Placeholders in prompts

Expanded by `variableResolver.ts` before a turn is sent:

- `${userMessage}` — the raw user text.
- `${wrappedPrompt}` — the user message after the profile's user-message template runs (used by `userPromptWrapper`).
- `${memory}`, `${memory-shared}`, `${memory-quest}` — two-tier memory injection (direct transport only; Agent SDK pulls memory via tools).
- `${compactedSummary}` + `${rawTurns}` — exposed when `trim_and_summary` is active so a template can decide how to include history.
- Standard chat variables: `${tomAi.quest}`, `${tomAi.role}`, `${tomAi.activeProjects}`, `${tomAi.todo}`, `${tomAi.workspaceName}`.

See [file_and_prompt_placeholders.md](../doc/file_and_prompt_placeholders.md).

### Tool surface

Shared tools (exposed to the model): file I/O, search, guideline access, memory, diagnostics, git, issue, editor-context, notify-user, run-command/run-vscode-command, and the **past-tool-access trio** (`tomAi_listPastToolCalls`, `tomAi_searchPastToolResults`, `tomAi_readPastToolResult`) backed by the in-memory tool trail.

Write tools (`tomAi_createFile`, `tomAi_editFile`, `tomAi_multiEditFile`, `tomAi_runCommand`, `tomAi_runVscodeCommand`, `tomAi_notifyUser`) go through an approval gate. Read-only tools skip it. Per-call approval, session-wide elevation, and `toolApprovalMode: 'never'` on a profile are all supported.

On the Agent SDK path, tools surface through an MCP server (`mcp__tom-ai__<tool>` name prefix). Built-in preset tools (Read/Write/Bash/Grep/…) can be enabled per profile via `useBuiltInTools: true`; the stream is mirrored into the raw trail + tool trail for full visibility.

### Trails on disk

- **Raw trail** — `_ai/trail/anthropic/<quest>/` (per subsystem): `<ts>_prompt_<rid>.userprompt.md`, `<ts>_payload_<rid>.payload.md`, `<ts>_answer_<rid>.answer.json`, plus `<ts>_toolrequest_*.json` / `<ts>_toolanswer_*.json` for each tool call. Written by `TrailService`.
- **Live trail** — `_ai/quests/<quest>/live-trail.md`. Written by `LiveTrailWriter` as events arrive (thinking / tool_use / tool_result / assistant text). Rolling window keeps the most recent 5 prompt blocks. Open via the chat-panel "Open Live Trail" button — the MD Browser launches in live mode and follow-tails the file.
- **In-memory tool trail** — `src/services/tool-trail.ts`. Ring buffer of 40 entries with replay keys `t1`, `t2`, …; summarised into the next user prompt and queryable via the past-tool-access tools.

### History + compaction

`trim_and_summary` (default for direct transport) rolls `_ai/quests/<quest>/history/history.json` + `history.md` forward each turn. SDK-managed mode delegates continuity to the Agent SDK and writes the session id to `_ai/quests/<quest>/history/default.session.json` (gitignored; idempotent — skipped when unchanged). Memory extraction runs as a background job after each direct-transport turn.

## 6. Bridge and automation

Bridge commands cover restart / profile switching / debug logging. CLI server and process-monitor integrations activate only when available; their absence doesn't block the extension. See [extension_bridge.md](extension_bridge.md) and [bridge_scripting_guide.md](bridge_scripting_guide.md).

## 7. Custom editors

| View type | Files | Purpose |
| --- | --- | --- |
| `tomAi.yamlGraphEditor` | `*.flow.yaml`, `*.state.yaml`, `*.er.yaml` | Visual graph editor; requires numeric `meta.graph-version`. |
| `tomAi.todoEditor` | `*.todo.yaml` | Quest todo list editor with status tracking. |
| `tomAi.markdownBrowser` | `*.md` | Rendered markdown preview with navigation history, mermaid, debounced file-watcher reload, live-mode follow-tail. |
| `tomAi.trailViewer` | `*.prompts.md`, `*.answers.md` | Summary trail viewer. |

## 8. Maintenance rules

- **Keep command IDs stable.** Renaming breaks keybindings, queue entries, and external scripts.
- **Update `sendToChatConfig.ts` + `config/tom_vscode_extension.schema.json` together** when the configuration shape changes.
- **Run `npx tsc --noEmit`** after edits; commit only when clean.
- **Fail-soft on optional modules** (bridge, CLI, telegram). Missing dependencies must degrade, not crash, activation.
- **Sync this doc + [architecture.md](architecture.md) + [implementation.md](implementation.md)** when panels, subpanels, or major flows change.

## 9. Related docs

- [architecture.md](architecture.md) — layering + dependency rules.
- [implementation.md](implementation.md) — per-subsystem implementation notes.
- [tom_ai_chat.md](tom_ai_chat.md) — Tom AI Chat subpanel + Anthropic routing.
- [tom_ai_bottom_panel.md](tom_ai_bottom_panel.md) — @CHAT webview mechanics.
- [tom_status_page.md](tom_status_page.md) — @Tom configuration panel.
- [extension_bridge.md](extension_bridge.md) — bridge subsystem.
- [keybindings_and_commands.md](keybindings_and_commands.md) — shortcut + command reference.
- [../doc/file_and_prompt_placeholders.md](../doc/file_and_prompt_placeholders.md) — placeholder reference for template authors.
- [../doc/placeholder_engine.md](../doc/placeholder_engine.md) — placeholder engine map for maintainers (which syntax resolves where).
- [../doc/anthropic_handler.md](../doc/anthropic_handler.md) — Anthropic handler deep-dive.
- [../doc/chat_log_custom_editor.md](../doc/chat_log_custom_editor.md) — Markdown Browser + live trail.
