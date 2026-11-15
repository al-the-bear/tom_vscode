# VS Code Bridge API Reference

The bridge's own API: the requests `tom_bs` answers and sends, what a script run
by the bridge gets, and the `VSCodeBridgeServer` class for programs that embed
the bridge. The VS Code API scripts call — `vscode`, `window`, `workspace`,
`commands`, `extensions`, `lm`, `chat`, the types and `VsCodeHelper` — is the
scripting API of `tom_vscode_scripting_api`, documented there:
[VS Code scripting guide](../../tom_vscode_scripting_api/doc/vscode_api_vscode_scripting_guide.md),
[introduction](../../tom_vscode_scripting_api/doc/vscode_api_intro.md). How to
write and run scripts, with examples run through `tom_bs`:
[User Guide](USER_GUIDE.md).

## Table of Contents

- [Transport](#transport)
- [Requests the bridge answers](#requests-the-bridge-answers)
- [Running Dart: executeFileVcb, executeScriptVcb, executeExpressionVcb](#running-dart-executefilevcb-executescriptvcb-executeexpressionvcb)
- [Requests the bridge sends to the extension](#requests-the-bridge-sends-to-the-extension)
- [The CLI integration server](#the-cli-integration-server)
- [VSCodeBridgeServer (embedding the bridge)](#vscodebridgeserver-embedding-the-bridge)
- [Logging](#logging)

## Transport

The extension starts `tom_bs` as a subprocess and talks to it in JSON-RPC 2.0,
one JSON object per line on stdin and stdout. A request has `id`, `method` and
`params`; the answer has the same `id` and `result`, or `error`
(`{message, data}`). Every request with an `id` gets exactly one answer. The
bridge's own log lines go to stderr.

```json
{"jsonrpc": "2.0", "id": 7, "method": "executeFileVcb", "params": {"filePath": "/ws/tool.dart", "params": {}}}
{"jsonrpc": "2.0", "id": 7, "result": {"success": true, "result": {"done": true}, "logs": []}}
```

Method names say who answers: `…Vcb` methods are answered by the bridge, `…Vce`
methods by the VS Code extension. A `…Vce` request a CLI client sends to the
bridge is forwarded to the extension.

## Requests the bridge answers

| Method | Params | Result |
| --- | --- | --- |
| `executeFileVcb` | `filePath`, `params` (not handed to the script) | see [Running Dart](#running-dart-executefilevcb-executescriptvcb-executeexpressionvcb) |
| `executeScriptVcb` | `script`, `basePath` (relative imports), `params` | the same |
| `executeExpressionVcb` | `expression` | the same; `result` the expression's value |
| `echo` | `message` | `{message}` |
| `getWorkspaceInfo` | `workspaceRoot` | `{root, projects, projectCount}` |
| `generateDocs` | `projectPath`, `prompt` | documentation written through the language model (`{docsPath, success, copilotResponse}`) |
| `startCliServer` | `port` (optional) | `{success, port, message}` |
| `stopCliServer` | — | `{success, message, port, wasRunning}` |
| `getCliServerStatus` | — | `{running, port}` |
| `startProcessMonitor` | — | whether the Tom process monitor, its watcher and the ledger server run |
| `setDebugLogging` / `getDebugLogging` | `enabled` | the bridge's debug logging |
| `printConfiguration` | — | the D4rt interpreter's configuration, written to the log |

An unknown method is answered with `error` `Unknown method: <name>`.

## Running Dart: executeFileVcb, executeScriptVcb, executeExpressionVcb

`executeFileVcb` reads the file and runs it as `executeScriptVcb` does, with
the file's folder as `basePath` (its relative imports resolve). The script runs
in the bridge's D4rt interpreter:

- its top-level `main()` is called with no arguments (`main(List<String> args)`
  gets an empty list); a script without `main` fails with *Undefined variable:
  main*; an `async` `main` is awaited;
- nothing is imported for it; `package:tom_vscode_scripting_api/script_globals.dart`
  gives the VS Code globals and the scripting API (see the
  [User Guide](USER_GUIDE.md#imports));
- the request's `params` do not reach the script.

The answer:

```json
{"success": true, "result": "<what main returned>", "logs": ["<print output>"]}
{"success": false, "error": "<message>", "stackTrace": "<trace>", "logs": []}
```

`exception` / `exceptionStackTrace` are added to a successful answer when the
script recorded an exception it caught itself. The extension's commands open a
result `{action: 'showDocument', filename, content}` in a new editor.

`executeExpressionVcb` evaluates the expression with D4rt's `eval`, after the
interpreter's init source has run once: `VSCodeBridgeServer.defaultInitSource`
without the `package:` imports this bridge has no bridges for
(`initSourceFor`). In the plain `tom_bs` an expression sees the `dart:`
libraries, `tom_dcli`, `tom_d4rt_dcli` and the scripting API (`1 + 2`,
`max(2, 5)`, `Directory.current.path`).

## Requests the bridge sends to the extension

The scripting API reaches VS Code through these requests; a script does not
send them itself.

| Method | Params | What the extension does |
| --- | --- | --- |
| `executeScriptVce` | `script` (a JavaScript function body), `params` | runs it as an async function of `(params, context)`, `context.vscode` the VS Code API, `context.require` Node's; answers `{success, result}` |
| `executeFileVce` | `filePath`, `params` | loads a JavaScript module and calls its `execute` / `default` export with `(params, context)`; answers `{filePath, success, result}` |
| `showInfoVce` / `showWarningVce` / `showErrorVce` | `message` | a notification |
| `readFileVce` / `writeFileVce` / `openFileVce` | `path` (and `content`) | file access in the extension host |
| `askCopilotVce` | `prompt` | asks the language model |
| `logVce` | `message` | appends to the bridge's output channel |
| `sendToChatVce` | `prompt`, `target` | sends the prompt to the ANTHROPIC/LLM panel's profile, or to Copilot with `target: 'copilot'` |
| `tools.*Vce`, `todo.*Vce`, `queue.*Vce`, `timed.*Vce`, `doc.*Vce`, `workspace.*Vce`, `agentSdk.*Vce` | | the extension's tools and features for the scripting API (`tomScriptingBridge-handler` and the Agent SDK bridge in the extension) |

## The CLI integration server

The bridge runs a TCP server for Dart programs outside VS Code
(`startCliServer`; `@T: Start Tom CLI Integration Server`). It listens on the
first free port of `19900`–`19909`, so every window has its own. A frame is a
4-byte big-endian length followed by the UTF-8 JSON message. A client sends
the same requests as the extension (`…Vcb` answered by the bridge, `…Vce`
forwarded to the extension) and gets each answer on its own socket, never on
the bridge's stdout; a failing request is answered with an error frame.
`tom_vscode_scripting_api`'s `VSCodeBridgeClient` and `connectToWorkspace` are
the client side.

## VSCodeBridgeServer (embedding the bridge)

`tom_bs` (`bin/tom_bs.dart`) is `VSCodeBridgeServer().start()`. A program that
embeds the bridge with more D4rt bridges — `core_bs` of `tom_core_bridge` —
constructs it with them.

| Member | What it does |
| --- | --- |
| `VSCodeBridgeServer({List<BridgeRegistrar>? additionalBridgeRegistrars, String? initSource})` | Sets up the D4rt interpreter with every permission, the DCli bridges, `VsCodeBridge` and the VS Code globals; `additionalBridgeRegistrars` register more bridges; `initSource` replaces `defaultInitSource` and is used as given. |
| `void start()` | Reads requests from stdin, writes answers and requests to stdout. |
| `Future<Map<String, dynamic>> sendRequest(String method, Map<String, dynamic> params, {String? scriptName, Duration timeout})` | Sends a request to the extension and waits for its answer (default timeout 30 s). |
| `void sendNotification(String method, Map<String, dynamic> params)` | Sends a notification (no answer). |
| `Future<Map<String, dynamic>?> handleCliRequest(String method, Map<String, dynamic> params, Object? id, void Function(String) sendLogToSocket)` | Answers a CLI client's request (used by the CLI integration server). |
| `Stream<Map<String, dynamic>> get extensionPushMessages` | Agent SDK traffic the extension pushes, relayed to CLI clients. |
| `static String defaultInitSource` | The source run once before the first expression is evaluated: the imports an expression sees; those this interpreter has no bridges for are left out. |
| `static String initSourceFor(String source, Set<String> registered)` | `source` without its `package:` imports not in `registered`. |
| `debugInjectExtensionPush`, `debugHandleLine`, `debugOutput` | Test-only seams. |

`VSCodeBridgeServer.params` and `VSCodeBridgeServer.setResult` read and set
the running script's zone values; a script cannot reach them in `tom_bs`
(`package:tom_vscode_bridge/bridge_server.dart` does not load there).

## Logging

`BridgeLogging.debugLogging` (`setDebugLogging` request, `@T: Toggle Bridge
Debug Logging`) logs every request and answer in full; `debugTraceLogging`
logs one short line per message. The log goes to stderr, which the extension
shows in the **Tom Dartbridge Log** output channel.
