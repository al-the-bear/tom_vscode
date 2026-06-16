# tom_vscode_workflow

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](LICENSE).

TOM Tracker — a lightweight VS Code extension that surfaces the workspace's
`*.todo.yaml` tree as an interactive `@TODO` bottom panel and a clickable
mindmap. It is the panel-facing companion to
[`tom_vscode_shared`](../tom_vscode_shared/README.md), which it uses to scan,
read, update, and render todo files.

---

## Overview

`tom_vscode_workflow` (display name **TOM Tracker**) is a self-contained VS Code
extension focused on TODO-oriented workflows. Where
[`tom_vscode_shared`](../tom_vscode_shared/README.md) provides the pure todo
model, scanner, and Mermaid renderer, this package wires that logic into VS Code
surfaces:

1. **The `@TODO` bottom panel** — an accordion webview (`tomTracker.todoPanel`)
   with a tracker graph, a todo list, and two free-form note editors.
2. **The TODO mindmap** — a full-tab Mermaid flowchart of every `*.todo.yaml`
   under the scan root, with click-to-open navigation.
3. **A YAML Graph custom editor** — registered opportunistically from
   [`yaml_graph_core`](../yaml_graph_core/README.md) /
   [`yaml_graph_vscode`](../yaml_graph_vscode/README.md) when those packages
   resolve, and silently skipped otherwise.

All disk-facing logic — finding the scan root, gathering files, parsing items,
mutating todos, rendering the flowchart — is delegated to
`tom-vscode-shared`; this package owns only the VS Code glue (webviews,
commands, logging, error capture).

---

## Installation

Internal workspace extension; build it from source:

```bash
npm install
npm run compile      # tsc -p ./  → out/extension.js
```

It depends on the **DartScript extension** at runtime — `extensionDependencies`
lists `tom.dartscript-vscode`, so VS Code installs that alongside it.

Workspace library dependencies are consumed by path:

```json
// package.json
"dependencies": {
  "tom-vscode-shared": "file:../tom_vscode_shared",
  "yaml-graph-core": "file:../yaml_graph_core",
  "yaml-graph-vscode": "file:../yaml_graph_vscode",
  "@vscode/codicons": "^0.0.44",
  "yaml": "^2.8.2"
}
```

VS Code engine `^1.96.0`. Activation: `onStartupFinished`.

---

## Features

### Commands

| Command id | Title | Purpose |
| --- | --- | --- |
| `tomTracker.showLog` | TOM Tracker: Show Log | Reveal the "Tom Tracker Log" output channel. |
| `tomTracker.showDebugLog` | TOM Tracker: Show Debug Log | Reveal the "Tom Tracker Debug Log" output channel. |
| `tomTracker.showTodoMindmap` | TOM Tracker: Show TODO Mindmap | Open the workspace-wide `*.todo.yaml` Mermaid flowchart. |

### Views

| Contribution | Id | Where |
| --- | --- | --- |
| Panel container | `tomTracker-todo-panel` (`@TODO`, `$(checklist)`) | Bottom panel. |
| Webview view | `tomTracker.todoPanel` (`@TODO`) | Inside the container. |

### `@TODO` panel sections

The panel is an accordion (`components/accordionPanel.ts`) with four sections:

| Section | Role |
| --- | --- |
| **TRACKER** | Graph/overview of the tracked todos. |
| **TODOS** | The scanned todo items (via `scanTodoFiles` + `readTodoFile`), editable in place (`updateTodoInFile`). |
| **FILE1** / **FILE2** | Free-form note editors over `todo1.md` / `todo2.md` in the workspace root, auto-saved on a debounce timer. |

### Infrastructure

| Capability | Provided by |
| --- | --- |
| Centralized logging (output channel, console, file) | `infrastructure/logger.ts` (`log`, `debug`, `showLog`, `showDebugLog`). |
| Global error handlers + command/listener wrappers | `infrastructure/errorCapture.ts` (`installGlobalErrorHandlers`, `wrapCommand`, `wrapListener`, `reportError`). |

