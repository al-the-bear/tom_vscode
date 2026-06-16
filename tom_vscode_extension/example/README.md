# tom_vscode_extension — examples

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](../LICENSE).

A small set of **extension-side** examples: script files the extension can
execute over the bridge, and copy-and-edit configuration samples. These are
specific to the extension itself — for the Dart **scripting API** samples
(driving VS Code from a Dart program) see the canonical home linked below.

---

## What's here

### Script-execution samples

The extension can run JS/TS files and inline scripts through the bridge
(`tomAi.executeFile` / `tomAi.executeScript`), passing a `context` with `vscode`,
`bridge`, and `console`. These files are runnable demonstrations of that surface:

| File | Demonstrates | Run via |
| --- | --- | --- |
| [`example_script.js`](example_script.js) | `module.exports = async (params, context)` — access workspace folders, make nested calls back to the Dart bridge, return structured results. | `@T: Execute File` (`tomAi.executeFile`) |
| [`example_inline_script.js`](example_inline_script.js) | An inline script body for `executeScript` — read params, use the `vscode` API without `module.exports`, return a value. | `@T: Execute as Script` (`tomAi.executeScript`) |
| [`nested_execution_example.ts`](nested_execution_example.ts) | A multi-hop TS → Dart → TS execution flow where each nested call completes before the next returns. | `@T: Execute File` on the compiled output, or as a reference. |

### Configuration samples

Copy-and-edit starting points for the extension's on-disk config (shape defined
by `src/config/tom_vscode_extension.schema.json` ⇄ `src/utils/sendToChatConfig.ts`):

| File | Purpose |
| --- | --- |
| [`tom_vscode_extension.json`](tom_vscode_extension.json) | A worked **workspace** config sample — post-actions, send-to-chat config, panels, etc. Copy to `.tom/tom_vscode_extension.json` in a workspace and trim to taste. |
| [`tom_vscode_extension.user.sample.yaml`](tom_vscode_extension.user.sample.yaml) | A **user-global** config overlay sample. Its header documents where to copy it; the overlay supplies defaults when the workspace config omits a key. |

### `graph_samples/` (empty)

This directory is a leftover of the removed YAML Graph editor feature
(`3b0b63d`). The graph fixtures it used to hold are preserved with the rest of
the removed glue under
`../../yaml_graph_vscode/_extension_backup/example/graph_samples/`. The YAML
Graph packages are otherwise decoupled — see
[`yaml_graph_core`](../../yaml_graph_core/README.md) /
[`yaml_graph_vscode`](../../yaml_graph_vscode/README.md).

---

## Running the examples

Script execution runs against a **live window** — the extension must be
installed and active.

**From the Command Palette / Explorer:**

1. Open a `.dart`, `.js`, or `.ts` file (or right-click it in the Explorer).
2. Run **@T: Execute File** (`tomAi.executeFile`) or **@T: Execute as Script**
   (`tomAi.executeScript`).

**From Dart (via the scripting API / bridge):**

```dart
final result = await vscode.workspace.executeFile(
  filePath: 'example/example_script.js',
  params: {'verbose': true},
);
```

**Bridge test runner.** The extension also ships a built-in runner
(`BridgeTestRunner` in `src/tests.ts`) exposed as **@T: Run Tests**
(`tomAi.runTests`); it executes the D4rt test scripts under
`tom_vscode_bridge/test/` and writes per-test JSON results.

---

## Looking for the Dart scripting samples?

The runnable **Dart** samples that drive VS Code through the scripting API live
in their own canonical home:

- [`tom_vscode_scripting_api/example/`](../../tom_vscode_scripting_api/example/README.md)
  — connect to a window, edit files, run commands, use the agent tools and the
  Agent SDK; each is a self-contained project with a full article README.

---

## Where to look next

- [`tom_vscode_extension`](../README.md) — the extension itself (handlers,
  panels, config shape, commands).
- [`tom_vscode_bridge`](../../tom_vscode_bridge/README.md) — the bridge that
  hosts script execution.
- [Repository map](../../README.md) — the whole Tom VS Code ecosystem.

---

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](../LICENSE).
