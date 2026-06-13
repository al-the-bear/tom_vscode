# VS Code Scripting test scripts

Live integration scripts that drive a running VS Code window through the Tom AI
extension's **CLI Integration Server** using `tom_vscode_scripting_api`. They are
**not** unit tests — they require a live window — so they live here, outside
`test/`, and are never picked up by `dart test` / `testkit`.

## `scripting_api_suite.dart`

A verification suite that exercises the scripting API end-to-end and reports
`PASS` / `FAIL` / `SKIP` per check. Use it as a smoke gate after rebuilding the
bridge (`tom_bs`) or bumping `tom_vscode_scripting_api`.

It covers: core (`getVersion`, `getEnv`), workspace (root, name, folders,
`findFilePaths`, `fileExists`/`readFile`, configuration), commands, extensions,
window, and the Tom feature APIs added in scripting-API 1.1.0
(`TomWorkspaceApi`, `TomQueueApi`, `TomTodoApi`).

### Prerequisite

In the target window run **"DS: Start Tom CLI Integration Server"** (Command
Palette). It listens on the first free port in `19900–19909`; each open window
gets its own port.

### Run

```bash
cd tom_ai/vscode/tom_vscode_bridge

# auto-discover the single open window
dart run test_scripts/scripting_api_suite.dart

# target a specific window by workspace name or port
dart run test_scripts/scripting_api_suite.dart --workspace=tom_agent_container
dart run test_scripts/scripting_api_suite.dart --port=19900

# also run checks with visible side effects (status bar, info toast)
dart run test_scripts/scripting_api_suite.dart --interactive
```

Exit code is `0` when no check fails, `1` otherwise.

## Two execution models (important)

The scripting API reaches a window two different ways, with **different API
surfaces** — the suite targets the first:

1. **Standalone client (what these scripts use).** A normal Dart program
   connects over TCP to the CLI Integration Server. The whole package is
   available, including the static-class feature APIs (`TomWorkspaceApi`,
   `TomQueueApi`, `TomTodoApi`, `TomToolsApi`, `TomChatApi`, `AiPromptApi`, …).
   Run with `dart run` as above.

2. **Bridge-hosted d4rt script (`tom_bs`).** When the extension runs a d4rt
   script through the bridge subprocess, the bridge server *is* the
   `VSCodeAdapter` (wired to the extension over stdio), so the script uses the
   pre-initialised globals (`vscode`, `window`, `workspace`, `commands`,
   `extensions`, `lm`, `chat`) **directly** — no TCP connect, no
   `VSCode.initialize`. Only the VS Code-namespace globals from
   `script_globals.dart` are bridged into the interpreter; the `Tom*Api`
   static classes are **not** bridged (they are a standalone-client surface).
   This is why `scripting_api_suite.dart` is run standalone rather than fed to
   `tom_bs`.

## Rebuilding `tom_bs` (when the API changes)

The bridge links `tom_vscode_scripting_api` at compile time and generates d4rt
bridges from it, so a new API version needs a regenerate + recompile:

```bash
cd tom_ai/vscode/tom_vscode_bridge
dart pub upgrade tom_vscode_scripting_api   # move the lock to the new version
d4rtgen                                      # regenerate the d4rt bridges
dart analyze
buildkit :compiler -t linux-x64              # compile tom_bs into tom_binaries
```

`buildkit :compiler` writes `tom_bs` into `$TOM_BINARY_PATH/<platform>/`;
`install_extension.sh` then bundles whatever binaries are present there. Only the
host platform can be compiled natively (darwin/win32 binaries must be rebuilt on
their own hosts). If the target binary is in use by a running window you will get
`Text file busy` — compile to a temp path and `mv` it into place.
