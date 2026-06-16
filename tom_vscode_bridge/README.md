# tom_vscode_bridge

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](LICENSE).

The Dart **bridge server** the Tom AI VS Code extension launches. It runs Dart
(through the D4rt interpreter) with full VS Code API access, talks JSON-RPC to
the extension over stdin/stdout, and hosts the **CLI Integration Server** (TCP
`19900`–`19909`) that out-of-process clients — Tom CLI tools, `*.d4rt.dart`
scripts, and the [`tom_vscode_scripting_api`](../tom_vscode_scripting_api/README.md)
client — connect to.

---

## Overview

The bridge is the **server half** of the Tom VS Code scripting story. The
extension owns the VS Code API; the bridge is the Dart process that lets Dart
code reach it. It plays two roles at once:

1. **D4rt script host.** It runs Dart scripts (compiled or interpreted via D4rt)
   that call the VS Code API — open files, run commands, query the language
   model, drive the editor — and returns their JSON result to the extension.
2. **CLI Integration Server.** It listens on a local TCP port and forwards
   length-prefixed JSON-RPC 2.0 requests from external clients into the same VS
   Code API, streaming notifications and reverse-RPC callbacks (Agent SDK chunks,
   `canUseTool`) back to the originating client.

The VS Code API wrappers themselves are **not** defined here — they live in
[`tom_vscode_scripting_api`](../tom_vscode_scripting_api/README.md), which this
package depends on and re-exports. The bridge adds the **execution and transport
machinery** around that surface.

```dart
// tom_vscode_bridge re-exports the whole scripting API:
export 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';
```

---

## Installation

This package is an internal binary (`publish_to: none`); consume it by path from
within the Tom VS Code repo:

```yaml
# pubspec.yaml
dependencies:
  tom_vscode_bridge:
    path: ../tom_vscode_bridge
```

It depends on `tom_vscode_scripting_api: ^1.1.0`, `tom_d4rt`, `tom_d4rt_dcli`,
and `path`. Dart SDK `^3.10.4`.

> If you only need the **client** surface (typed Dart calls into a running
> window), depend on the published
> [`tom_vscode_scripting_api`](../tom_vscode_scripting_api/README.md) instead —
> you do not need the bridge package to *script* the editor, only to *host* the
> server.

---

## Features

| Capability | What it does |
| --- | --- |
| **D4rt script execution** | Runs Dart scripts with full VS Code API access via the D4rt interpreter — no compile step. |
| **stdin/stdout JSON-RPC** | Bidirectional JSON-RPC with the extension that spawns it (the LSP-style child-process model). |
| **CLI Integration Server** | TCP server (`19900`–`19909`), length-prefixed JSON-RPC 2.0, for external clients. |
| **Agent SDK stream routing** | Routes `agentSdk.chunk` notifications and `agentSdk.toolCall` / `agentSdk.canUseTool` reverse-RPC back to the client that started each stream. |
| **D4rt bridge registration** | Registers the VS Code API classes with a D4rt interpreter so scripts can use them natively. |
| **Re-exported scripting API** | Exposes the entire `tom_vscode_scripting_api` surface (`VSCode`, `window`, `workspace`, `lm`, `VsCodeHelper`, …). |

### Binaries

| Binary | Source | Role |
| --- | --- | --- |
| `tom_bs` | `bin/tom_bs.dart` | The basic bridge server — DCli + VS Code API bridges. Launched by the extension. |
| `d4rtrun.b.dart` | `bin/d4rtrun.b.dart` | D4rt script runner entry point. |

> For the extended server with the full Tom Framework bridges, use `core_bs`
> from `tom_core_bridge` instead of `tom_bs`.

---

## Quick start

A bridge script implements an `execute(params, context)` handler. The bridge
sets up the `context` (with the `vscode` global), runs the handler, and returns
its result as JSON.

```dart
// hello.dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  final vscode = context['vscode'] as VSCode;

  await vscode.window.showInformationMessage('Hello from Dart!');
  final files = await vscode.workspace.findFiles('**/*.dart');

  return {'success': true, 'dartFilesFound': files.length};
  // → returned to the extension as JSON, e.g. {success: true, dartFilesFound: 312}
}
```

Run it from the extension (right-click → "Execute in DartScript") or
programmatically:

