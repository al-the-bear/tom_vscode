# File Storage

This document reviews file storage behavior across all components listed in code_structure.md. For each component it summarizes:

- Which files/folders are read.
- Which files/folders are written.
- Which naming conventions and path templates are used.

## Method and Coverage

- Component baseline: doc/review/code_structure.md (10 component groups under Component Breakdown).
- Evidence source: static code inspection of component files and storage helpers.
- Storage classes covered:
  - Workspace files under _ai/, .tom/, project folders.
  - Home-level files under ~/.tom/.
  - VS Code workspaceState key-value persistence where used.

## Cross-Component Naming Conventions

The following conventions appear repeatedly and form the extension-wide storage model:

- Queue entries: {hostname}_{workspace}_{YYMMDD_HHMMSS}_{quest}.{type}.entry.queue.yaml
- Queue templates: {name}.template.queue.yaml
- Queue settings: queue-settings.yaml
- Todo files:
  - Quest main: todos.{questId}.todo.yaml
  - Session: {YYYYMMDD}_{HHMM}_{windowId}.todo.yaml
  - Workspace: workspace.todo.yaml
- Window state: {windowId}.window-state.json
- Chat variable snapshots: {windowId}.chatvariable.yaml
- Prompt panel state: {workspace}.{section}.prompt-panel.yaml
- Trail summaries:
  - ${ai}/quests/${quest}/${quest}.${subsystem}.prompts.md
  - ${ai}/quests/${quest}/${quest}.${subsystem}.answers.md
- Trail raw exchange files:
  - {timestamp}_prompt_{exchangeId}.userprompt.md
  - {timestamp}_answer_{exchangeId}.answer.json
  - {timestamp}_{kind}_{windowId}.json
- Reusable prompt files: *.prompt.md

## Component-by-Component Analysis

### 1) Bridge, Execution, CLI, and Integrations

Representative files:

- src/handlers/commandline-handler.ts
- src/handlers/tomScriptingBridge-handler.ts
- src/handlers/telegram-cmd-handlers.ts
- src/handlers/restartBridge-handler.ts

Reads:

- Extension config (tom_vscode_extension.json via shared config resolution).
- Workspace/project files opened in editor for command execution contexts.
- Todo documents via quest todo manager helpers.
- Directory listings and existence checks for commandline/telegram workflows.

Writes:

- Commandline-generated helper/output files (workspace-relative destinations).
- Bridge/telegram helper artifacts.
- Todo mutations through createTodoInFile/updateTodoInFile.

Naming conventions used:

- todo schema filenames (*.todo.yaml), including workspace.todo.yaml and quest-scoped paths.
- Config path placeholders: ${workspaceFolder}, ${home}.

### 2) Chat, Copilot, and Local LLM Flows

Representative files:

- src/handlers/chatPanel-handler.ts
- src/handlers/aiConversation-handler.ts
- src/managers/chatVariablesStore.ts
- src/utils/sendToChatConfig.ts

Reads:

- Prompt templates and chat input files.
- Config sections for localLlm/aiConversation/copilot/tomAiChat.
- Existing panel draft YAML, trail files, and todo context files.
- workspaceState values such as auto-hide and legacy chatVar keys.

Writes:

- Prompt-panel YAML snapshots via writePromptPanelYaml.
- Trail data via trail service calls.
- Chat variable snapshots in both file and workspaceState stores.
- Conversation and local LLM generated outputs/logs.

Naming conventions used:

- Trail summary: *.prompts.md and *.answers.md.
- Chat variable per-window file: {windowId}.chatvariable.yaml.
- Todo references: *.todo.yaml.
- Config anchoring: tom_vscode_extension.json.

### 3) Core Extension Wiring

Representative files:

- src/handlers/handler_shared.ts
- src/tests.ts

Reads:

- Shared config and workspace tree/document picks.
- Test harness reads fixture/workspace files.

Writes:

- Test harness output artifacts (file write/create dir paths in tests.ts).

Naming conventions used:

- Central config resolution to tom_vscode_extension.json.
- Path variable expansion conventions: ${workspaceFolder}, ${home}.

### 4) General Handlers

Representative files:

- src/handlers/reusablePromptEditor-handler.ts
- src/handlers/githubIssueProvider.ts

Reads:

- Prompt file lists and prompt file contents in scope-specific prompt directories.
- Issue provider local support files where present.

Writes:

- Prompt editor create/save/delete operations for *.prompt.md files.

Naming conventions used:

- Prompt filename suffix enforced as .prompt.md.
- Prompt scope directories:
  - Global: _ai/prompt/
  - Project: {project}/prompt/
  - Quest: _ai/quests/{questId}/prompt/
  - Scan scope: discovered prompt/ directories in workspace tree.

### 5) Queue, Timed Requests, and Scheduling

Representative files:

- src/storage/queueFileStorage.ts
- src/managers/promptQueueManager.ts
- src/managers/timerEngine.ts
- src/managers/reminderSystem.ts

Reads:

- queue-settings.yaml
- *.entry.queue.yaml queue entries
- *.template.queue.yaml queue templates

Writes:

- queue-settings.yaml updates
- Queue entry create/update/delete in file-per-entry model
- Template create/update/delete in file-per-template model
- Timed panel YAML persistence (timerActivated/schedule/entries)

Naming conventions used:

