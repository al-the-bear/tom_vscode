# yaml_graph_vscode

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](LICENSE).

VS Code custom-editor integration for YAML-graph files, built on the
[`yaml_graph_core`](../yaml_graph_core/README.md) conversion engine.

---

## Status: decoupled from the Tom AI extension

This package is **no longer consumed by the Tom AI extension**. The YAML Graph
editor feature was removed from `tom_vscode_extension` in commit `3b0b63d` — the
custom-editor contribution, `yamlValidation` schema entries, the
`yaml-graph-core` / `yaml-graph-vscode` `file:` dependencies, the
`registerYamlGraphEditor` call, and the related build steps were all stripped out.
`yaml_graph_vscode` now stands alone: it builds and tests on its own, but nothing
in the active extension imports it.

The removed extension-side glue (handler, sample graphs, docs) is preserved under
[`_extension_backup/`](_extension_backup/README.md) — see that folder's README
for the file-by-file inventory and the revival path.

---

## What it does

`yaml-graph-vscode` adapts the
[`yaml_graph_core`](../yaml_graph_core/README.md) engine to VS Code: a custom
editor that renders graph YAML as an interactive diagram and syncs edits back to
source. The public surface (`src/index.ts`) centres on
`YamlGraphEditorProvider`, `VsCodeCallbacks`, `WebviewManager`,
`SelectionCoordinator`, `TreeDataBuilder`, `SourceSyncManager`,
`NodeEditorController`, and `SchemaResolver`.

```bash
npm run build    # tsc → dist/
npm test         # vitest run
```

Runtime dependencies: `yaml ^2.6.0`, `yaml-graph-core` (`file:../yaml_graph_core`).

---

## Where to look next

- [`yaml_graph_core`](../yaml_graph_core/README.md) — the conversion engine this
  integration is built on (also decoupled).
- [`_extension_backup/`](_extension_backup/README.md) — the removed extension
  glue, kept for a possible revival.
- [Repository map](../README.md) — the whole Tom VS Code ecosystem, including
  where `yaml_graph_*` sits relative to the active extension.

---

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](LICENSE).