```typescript
const result = await bridgeClient.sendRequest('executeFile', {
  filePath: '/path/to/hello.dart',
  params: {},
});
```

---

## Example scripts

Runnable example scripts and a verification suite live alongside the package:

| Location | What it is |
| --- | --- |
| [`doc/examples.md`](doc/examples.md) | Annotated example index — "Helper" samples use `VsCodeHelper`; "Direct" samples use `VSCode` and its namespaces. |
| [`doc/examples_scripts.md`](doc/examples_scripts.md) | The example script catalogue. |
| [`test_scripts/scripting_api_suite.dart`](test_scripts/) | End-to-end verification suite — connects to a running window and exercises the scripting API over TCP. Use it after rebuilding `tom_bs` or bumping the scripting API. |

The client-side learning-path samples (connect → advanced → tools → Agent SDK)
live with the client package, under
[`tom_vscode_scripting_api/example/`](../tom_vscode_scripting_api/example/).

---

## Usage

### The script execution model

Scripts run through the bridge expose an `execute(params, context)` function.
`params` carries caller-supplied arguments; `context` carries the runtime
globals, including `vscode`. Results are JSON-encoded back to the caller; thrown
exceptions are captured (message + stack trace) and returned as an error
envelope rather than crashing the server.

```dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  final vscode = context['vscode'] as VSCode;

  final wsRoot = await vscode.workspace.getRootPath();
  final dartFiles = await vscode.workspace.findFiles('**/*.dart');

  var totalLines = 0;
  for (final file in dartFiles) {
    totalLines += (await vscode.workspace.readFile(file.fsPath)).split('\n').length;
  }

  await vscode.window.showInformationMessage(
    'Found ${dartFiles.length} Dart files, $totalLines lines in $wsRoot',
  );
  return {'files': dartFiles.length, 'lines': totalLines};
}
```

The VS Code API used here (`window`, `workspace`, `lm`, `VsCodeHelper`, …) is the
re-exported `tom_vscode_scripting_api` surface. For its full reference see the
[scripting API guides](../tom_vscode_scripting_api/doc/vscode_api_intro.md) —
this README does not duplicate them.

### Standard methods

The bridge answers a small set of built-in methods over both transports:

| Direction | Method | Purpose |
| --- | --- | --- |
| → Dart | `getWorkspaceInfo` | Workspace root and project list. |
| → Dart | `analyzeProject` | Analyze a Dart project. |
| → Dart | `generateDocs` | Generate documentation (via the language model). |
| → Dart | `executeFile` | Execute a Dart file, return its JSON result. |
| → Dart | `executeScript` | Execute inline Dart code, return its JSON result. |
| Dart → | `showInfo` / `showError` / `showWarning` | Notifications. |
| Dart → | `readFile` / `writeFile` / `openFile` | File operations. |
| Dart → | `askCopilot` | Query the language model. |
| Dart → | `log` | Append to the output channel. |

### `executeFile` / `executeScript`

Both run code on the *other* side of the bridge and return a structured result:

```typescript
// From the extension: run a Dart file
const result = await bridge.sendRequest('executeFile', {
  filePath: '/path/to/script.dart',
  args: ['--verbose', '--output=json'],
});
// → { exitCode, stdout, stderr, success, data }
```

```dart
// From a Dart script: run inline JS/TS in the extension host
final result = await server.sendRequest('executeScript', {
  'script': "return { fileCount: (await vscode.workspace.findFiles('**/*.dart')).length };",
  'language': 'javascript',
});
// → { success, data, language }
```

The `data` field is populated automatically by parsing `stdout` as JSON, so a
script that prints a JSON object yields a typed result with no extra plumbing.

### D4rt bridge registration

To make the VS Code API classes available inside a D4rt interpreter, register
the bridges once:

```dart
import 'package:tom_vscode_bridge/dartscript.dart';

final d4rt = D4rt();
TomDartscriptBridgeBridges.register(d4rt);
// the interpreter can now resolve VSCode, window, workspace, lm, ... natively
```

---

## Architecture

The extension spawns the bridge as a child process (the LSP model). The bridge
speaks JSON-RPC to the extension over stdin/stdout, and simultaneously hosts the
TCP CLI Integration Server for out-of-process clients.

