# Reusable Component Analysis

This document summarizes reusable components currently used across the extension.

## Webview UI Components

### Accordion Panel ([src/handlers/accordionPanel.ts](../../src/handlers/accordionPanel.ts))

Used by:

- `@CHAT` ([chatPanel-handler.ts](../../src/handlers/chatPanel-handler.ts))
- `@WS` ([wsPanel-handler.ts](../../src/handlers/wsPanel-handler.ts))
- Quest TODO panel ([questTodoPanel-handler.ts](../../src/handlers/questTodoPanel-handler.ts))
- Minimal mode ([minimalMode-handler.ts](../../src/handlers/minimalMode-handler.ts))

Provides:

- pin / unpin behavior,
- section collapse / expand,
- persisted expanded state,
- rotation to vertical tabs for collapsed sections (see [tab_navigation.md](../../_copilot_guidelines/tab_navigation.md)),
- codicon title integration,
- optional additional CSS / JS injection.

### Tab Panel ([src/handlers/tabPanel.ts](../../src/handlers/tabPanel.ts))

Reusable tab abstraction for webview sections where strict tabbed interaction is needed. Used by the accordion for collapsed-section rotation.

### Shared HTML / CSS fragments

- Issues fragment helpers (`issuesPanel-handler.ts`).
- Quest TODO fragment helpers (`questTodoPanel-handler.ts`).
- Markdown preview helper (`markdownHtmlPreview.ts`) — also used by the Markdown Browser (`markdownBrowser-handler.ts`).
- Queue entry component (`queueEntryComponent.ts`) — shared between queue editor and timed requests editor.

## Shared Logic Components

### Path and workspace utilities

- `WsPaths` for workspace-resolved folders.
- `handler_shared` helper set for config and template handling.

### State/Store components

- `ChatVariablesStore`
- `WindowSessionTodoStore`
- `PromptQueueManager`
- `TimerEngine`
- `ReminderSystem`

### YAML graph modular stack

- `yaml-graph-core` (conversion + graph registry)
- `yaml-graph-vscode` (provider/webview coordination)
- Extension glue (`yamlGraph-handler.ts`)

## Reuse Opportunities

- Move repeated toolbar HTML snippets to shared render helpers.
- Normalize webview message envelope typings between panel handlers.
- Consolidate common editor popup patterns used for template/profile editing.
