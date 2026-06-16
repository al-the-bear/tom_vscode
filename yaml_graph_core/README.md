# yaml_graph_core

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](LICENSE).

A YAML-graph → Mermaid conversion engine with configurable, schema-validated
type mappings.

---

## Status: decoupled from the Tom AI extension

This package is **no longer consumed by the Tom AI extension**. The YAML Graph
editor feature was removed from `tom_vscode_extension` in commit `3b0b63d` — no
handler, contribution, `file:` dependency, or build step remains. `yaml_graph_core`
now stands alone: it builds and tests on its own, but nothing in the active
extension imports it.

The companion package
[`yaml_graph_vscode`](../yaml_graph_vscode/README.md) keeps the removed
extension-side glue under `yaml_graph_vscode/_extension_backup/` should the
feature ever be revived.

---

## What it does

`yaml-graph-core` parses graph-shaped YAML files, validates them against
per-domain JSON schemas, and converts them into Mermaid diagrams via configurable
mappings. The public surface (`src/index.ts`) centres on `ConversionEngine`,
`GraphTypeRegistry`, `MappingLoader`, `SchemaValidator`, `SchemaResolver`,
`YamlParserWrapper`, and `AstNodeTransformerRuntime`.

```bash
npm run build    # tsc → dist/
npm test         # vitest run
```

Runtime dependencies: `yaml ^2.6.0`, `ajv ^8.17.0`.

---

## Where to look next

- [Repository map](../README.md) — the whole Tom VS Code ecosystem, including
  where `yaml_graph_*` sits relative to the active extension.
- [`yaml_graph_vscode`](../yaml_graph_vscode/README.md) — the VS Code
  custom-editor integration built on this engine (also decoupled).

---

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](LICENSE).
