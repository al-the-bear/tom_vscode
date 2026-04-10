# Configuration Structure

This document inventories configuration and persistent storage used by the VS Code extension, including workspace files, VS Code instance settings, VS Code workspace storage (memento), and per-window storage files.

## Scope and Interpretation

- Scope: source under src/ plus package.json contribution metadata.
- "VS Code instance storage" in this document means VS Code settings storage (User/Workspace settings.json) and extension-level persistent stores provided by VS Code.
- "VS Code workspace storage" means ExtensionContext.workspaceState (memento keys, persisted by VS Code in workspaceStorage state DB).
- "VS window storage" means extension-managed per-window persisted files keyed by window/session identifiers.

## Configuration Resolution Order

Primary extension config file path resolution (tom_vscode_extension.json/yaml):

1. Workspace file: .tom/tom_vscode_extension.json (if it exists).
2. VS Code setting tomAi.configPath (supports ~, ${workspaceFolder}, ${home}).
3. Workspace default target .tom/tom_vscode_extension.json.

Related implementations:

- src/utils/tomAiConfiguration.ts
- src/handlers/handler_shared.ts
- src/utils/sendToChatConfig.ts

## VS Code Instance Storage

### A) Contributed VS Code Settings (27)

All contributed settings are window-scoped and are stored by VS Code in settings.json (User or Workspace settings, depending on where the user sets them).

| Setting key |
| --- |
| tomAi.aiFolder |
| tomAi.autoRunOnSave |
| tomAi.bridge.maxRestarts |
| tomAi.bridge.requestTimeout |
| tomAi.bridge.restartDelay |
| tomAi.configPath |
| tomAi.contextApproach |
| tomAi.copilot.answerFolder |
| tomAi.copilot.model |
| tomAi.copilot.showNotifications |
| tomAi.guidelines.excludeGlobs |
| tomAi.localLlm.ollamaModel |
| tomAi.localLlm.ollamaUrl |
| tomAi.maxContextSize |
| tomAi.notes.questNotesPattern |
| tomAi.projectDetection.excludeGlobs |
| tomAi.queueFolder |
| tomAi.timedRequests.tickInterval |
| tomAi.todo.questTodoPattern |
| tomAi.todo.workspaceTodoFile |
| tomAi.tomAiChat.enablePromptOptimization |
| tomAi.tomAiChat.modelId |
| tomAi.tomAiChat.preProcessingModelId |
| tomAi.tomAiChat.responsesTokenLimit |
| tomAi.tomAiChat.responseSummaryTokenLimit |
| tomAi.tomAiChat.tokenModelId |
| tomAi.trail.enabled |

### B) ExtensionContext Global Stores

- globalState: not used.
- secrets: not used.
- globalStorageUri/globalStoragePath files: not used directly.

## VS Code Workspace Storage (workspaceState)

workspaceState is actively used. Keys below are the persisted elements.

| Key | Purpose |
| --- | --- |
| chatVariablesStore | Snapshot of chat variable state (quest, role, activeProjects, todo, todoFile, custom, changeLog). |
| tomAi.questTodo.panelState | Quest TODO panel UI state (quest/file/tag scope/sort/filter). |
| tomAi.questTodo.pendingSelect | Deferred todo selection state for editors/panels. |
| tomAi.copilot.autoHideDelay | Copilot panel auto-hide delay setting in UI. |
| copilotKeepContent | Keep-content-after-send toggle. |
| tomAi.trailEditor.pendingFocus | Deferred focus target for trail editor. |
| tomAi.queueEditor.collapsedItemIds | Queue editor collapsed queue-entry IDs. |
| tomAi.timedEditor.collapsedEntryIds | Timed requests editor collapsed entry IDs. |
| tomAi.notepad.content | Notepad handler workspace notepad content. |
| tomAi.vscodeNotes.content | Notepad handler VS Code notes content. |
| tomAi.notes.tomNotepadTemplate | Selected template for TOM notepad. |
| tomAi.chatPanel.copilot.draft | Copilot notepad/panel draft text. |
| tomAi.chatPanel.copilot.template | Copilot notepad/panel selected template key. |
| tomAi.chatPanel.localLlm.draft | Local LLM panel draft text. |
| tomAi.chatPanel.localLlm.profile | Local LLM panel selected profile key. |
| tomAi.localLlm.selectedConfig | Local LLM selected configuration ID. |
| tomAi.chatPanel.aiConversation.draft | Conversation panel draft text. |
| tomAi.chatPanel.aiConversation.profile | Conversation panel selected profile key. |
| tomAi.aiConversation.selectedSetup | Conversation selected setup ID. |
| tomAi.chatPanel.tomAiChat.draft | Tom AI Chat panel draft text. |
| tomAi.chatPanel.tomAiChat.template | Tom AI Chat selected template key. |
| tomAi.notes.activeNoteFile | Active note file ID in multi-note notes panel. |
| tomAi.notes.workspaceNoteFile | Absolute path of selected workspace notes file. |
| tomAi.notes.workspaceNotepadTemplate | Selected workspace-notepad template key. |
| tomAi.notes.questNotesTemplate | Selected quest-notes template key. |
| chatVar_quest | Legacy/read-compat quest value access. |
| chatVar_role | Legacy/read-compat role value access. |
| tomAi.windowId | Read by scripting bridge (no writer found in current code). |

