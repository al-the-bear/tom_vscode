# Diagram Editing in YAML Graph Editor

This document describes the implemented editing flow in the custom YAML Graph editor.

## Editor Runtime

The extension registers `yamlGraph.editor` as a `CustomTextEditorProvider` for:

- `*.flow.yaml`
- `*.state.yaml`
- `*.er.yaml`

Provider wiring lives in `src/handlers/yamlGraph-handler.ts` and delegates to `yaml-graph-vscode`.

## Main Interaction Model

The editor uses a split model:

- Visual graph view (Mermaid preview in webview).
- Structured tree/navigation data.
- Source YAML document as authoritative state.

`SourceSyncManager` keeps source and webview aligned; document updates are debounced before re-render.

## Type Resolution Rules

A file must include numeric `meta.graph-version`.

If missing or unsupported:

- the editor shows an error message,
- rendering does not proceed,
- source remains editable in text mode.

## Node Editing Flow

At a high level:

1. Webview sends edit/select messages.
2. `SelectionCoordinator` routes actions.
3. `NodeEditorController` computes edits.
4. Text edits apply to YAML document.
5. Updated YAML is converted and rendered again.

## Error Handling

The provider intentionally fails soft:

- dynamic import errors do not break extension activation,
- unresolved graph type shows an in-webview error,
- parse/convert errors are returned to the webview diagnostics channel.

## Current Constraints

- Graph behavior is bounded by registered graph type mappings.
- `meta.graph-version` is mandatory for graph type lookup.
- Mermaid interaction support varies by diagram type/mapping.

## Related Docs

- `yaml_graph.md`
- `yaml_graph_architecture_design.md`
- `../_copilot_guidelines/vscode_extension_overview.md`
