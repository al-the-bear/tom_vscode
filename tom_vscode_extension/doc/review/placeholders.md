# Placeholder Replacements and Usable Placeholders

This document reviews placeholder behavior across all components listed in code_structure.md. For each component group it explains:

- Which replacement engine is used.
- Which placeholder syntaxes are actually replaced.
- Which placeholders are usable in that component's real execution paths.

## Method and Coverage

- Component baseline: doc/review/code_structure.md (10 component groups under Component Breakdown).
- Evidence source: static code inspection of resolver and consumer call sites.
- Placeholder systems covered:
  - Unified resolver: src/utils/variableResolver.ts
  - Prompt expansion: src/handlers/promptTemplate.ts
  - Path wrapper: src/handlers/handler_shared.ts resolvePathVariables
  - Config-level placeholder resolver: src/utils/executableResolver.ts
  - Trail token resolvers: src/services/trailService.ts and src/handlers/trailViewer-handler.ts
  - Reminder template replacement: src/managers/reminderSystem.ts
  - Component-specific direct replacements in notes and window status handlers

## Placeholder Engines Overview

| Engine | Syntax | Typical consumers | Unresolved behavior |
| --- | --- | --- | --- |
| resolveVariables / resolveVariablesAsync | `${key}`, `${namespace.key}`, `${{expression}}` | Path fields, commandline paths, queue affixes | Empty string by default, or keep token when requested |
| expandTemplate | `${key}`, `{{key}}`, `${{expression}}` | Copilot/chat templates, queue wrapping, notes preview | Empty string |
| expandConfigPlaceholders | `${binaryPath}`, `${home}`, `${workspaceFolder}`, `${env:VARNAME}`, `~` | Executable and commandline config fields | Keeps unknown placeholders except env fallback behavior |
| trailService.resolvePathTokens | `${workspaceFolder}`, `${ai}`, `${username}`, `${home}`, `${quest}`, `${subsystem}` | Trail raw/summary path patterns | Only these tokens are supported |
| trailViewer.resolveTrailPathTokens | `${workspaceFolder}`, `${ai}`, `${home}`, `${username}` (strips `${quest}`, `${subsystem}`) | Trail viewer root discovery | Limited manual token set |
| reminderSystem template replace | `{{timeoutMinutes}}`, `{{waitingMinutes}}`, etc. | Reminder prompt generation | Non-listed tokens remain unchanged |

## Use-Case Placeholder Matrix

| Use case | Replacement path | Usable placeholders |
| --- | --- | --- |
| Prompt/body template expansion | expandTemplate | Full resolver set from PLACEHOLDER_HELP, plus caller values like `${originalPrompt}`, `${goal}`, `${response}`, `${notesFile}` |
| File/path/cwd expansion | resolvePathVariables -> resolveVariables | Resolver `${...}` tokens, namespaces (`env.`, `config.`, `git.`, `chat.`, `vscode.`), `${{...}}`; no `{{...}}` support |
| Executable/config placeholders | expandConfigPlaceholders | `${binaryPath}`, `${home}`, `${workspaceFolder}`, `${env:VARNAME}`, `~` |
| Trail storage patterns | resolvePathTokens (trail service) | `${workspaceFolder}`, `${ai}`, `${username}`, `${home}`, `${quest}`, `${subsystem}` |
| Trail viewer path normalization | resolveTrailPathTokens | `${workspaceFolder}`, `${ai}`, `${home}`, `${username}` and token stripping for `${quest}`, `${subsystem}` |
| Reminder templates | reminderSystem manual replacements | `{{timeoutMinutes}}`, `{{waitingMinutes}}`, `{{originalPrompt}}`, `{{followUpIndex}}`, `{{followUpTotal}}`, `{{sentAt}}`, `{{followUpText}}`, `{{promptId}}`, `{{promptType}}`, `{{status}}`, `{{template}}`, `{{requestId}}`, `{{expectedRequestId}}`, `{{createdAt}}`, `{{reminderSentCount}}`, `{{queueLength}}` |
| Quest notes/todo path patterns | sidebarNotes manual replace | `${quest}` and `${workspaceFolder}` |
| Window status local folder | windowStatusPanel manual replace | `${ai}` only |

## Component-by-Component Analysis

### 1) Bridge, Execution, CLI, and Integrations

Representative files:

