# Reusable Component Analysis

This document summarizes reusable components currently used across the extension.

## Webview UI Components

### Accordion Panel (`src/handlers/accordionPanel.ts`)

Used by:

- `@CHAT` (`unifiedNotepad-handler.ts`)
- `@WS` (`t3Panel-handler.ts`)

Provides:

- pin/unpin behavior,
- section collapse/expand,
- persisted expanded state,
- codicon title integration,
- optional additional CSS/JS injection.

### Tab Panel (`src/handlers/tabPanel.ts`)

Reusable tab abstraction for webview sections where strict tabbed interaction is needed.

### Shared HTML/CSS fragments

- Issues fragment helpers (`issuesPanel-handler.ts`)
- Quest TODO fragment helpers (`questTodoPanel-handler.ts`)
- Markdown preview helper (`markdownHtmlPreview.ts`)

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