- Entry: {hostname}_{workspace}_{YYMMDD_HHMMSS}_{quest}.{type}.entry.queue.yaml
- Template: {name}.template.queue.yaml
- Panel timed file: host+workspace prefixed YAML through panelYamlStore builder.

### 6) Shared Infrastructure and Contracts

Representative files:

- src/utils/fsUtils.ts
- src/utils/tomAiConfiguration.ts
- src/utils/debugLogger.ts
- src/utils/workspacePaths.ts

Reads:

- Generic file utilities for safe JSON/YAML/text reads.
- Config file load/parse (JSON or YAML) with workspace-first resolution.

Writes:

- Generic file utilities for safe JSON/YAML/text writes.
- Debug log file append/write/rotation support.
- Config save operations through TomAiConfiguration persistence.

Naming conventions used:

- Config canonical name: tom_vscode_extension.json.
- Resolved tokenized patterns: ${ai}, ${quest}, ${subsystem}, ${workspaceFolder}, ${home}.
- Workspace path registry conventions for _ai, .tom, and ~/.tom roots.

### 7) Todo, Notes, and Work Tracking

Representative files:

- src/managers/questTodoManager.ts
- src/managers/sessionTodoStore.ts
- src/handlers/sidebarNotes-handler.ts
- src/handlers/questTodoPanel-handler.ts

Reads:

- Workspace todo and quest todo YAML files.
- Session todo YAML files.
- Notes content files (workspace and quest notes).
- Global notes file under ~/.tom/notes/global_notes.md.

Writes:

- Todo create/update/move across quest and workspace files.
- Session todo file creation and updates.
- Notes save operations for global/workspace/quest notepads.
- questTodo panel state and pending selections in workspaceState.

Naming conventions used:

- Quest todo main: todos.{questId}.todo.yaml
- Session todo: {YYYYMMDD}_{HHMM}_{windowId}.todo.yaml
- Workspace todo: workspace.todo.yaml
- Quest notes default pattern: _ai/quests/${quest}/quest-notes.${quest}.md
- Quest todo pattern (configurable): todos.${quest}.todo.yaml
- Global notes fixed path: ~/.tom/notes/global_notes.md

### 8) Tooling Surface and Model Tools

Representative files:

- src/tools/tool-executors.ts
- src/tools/local-llm-tools-config.ts

Reads:

- Tool inputs targeting workspace files/folders.
- LLM tools configuration files.

Writes:

- create/edit/delete operations delegated by tool executors.
- LLM tool configuration updates.

Naming conventions used:

- Inherits conventions from delegated paths (todo/prompt/queue/trail schemas), rather than introducing a separate file naming family.

### 9) Trail and Markdown Views

Representative files:

- src/services/trailService.ts
- src/handlers/trailViewer-handler.ts
- src/handlers/trailEditor-handler.ts
- src/handlers/markdownBrowser-handler.ts

Reads:

- Consolidated trail markdown files.
- Raw trail prompt/answer JSON/markdown files.
- Markdown browser target files and directories.

Writes:

- Raw trail files (prompt/answer/tool request/tool answer).
- Summary trail files for prompts and answers.
- Trail viewer helper outputs (export/format conversions where requested).
- trailEditor pending focus state in workspaceState.

Naming conventions used:

- Raw prompt: {timestamp}_prompt_{exchangeId}.userprompt.md
- Raw answer: {timestamp}_answer_{exchangeId}.answer.json
- Raw tools: {timestamp}_{tool_request|tool_answer}_{windowId}.json
- Summary files: ${ai}/quests/${quest}/${quest}.${subsystem}.prompts.md and .answers.md

### 10) Window Layout, Panels, and UI Shell

Representative files:

- src/handlers/windowStatusPanel-handler.ts
- src/handlers/issuesPanel-handler.ts
- src/handlers/wsPanel-handler.ts
- src/handlers/statusPage-handler.ts

Reads:

- Window state cards from local folder.
- Issues panel fallback attachment folders.
- WS panel document/guideline content and section files.

Writes:

- Window state updates (atomic temp + rename).
- Attachment fallback copy/delete under workspace _ai/attachments.
- Status/settings mutations that persist into queue/config stores.

Naming conventions used:

- Window state file: {windowId}.window-state.json
- Local attachment fallback: _ai/attachments/issue-{issueNumber}/{fileName}
- Uses ${ai} token support for alternate window state folder roots.

## Storage Pattern Observations

- The extension prefers schema-friendly YAML for editable operational state (queue, timed, todo, panel state).
- It uses JSON where machine exchange payloads dominate (window state, raw answer files).
- Naming conventions encode runtime dimensions in filenames (host, workspace, quest, window, timestamps) to reduce collisions and make file provenance obvious.
- WorkspaceState is used for UI/session preferences and handoff signals, while substantial business state is mostly file-backed under _ai/ and .tom/.

## Risks and Review Notes

- Naming conventions are mostly centralized in helper modules (queueFileStorage, panelYamlStore, questTodoManager, trailService), which is positive for consistency.
- A few file families still depend on scattered literal strings in handlers (for example notes/todo defaults in sidebarNotes-handler), which increases drift risk.
- Legacy workspaceState keys (chatVar_quest/chatVar_role) coexist with newer ChatVariablesStore, so migration consistency should be watched.
