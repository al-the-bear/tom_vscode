# Extension YAML Graph backup

These files were removed from `tom_vscode_extension` when the YAML Graph editor
feature was retired from the extension. They are preserved here in case the
feature is revived (the `yaml_graph_core` / `yaml_graph_vscode` packages
themselves remain intact).

Original locations within `tom_vscode_extension/`:

| Backup path | Original path |
| --- | --- |
| `src/handlers/yamlGraph-handler.ts` | `src/handlers/yamlGraph-handler.ts` |
| `example/graph_samples/*.yaml` | `example/graph_samples/*.yaml` |
| `doc/yaml_graph.md` | `doc/yaml_graph.md` |
| `doc/yaml_graph_architecture_design.md` | `doc/yaml_graph_architecture_design.md` |
| `doc/diagram_editing.md` | `doc/diagram_editing.md` |
| `doc/information/mermaid_diagrams.md` | `doc/information/mermaid_diagrams.md` |

What was also removed from the extension (not files, so not backed up here):

- `tomAi.yamlGraphEditor` custom-editor contribution and the three
  `yamlValidation` schema entries in `package.json`.
- The `yaml-graph-core` / `yaml-graph-vscode` `file:` dependencies in
  `package.json`.
- The `registerYamlGraphEditor` export (`src/handlers/index.ts`) and its call
  in `src/extension.ts`.
- The `GLOB_FLOW` / `GLOB_STATE` / `GLOB_ER` constants in
  `src/utils/constants.ts`.
- The `yaml_graph_core` / `yaml_graph_vscode` build steps in
  `install_extension.sh` / `install_extension.ps1`.
- The yaml-graph exclusions in `.vscodeignore`.
