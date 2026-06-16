# @Tom VS Code Extension

A VS Code extension for Copilot-driven workflows, prompt queue automation, timed requests, workspace tools, and bridge-based scripting.

## Overview

@Tom provides a unified AI workspace in VS Code with:

- Copilot and local LLM prompt workflows
- prompt queue orchestration with follow-ups, reminders, and repeat support
- timed request scheduling that enqueues prompts automatically
- markdown/guideline browsing and quest navigation
- bridge and CLI integration for workspace automation

## Key Features

- Copilot prompt send flows with template support
- @CHAT panel with repeat (R) and answer-wait (W) action-bar fields
- Prompt Queue editor with auto-send, auto-start, auto-pause, auto-continue, and restart controls
- RequestId-based answer detection with file watcher + polling fallback
- Timed Requests editor with interval/scheduled modes, sendMaximum, repeat affixes, and answer wait minutes
- Dedicated output channels: Tom Prompt Queue and Tom Timed Requests
- Markdown Browser with grouped document picker, quest filters, line anchors, and auto reload
- Window Status panel showing per-window subsystem state from window-state files
- Local LLM, AI Conversation, and Tom AI Chat integration
- D4rt/bridge/CLI runtime tooling

## Installation

### Prerequisites

| Software | Version | Notes |
| --- | --- | --- |
| Dart SDK | ≥ 3.10.4 (< 4.0) | Compiles the `tom_bs` bridge binary and runs the d4rt generator |
| Node.js | ≥ 20 (LTS) | Enforced by the installer; the extension targets Node v25 — install/switch with nvm |
| nvm | latest | Recommended — lets the installer install/switch to a supported Node automatically |
| VS Code | ≥ 1.96.0 | `engines.vscode` in `package.json` |
| `code` CLI | — | Must be on `PATH` for the installer to install the VSIX (VS Code → *Shell Command: Install 'code' command in PATH*) |
| `@vscode/vsce` | latest | Auto-run via `npx` if not installed globally |

