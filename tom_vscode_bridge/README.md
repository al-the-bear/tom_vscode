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

A bridge script defines a top-level `main()`. The bridge runs it in D4rt with
no arguments, waits for it when it is `async`, and returns what it returns as
the request's `result` (its `print` output comes back as `logs`).

```dart
// hello.dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
  await vscode.window.showInformationMessage('Hello from Dart!');
  final files = await vscode.workspace.findFiles('**/*.dart');

  return {'success': true, 'dartFilesFound': files.length};
  // → returned to the extension as JSON, e.g. {success: true, dartFilesFound: 312}
}
```

Run it from the extension (`@T: Execute File` or `@T: Execute as Script` on the
file) or programmatically:

```typescript
const result = await bridgeClient.sendRequest('executeFileVcb', {
  filePath: '/path/to/hello.dart',
  params: {},
});
```

---

## Example scripts

Example scripts and a verification suite:

| Location | What it is |
| --- | --- |
| [`doc/USER_GUIDE.md`](doc/USER_GUIDE.md#examples) | Complete example scripts for `@T: Execute File`, each run through `tom_bs` as written; [`doc/examples.md`](doc/examples.md) indexes them. |
| [`test_scripts/scripting_api_suite.dart`](test_scripts/) | End-to-end verification suite — connects to a running window and exercises the scripting API over TCP. Use it after rebuilding `tom_bs` or bumping the scripting API. |

The client-side learning-path samples (connect → advanced → tools → Agent SDK)
live with the client package, under
[`tom_vscode_scripting_api/example/`](../tom_vscode_scripting_api/example/).

---

## Usage

### The script execution model

Scripts run through the bridge (`executeFileVcb`, `executeScriptVcb`) define a
top-level `main()`; the bridge calls it with no arguments (a
`main(List<String> args)` gets an empty list) and a script without `main` fails
with *Undefined variable: main*. An `async` `main` is awaited. Its return value
is JSON-encoded back to the caller as `result`, with the script's `print`
output as `logs`; a thrown exception is captured (message + stack trace) and
returned as an error envelope rather than crashing the server. The request's
`params` are not handed to the script. Nothing is imported for it:
`package:tom_vscode_scripting_api/script_globals.dart` gives the VS Code globals
(`vscode`, `window`, `workspace`, `commands`, `extensions`, `lm`, `chat`) and
`VsCodeHelper`; `dart:io` and the rest are imported as usual.

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
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
| → Dart | `generateDocs` | Generate documentation (via the language model). |
| → Dart | `executeFileVcb` | Run a Dart file in D4rt (its `main()`), return what `main` returns. |
| → Dart | `executeScriptVcb` | Run inline Dart code in D4rt (its `main()`), return what `main` returns. |
| → Dart | `executeExpressionVcb` | Evaluate a Dart expression, return its value. |
| Dart → | `showInfoVce` / `showErrorVce` / `showWarningVce` | Notifications. |
| Dart → | `readFileVce` / `writeFileVce` / `openFileVce` | File operations. |
| Dart → | `askCopilotVce` | Query the language model. |
| Dart → | `logVce` | Append to the output channel. |
| Dart → | `executeFileVce` / `executeScriptVce` | Run JavaScript in the extension host. |

### Running code on the other side

`executeFileVcb` / `executeScriptVcb` run Dart in the bridge's D4rt
interpreter. The script defines a top-level `main()`, called with no arguments
(see [The script execution model](#the-script-execution-model)); the answer
is `{success, result, logs}` — `result` what `main` returned, `logs` its
`print` output — or `{success: false, error, stackTrace, logs}`:

```typescript
// From the extension: run a Dart file
const result = await bridge.sendRequest('executeFileVcb', {
  filePath: '/path/to/script.dart',
  params: {},
});
// → { success: true, result: <what main returned>, logs: [...] }
```

`executeFileVce` / `executeScriptVce` go the other way: JavaScript the
extension runs for a Dart script. There the code is an async function body (or,
for a file, a module exporting `execute` / `default`) called with
`(params, context)`, `context.vscode` being the VS Code API; the answer is
`{success, result}`:

```dart
// From a Dart script: run JavaScript in the extension host
final result = await server.sendRequest('executeScriptVce', {
  'script': "return { fileCount: (await context.vscode.workspace.findFiles('**/*.dart')).length };",
  'params': {},
});
// → { success: true, result: { fileCount: 312 } }
```

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
| [doc/API_REFERENCE.md](doc/API_REFERENCE.md) | The bridge's requests (both directions), what a script gets, the CLI integration server, `VSCodeBridgeServer`. |
| [doc/IMPLEMENTATION.md](doc/IMPLEMENTATION.md) | Server-side implementation and architecture detail. |
| [doc/examples.md](doc/examples.md) | The index of the User Guide's example scripts. |

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
