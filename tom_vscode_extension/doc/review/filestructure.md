# Tom VS Code Extension File Structure

This document outlines the current file structure of `tom_vscode_extension` as a baseline for a full-scale code review.

## Review Scope

- Project root: `tom_ai/vscode/tom_vscode_extension`
- Snapshot depth: up to 3 directory levels for overview
- Excluded from structural listing: `.git/`, `node_modules/`, `out/`

## Root Layout

| Path | Purpose |
| --- | --- |
| `src/` | Main TypeScript source code for extension runtime |
| `doc/` | User and design documentation |
| `doc/review/` | Review workspace and review-specific documents |
| `_copilot_guidelines/` | Project-specific development and architecture guidelines |
| `example/` | Usage examples, graph sample files, script examples |
| `resources/` | Extension static assets (icons, webview assets) |
| `bin/` | Platform-specific helper binaries |
| `.vscode/` | Local launch/task configuration for development |
| `package.json` | Extension manifest, commands, contributes, scripts |
| `tsconfig.json` | TypeScript compiler configuration |
| `README.md` | Project overview and setup |
| `buildkit.yaml` | Build configuration |
| `tom_project.yaml` | Project metadata/configuration |

## Source Structure

### Source Root

| Path | Role |
| --- | --- |
| `src/extension.ts` | Main activation entry point and registration wiring |
| `src/vscode-bridge.ts` | Bridge entry and integration logic |
| `src/tests.ts` | VS Code extension test bootstrap |
| `src/config/` | Static configuration payloads |
| `src/handlers/` | UI panels, commands, chat flows, editor handlers |
| `src/managers/` | Runtime orchestration managers and state controllers |
| `src/services/` | Service-layer helpers |
| `src/storage/` | File-backed persistence utilities |
| `src/tools/` | Copilot/chat tool registration and execution |
| `src/types/` | Shared typing contracts |
| `src/utils/` | Generic utilities, path/config/logging helpers |

### Source Module Size Snapshot

- Total TypeScript files in `src/`: 107
- `src/handlers/`: 65 files
- `src/managers/`: 11 files
- `src/utils/`: 18 files
- `src/tools/`: 6 files
- `src/services/`: 2 files
- `src/storage/`: 1 file
- `src/types/`: 1 file

## Handler Subsystem Map

`src/handlers/` is the largest subsystem and contains feature-oriented handlers.

Main clusters:

- Chat and Copilot integration:
  - `chatPanel-handler.ts`
  - `tomAiChat-handler.ts`
  - `tomAiChat-utils.ts`
  - `copilotTemplates-handler.ts`
  - `chatVariablesEditor-handler.ts`
- Queue and TODO workflows:
  - `queueEditor-handler.ts`
  - `queueTemplateEditor-handler.ts`
  - `questTodoEditor-handler.ts`
  - `questTodoPanel-handler.ts`
  - `todoLogPanel-handler.ts`
- Bridge and automation:
  - `cliServer-handler.ts`
  - `tomScriptingBridge-handler.ts`
  - `executeInTomAiBuild-handler.ts`
  - `restartBridge-handler.ts`
- UI panel infrastructure:
  - `accordionPanel.ts`
  - `tabPanel.ts`
  - `windowStatusPanel-handler.ts`
  - `statusPage-handler.ts`
  - `wsPanel-handler.ts`
- Graph/document tooling:
  - `yamlGraph-handler.ts`
  - `stateMachine-handler.ts`
  - `markdownBrowser-handler.ts`
  - `trailEditor-handler.ts`
  - `trailViewer-handler.ts`

## Manager Subsystem Map

`src/managers/` centralizes stateful orchestration:

- `promptQueueManager.ts` for queue lifecycle and file synchronization
- `timerEngine.ts` and `reminderSystem.ts` for scheduled execution/reminders
- `questTodoManager.ts`, `sessionTodoStore.ts`, `chatTodoSessionManager.ts` for todo state domains
- `chatVariablesStore.ts` for variable persistence and resolution
- `todoProvider.ts` for provider-level todo integration

## Storage, Services, and Utility Layers

- `src/storage/queueFileStorage.ts` provides queue file read/write and persistence helpers.
- `src/services/trailService.ts` and `src/services/trailLogging.ts` provide trail-oriented service behavior.
- `src/utils/` contains cross-cutting helpers:
  - path and workspace resolution
  - debug and queue logging
  - config and constants
  - webview base abstractions
  - variable resolution and send-to-chat support

## Tests and Test Placement

Current in-source tests are colocated in `__tests__` directories:

- `src/handlers/__tests__/tomAiChat-utils.test.ts`
- `src/managers/__tests__/noReminder.test.ts`
- `src/managers/__tests__/step3QueueBehavior.test.ts`
- `src/managers/__tests__/step4WatchdogAndAnswerDetection.test.ts`
- `src/utils/__tests__/queueLogger.test.ts`
- `src/utils/__tests__/step5FileNamingAndMigration.test.ts`

Total test files in these colocated folders: 6

## Documentation Structure

| Path | Focus |
| --- | --- |
| `doc/user_guide.md` | User-facing extension usage |
| `doc/quick_reference.md` | Command and behavior quick lookup |
| `doc/yaml_graph.md` | YAML graph feature docs |
| `doc/yaml_graph_architecture_design.md` | YAML graph architecture |
| `doc/refactoring/` | Refactor analyses and plans |
| `doc/information/` | Additional internal information pages |

## Review Guidance Derived from Structure

The structural hotspots for deep review are:

- `src/handlers/` due to size and feature concentration.
- Queue and TODO flow across handler-manager-storage layers.
- Chat and tool execution boundaries across handlers and `src/tools/`.
- Utility growth in `src/utils/` to monitor cohesion and avoid overlap.

This file is intended as the baseline map for follow-up review documents (architecture risks, coupling analysis, test coverage analysis, and remediation plan).