- src/handlers/commandline-handler.ts
- src/handlers/restartBridge-handler.ts
- src/handlers/tomScriptingBridge-handler.ts

Replacement behavior:

- commandline-handler expands command fields in two stages:
  - Config placeholders via expandConfigPlaceholders and executable placeholders (`${executable.name}`).
  - Generic path placeholders via resolvePathVariables.
- restartBridge-handler resolves profile cwd via resolvePathVariables.

Usable placeholders in this component:

- Config placeholders: `${binaryPath}`, `${home}`, `${workspaceFolder}`, `${env:VARNAME}`, `~`.
- Generic resolver placeholders for path-like fields: `${workspaceFolder}`, `${home}`, `${file}`, `${env.*}`, `${git.*}`, `${chat.*}`, `${vscode.*}`, `${{expression}}`.

Notes:

- Any field that only passes through config expansion does not automatically gain the full prompt template placeholder surface.

### 2) Chat, Copilot, and Local LLM Flows

Representative files:

- src/handlers/chatPanel-handler.ts
- src/handlers/aiConversation-handler.ts
- src/handlers/localLlm-handler.ts
- src/managers/chatVariablesStore.ts

Replacement behavior:

- Prompt sending flows call expandTemplate for user prompt text, selected templates, and answer-file wrappers.
- aiConversation file-context reads first resolve file paths with resolvePathVariables.
- Chat variable and response-value namespaces feed into resolver maps used by template expansion.

Usable placeholders in this component:

- Full expandTemplate set:
  - `${...}` (including resolver namespaces and built-ins from PLACEHOLDER_HELP).
  - `{{...}}` (legacy mustache form resolved against same values map).
  - `${{...}}` JavaScript expressions.
- Caller-provided placeholders in specific flows:
  - `${originalPrompt}`, `${goal}`, `${response}`, `${notesFile}` (where passed).

Notes:

- This is the broadest placeholder surface in the extension.

### 3) Core Extension Wiring

Representative files:

- src/handlers/handler_shared.ts
- src/handlers/promptTemplate.ts

Replacement behavior:

- handler_shared exposes resolvePathVariables as the standard path placeholder entrypoint.
- promptTemplate exports expandTemplate and re-exports PLACEHOLDER_HELP from variableResolver.

Usable placeholders in this component:

- All placeholders supported by resolveVariables and expandTemplate, depending on caller path.

Notes:

- This layer owns placeholder contract exposure, not component-specific token subsets.

### 4) General Handlers

Representative files:

- src/handlers/globalTemplateEditor-handler.ts
- src/handlers/contextSettingsEditor-handler.ts
- src/handlers/reusablePromptEditor-handler.ts

Replacement behavior:

- General editors mostly expose placeholder help and collect template text.
- Expansion is typically deferred to runtime consumers (chat/queue/tools) rather than performed directly in these handlers.

Usable placeholders in this component:

- Whatever placeholders the downstream consumer supports.
- Template authoring UIs present PLACEHOLDER_HELP to users for guidance.

Notes:

- This component is placeholder-definition UX, not a primary replacement engine.

### 5) Queue, Timed Requests, and Scheduling

Representative files:

- src/managers/promptQueueManager.ts
- src/managers/reminderSystem.ts
- src/handlers/queueEditor-handler.ts
- src/handlers/timedRequestsEditor-handler.ts

Replacement behavior:

- Queue prompt expansion pipeline:
  - resolveVariables on repetition affixes with explicit values (`repeatCount`, `repeatIndex`, `repeatNumber`).
  - expandTemplate for body/template/wrapper expansion.
- ReminderSystem does direct chained string replacements on mustache tokens.

Usable placeholders in this component:

- Queue body/wrappers: full expandTemplate support.
- Repeat affix fields: `${repeatCount}`, `${repeatIndex}`, `${repeatNumber}` and other resolveVariables-compatible `${...}` tokens.
- Reminder templates: only the explicit mustache token list handled in reminderSystem.

Notes:

- Reminder editor help in queue/timed handlers documents reminder placeholders using `${...}` notation, while runtime replacement uses `{{...}}` tokens.

### 6) Shared Infrastructure and Contracts

Representative files:

- src/utils/variableResolver.ts
- src/utils/executableResolver.ts
- src/utils/workspacePaths.ts
- src/utils/tomAiConfiguration.ts

Replacement behavior:

- variableResolver builds the canonical values map and handles dynamic namespaces (`env.`, `config.`, `git.`, `chat.`, `vscode.`, `date.`, `time.`).
- executableResolver handles config-level placeholders for binary and executable settings.
- Workspace path defaults in configuration include tokenized patterns later consumed by trail and other services.

Usable placeholders in this component:

- Canonical placeholder catalog listed in PLACEHOLDER_HELP.
- Config placeholder subset in executableResolver.

Notes:

- This component defines the contract; other components implement subsets or wrappers of this behavior.

### 7) Todo, Notes, and Work Tracking

Representative files:

- src/handlers/sidebarNotes-handler.ts
- src/handlers/questTodoPanel-handler.ts
- src/managers/questTodoManager.ts

Replacement behavior:

- Notes send/preview flow uses expandTemplate with additional value `${notesFile}`.
- Quest note/todo path patterns in sidebarNotes are resolved by manual `.replace()` for `${quest}` and `${workspaceFolder}`.
- questTodoPanel resolves username and prompt templates via resolvePathVariables/expandTemplate.

Usable placeholders in this component:

- Notes content templates: full expandTemplate surface plus `${notesFile}`.
- Quest note/todo path patterns: `${quest}` and `${workspaceFolder}` only.
- Username template path: resolvePathVariables `${...}` surface.

Notes:

- There is mixed engine usage in one component: full resolver for text flows, targeted manual replacement for quest path patterns.

### 8) Tooling Surface and Model Tools

Representative files:

- src/tools/tool-executors.ts
- src/tools/local-llm-tools-config.ts

Replacement behavior:

- Tool file-path inputs call resolvePathVariables before workspace path normalization.
- askCopilot tool expands selected template and answer wrapper with expandTemplate.

Usable placeholders in this component:

- Tool path args: resolvePathVariables `${...}` support.
- Tool prompt templates: full expandTemplate support and `${originalPrompt}` wrapper chaining.

Notes:

- Tooling inherits behavior from core engines and does not define a separate placeholder language.

### 9) Trail and Markdown Views

Representative files:

- src/services/trailService.ts
- src/handlers/trailViewer-handler.ts

Replacement behavior:

- trailService path generation uses a dedicated resolvePathTokens with a limited token set.
- trailViewer has a second dedicated resolver that also strips `${quest}` and `${subsystem}` for folder discovery.

Usable placeholders in this component:

- trailService: `${workspaceFolder}`, `${ai}`, `${username}`, `${home}`, `${quest}`, `${subsystem}`.
- trailViewer: `${workspaceFolder}`, `${ai}`, `${home}`, `${username}`; `${quest}` and `${subsystem}` are removed.

Notes:

- Trail path handling is intentionally narrower than the global resolver.

### 10) Window Layout, Panels, and UI Shell

Representative files:

- src/handlers/windowStatusPanel-handler.ts
- src/utils/sendToChatConfig.ts

Replacement behavior:

- windowStatusPanel local folder resolution manually replaces `${ai}` and resolves relative-to-workspace path.
- sendToChatConfig documents `${ai}` support for window-state folder settings.

Usable placeholders in this component:

- `${ai}` for window status local folder.

Notes:

- This component does not use the full resolver for window state path handling.

## Review Findings and Risks

1. Reminder placeholder notation mismatch

- UI help in queue/timed editors displays reminder placeholders as `${timeoutMinutes}` style.
- Runtime replacement in reminderSystem uses `{{timeoutMinutes}}` style.
- Impact: user-authored reminder templates can silently fail when authored with the wrong syntax.

1. Multiple token engines with different capability and fallback rules

- Full resolver, promptTemplate, config placeholder resolver, trail token resolvers, and manual replacements coexist.
- Impact: portability of templates/path patterns across components is low; tokens valid in one place can be ignored in another.

1. Manual replacement islands bypass canonical resolver

- sidebarNotes quest patterns and windowStatus local folder use narrow direct replacement instead of resolveVariables.
- Impact: duplicated token logic and higher drift risk when placeholder catalog evolves.

## Practical Guidance

- Use expandTemplate for prompt/body text whenever broad placeholder support is desired.
- Use resolvePathVariables for path-like values that should honor global `${...}` resolver behavior.
- Use reminder templates with mustache token syntax (`{{...}}`) until runtime and help text are unified.
- Treat trail path patterns and window status paths as limited-token contexts, not global placeholder contexts.