Notes:

- STORAGE_KEYS.localLlmModel, STORAGE_KEYS.notes, and STORAGE_KEYS.tomNotepad are declared in sidebarNotes-handler but not used in current read/write paths.
- Physical persistence location is VS Code workspaceStorage state DB, not a workspace file in this repository.

## VS Window Storage (per-window persisted files)

The extension persists several window-scoped files, keyed by session/window IDs.

| Path pattern | Format | Stored elements |
| --- | --- | --- |
| _ai/local/{windowId}.window-state.json (or windowStatus.localFolder override) | JSON | windowId, workspace, activeQuest, status[] where each status item has subsystem, status (prompt-sent/answer-received), promptStartedAt, lastAnswerAt. |
| _ai/chat_variables/{windowId}.chatvariable.yaml | YAML | quest, role, activeProjects[], todo, todoFile, custom{}, changeLog[]. |
| _ai/quests/{questId}/{YYYYMMDD}_{HHMM}_{windowId}.todo.yaml | YAML | Session todos using todo schema fields (id, title, description, status, priority, tags, scope, references, dependencies, blocked_by, notes, created, updated, completed_*). |

## Workspace and Home File Stores

### A) Core Config File

| Path resolution | Format | Stored elements |
| --- | --- | --- |
| .tom/tom_vscode_extension.json preferred, otherwise tomAi.configPath | JSON or YAML | Top-level sections merged with defaults: userName, localLlm, aiConversation, copilot, tomAiChat, trail (raw + summary), bridge, todo, reminders, favorites. |

Config section detail (effective persisted structure):

- userName
- localLlm: profiles, ollamaUrl, model, models, tools, configurations, defaultTemplate
- aiConversation: profiles, telegram, setups, defaultTemplate
- copilot: templates, defaultTemplate, answerFolder
- tomAiChat: defaultTemplate, templates
- trail:
  - raw: enabled, cleanupDays, maxEntries, stripThinking, paths.localLlm/copilot/lmApi
  - summary: enabled, promptsFilePattern, answersFilePattern
- windowStatus: localFolder
- externalApplications: mappings[]
- bridge: current, cliServerAutostart, binaryPath, executables, profiles
- todo: defaultColumns and related todo settings
- reminders: templates[], config
- favorites[]

### B) Queue Storage (_ai/queue or tomAi.queueFolder)

| File | Format | Stored elements |
| --- | --- | --- |
| queue-settings.yaml | YAML | response-timeout-minutes, default-reminder-template-id, auto-send-enabled, auto-start-enabled, auto-pause-enabled, auto-continue-enabled, reload-prompt-by-scope{scope->{enabled,prompt}} |
| *.entry.queue.yaml | YAML | meta{} + prompt-queue[] according to queue-entry schema. |
| *.template.queue.yaml | YAML | Template documents using same queue-entry schema shape. |

Queue entry element model (prompt-queue item):

- id, name, type (main/followup/preprompt/gate/decision)
- prompt-text, expanded-text, file
- template, answer-template, answer-wrapper
- repeat-count, repeat-index, repeat-prefix, repeat-suffix
- answer-wait-minutes, llm-profile
- reminder{enabled, template-id, timeout-minutes, repeat, sent-count, last-sent-at, queued}
- gate-ref, pre-prompt-refs, follow-up-refs
- gate-condition, case-expression, case-mapping[], case-reminder-ref
- metadata{}
- execution{request-id, expected-request-id, sent-at, error, follow-up-index}

