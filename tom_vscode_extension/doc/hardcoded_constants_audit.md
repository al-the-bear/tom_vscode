# Hardcoded Constants & Missing Configuration Audit

**Date:** 2026-02-26  
**Scope:** `tom_vscode_extension/src/` (excluding `__tests__/`)

---

## 1. WsPaths Constants (workspacePaths.ts) — Full Registry

[src/utils/workspacePaths.ts](src/utils/workspacePaths.ts) defines the central path registry.

### Top-Level Folder Constants

| Constant | Value | Used For |
|----------|-------|----------|
| `AI_FOLDER` | `_ai` | Workspace AI artefacts root |
| `GUIDELINES_FOLDER` | `_copilot_guidelines` | AI guidelines documents |
| `TOM_METADATA_FOLDER` | `.tom_metadata` | Tom metadata |
| `HOME_TOM_FOLDER` | `.tom` | User home `~/.tom/` data |
| `GITHUB_FOLDER` | `.github` | GitHub config folder |
| `WORKSPACE_CONFIG_FOLDER` | `.tom` | Workspace `.tom/` config |
| `CONFIG_FILE_NAME` | `tom_vscode_extension.json` | Extension config filename |

### AI_SUBPATHS (sub-paths inside `_ai/`)

| Key | Sub-path |
|-----|----------|
| `quests` | `quests` |
| `roles` | `roles` |
| `notes` | `notes` |
| `local` | `local` |
| `schemas` | `schemas/yaml` |
| `copilot` | `copilot` |
| `tomAiChat` | `tom_ai_chat` |
| `chatReplies` | `chat_replies` |
| `botConversations` | `bot_conversations` |
| `attachments` | `attachments` |
| `answersCopilot` | `answers/copilot` |
| `trailLocal` | `local/trail` |
| `trailConversation` | `conversation/trail` |
| `trailTomai` | `tomai/trail` |
| `trailCopilot` | `copilot/trail` |

### HOME_SUBPATHS (sub-paths inside `~/.tom/`)

| Key | Sub-path |
|-----|----------|
| `vscodeConfig` | `vscode/tom_vscode_extension.json` |
| `copilotChatAnswers` | `copilot-chat-answers` |
| `chatReplies` | `chat_replies` |
| `botConversations` | `bot_conversations` |
| `botConversationAnswers` | `bot-conversation-answers` |
| `copilotAnswers` | `copilot-answers` |
| `copilotPrompts` | `copilot-prompts` |

### Static Getters & Methods

| Method | Returns |
|--------|---------|
| `WsPaths.aiFolder` | `_ai` |
| `WsPaths.guidelinesFolder` | `_copilot_guidelines` |
| `WsPaths.metadataFolder` | `.tom_metadata` |
| `WsPaths.githubFolder` | `.github` |
| `WsPaths.homeTomFolder` | `.tom` |
| `WsPaths.wsConfigFolder` | `.tom` |
| `WsPaths.configFileName` | `tom_vscode_extension.json` |
| `WsPaths.wsRoot` | First workspace folder path |
| `WsPaths.ai(key, ...extra)` | Absolute path: `<ws>/_ai/<subpath>/...` |
| `WsPaths.aiRelative(key)` | Relative path: `_ai/<subpath>` |
| `WsPaths.aiRoot` | `<ws>/_ai` |
| `WsPaths.guidelines(projectRelPath?)` | `<ws>/_copilot_guidelines` or `<ws>/<proj>/_copilot_guidelines` |
| `WsPaths.metadata(...extra)` | `<ws>/.tom_metadata/...` |
| `WsPaths.github(...extra)` | `<ws>/.github/...` |
| `WsPaths.wsConfig(...extra)` | `<ws>/.tom/...` |
| `WsPaths.home(key, ...extra)` | `~/.tom/<subpath>/...` |
| `WsPaths.homeRoot` | `~/.tom` |
| `WsPaths.questTodoGlob` | `_ai/quests/**/*.todo.yaml` |
| `WsPaths.guidelinesGlob` | `_copilot_guidelines/**/*.md` |
| `WsPaths.getResolverVariables()` | Variable map for template resolver |

### Missing from WsPaths

The following folder names are used in the codebase but **NOT** defined in `WsPaths`:

| Folder | Where Used |
|--------|------------|
| `_copilot_tomai` | tool-executors.ts (guideline executor) |
| `_copilot_local` | tool-executors.ts (guideline executor) |
| `ztmp` | debugLogger.ts L40 |
| `local-instructions` | expandPrompt-handler.ts (`.tom/local-instructions/`) |
| `json-schema` | panelYamlStore.ts, chatVariablesEditor-handler.ts |
| `notes` (home) | dsNotes-handler.ts (`~/.tom/notes/global_notes.md`) |
| `prompt` (AI sub) | reusablePromptEditor-handler.ts (`_ai/prompt/`) |
| `trail/escalation` | trailLogger-handler.ts (`_ai/trail/escalation/`) |

---

## 2. Hardcoded Path Strings NOT Using WsPaths

### `_ai/` paths with inline string literals

| File | Line | Hardcoded String | Should Use |
|------|------|-----------------|------------|
| [questTodoManager.ts](src/managers/questTodoManager.ts#L129) | 129 | `path.join(wsRoot, '_ai', 'schemas', 'yaml', 'todo.schema.json')` | `WsPaths.ai('schemas', 'todo.schema.json')` |
| [questTodoManager.ts](src/managers/questTodoManager.ts#L665) | 665 | `sourceFile.startsWith('_ai/')` | `WsPaths.aiFolder + '/'` |
| [questTodoManager.ts](src/managers/questTodoManager.ts#L670) | 670 | `!sourceFile.startsWith('_ai/')` | `WsPaths.aiFolder + '/'` |
| [variableResolver.ts](src/utils/variableResolver.ts#L245) | 245 | `'_ai/chat_replies'` | `WsPaths.aiRelative('chatReplies')` |
| [variableResolver.ts](src/utils/variableResolver.ts#L255) | 255 | `path.join(os.homedir(), '.tom', 'chat_replies')` | `WsPaths.home('chatReplies')` |
| [trailViewer-handler.ts](src/handlers/trailViewer-handler.ts#L330) | 330 | `'_ai/trail'` (warning message) | `WsPaths.aiRelative('trail')` |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L580) | 580 | `'_ai/quests/${quest}/quest-notes.${quest}.md'` | Use `WsPaths.ai('quests', quest, ...)` |
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L704) | 704 | `path.join(..., '_ai', 'tom_ai_chat')` fallback | Already has `WsPaths.ai('tomAiChat')` — remove literal fallback |
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts#L2346) | 2346 | `path.join(..., '_ai', 'tom_ai_chat')` fallback | Same as above |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L2046) | 2046 | `path.join(..., '_ai', 'tom_ai_chat')` fallback | Same as above |
| [timerEngine.ts](src/managers/timerEngine.ts#L418) | 418 | `'../../_ai/schemas/yaml/timed.schema.json'` | Use `WsPaths.ai('schemas', ...)` |
| [promptQueueManager.ts](src/managers/promptQueueManager.ts#L898) | 898 | `'../../_ai/schemas/yaml/queue.schema.json'` | Use `WsPaths.ai('schemas', ...)` |

### `_copilot_tomai/` and `_copilot_local/` paths

| File | Line | Hardcoded String |
|------|------|-----------------|
| [tool-executors.ts](src/tools/tool-executors.ts#L445) | 445 | `'_copilot_tomai/'` in description string |
| [tool-executors.ts](src/tools/tool-executors.ts#L449) | 449 | `createGuidelineExecutor('_copilot_tomai')` |
| [tool-executors.ts](src/tools/tool-executors.ts#L456) | 456 | `'_copilot_local/'` in description string |
| [tool-executors.ts](src/tools/tool-executors.ts#L460) | 460 | `createGuidelineExecutor('_copilot_local')` |
| [tool-executors.ts](src/tools/tool-executors.ts#L484) | 484 | `'_copilot_tomai'` |
| [tool-executors.ts](src/tools/tool-executors.ts#L490) | 490 | `'_copilot_local'` |

### `_copilot_guidelines/` fallback paths (WsPaths used but with inline fallback)

| File | Line | Hardcoded String |
|------|------|-----------------|
| [t3Panel-handler.ts](src/handlers/t3Panel-handler.ts#L201) | 201 | `path.join(wsRoot, '_copilot_guidelines')` fallback |
| [t3Panel-handler.ts](src/handlers/t3Panel-handler.ts#L722) | 722 | `path.join(wsRoot, '_copilot_guidelines')` fallback |
| [t3Panel-handler.ts](src/handlers/t3Panel-handler.ts#L764) | 764 | `path.join(wsRoot, '_copilot_guidelines')` fallback |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L2599) | 2599 | `path.join(rootPath, '_copilot_guidelines')` fallback |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L2644) | 2644 | `path.join(wsFolder, '_copilot_guidelines')` fallback |

### `.tom_metadata/` fallback paths

| File | Line | Hardcoded String |
|------|------|-----------------|
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts#L1852) | 1852 | `path.join(wsRoot, '.tom_metadata', 'tom_master.yaml')` fallback |
| [contextSettingsEditor-handler.ts](src/handlers/contextSettingsEditor-handler.ts#L159) | 159 | `path.join(wsRoot, '.tom_metadata', 'tom_master.yaml')` fallback |

### `.github/` fallback paths

| File | Line | Hardcoded String |
|------|------|-----------------|
| [tomAiChat-utils.ts](src/handlers/tomAiChat-utils.ts#L26) | 26 | `path.join(workspaceRoot, '.github', 'copilot-instructions.md')` fallback |
| [t3Panel-handler.ts](src/handlers/t3Panel-handler.ts#L725) | 725 | `path.join(wsRoot, '.github')` fallback |
| [t3Panel-handler.ts](src/handlers/t3Panel-handler.ts#L778) | 778 | `path.join(wsRoot, '.github')` fallback |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L2594) | 2594 | `path.join(rootPath, '.github', 'copilot-instructions.md')` fallback |

### `.tom/` hardcoded paths (not using WsPaths.wsConfig)

| File | Line | Hardcoded String |
|------|------|-----------------|
| [panelYamlStore.ts](src/utils/panelYamlStore.ts#L170) | 170 | `'../../.tom/json-schema/panels/prompt.schema.json'` |
| [chatVariablesEditor-handler.ts](src/handlers/chatVariablesEditor-handler.ts#L150) | 150 | `'../../.tom/json-schema/panels/chatvars.schema.json'` |
| [minimalMode-handler.ts](src/handlers/minimalMode-handler.ts#L55) | 55 | `'create a .tom/ folder'` string literal |
| [minimalMode-handler.ts](src/handlers/minimalMode-handler.ts#L134) | 134 | `'.tom/'` in HTML |
| [minimalMode-handler.ts](src/handlers/minimalMode-handler.ts#L135) | 135 | `'.tom/tom_vscode_extension.json'` in HTML |

### `ztmp/` hardcoded path

| File | Line | Hardcoded String |
|------|------|-----------------|
| [debugLogger.ts](src/utils/debugLogger.ts#L40) | 40 | `path.join(wsRoot, 'ztmp', DEBUG_LOG_FILE_NAME)` |

### `~/.tom/notes/` hardcoded path

| File | Line | Hardcoded String |
|------|------|-----------------|
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L577) | 577 | `path.join(HOME, WsPaths.homeTomFolder, 'notes', 'global_notes.md')` |

---

## 3. Hardcoded File Extension Patterns

### `.todo.yaml` (widely used — structural, likely intentional)

Used in 20+ locations across `questTodoManager.ts`, `questTodoPanel-handler.ts`, `questTodoEditor-handler.ts`, `contextSettingsEditor-handler.ts`, `dsNotes-handler.ts`. This is a format identifier and probably should remain hardcoded as a constant, but could be centralized.

### `.prompt.md`

| File | Line | Context |
|------|------|---------|
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts#L1098) | 1098 | `.filter((file) => file.endsWith('.prompt.md'))` |
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts#L1259) | 1259 | `'Enter filename (without .prompt.md)'` |
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts#L1271) | 1271 | `` `${normalized}.prompt.md` `` |
| [reusablePromptEditor-handler.ts](src/handlers/reusablePromptEditor-handler.ts#L270) | 270 | `.filter(f => f.endsWith('.prompt.md'))` |
| [reusablePromptEditor-handler.ts](src/handlers/reusablePromptEditor-handler.ts#L417) | 417 | `placeHolder: 'my_prompt.prompt.md'` |
| [reusablePromptEditor-handler.ts](src/handlers/reusablePromptEditor-handler.ts#L420) | 420–436 | Multiple `.prompt.md` string checks |
| [reusablePromptEditor-handler.ts](src/handlers/reusablePromptEditor-handler.ts#L797) | 797 | `'No .prompt.md files in this scope'` |

### `.answers.md` / `.prompts.md` / `.trail.md`

| File | Line | Context |
|------|------|---------|
| [botConversation-handler.ts](src/handlers/botConversation-handler.ts#L952) | 952 | `` `${workspaceName}.answers.md` `` |
| [botConversation-handler.ts](src/handlers/botConversation-handler.ts#L953) | 953 | `` `${workspaceName}.trail.md` `` |
| [trailEditor-handler.ts](src/handlers/trailEditor-handler.ts#L177) | 177 | `.endsWith('.prompts.md') \|\| .endsWith('.answers.md')` |
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts#L248) | 248 | `` `${workspaceName}.answers.md` `` |
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts#L1573) | 1573–1574 | `.answers.md` and `.trail.md` |
| [todoLogPanel-handler.ts](src/handlers/todoLogPanel-handler.ts#L103) | 103 | `'*.answers.md'` glob pattern |

### `.flow.yaml` / `.state.yaml` / `.er.yaml`

| File | Line | Context |
|------|------|---------|
| [extension.ts](src/extension.ts#L331) | 331 | `*.flow.yaml, *.state.yaml, *.er.yaml` registration comment |
| [yamlGraph-handler.ts](src/handlers/yamlGraph-handler.ts#L27) | 27 | `*.flow.yaml, *.state.yaml, *.er.yaml` |

### `.chat.md`

| File | Line | Context |
|------|------|---------|
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L498) | 498 | `filePath.endsWith('.chat.md')` |

### `.schema.json`

| File | Line | Context |
|------|------|---------|
| [panelYamlStore.ts](src/utils/panelYamlStore.ts#L170) | 170 | `prompt.schema.json` relative path |
| [chatVariablesEditor-handler.ts](src/handlers/chatVariablesEditor-handler.ts#L150) | 150 | `chatvars.schema.json` relative path |
| [questTodoManager.ts](src/managers/questTodoManager.ts#L129) | 129 | `todo.schema.json` |

### `workspace.todo.yaml` (hardcoded filename)

| File | Line |
|------|------|
| [questTodoManager.ts](src/managers/questTodoManager.ts#L779) | 779 |
| [questTodoManager.ts](src/managers/questTodoManager.ts#L825) | 825 |
| [contextSettingsEditor-handler.ts](src/handlers/contextSettingsEditor-handler.ts#L199) | 199, 201, 224, 226, 332, 333 |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L579) | 579 |
| [questTodoPanel-handler.ts](src/handlers/questTodoPanel-handler.ts#L2237) | 2237, 2358, 2869 |

### `copilot-instructions.md` (hardcoded filename)

| File | Line |
|------|------|
| [tomAiChat-utils.ts](src/handlers/tomAiChat-utils.ts#L26) | 26 |
| [tomAiChat-utils.ts](src/handlers/tomAiChat-utils.ts#L144) | 144 |
| [t3Panel-handler.ts](src/handlers/t3Panel-handler.ts#L779) | 779 |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L2594) | 2594, 2596, 2667 |

### `tom_master.yaml` (hardcoded filename)

| File | Line |
|------|------|
| [tomAiChat-utils.ts](src/handlers/tomAiChat-utils.ts#L115) | 115 |
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts#L1852) | 1852 |
| [contextSettingsEditor-handler.ts](src/handlers/contextSettingsEditor-handler.ts#L159) | 159 |

### `global_notes.md` (hardcoded filename)

| File | Line |
|------|------|
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L577) | 577 |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L797) | 797, 855, 856 |

---

## 4. Hardcoded Model Names

| File | Line | Model Name | Context |
|------|------|------------|---------|
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L479) | 479 | `gpt-5.2` | Default `tomAiChat.modelId` fallback |
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L480) | 480 | `gpt-4o` | Default `tomAiChat.tokenModelId` fallback |
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L481) | 481 | `gpt-5-mini` | Default `tomAiChat.preProcessingModelId` fallback |
| [handler_shared.ts](src/handlers/handler_shared.ts#L366) | 366 | `gpt-4o` | Default `copilotModel` config value |
| [vscode-bridge.ts](src/vscode-bridge.ts#L742) | 742 | `gpt-4` | Model family for LM API call |
| [vscode-bridge.ts](src/vscode-bridge.ts#L978) | 978 | `gpt-4` | Model family for LM API call |
| [escalation-tools-config.ts](src/tools/escalation-tools-config.ts#L105) | 105 | `GPT-5.2` | Default `askBigBrother.defaultModel` |
| [escalation-tools-config.ts](src/tools/escalation-tools-config.ts#L113) | 113 | `gpt-4o` | Default `askBigBrother.summarizationModel` |
| [escalation-tools-config.ts](src/tools/escalation-tools-config.ts#L122) | 122–124 | `claude-3.5-sonnet`, `claude-3-opus`, `gpt-4o`, `o1`, `o3`, `gpt-4o-mini` | Model recommendations text |
| [expandPrompt-handler.ts](src/handlers/expandPrompt-handler.ts#L205) | 205 | `qwen3:8b` | Default Ollama model |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L256) | 256, 258 | `qwen3:8b`, `llama3:70b` | Ollama model prompt/placeholder |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L839) | 839 | `qwen3:8b` | Status page Ollama model default |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L1757) | 1757 | `gpt-4o` | Summarization model default in webview JS |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L2470) | 2470 | `qwen3:8b` | Ollama config webview default |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L2489) | 2489 | `qwen3:8b` | Hardcoded default object |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L1132) | 1132 | `qwen3:8b` | Prompt expander model default |
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts#L2356) | 2356 | `claude-sonnet-4-20250514` | Help text model example |
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts#L2357) | 2357 | `gpt-4.1-mini` | Help text token model example |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L2056) | 2056 | `claude-sonnet-4-20250514` | Help text model example |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L2057) | 2057 | `gpt-4.1-mini` | Help text token model example |

---

## 5. Hardcoded URLs

### Ollama URL (`http://localhost:11434`)

| File | Line |
|------|------|
| [expandPrompt-handler.ts](src/handlers/expandPrompt-handler.ts#L204) | 204 |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L247) | 247 |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L266) | 266 |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L320) | 320 |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L838) | 838 |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L857) | 857 |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L2470) | 2470 |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L2488) | 2488 |
| [dsNotes-handler.ts](src/handlers/dsNotes-handler.ts#L1131) | 1131 |

**Total:** 9 occurrences across 3 files. Should use a single `DEFAULT_OLLAMA_URL` constant.

### Telegram API (`api.telegram.org`)

| File | Line |
|------|------|
| [chat/telegram-channel.ts](src/handlers/chat/telegram-channel.ts#L187) | 187 |
| [chat/telegram-channel.ts](src/handlers/chat/telegram-channel.ts#L330) | 330 |
| [chat/telegram-channel.ts](src/handlers/chat/telegram-channel.ts#L370) | 370 |
| [chat-enhancement-tools.ts](src/tools/chat-enhancement-tools.ts#L58) | 58 |

**Note:** The `api.telegram.org` hostname is correct and unlikely to change, but the repeated literal could be a constant.

### GitHub API (`https://api.github.com`)

| File | Line |
|------|------|
| [githubApi.ts](src/handlers/githubApi.ts#L90) | 90 |

Already defined as `const API_BASE` — good pattern.

### CLI Server Port (`19900`)

| File | Line |
|------|------|
| [cliServer-handler.ts](src/handlers/cliServer-handler.ts#L12) | 12 |
| [cliServer-handler.ts](src/handlers/cliServer-handler.ts#L54) | 54–55 (comment: port range 19900-19909) |
| [cliServer-handler.ts](src/handlers/cliServer-handler.ts#L140) | 140 (error message: `19900-19909`) |

`DEFAULT_CLI_SERVER_PORT` is defined as a local constant but the range `19900-19909` is hardcoded in comments/messages.

---

## 6. Magic Numbers (Timeouts, Limits, Delays)

### Named Constants (defined but only used locally)

| File | Line | Constant | Value | Purpose |
|------|------|----------|-------|---------|
| [timerEngine.ts](src/managers/timerEngine.ts#L64) | 64 | `CHECK_INTERVAL_MS` | `30_000` | Timer tick interval |
| [chatVariablesStore.ts](src/managers/chatVariablesStore.ts#L44) | 44 | `MAX_CHANGE_LOG` | `100` | Change log entry limit |
| [promptQueueManager.ts](src/managers/promptQueueManager.ts#L64) | 64 | `MAX_SENT_HISTORY` | `50` | Sent items history limit |
| [promptQueueManager.ts](src/managers/promptQueueManager.ts#L65) | 65 | `MAX_TOTAL_ITEMS` | `100` | Total queue items limit |
| [variableResolver.ts](src/utils/variableResolver.ts#L75) | 75 | `GIT_CACHE_TTL` | `5000` | Git info cache TTL (ms) |
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L163) | 163 | `DEFAULT_MAX_CONTEXT_CHARS` | `50000` | Max context chars |
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L164) | 164 | `DEFAULT_MAX_TOOL_RESULT_CHARS` | `50000` | Max tool result chars |
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L165) | 165 | `DEFAULT_MAX_DRAFT_CHARS` | `8000` | Max draft chars |
| [cliServer-handler.ts](src/handlers/cliServer-handler.ts#L12) | 12 | `DEFAULT_CLI_SERVER_PORT` | `19900` | CLI server port |
| [telegram-cmd-response.ts](src/handlers/telegram-cmd-response.ts#L24) | 24 | `TELEGRAM_MAX_MESSAGE` | `4096` | Telegram max message length |
| [telegram-cmd-response.ts](src/handlers/telegram-cmd-response.ts#L27) | 27 | `DEFAULT_TRUNCATE_LIMIT` | `4000` | Default truncate limit |
| [escalation-tools-config.ts](src/tools/escalation-tools-config.ts#L77) | 77 | (default) `answerFileTimeout` | `120000` | Ask Copilot answer timeout |
| [escalation-tools-config.ts](src/tools/escalation-tools-config.ts#L78) | 78 | (default) `pollInterval` | `2000` | Answer file poll interval |
| [escalation-tools-config.ts](src/tools/escalation-tools-config.ts#L110) | 110 | (default) `maxToolResultChars` | `10000` | Big Brother tool result limit |
| [escalation-tools-config.ts](src/tools/escalation-tools-config.ts#L111) | 111 | (default) `responseTimeout` | `120000` | Big Brother response timeout |
| [escalation-tools-config.ts](src/tools/escalation-tools-config.ts#L118) | 118 | (default) `maxResponseChars` | `20000` | Summarize above this |

### Inline Magic Numbers (no constant defined)

| File | Line | Value | Context |
|------|------|-------|---------|
| [tool-executors.ts](src/tools/tool-executors.ts#L268) | 268 | `15000` | HTTP request timeout (web search) |
| [tool-executors.ts](src/tools/tool-executors.ts#L953) | 953 | `30000` | Ask Copilot LM API timeout |
| [vscode-bridge.ts](src/vscode-bridge.ts#L114) | 114 | `30000` | Default Dart bridge request timeout |
| [vscode-bridge.ts](src/vscode-bridge.ts#L256) | 256 | `1000` | Restart delay (ms) |
| [vscode-bridge.ts](src/vscode-bridge.ts#L334) | 334 | `5000` | Restart timer delay |
| [vscode-bridge.ts](src/vscode-bridge.ts#L367) | 367 | `2000` | Reconnect delay |
| [extension.ts](src/extension.ts#L381) | 381 | `2000` | Telegram polling start delay |
| [extension.ts](src/extension.ts#L989) | 989 | `5000` | Reminder notification delay |
| [commandline-handler.ts](src/handlers/commandline-handler.ts#L442) | 442 | `300` | Post-command delay |
| [commandline-handler.ts](src/handlers/commandline-handler.ts#L745) | 745 | `10000` | Command execution timeout |
| [botConversation-handler.ts](src/handlers/botConversation-handler.ts#L1405) | 1405 | `1000` | Polling delay between turns |
| [issuesPanel-handler.ts](src/handlers/issuesPanel-handler.ts#L1018) | 1018 | `50` | Resize debounce |
| [issuesPanel-handler.ts](src/handlers/issuesPanel-handler.ts#L1396) | 1396 | `5000` | Toast notification auto-dismiss |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L2719) | 2719 | `500` | Status page refresh delay |
| [notepad-handler.ts](src/handlers/notepad-handler.ts#L212) | 212 | `500` | Autosave debounce |
| [questTodoPanel-handler.ts](src/handlers/questTodoPanel-handler.ts#L146) | 146 | `500` | Panel initialization delay |
| [t3Panel-handler.ts](src/handlers/t3Panel-handler.ts#L120) | 120 | `500` | Status data refresh delay |
| [reloadWindow-handler.ts](src/handlers/reloadWindow-handler.ts#L33) | 33 | `1000` | Notification timeout |
| [queueEditor-handler.ts](src/handlers/queueEditor-handler.ts#L86) | 86 | `500` | State send delay |
| [queueEditor-handler.ts](src/handlers/queueEditor-handler.ts#L872) | 872 | `3000` | Feedback auto-clear |
| [timedRequestsEditor-handler.ts](src/handlers/timedRequestsEditor-handler.ts#L87) | 87 | `500` | State send delay |
| [timedRequestsEditor-handler.ts](src/handlers/timedRequestsEditor-handler.ts#L802) | 802 | `3000` | Feedback auto-clear |
| [reminderSystem.ts](src/managers/reminderSystem.ts#L136) | 136 | `30_000` | Timeout check interval |
| [promptQueueManager.ts](src/managers/promptQueueManager.ts#L123) | 123 | `2000` | Auto-send delay default |
| [promptQueueManager.ts](src/managers/promptQueueManager.ts#L481) | 481 | `500` | Minimum auto-send delay |
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L792) | 792 | `128` | Max tools limit |
| [telegram-channel.ts](src/handlers/chat/telegram-channel.ts#L194) | 194 | `30000` | HTTP request timeout |
| [telegram-channel.ts](src/handlers/chat/telegram-channel.ts#L337) | 337 | `10000` | Send message timeout |
| [telegram-channel.ts](src/handlers/chat/telegram-channel.ts#L377) | 377 | `10000` | API call timeout |

### Other Numeric Limits

| File | Line | Value | Context |
|------|------|-------|---------|
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L486) | 486 | `100` | Default `maxIterations` |
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L484) | 484 | `50000` | Default `responsesTokenLimit` |
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L485) | 485 | `8000` | Default `responseSummaryTokenLimit` |
| [tomAiChat-handler.ts](src/handlers/tomAiChat-handler.ts#L907) | 907 | `2000` | Tool result truncation limit |
| [statusPage-handler.ts](src/handlers/statusPage-handler.ts#L824) | 824 | `1000` | Default `trailMaxEntries` |
| [expandPrompt-handler.ts](src/handlers/expandPrompt-handler.ts#L210) | 210 | `8000` | Trail maximum tokens |
| [expandPrompt-handler.ts](src/handlers/expandPrompt-handler.ts#L213) | 213 | `4000` | Max history tokens |
| [escalation-tools-config.ts](src/tools/escalation-tools-config.ts#L107) | 107 | `5` | Max tool invocation iterations |
| [escalation-tools-config.ts](src/tools/escalation-tools-config.ts#L106) | 106 | `0.7` | Default temperature |

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Path strings not using WsPaths | **~30** occurrences |
| Folder names missing from WsPaths | **8** folders |
| Hardcoded fallback paths (duplicating WsPaths) | **~15** |
| Hardcoded model names | **~20** occurrences across 8 files |
| `http://localhost:11434` repetitions | **9** occurrences across 3 files |
| `api.telegram.org` repetitions | **4** occurrences |
| File extension patterns scattered | **50+** (`.todo.yaml`, `.prompt.md`, `.answers.md`, etc.) |
| Inline magic numbers (no constant) | **~30** occurrences |
| Named constants (local, not configurable) | **~17** |

### Priority Recommendations

1. **HIGH** — Add `_copilot_tomai`, `_copilot_local`, `ztmp`, `json-schema`, `local-instructions` to WsPaths
2. **HIGH** — Extract `DEFAULT_OLLAMA_URL = 'http://localhost:11434'` to a shared constant
3. **HIGH** — Extract default model names (`qwen3:8b`, `gpt-4o`, `gpt-5.2`) to a shared defaults module
4. **MEDIUM** — Remove inline `.tom_metadata`, `.github`, `_copilot_guidelines` fallback strings (use `WsPaths.xxx()!` with assertion or `??` from WsPaths)
5. **MEDIUM** — Centralize file extension constants (`.todo.yaml`, `.prompt.md`, `.answers.md`, `.trail.md`, `.chat.md`)
6. **MEDIUM** — Extract Telegram channel timeouts (`30000`, `10000`) into named constants
7. **LOW** — Extract UI delay constants (debounce `500ms`, toast `3000ms`, `5000ms`) to a shared UI constants module
8. **LOW** — Centralize bridge timeouts (`30000`, `5000`, `2000`, `1000`) into DartBridge config
