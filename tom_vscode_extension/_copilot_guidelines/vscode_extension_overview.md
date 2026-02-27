# VS Code Extension Overview

This is the canonical high-level overview of the current `tom_vscode_extension` implementation.

## 1. Runtime summary

The extension is activated on startup and registers:

- command suite (`tomAi.*`, with `tomAi.*` compatibility aliases),
- webview panels (`@CHAT`, `@WS`),
- explorer note/todo views,
- YAML graph custom editor,
- quest todo custom editor,
- AI toolchain (Copilot, Tom AI chat, local LLM, escalation helpers),
- bridge/CLI/process monitor integrations.

## 2. Main modules

- `src/extension.ts`: activation orchestration.
- `src/handlers/*`: UI and command handlers.
- `src/managers/*`: chat/session/queue/timer/reminder state.
- `src/tools/*`: tool description/execution and variable resolvers.

## 3. Bottom panels (current)

### `@CHAT` (`tomAi.chatPanel`)

Primary AI working surface with sections:

- Session Todo
- Workspace Todo
- Local LLM
- AI Conversation
- Copilot
- Tom AI Chat

Notable capabilities:

- template/profile CRUD,
- Copilot slot-aware answer handling,
- trail logging,
- response value extraction,
- quick todo actions.

### `@WS` (`tomAi.wsPanel`)

Workspace operations surface with sections:

- Guidelines
- Documentation
- Logs
- Settings
- Issues
- Tests
- Quest TODO

Notable capabilities:

- links into `_copilot_guidelines` and `_ai/notes`,
- embedded issues/tests fragments,
- embedded quest todo panel and refresh watcher.

## 4. Explorer views

The extension contributes note/todo views in Explorer:

- VS CODE NOTES
- QUEST NOTES
- QUEST TODOS
- SESSION TODOS
- WORKSPACE NOTES
- WORKSPACE TODOS

## 5. AI and tool ecosystem

### Copilot pathways

- `sendToChat` commands (standard/advanced/template variants),
- Unified Notepad Copilot section with answer-file support.

### Tom AI Chat

- start/send/interrupt command surface,
- tool registration via `registerTomAiChatTools`.

### Local LLM

- Ollama-oriented commands and profile-driven prompt expansion.

### Ask-AI / escalation

Escalation tool initialization is active and documented under:

- `doc/copilot_chat_tools.md`
- `tom_ai_chat.md`

(legacy `ask_ai_tools.md` removed).

## 6. Bridge and automation

Bridge commands cover restart/profile switching and optional CLI/process monitor helpers. Extension remains usable even if optional subsystems are unavailable.

## 7. Custom editors

### YAML Graph Editor

- view type: `yamlGraph.editor`
- file patterns: `*.flow.yaml`, `*.state.yaml`, `*.er.yaml`
- requires numeric `meta.graph-version`

### Quest TODO Editor

- view type: `questTodo.editor`
- file pattern: `*.todo.yaml`

## 8. Key maintenance rules

- Keep command IDs stable.
- Keep docs synchronized when panel sections or command surfaces change.
- Run compile checks after edits.
- Favor fail-soft activation for optional modules.

## 9. Related docs

- `architecture.md`
- `implementation.md`
- `extension_bridge.md`
- `keybindings_and_commands.md`
- `tom_ai_bottom_panel.md`
- `tom_ai_chat.md`
- `tom_status_page.md`