### C) Panel YAML Storage (_ai/local or tomAi.panelStoragePath)

| File pattern | Format | Stored elements |
| --- | --- | --- |
| {workspace}.chatvars.yaml | YAML | quest, role, activeProjects[], todo, todoFile, custom{} (+ metadata fields $schema, updated). |
| {host}_{workspace}.timed.yaml | YAML | timerActivated, schedule[], entries[] (+ metadata fields). |
| {host}_{workspace}.queue.yaml | YAML | Reserved panel storage naming for queue state (queue itself is file-per-entry under _ai/queue). |
| {workspace}.{section}.prompt-panel.yaml | YAML | section, text, profile, llmConfig, aiSetup, activeSlot, slots{} (+ metadata fields). |

Timed entry element model (entries[]):

- id, enabled, template, answerWrapper, originalText
- scheduleMode (interval/scheduled), intervalMinutes, scheduledTimes[]
- reminderEnabled, reminderTemplateId, reminderTimeoutMinutes, reminderRepeat
- repeatCount, repeatPrefix, repeatSuffix
- sendMaximum, sentCount, answerWaitMinutes, lastSentAt, status

### D) Todo and Notes Files

| Path pattern | Format | Stored elements |
| --- | --- | --- |
| workspace.todo.yaml (or tomAi.todo.workspaceTodoFile) | YAML | Workspace todo document (todo schema with file-level metadata + todos[]). |
| _ai/quests/{questId}/todos.{questId}.todo.yaml (or todo.questTodoPattern) | YAML | Quest todo document with todo schema fields. |
| _ai/quests/{questId}/*.todo.yaml | YAML | Additional session/aux todo files, same schema. |
| notes.md (workspace selected file persisted in workspaceState) | Markdown | Workspace notes free-form markdown content. |
| _ai/quests/{questId}/quest-notes.{questId}.md (or notes.questNotesPattern) | Markdown | Quest notes markdown content. |
| ~/.tom/notes/global_notes.md | Markdown | Global TOM notepad content shared across windows. |

Todo item model (schema-backed):

- id, title, description
- status: not-started, in-progress, blocked, completed, cancelled
- priority: low, medium, high, critical
- tags[]
- scope{project, projects[], module, area, files[]}
- references[]{type, path, url, description, lines}
- dependencies[], blocked_by[]
- notes
- created, updated, completed_date, completed_by

### E) Trail and Conversation Audit Files

| Path pattern | Format | Stored elements |
| --- | --- | --- |
| _ai/trail/localllm/{quest}[-{configName}]/* | .md/.json | Raw prompt/answer/tool exchange files with timestamps and request IDs. |
| _ai/trail/copilot/{quest}/* | .md/.json | Raw Copilot prompt/answer/tool files. |
| _ai/trail/lm-api/{quest}[-{model}]/* | .md/.json | Raw LM API prompt/answer/tool files. |
| _ai/quests/{quest}/{quest}.{subsystem}.prompts.md | Markdown | Consolidated prompt log entries, newest first, sequence-trimmed. |
| _ai/quests/{quest}/{quest}.{subsystem}.answers.md | Markdown | Consolidated answer log entries, metadata-enriched where available. |

## Storage by Runtime Domain

| Domain | Primary store |
| --- | --- |
| User settings and feature toggles | VS Code settings.json via contributed tomAi.* settings |
| Extension transient UI state | workspaceState keys |
| Queue runtime and templates | _ai/queue/*.queue.yaml + queue-settings.yaml |
| Timed requests | _ai/local/{host}_{workspace}.timed.yaml |
| Chat variable state | workspaceState.chatVariablesStore + _ai/chat_variables/{windowId}.chatvariable.yaml |
| Todo workflow | workspace.todo.yaml + _ai/quests/{quest}/*.todo.yaml |
| Notes workflow | notes.md, quest notes, ~/.tom/notes/global_notes.md |
| Window status | _ai/local/{windowId}.window-state.json |
| Trail/audit logs | _ai/trail/... and _ai/quests/{quest}/*.(prompts-or-answers).md |

## Findings Summary

- The extension uses workspaceState extensively and does not use globalState or secrets.
- Configuration is primarily file-based with workspace-first resolution and optional setting override.
- Window-specific persistence is implemented through explicit per-window files (not VS Code window memento APIs).
- There is one legacy compatibility layer via chatVar_quest/chatVar_role reads and one read-only key usage for tomAi.windowId.
