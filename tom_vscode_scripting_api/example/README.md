# tom_vscode_scripting_api — examples

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](../LICENSE).

This is the **canonical home** for the
[`tom_vscode_scripting_api`](../README.md) samples. Everything that shows how to
drive VS Code from Dart lives here — a single quick-look script plus four
self-contained sample projects ordered as a learning path.

---

## What's here

### Quick-look script

[`tom_vscode_scripting_api_example.dart`](tom_vscode_scripting_api_example.dart)
is the smallest possible end-to-end script: connect to a live window, show a
message, list workspace folders, run a command, read the version, disconnect. Run
it to confirm your setup works before moving to the structured samples.

### Sample projects (learning path)

Each sample is its own runnable Dart subproject (its own `pubspec.yaml`,
`bin/`, run scripts, and a comprehensive README that doubles as a standalone
article). They build on one another — start at the top.

| Sample | Demonstrates |
| --- | --- |
| [`vscode_scripting_introduction_sample`](vscode_scripting_introduction_sample/) | Connecting to a live window — information messages, commands, workspace folders, reading and opening files. **Start here.** |
| [`vscode_scripting_advanced_sample`](vscode_scripting_advanced_sample/) | Editor edits, file batches, progress reporting, quick-pick / input boxes, the language model, and `VsCodeHelper`. |
| [`vscode_agent_tools_sample`](vscode_agent_tools_sample/) | The extension's own feature APIs — todos, the prompt queue, timed requests, documents, workspace metadata, `TomToolsApi`, and send-to-chat. |
| [`vscode_agent_sdk_sample`](vscode_agent_sdk_sample/) | Streaming an Anthropic Agent SDK `query()` with `Options`, typed messages, in-process Dart `tool()`s, and `canUseTool`. |

---

## Running the samples

> **Prerequisite — a live window.** These samples talk to VS Code over the
> socket bridge, so they need a running VS Code instance with the Tom VS Code
> Bridge extension active. Without it, the socket calls cannot connect.

**Quick-look script** — from this folder:

```bash
dart run tom_vscode_scripting_api_example.dart
```

**A sample project** — each is a self-contained subproject, so resolve its
dependencies first, then run its entry point or aggregator:

```bash
cd vscode_scripting_introduction_sample
dart pub get
dart run bin/run_example.dart        # or the per-concept files under the project
```

Every sample ships a `run_all_examples.dart` aggregator that runs its concept
files in sequence, prints a pass/fail tally, and exits non-zero on failure — see
each sample's README for the exact commands and the concept-by-concept walk.

---

## Where to look next

- [`tom_vscode_scripting_api`](../README.md) — the package these samples
  exercise: the full API surface, connection modes, and namespaces.
- [Repository map](../../README.md) — the whole Tom VS Code ecosystem at a
  glance.

---

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](../LICENSE).
