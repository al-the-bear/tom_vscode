# YAML Graph Architecture Design

This document captures the currently implemented architecture (not a proposal).

## 1. Integration boundary

Extension integration point: `src/handlers/yamlGraph-handler.ts`.

Responsibilities:

- import graph modules dynamically,
- create engine + registry,
- register graph types from package graph-types folder,
- register `yamlGraph.editor` provider.

## 2. Provider stack

Provider class: `YamlGraphEditorProvider` from `yaml-graph-vscode`.

Collaborators:

- `WebviewManager`
- `SelectionCoordinator`
- `TreeDataBuilder`
- `NodeEditorController`
- `SourceSyncManager`

## 3. Source of truth

The YAML text document is authoritative.

All node operations ultimately apply edits to the text document. Visual/tree state is recomputed from document text.

## 4. Type resolution

Graph type resolution requires:

- matching filename pattern,
- numeric `meta.graph-version`.

Lookup uses `GraphTypeRegistry.getForFileVersion(...)`.

## 5. Conversion lifecycle

- parse YAML,
- select graph type mapping,
- run conversion engine,
- render Mermaid source,
- include conversion/validation errors in webview updates.

## 6. Debounce and sync

Document-change to render updates are debounced (default 1000ms) to reduce churn during typing.

Side-by-side source synchronization is managed through `SourceSyncManager`.

## 7. Error model

- Dynamic-import failure: logs error; extension continues.
- Parse/type errors: shown through VS Code errors and/or webview fallback HTML.
- Conversion errors: surfaced in update payload.
