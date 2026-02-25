# YAML Graph Editor

## Current Status

The YAML Graph editor is implemented and registered as a custom text editor (`yamlGraph.editor`) during extension activation.

Supported file patterns:

- `*.flow.yaml`
- `*.state.yaml`
- `*.er.yaml`

## Runtime Architecture

The extension-level registration (`src/handlers/yamlGraph-handler.ts`) dynamically imports:

- `yaml-graph-core` (conversion + graph type registry)
- `yaml-graph-vscode` (provider, webview coordination, source sync)

Graph types are auto-loaded from `yaml-graph-core/graph-types`.

## Required YAML metadata

Each graph file must contain numeric `meta.graph-version`.

Without this field, graph type resolution fails and the custom editor reports an error.

## Editing and Rendering Flow

1. Document opens in custom editor.
2. Graph type resolves by filename + `meta.graph-version`.
3. YAML converts to Mermaid source.
4. Webview updates tree + Mermaid preview.
5. Source document changes trigger debounced re-render.

## Failure Behavior

- If YAML graph packages fail to import, extension activation continues (feature disabled only for graph editor).
- If a graph type cannot be resolved, the webview shows a scoped error panel.

## Related Docs

- `yaml_graph_architecture_design.md`
- `diagram_editing.md`
