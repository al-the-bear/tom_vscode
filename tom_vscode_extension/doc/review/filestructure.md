# Tom VS Code Extension File Structure

This document is the structural baseline for a full-scale code review of Tom VS Code Extension.

## Scope

- Project root: `tom_ai/vscode/tom_vscode_extension`
- Snapshot type: repository layout + source subsystem map
- Snapshot excludes generated/vendor folders from topology analysis: `.git/`, `node_modules/`, `out/`

## Root Topology

### Top-level directories

- `.vscode/`
- `_copilot_guidelines/`
- `bin/`
- `doc/`
- `example/`
- `resources/`
- `src/`

### Runtime and build anchors

| Path | Purpose |
| --- | --- |
| `package.json` | Extension manifest, contributes, scripts |
| `tsconfig.json` | TypeScript compiler configuration |
| `README.md` | Main project overview |
| `buildkit.yaml` | Build and workspace automation config |
| `tom_project.yaml` | Project metadata/config |

## Documentation Topology

| Path | Purpose |
| --- | --- |
| `doc/` | User and project documentation |
| `doc/information/` | Internal/explanatory notes |
| `doc/refactoring/` | Refactoring analyses and plans |
| `doc/review/` | Structured review documents and outputs |

## Source Topology

### Source root map

| Path | Role |
| --- | --- |
| `src/extension.ts` | Extension activation, initialization, command registration |
| `src/vscode-bridge.ts` | Bridge runtime/client integration |
| `src/tests.ts` | Extension test bootstrap |
| `src/config/` | Static config payloads bundled with extension |
| `src/handlers/` | Command/webview/panel feature handlers |
| `src/managers/` | Stateful orchestrators and workflow controllers |
| `src/services/` | Service-layer components |
| `src/storage/` | File-backed storage modules |
| `src/tools/` | Tool registration and tool executor implementations |
| `src/types/` | Shared type contracts |
| `src/utils/` | Cross-cutting helper utilities |

### Source module size snapshot

- Total TypeScript files under `src/`: 107
- `src/handlers/`: 65
- `src/managers/`: 11
- `src/utils/`: 18
- `src/tools/`: 6
- `src/services/`: 2
- `src/storage/`: 1
- `src/types/`: 1

## Subsystem Breakdown

### Handlers (`src/handlers/`)

Primary entry surface for UI and command behavior. Largest subsystem and main review hotspot.

Key clusters:

- Chat and Copilot flows: `chatPanel-handler.ts`, `tomAiChat-handler.ts`, `copilotTemplates-handler.ts`, `chatVariablesEditor-handler.ts`
- Queue/TODO workflows: `queueEditor-handler.ts`, `queueTemplateEditor-handler.ts`, `questTodoEditor-handler.ts`, `todoLogPanel-handler.ts`
- Bridge and automation: `cliServer-handler.ts`, `tomScriptingBridge-handler.ts`, `restartBridge-handler.ts`
- Panel and shell UI: `statusPage-handler.ts`, `windowStatusPanel-handler.ts`, `wsPanel-handler.ts`
- Graph/trail/docs tooling: `yamlGraph-handler.ts`, `stateMachine-handler.ts`, `trailEditor-handler.ts`, `trailViewer-handler.ts`, `markdownBrowser-handler.ts`

### Managers (`src/managers/`)

Stateful orchestration layer.

- Queue lifecycle: `promptQueueManager.ts`
- Timers/reminders: `timerEngine.ts`, `reminderSystem.ts`
- Variables/session state: `chatVariablesStore.ts`, `sessionTodoStore.ts`, `chatTodoSessionManager.ts`
- TODO domain: `questTodoManager.ts`, `todoProvider.ts`

### Services + storage + utils

- Storage: `src/storage/queueFileStorage.ts`
- Services: `src/services/trailService.ts`, `src/services/trailLogging.ts`
- Utilities: path/workspace resolution, debug/queue logging, template/variable resolution, config helpers, reusable webview helpers

## Tests Placement

Colocated test files discovered in `__tests__` folders:

- `src/handlers/__tests__/tomAiChat-utils.test.ts`
- `src/managers/__tests__/noReminder.test.ts`
- `src/managers/__tests__/step3QueueBehavior.test.ts`
- `src/managers/__tests__/step4WatchdogAndAnswerDetection.test.ts`
- `src/utils/__tests__/queueLogger.test.ts`
- `src/utils/__tests__/step5FileNamingAndMigration.test.ts`

Total colocated test files: 6

## Structural Review Hotspots

This topology indicates priority review zones:

- High concentration and coupling risk in `src/handlers/`
- Cross-layer queue behavior (`handlers <-> managers <-> storage`)
- Placeholder/value resolution path (`tools/`, `handlers/`, `utils/`, `managers/`)
- Utility surface growth in `src/utils/` (cohesion and duplication risk)

This file acts as the baseline for deeper review artifacts (dependency map, risk register, test-gap analysis, and remediation plan).