```
┌──────────────────────────────────────┐
│  Tom AI VS Code Extension (TypeScript)│
│   · spawns the bridge process         │
│   · owns the real VS Code API         │
└───────────────┬──────────────────────┘
                │  JSON-RPC over stdin/stdout
┌───────────────▼──────────────────────┐
│  tom_vscode_bridge  (Dart — tom_bs)   │
│   · VSCodeBridgeServer (script host)  │
│   · D4rt interpreter + bridges        │
│   · re-exports tom_vscode_scripting_api│
│   ┌──────────────────────────────────┐│
│   │  CliIntegrationServer            ││
│   │  TCP 19900–19909                 ││
│   │  length-prefixed JSON-RPC 2.0    ││
│   │  + Agent SDK stream routing      ││
│   └───────────────▲──────────────────┘│
└───────────────────┼────────────────────┘
                    │  TCP socket
┌───────────────────┴────────────────────┐
│  External clients                      │
│   · tom_vscode_scripting_api (Dart)    │
│   · Tom CLI tools · *.d4rt.dart scripts│
└─────────────────────────────────────────┘
```

The wire protocol is **JSON-RPC 2.0** — request (`{jsonrpc, id, method,
params}`), response (`{jsonrpc, id, result}`), and notification (no `id`). The
stdin/stdout channel is newline/length-framed; the TCP channel uses a 4-byte
big-endian length prefix per message.

### Key types

| Type | Role |
| --- | --- |
| `VSCodeBridgeServer` | The server core: parses JSON-RPC, dispatches methods, runs scripts, relays extension push messages. |
| `CliIntegrationServer` | TCP server for external clients; frames messages, tracks Agent SDK stream owners, routes reverse-RPC to the originating socket. |
| `VsCodeBridge` | Per-script runtime handle — sets the execution context and emits `__BRIDGE_RESULT__` / `__BRIDGE_ERROR__`. |
| `ExecutionContext` | Captures a script's logs and exception info for the response. |
| `BridgeLogging` | Debug switches (`debugLogging`, `debugTraceLogging`). |
| `TomDartscriptBridgeBridges` | Registers the VS Code API classes with a D4rt interpreter. |

---

## Ecosystem

The bridge is the server-side counterpart to the scripting-API client; the two
meet at the CLI Integration Server.

- [`tom_vscode_scripting_api`](../tom_vscode_scripting_api/README.md) — the typed
  Dart client that connects to this server (and the surface this package
  re-exports).
- [`tom_vscode_extension`](../tom_vscode_extension/README.md) — the extension
  that spawns this bridge and owns the VS Code API.
- [Repository map](../README.md) — the whole Tom VS Code ecosystem at a glance.

---

## Further documentation

| Document | Covers |
| --- | --- |
| [doc/PROJECT.md](doc/PROJECT.md) | Project overview and getting started. |
| [doc/USER_GUIDE.md](doc/USER_GUIDE.md) | Writing Dart scripts that control VS Code through the bridge. |
| [doc/API_REFERENCE.md](doc/API_REFERENCE.md) | Complete API reference. |
| [doc/IMPLEMENTATION.md](doc/IMPLEMENTATION.md) | Server-side implementation and architecture detail. |
| [doc/examples.md](doc/examples.md) · [doc/examples_scripts.md](doc/examples_scripts.md) | Example index and scripts. |

For the VS Code API surface itself, see the
[scripting API guides](../tom_vscode_scripting_api/doc/vscode_api_intro.md).

---

## Why JSON-RPC over stdin/stdout

D4rt is a Dart-in-Dart interpreter; it is not available as an npm package for the
Node/TypeScript extension host. Rather than embed an interpreter, the bridge runs
as a separate Dart process and communicates over JSON-RPC — the same model the
Language Server Protocol uses. It is a standard protocol, language-agnostic,
fully bidirectional, and needs no external runtime dependency.

---

## Status

| | |
| --- | --- |
| Version | 1.0.0 |
| Dart SDK | `^3.10.4` |
| Publishing | internal (`publish_to: none`) |
| Binary | `tom_bs` (`bin/tom_bs.dart`) |
| Tests | end-to-end suite in `test_scripts/scripting_api_suite.dart` (requires a live window); no standalone unit-test suite |
| License | BSD-3-Clause |

---

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](LICENSE).
</content>