The from-source build also needs two sibling Tom projects present on disk (see
[Directory Layout](#directory-layout)):

- **`tom_vscode_bridge`** — the bridge whose `tom_bs` binary is compiled (ships
  in the same repo as this extension).
- **`tom_d4rt_generator`** — the d4rt bridge generator, part of the **d4rt
  repo**, which must be cloned as a sibling under `tom_ai/d4rt/`.

All other Dart dependencies (`tom_d4rt`, `tom_vscode_scripting_api`,
`tom_build_base`, `analyzer`, …) are resolved from pub.dev by `dart pub get`.

### Preferred: build from source for the current platform

`compile_and_install.sh` / `.ps1` is the recommended installer. It performs a
fully local build for the host platform only:

```bash
bash compile_and_install.sh      # macOS / Linux
pwsh compile_and_install.ps1     # Windows
```

It runs end to end:

1. Checks Node (switches via nvm if below 20), installs npm deps, compiles the TypeScript.
2. `dart pub get` for the generator and the bridge.
3. Regenerates the d4rt bridges for `tom_vscode_bridge`.
4. `dart compile exe bin/tom_bs.dart` straight into the extension's local
   `bin/<platform>/` — it never writes to `tom_binaries`, relies on
   `$TOM_BINARY_PATH`, or needs any tool on `PATH`.
5. Ensures the host's Claude Agent SDK native CLI binary is present.
6. Packages the VSIX (bundling only the host `tom_bs`) and installs it via the `code` CLI.

After install, reload VS Code: `Cmd/Ctrl+Shift+P` → **Developer: Reload Window**.

### Alternative: bundle prebuilt binaries for all platforms

`install_extension.sh` / `.ps1` builds the same VSIX but bundles prebuilt
`tom_bs` binaries for all five platforms copied from
`tom_binaries/tom/<platform>/` (it does **not** compile from source). Use this
only when the prebuilt binaries layer is present:

```bash
bash install_extension.sh        # macOS / Linux
pwsh install_extension.ps1       # Windows
```

### Alternative: install a prebuilt VSIX

```bash
code --install-extension tom-ai-extension-0.1.0.vsix
```

### Directory Layout

Both installer scripts resolve the workspace root as **three levels above** the
extension folder (`tom_vscode_extension/../../..`) and expect the layout below.
The `tom_vscode_*` projects live in the **tom_vscode** repo (mounted at
`tom_ai/vscode/`); the `tom_d4rt*` projects live in the separate **d4rt** repo
(cloned at `tom_ai/d4rt/`):

```
<workspace-root>/                      # parent of tom_ai (e.g. tom_agent_container)
├── tom_ai/
│   ├── vscode/                        # tom_vscode repo
│   │   ├── tom_vscode_extension/      # ← this extension (scripts live here)
│   │   │   ├── compile_and_install.sh / .ps1
│   │   │   ├── install_extension.sh / .ps1
│   │   │   └── bin/<platform>/tom_bs  # build output (gitignored)
│   │   ├── tom_vscode_bridge/         # bridge source → compiled to tom_bs
│   │   └── tom_vscode_scripting_api/  # bridged scripting API
│   └── d4rt/                          # d4rt repo (separate clone, sibling of vscode/)
│       ├── tom_d4rt_generator/        # d4rtgen — regenerates the d4rt bridges
│       └── tom_d4rt/                  # d4rt interpreter runtime
└── tom_binaries/                      # prebuilt binaries layer (install_extension only)
    └── tom/<platform>/tom_bs
```

Paths the from-source build touches:

| Path | Role |
| --- | --- |
| `tom_ai/vscode/tom_vscode_bridge` | Bridge source; `dart pub get` + `dart compile exe bin/tom_bs.dart` |
| `tom_ai/d4rt/tom_d4rt_generator` | Generator; run via `dart --packages=<gen>/.dart_tool/package_config.json <gen>/bin/d4rtgen.dart` |
| `tom_vscode_extension/bin/<platform>/tom_bs` | Local compile output, bundled into the VSIX |

`<platform>` is VS Code's platform-vs id: `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, or `win32-x64`.

## Main Commands

Open the command palette and type @T: to discover commands.

### Core AI Commands

- @T: Send to Copilot
- @T: Send to Copilot (Default Template)
- @T: Send to Copilot (Pick Template)
- @T: Send to Local LLM
- @T: Change Local LLM Model...
- @T: Start AI Conversation
- @T: Start Tom AI Chat

### Queue and Timer Commands

- @T: Open Prompt Queue
- @T: Open Timed Requests
- @T: Open Prompt Templates
- @T: Open Reusable Prompts

### Workspace and Runtime Commands

- @T: Open in Markdown Browser
- @T: Extension Status Page
- @T: Restart Bridge
- @T: Start Tom CLI Integration Server
- @T: Stop Tom CLI Integration Server
- @T: Start Process Monitor

## Keybindings

See full keybindings in [doc/quick_reference.md](doc/quick_reference.md).

High-use shortcuts:

- Ctrl+Shift+0: focus @CHAT
- Ctrl+Shift+9: focus @WS
- Ctrl+Shift+6: open Prompt Queue
- Ctrl+Shift+7: open Timed Requests
- Ctrl+Shift+5: open Raw Trail Viewer
- Ctrl+Shift+\: maximize toggle

## Queue and Timed Request Behavior

Prompt Queue highlights:

- one-file-per-entry YAML storage
- automation toggles for queue flow behavior
- repetition support with prefix/suffix placeholders
- answer-wait timeout for time-based auto-advance
- watchdog health checks to recover watcher issues

Timed Requests highlights:

- interval and scheduled firing modes
- sendMaximum with sentCount-based auto-pause
- reminder and repeat configuration
- global schedule slot filtering
- all fires enqueue through Prompt Queue (single dispatch path)

## Output Channels

- Tom Prompt Queue
- Tom Timed Requests
- Tom Debug
- Tom Tests
- Tom Dartbridge Log
- Tom Conversation Log
- Tom AI Chat Log
- Tom Tool Log
- Tom AI Chat Responses
- Tom AI Local LLM
- Tom AI Local Log

## Requirements

- VS Code 1.96.0+
- Dart SDK 3.10.4+ for the bridge / from-source build
- Node.js 20+ (manage with nvm) for building the extension
- GitHub Copilot subscription for Copilot workflows

See [Installation → Prerequisites](#prerequisites) for the full software list
and the directory layout the build scripts expect.

## Development

Build:

```bash
npm run compile
```

Watch mode:

```bash
npm run watch
```

Run extension host for manual testing:

1. Open this project in VS Code.
2. Press F5.
3. Test commands in the Extension Development Host.

## Documentation

- [doc/user_guide.md](doc/user_guide.md): complete feature guide
- [doc/quick_reference.md](doc/quick_reference.md): shortcuts, panels, command map
- [doc/copilot_chat_tools.md](doc/copilot_chat_tools.md): Copilot/Tom AI Chat tooling
- [_copilot_guidelines/architecture.md](_copilot_guidelines/architecture.md): architecture and state model
- [_copilot_guidelines/keybindings_and_commands.md](_copilot_guidelines/keybindings_and_commands.md): command and keybinding details

## Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [Chat API](https://code.visualstudio.com/api/extension-guides/chat)
