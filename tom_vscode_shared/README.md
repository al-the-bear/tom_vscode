# tom_vscode_shared

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](LICENSE).

Shared TypeScript building blocks for the Tom VS Code extensions: a typed model
for `*.todo.yaml` files, the file/directory machinery that reads and writes them,
a workspace scanner that builds a todo tree and its dependency links, and a
Mermaid flowchart renderer for visualising that tree. It is the common library
the [`tom_vscode_workflow`](../tom_vscode_workflow/README.md) panels and the
[`tom_vscode_extension`](../tom_vscode_extension/README.md) are built on.

---

## Overview

`tom_vscode_shared` is a dependency-light library (only `yaml`) with three
cooperating concerns:

1. **Types** — one shared model for todos, scopes, references, files, trees,
   dependency links, and render results, so every consumer speaks the same shape.
2. **Todo file management** — read, create, and update todo items inside
   `*.todo.yaml` files, list files in a directory, and collect tags.
3. **Scanning & rendering** — find the scan root, gather todo files across a
   workspace, build a directory/file tree, extract dependency links, and render
   the result to a Mermaid flowchart with per-node actions.

It has no VS Code API dependency — it is pure data + rendering logic — so it is
trivially unit-testable and reusable from any Node context.

---

## Installation

Internal workspace library; consume it by path:

```json
// package.json
"dependencies": {
  "tom-vscode-shared": "file:../tom_vscode_shared"
}
```

```bash
npm run compile   # tsc -p ./  → out/index.js + out/index.d.ts
```

Runtime dependency: `yaml ^2.8.2`. Build: TypeScript `^5.3.0`, `@types/node`.

---

## Features

### Types (`types.ts`)

| Type | Purpose |
| --- | --- |
| `TodoItem` | A single todo parsed from a `*.todo.yaml` file (id, title, status, priority, tags, scope, references, dependencies, blocked_by, dates…). |
| `TodoScope` | Scope metadata — `project` / `module` / `area` / `files`. |
| `TodoReference` | A reference link on a todo (`type` / `path` / `url` / `description`). |
| `TodoFile` | A file plus its parsed `items`. |
| `TodoTreeNode` | A node in the directory/file tree (`directory` or `file`, with `children` and `todos`). |
| `TodoDependencyLink` | A `depends_on` / `blocked_by` edge between two todos. |
| `NodeAction` | An action attached to a diagram node (`openFile` / `selectTodo` / `openDirectory`). |
| `RenderResult` | A rendered flowchart — the `mermaid` string + a `nodeActions` map. |

### Todo file management (`todoFileManager.ts`)

| Function | Purpose |
| --- | --- |
| `readTodoFile(filePath)` | Parse the items in one todo file. |
| `findTodoByIdInFile(filePath, todoId)` | Find a single todo by id. |
| `listTodoFiles(dirPath)` | List `*.todo.yaml` files in a directory. |
| `readAllTodosInDirectory(dirPath)` | Read every todo across a directory. |
| `ensureTodoFile(filePath, meta?)` | Create the file with header metadata if absent. |
| `createTodoInFile(...)` / `updateTodoInFile(...)` | Add / mutate a todo in place. |
| `collectAllTags(dirPath)` | Gather the distinct tags across a directory. |

### Scanning & rendering (`todoScanner.ts`, `mermaidFlowchartRenderer.ts`)

| Function | Purpose |
| --- | --- |
| `findScanRoot(startPath)` | Resolve the root to scan from. |
| `scanTodoFiles(rootPath)` | Gather todo files (relative paths) under a root. |
| `buildTodoTree(rootPath, relativeFiles)` | Build the directory/file `TodoTreeNode` tree. |
| `extractDependencyLinks(root)` | Collect the `depends_on` / `blocked_by` edges. |
| `collectAllTodoIds(root)` | Collect the set of todo ids in the tree. |
| `renderFlowchart(root, links)` | Render the tree + links to a `RenderResult` (Mermaid + node actions). |

---

## Quick start

```ts
import {
  findScanRoot,
  scanTodoFiles,
  buildTodoTree,
  extractDependencyLinks,
  renderFlowchart,
} from 'tom-vscode-shared';

const root = findScanRoot(process.cwd());
const files = scanTodoFiles(root);
const tree = buildTodoTree(root, files);
const links = extractDependencyLinks(tree);

const { mermaid, nodeActions } = renderFlowchart(tree, links);
console.log(mermaid);          // → "flowchart TD\n  classDef ...\n  ..."
// nodeActions maps each node id to an openFile / selectTodo / openDirectory action
```

---

## Usage

### Read and update todos

```ts
import {
  readTodoFile,
  findTodoByIdInFile,
  createTodoInFile,
  updateTodoInFile,
  collectAllTags,
} from 'tom-vscode-shared';

const todos = readTodoFile('quests/vscode_extension/todos.vscode_extension.todo.yaml');
const one = findTodoByIdInFile('todos.todo.yaml', 'TD-12');

createTodoInFile('todos.todo.yaml', { id: 'TD-99', title: 'New task', status: 'open' });
updateTodoInFile('todos.todo.yaml', 'TD-99', { status: 'in_progress' });

const tags = collectAllTags('quests/vscode_extension');
```

### Scan a workspace and render

`scanTodoFiles` + `buildTodoTree` give you the structured tree;
`extractDependencyLinks` adds the cross-todo edges; `renderFlowchart` turns both
into a Mermaid diagram plus a `nodeActions` map a webview can wire to click
handlers (open the file, select the todo, open the directory).

---

## Architecture

```
              types.ts
        (the shared todo model)
                  │
     ┌────────────┼─────────────────────┐
     ▼            ▼                      ▼
todoFileManager  todoScanner   mermaidFlowchartRenderer
 read/create/    findScanRoot/  renderFlowchart(tree, links)
 update todos    scanTodoFiles/   → RenderResult
                 buildTodoTree/
                 extractDependencyLinks
                  │
                  ▼
            consumers: tom_vscode_workflow panels,
                       tom_vscode_extension
```

`index.ts` re-exports the public surface (the types plus the function groups
above). Everything is pure TypeScript over the `yaml` parser; there is no VS Code
or DOM dependency, which is what keeps the library reusable and testable.

---

## Ecosystem

- [`tom_vscode_workflow`](../tom_vscode_workflow/README.md) — the TODO-tracking
  panels built directly on this library.
- [`tom_vscode_extension`](../tom_vscode_extension/README.md) — the extension
  that surfaces the todo trees and flowcharts.
- [Repository map](../README.md) — the whole Tom VS Code ecosystem at a glance.

---

## Status

| | |
| --- | --- |
| Name | `tom-vscode-shared` |
| Version | 0.1.0 |
| Runtime dependency | `yaml ^2.8.2` |
| Build | `npm run compile` (TypeScript `^5.3.0`) |
| Tests | none in-package (covered through `tom_vscode_extension`'s suites) |
| License | BSD-3-Clause |

---

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](LICENSE).
</content>