---

## Quick start

1. Build and launch the extension (`npm run compile`, then run the
   Extension Development Host).
2. Open the **@TODO** bottom panel — the accordion shows the tracker, todo list,
   and the two note editors.
3. Run **TOM Tracker: Show TODO Mindmap** from the command palette to render the
   whole `*.todo.yaml` tree as a Mermaid flowchart; click a node to open the file
   or reveal the todo.

---

## Usage

### Browsing and editing todos

The `@TODO` panel scans from the workspace root, lists the todos it finds, and
writes edits straight back into the source `*.todo.yaml` files through
`tom-vscode-shared`. The two note editors (FILE1/FILE2) are a scratch space:
they read and auto-save `todo1.md` / `todo2.md` in the workspace root.

### The mindmap

`tomTracker.showTodoMindmap` resolves the scan root
(`master.mindmap.yaml` / topmost `.git`), gathers every `*.todo.yaml`, builds
the directory/file tree, extracts dependency links, and renders a Mermaid
`flowchart TD` (bundled `lib/mermaid.min.js`). Nodes are color-coded by status;
`depends_on` / `blocked_by` edges are dotted. Clicking a node posts back to the
extension, which opens the file, selects the todo, or reveals the directory.

---

## Architecture

```
                  extension.ts
        (activation: logger + error handlers,
         command + panel + mindmap + graph editor)
                       │
     ┌─────────────────┼──────────────────────┐
     ▼                 ▼                        ▼
  handlers/         components/           infrastructure/
  flowPanel-        accordionPanel        logger.ts
   handler.ts        (reused UI)          errorCapture.ts
  todoMindmap-
   handler.ts
     │
     ▼
  tom-vscode-shared  (scan / read / update / renderFlowchart)
  yaml-graph-core + yaml-graph-vscode  (optional custom editor)
```

| Component | File | Responsibility |
| --- | --- | --- |
| Entry point | `extension.ts` | Activation/deactivation, command + view + custom-editor registration. |
| `@TODO` panel | `handlers/flowPanel-handler.ts` | `WebviewViewProvider` for the accordion panel and todo/file editing. |
| Mindmap | `handlers/todoMindmap-handler.ts` | Full-tab Mermaid flowchart panel + node-click navigation. |
| Accordion UI | `components/accordionPanel.ts` | Reusable collapsible-section HTML builder. |
| Logging | `infrastructure/logger.ts` | Output-channel + console + file logging. |
| Error capture | `infrastructure/errorCapture.ts` | Global handlers and command/listener wrappers. |

The YAML Graph custom editor is registered through dynamic `import()` so a
missing `yaml-graph-*` package degrades gracefully instead of failing
activation.

---

## Ecosystem

- [`tom_vscode_shared`](../tom_vscode_shared/README.md) — the todo model,
  scanner, and Mermaid renderer this extension is built on.
- [`yaml_graph_core`](../yaml_graph_core/README.md) /
  [`yaml_graph_vscode`](../yaml_graph_vscode/README.md) — the optional YAML
  Graph custom editor.
- [`tom_vscode_extension`](../tom_vscode_extension/README.md) — the main Tom AI
  extension; the `@TODO` mindmap is adapted from its preview handlers.
- [Repository map](../README.md) — the whole Tom VS Code ecosystem at a glance.

---

## Status

| | |
| --- | --- |
| Name | `tom-vscode-workflow` (display name **TOM Tracker**) |
| Version | 0.1.0 |
| VS Code engine | `^1.96.0` |
| Runtime dependencies | `tom-vscode-shared`, `yaml-graph-core`, `yaml-graph-vscode`, `@vscode/codicons`, `yaml` |
| Extension dependency | `tom.dartscript-vscode` |
| Build | `npm run compile` (TypeScript `^5.3.0`) |
| Lint | `npm run lint` (`eslint src --ext ts`) |
| Tests | none in-package |
| License | BSD-3-Clause |

---

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](LICENSE).
