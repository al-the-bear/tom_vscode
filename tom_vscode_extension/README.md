# @Tom VS Code Extension

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](LICENSE).

The **`@Tom`** VS Code extension — an AI-assisted development cockpit. It adds
multi-model chat panels (Anthropic, Copilot), a multi-transport prompt
queue, timed requests, a shared tool registry, a standalone MCP server, the
status page, and the **CLI Integration Server** that lets out-of-process Dart
clients drive the live window. This is the product of the Tom VS Code repo.

---

## Overview

`@Tom` turns a normal VS Code window into a unified AI workspace:

- **Multi-model chat** — Anthropic (direct SDK, Agent SDK, VS Code LM, or a local
  LLM through an Anthropic profile on a Local LLM configuration) and Copilot, in
  dedicated bottom-panel subpanels.
- **Prompt queue orchestration** — queue work across transports with follow-ups,
  reminders, repeat support, and automation toggles.
- **Timed requests** — interval / scheduled prompts that enqueue automatically.
- **Tool registry + MCP server** — the same MCP-style tools the panels use,
  published to external MCP clients over HTTP.
- **TomSpecs tools** — read, search, edit (model-checked, in atomic batches),
  validate and render TomSpecs specifications, check plain DocSpecs Markdown, and
  take a specification through Phase 4 (CodeSpecs gate, extracts, verdicts, todo
  tree, step context, validation and tracing) — see
  [doc/tomspecs_agent_workflow.md](doc/tomspecs_agent_workflow.md).
- **Scripting surface** — the CLI Integration Server exposes the extension to the
  [`tom_vscode_scripting_api`](../tom_vscode_scripting_api/README.md) Dart client
  and the [`tom_vscode_bridge`](../tom_vscode_bridge/README.md) server.
- **Workspace tooling** — markdown/guideline browsing, quest navigation, a
  per-window status page, and D4rt/bridge/CLI runtime integration.

---

## Installation

### Prerequisites

| Software | Version | Notes |
| --- | --- | --- |
| Dart SDK | ≥ 3.10.4 (< 4.0) | Compiles `validate_codespecs` and the `tom_bs` bridge binary, runs the d4rt generator. Need not be on `PATH`: the installer also finds Flutter's Dart, `DART_SDK`, `FLUTTER_ROOT` and the usual install folders (`scripts/find-dart.cjs`). Without one the build goes on without `tom_bs` and `validate_codespecs` (no DartScript, no CodeSpecs validation) and ends with a warning; `--no-dart` (PowerShell `-NoDart`) builds that way on purpose |
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

Every build (from source or not) also needs the **TomSpecs SOM TypeScript
pair** from the **ai_build repo** (`tom_ai/ai_build/`):
`tom_som_typescript_runtime` and `tom_som_typescript_v0`. The spec tools load
the TomSpecs model through them. They are not on npm:
`scripts/build-som-packages.cjs` (`npm run som:pack`) builds both and packs them
into `vendor/tom_som/` (gitignored), and `package.json` depends on those two
tarballs. Installed from tarballs, the packages are real files in
`node_modules` and so travel inside the VSIX; the installed extension never
reads from ai_build. The script also copies the CodeSpecs area catalogue
(`tom_specs_model/generated-doc/codespecs/codespecs_areas.json`), tom_code_specs'
vocabulary (`tom_code_specs/lib/src/annotations/vocabulary.dart`, the hook
catalogue CodeSpecs validate checks 40 and 41 need), the two CodeSpecs
workflow guides (`tom_specs_model/doc/codespecs_prompt.md` and
`tom_ai/ai_build/tom_core_codespecs/doc/codespecs_mapping.md`) and the CodeSpecs
derivation contract (`tom_ai/ai_build/tom_core_codespecs/doc/codespecs_derivation_contract.md`)
to `resources/codespecs/`
(gitignored), which the VSIX carries too.

The CodeSpecs validate and trace tools run `validate_codespecs` from ai_build's
`tom_specs_clitool` as a compiled binary in `bin/<platform>/`.
`scripts/build-validate-codespecs.cjs` (`npm run codespecs:build`) compiles it
for the host with `dart compile exe`; the install scripts run it. The installed
extension never runs `dart run` for it.
`TOM_SOM_AI_BUILD` points the script at another ai_build location. ai_build is
shared with other sessions, so the script lists any uncommitted changes in the
paths it packs, and `npm run som:pack -- --from-head` packs ai_build's committed
HEAD instead of its working tree.

All other Dart dependencies (`tom_d4rt`, `tom_vscode_scripting_api`,
`tom_build_base`, `analyzer`, …) are resolved from pub.dev by `dart pub get`.

### Preferred: build from source for the current platform

`compile_and_install.sh` / `.ps1` is the recommended installer. It performs a
fully local build for the host platform only:

```bash
bash compile_and_install.sh      # macOS / Linux
pwsh compile_and_install.ps1     # Windows
```

Options (bash / PowerShell):

- `--no-dart` / `-NoDart` (or `TOM_NO_DART=1`): builds as on a machine
  without a Dart SDK (below);
- `--all-platforms` / `-AllPlatforms` (or `TOM_ALL_PLATFORMS=1`): bundles the
  Agent SDK's Claude CLI for darwin-arm64, linux-x64 and win32-x64;
- `--binaries-only` / `-BinariesOnly`: builds `tom_bs` and `validate_codespecs`
  for this host, puts them into the binaries layer (step 5) and stops — no
  npm, no TypeScript, no VSIX, nothing installed;
- `--no-layer` / `-NoLayer` (or `TOM_NO_LAYER=1`): leaves the binaries layer
  alone (step 5 skipped).

It runs end to end:

1. Checks Node (switches via nvm if below 20), builds the TomSpecs SOM packages
   from ai_build's current state (`npm run som:pack`), installs npm deps, checks
   that the installed model is the one just packed (`npm run som:check` — the
   install stops if npm kept a stale copy), compiles the TypeScript.
2. `dart pub get` for the generator and the bridge.
3. Regenerates the d4rt bridges for `tom_vscode_bridge`.
4. `dart compile exe bin/tom_bs.dart` straight into the extension's local
   `bin/<platform>/` — it never relies on `$TOM_BINARY_PATH` or needs any tool
   on `PATH` — and the same for `validate_codespecs` from `tom_specs_clitool`
   (`npm run codespecs:build`).
5. Puts both into the binaries layer, `tom_binaries/tom/<platform>/`, with
   their build stamps (`tom_bs.build.json`: the versioner stamp, build time,
   host and a hash of the bridge sources it was built from;
   `validate_codespecs.build.json`: the source hash), commits exactly
   those files there and pushes (`scripts/binaries-layer.cjs publish`). The
   layer so always holds the latest build of each platform's host, which
   multi-platform VSIXes take (below). A push the remote refuses (the layer is
   behind it) leaves the commit local and the install goes on; nothing pulls
   the layer on its own.
6. Ensures the host's Claude Agent SDK native CLI is present (its npm
   package); with `--all-platforms` it also fetches the fleet's other CLIs
   with `npm pack` and bundles them as `bin/<platform>/claude[.exe]`.
7. Builds the workspace template (`npm run template:build`): the workspace's
   config, guidelines, CLAUDE.md and the generic `_ai` folders, checked for
   personal files and literal secrets, as `resources/workspace_template.zip`
   (in the VSIX) and a copy beside it.
8. Packages the VSIX (bundling only the host `tom_bs` and `validate_codespecs`),
   checks that it is self-contained (`scripts/check-vsix-contents.cjs`: the SOM
   packages present as real files, no symlinks; the install stops otherwise;
   which of `tom_bs` / `validate_codespecs` it carries per platform is listed,
   and for which platforms it carries the Agent SDK CLI),
   and installs it via the `code` CLI (without `code` it is only packaged).
9. Prints the VSIX's path, to install the same file on other machines with
   `code --install-extension <file>`.

Without a Dart SDK, or with `./compile_and_install.sh --no-dart`
(`.\compile_and_install.ps1 -NoDart`), steps 2–5 are skipped: the VSIX has no
`tom_bs` and no `validate_codespecs` for the host, and a red warning before and
after the closing line says so. Such a VSIX lacks two things only:

- **DartScript** (`tom_bs`): the Dart bridge, running `.dart` / D4rt scripts,
  the CLI integration server, the bridge-side Agent SDK, the bridge debug
  logging, process monitor, Print Configuration and Run Tests;
- **CodeSpecs validation** (`validate_codespecs`): `tomAi_specCodeSpecsValidate`,
  the back-link agreement of `tomAi_specCodeSpecsTrace` and the validation
  stage of `tomAi_specCodeSpecsStatus`.

Everything else works: the chat panels and their transports, the prompt queue,
the tools, quests, todos and processes, TomSpecs editing.

A VSIX is about 150 MB; `--all-platforms` adds about 110 MB per added platform
(about 380 MB with all three).

After install, reload VS Code: `Cmd/Ctrl+Shift+P` → **Developer: Reload Window**.

### Alternative: bundle prebuilt binaries for all platforms

`install_extension.sh` / `.ps1` builds the same VSIX but bundles prebuilt
`tom_bs` binaries copied from `tom_binaries/tom/<platform>/` (it does **not**
compile the bridge). **They are only as current as the last from-source build
on each platform's host** (step 5 above); a platform nobody rebuilt lags the
bridge sources, so a script using a newer part of the scripting API can fail
through it (`npm run binaries:report` says, per platform).
`compile_and_install` is the install route on every host; this one is for a
machine without the d4rt and bridge checkouts. It compiles
`validate_codespecs` when a Dart SDK is found (without one, or with
`--no-dart`, it leaves it out as above), takes `--all-platforms` too, and it
says which bridge source the bundled `tom_bs` was built from
(`npm run check:tom-bs`) and that it lags:

```bash
bash install_extension.sh        # macOS / Linux
pwsh install_extension.ps1       # Windows
```

### Private distribution: `create_vsix` and the multi-platform VSIXes

To hand the extension to other machines, package a VSIX without installing
it:

```bash
bash create_vsix.sh              # with tom_bs / validate_codespecs for this platform
bash create_vsix_nodart.sh       # without the Dart binaries, no Dart SDK needed
pwsh create_vsix.ps1             # Windows (create_vsix_nodart.ps1 likewise)
```

For a VSIX that carries `tom_bs` and `validate_codespecs` for several
platforms, the binaries come from the binaries layer:

```bash
bash create_currentbinaries_vsix.sh   # this host's binaries built now, the others' as the layer holds them
bash create_fleetcompiled_vsix.sh     # every fleet platform's binaries built now, each on its own host
pwsh create_currentbinaries_vsix.ps1  # Windows (create_fleetcompiled_vsix.ps1 likewise)
```

- `create_currentbinaries_vsix` builds this host's binaries
  (`compile_and_install --binaries-only`, into the layer), then packages with
  every platform's `tom_bs` and `validate_codespecs` from the layer. Its report
  names each platform's binaries with their build stamps and says which are
  older than the sources here.
- `create_fleetcompiled_vsix` is for a reconciled, quiet fleet (the reconcile
  is yours to start; the script never reconciles or pulls a host). It checks
  that every `build: true` host of the `fleet_hosts` registry
  (`al_the_bear/repo_structure.md`: mbp darwin-arm64, bigbeast linux-x64,
  legiondary01 win32-x64) is reached and at this host's commits of
  `tom_ai/vscode`, `tom_ai/d4rt` and `tom_ai/ai_build` — a host that is not is
  named and nothing is built. Then each host runs its own
  `compile_and_install --binaries-only` (over SSH; PowerShell on Windows; nice
  10 on Linux), fast-forwards its binaries layer (only the layer, only when it
  has no commits of its own), commits its platform's binaries and pushes; this
  host's layer is fast-forwarded to hold them all, and the VSIX is packaged
  with the three platforms' binaries. `--dry-run` / `-DryRun` stops after the
  check; `--hosts mbp,bigbeast` / `-Hosts` builds on those hosts only.

Both package through `install_extension --package-only` with
`TOM_LAYER_BINARIES=1` (no second build), with the Agent SDK's Claude CLI for
the three platforms and the workspace template, and end like `create_vsix`
plus the layer report.

`create_vsix` builds like `compile_and_install` (`--package-only` of
`install_extension.*`: no uninstall, no install) and always bundle the Agent
SDK's Claude CLI for darwin-arm64, linux-x64 and win32-x64
(`--all-platforms`; about 370 MB). They end with:

- the VSIX's path;
- the workspace template's path (`workspace_template.zip`, beside the VSIX and
  inside it as `resources/workspace_template.zip`);
- which binaries the VSIX carries for which platform.

`create_vsix.sh` carries `tom_bs` and `validate_codespecs` for the platform it
runs on only: a Dart binary cannot be built for another platform, so build the
VSIX on the platform that needs DartScript most, take the other platforms'
from the binaries layer (`create_currentbinaries_vsix`,
`create_fleetcompiled_vsix`, above), or configure binaries per platform
(below). Without a Dart SDK it builds as `create_vsix_nodart.sh` and
says so in red.

### Installing the VSIX on another machine

Both installers end with the VSIX's path. Copy that file to another machine
and install it there (no checkout, Node or Dart needed):

```bash
code --install-extension <path-to>/tom-ai-extension-0.1.0.vsix
```

What runs there depends on the binaries the VSIX carries for that machine's
platform. The extension checks them when it starts, for the platform it runs
on:

- `tom_bs` (DartScript) and `validate_codespecs` (CodeSpecs validation): for
  the build machine's platform, when it had a Dart SDK;
- `claude`, the Agent SDK CLI (the Agent SDK transport): for the build
  machine's platform; with `--all-platforms` for darwin-arm64, linux-x64 and
  win32-x64.

A VSIX built on macOS and installed on Windows therefore has no DartScript
and no CodeSpecs validation there, and the Agent SDK transport only if it was
built with `--all-platforms`; everything else works. When something is
missing:

- **DartScript / CodeSpecs validation:** the page
  **@T: Missing Dart Binaries (DartScript / CodeSpecs validation)** opens once
  per build and platform, filled for that machine (what is missing, how to
  install Dart, build or configure the binaries); a status-bar item
  *Dart binaries missing* opens it again, and the Status Page has a
  **Dart binaries** section. A DartScript command answers *"Restart Bridge
  needs DartScript, which is not available on win32-x64: the tom_bs binary is
  missing."* (its own name and platform) with a **What does this mean?**
  button.
  `tomAi_specCodeSpecsValidate` answers `binaryMissing` with how to get the
  binary; Trace and Status skip validation and warn, the user once per tool
  and window session.
- **Agent SDK CLI:** an Agent SDK prompt fails before it runs, naming the
  missing CLI, with **What does this mean?** opening
  **@T: Missing Agent SDK CLI (Claude CLI for this platform)**. Use another
  transport (direct API, VS Code LM, Copilot, a local model) or a VSIX built
  with `--all-platforms`.

**Prebuilt binaries for such a machine** (built there, or copied from a
machine of the same platform) are configured per platform in the workspace's
`.tom/tom_vscode_extension.json`; a configured file that exists is used before
the bundled one:

```json
{
  "bridge": {
    "executables": {
      "tom_bs": { "win32-x64": "C:\\tom\\tom_bs.exe" },
      "validate_codespecs": { "win32-x64": "C:\\tom\\validate_codespecs.exe" }
    }
  }
}
```

The keys are platforms (`darwin-arm64`, `linux-x64`, `win32-x64`, …), a family
wildcard (`darwin-*`) or `*`; values may use `~`, `${home}`,
`${workspaceFolder}`, `${env:NAME}` and `${binaryPath}`. `tom_bs` is the
executable the bridge profile names (`bridge.profiles.<profile>.executable`).
After configuring, **@T: Restart Bridge** picks up `tom_bs`; no reload is
needed.

### After installing: set up a workspace, start with the introduction quest

In a folder without `.tom/`, the extension's panels offer **Setup new
workspace folder** (also `@T: Setup New Workspace Folder` and the top of the
Status Page, beside **Create new quest**): it unpacks the workspace template the VSIX carries
(`resources/workspace_template.zip`) into a folder you pick or create.

- **A folder that is not empty** shows what is in it first; **Set up anyway**
  goes on.
- **A file that already exists** is asked about one by one: **Overwrite**,
  **Skip**, **Overwrite All** or **Skip All** for the rest, or **Cancel**
  (the files written so far stay). The end shows what was written,
  overwritten and skipped.
- **Adapt the configuration afterwards.** `.tom/tom_vscode_extension.json`
  comes from the machine the VSIX was built on: its bridge profiles' paths,
  `bridge.executables`, the Local LLM endpoint and the name of the API key's
  environment variable. The setup offers to open it.
- **Then open** the introduction quest or the folder, each in a new window,
  or stay.

The template brings the quest **tomai_introduction**, the workspace's
starting quest: open `_ai/quests/tomai_introduction/tomai_introduction.code-workspace`
(the setup offers to). Its overview opens by itself the first time (once per
quest and machine), describes every feature and links to a page about each;
its todos are a guided first tour, run in the prompt queue (a todo walk over
`intro*`) or one by one in the chat. While no quest is open, the panels show
a *No quest is open* banner with **Create new quest** (`@T: Create New
Quest`) and **Setup new workspace folder**.

### After installing: the `_ai` format migration

The `_ai` files carry a format version in `_ai/format-version.yaml`. When a
window starts, it compares that version with the one its build understands and
warns:
- **files older, or unstamped:** run the migration;
- **files newer:** a newer build migrated them on another machine; install
  that build.

To migrate, install the new build, reload every window, then run (in this
folder, after `npm run compile`):

```bash
npm run migrate:ai-formats              # dry run: lists every change
npm run migrate:ai-formats -- --apply   # does it
```

It brings every quest to the current formats in one run and writes the stamp
last, once nothing is left as a problem. Run it on each machine after a
reconcile brings older files in.

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
│   ├── d4rt/                          # d4rt repo (separate clone, sibling of vscode/)
│   │   ├── tom_d4rt_generator/        # d4rtgen — regenerates the d4rt bridges
│   │   └── tom_d4rt/                  # d4rt interpreter runtime
│   └── ai_build/                      # ai_build repo (sibling of vscode/)
│       ├── tom_som_typescript_runtime/ # SOM runtime → vendor/tom_som/*.tgz
│       └── tom_som_typescript_v0/     # SOM typed facade, meta, schemas
└── tom_binaries/                      # binaries layer: each platform's latest from-source build
    └── tom/<platform>/                # tom_bs, validate_codespecs and their *.build.json stamps
```

`<platform>` is VS Code's platform-vs id: `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, or `win32-x64`.

---

## Features

### Chat panels

The bottom **@CHAT** panel (`tomAi.chatPanel`) hosts two subpanels:

| Subpanel | Transport |
| --- | --- |
| Anthropic | Per profile: direct Anthropic SDK, Agent SDK, VS Code LM, or a Local LLM configuration (`anthropic-handler`, `agent-sdk-transport`, `localLlm-handler`). |
| Copilot | VS Code Copilot Chat; the answer comes back through an answer file Copilot writes (the Copilot Queue Wrapper). |

Alongside it: **@WS** (`tomAi.wsPanel`, workspace) in the bottom panel, and the
**@TOM** sidebar for the quest (process, quest notes, quest and session todos)
and the **@TOM WS** sidebar for the workspace (VS Code and workspace notes,
workspace todos, the todo log, window status).

### Highlights

| Area | Capabilities |
| --- | --- |
| Prompt Queue | One-file-per-entry YAML storage; auto-send / auto-start / auto-pause / auto-continue / restart; repeat with prefix/suffix placeholders; answer-wait timeout; watchdog health checks. |
| Timed Requests | Interval and scheduled firing; `sentCount`-based `sendMaximum` auto-pause; reminder + repeat config; global schedule-slot filtering; all fires enqueue through the Prompt Queue (single dispatch path). |
| Answer detection | RequestId-based detection with a file watcher plus a polling fallback. |
| Browsing | Markdown Browser with a grouped document picker, quest filters, line anchors, and auto-reload. |
| Status | Window Status panel showing per-window subsystem state from window-state files. |
| MCP server | Standalone MCP server publishing the tool registry over HTTP — see [doc/mcp_server.md](doc/mcp_server.md). |
| TomSpecs | 36 tools over TomSpecs, DocSpecs and CodeSpecs documents, readers on the MCP read-only floor, writers behind approval — see [doc/tomspecs_agent_workflow.md](doc/tomspecs_agent_workflow.md). |

### Output channels

`Tom Prompt Queue` · `Tom Timed Requests` · `Tom Extension Debug Log` · `Tom Tests` ·
`Tom Dartbridge Log` · `Tom Tool Log` · `Tom AI Anthropic Chat` ·
`Tom AI Anthropic Chat Responses` · `Tom AI Compaction and Memory Extraction` ·
`Tom AI: MCP Server` · `Tom AI Local Log`.

---

## Commands

Open the command palette and type `@T:` to discover commands.

| Group | Commands |
| --- | --- |
| Core AI | Send to Copilot · Send to Copilot (Default Template) · Send to Copilot (Pick Template) · Send to Anthropic/LLM · Send to Anthropic/LLM (Default Template) · Send to Anthropic/LLM (Pick Template) |
| Queue & timer | Open Prompt Queue · Open Timed Requests · Open Prompt Templates · Open Reusable Prompts |
| Workspace & runtime | Open in Markdown Browser · Extension Status Page · Restart Bridge · Start / Stop Tom CLI Integration Server · Start Process Monitor |

### Keybindings

High-use shortcuts (full list in [doc/quick_reference.md](doc/quick_reference.md)):

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+0` | Focus @CHAT |
| `Ctrl+Shift+9` | Focus @WS |
| `Ctrl+Shift+6` | Open Prompt Queue |
| `Ctrl+Shift+7` | Open Timed Requests |
| `Ctrl+Shift+5` | Open Raw Trail Viewer |
| `Ctrl+Shift+\` | Maximize toggle |

---

## Architecture

The extension activates `onStartupFinished` (`src/extension.ts`) and is layered:
handlers own webview wiring, services own side-effects, utils are pure.

| Folder | Role |
| --- | --- |
| `config/` | Configuration schemas + defaults (`sendToChatConfig.ts`, `tom_vscode_extension.schema.json`). |
| `extension.ts` | Activation entry point. |
| `handlers/` | Per-subsystem handlers — chatPanel, anthropic, agent-sdk-transport, localLlm, queueEditor, statusPage, mcpServer, … |
| `managers/` | Long-lived state managers (e.g. `promptQueueManager`, `reminderSystem`). |
| `services/` | Pure side-effect services — trail, tool-result store, history compaction, memory, drafts, answer files. |
| `storage/` | Disk-backed stores (`panelYamlStore`, notepad stores). |
| `tools/` | MCP-style tool surface — shared tool registry, tool executors, chat-enhancement / issue / test tools. |
| `types/` | Shared type declarations. |
| `utils/` | Pure helpers — `variableResolver`, `tomAiConfiguration`, `fsUtils`, `workspacePaths`, `retryWithBudget`. |
| `vscode-bridge.ts` | External bridge surface consumed by `tom_vscode_bridge`. |

### Key components

| Component | Role |
| --- | --- |
| `promptQueueManager` (managers) | The single dispatch path; owns queue state, automation, and watchdog recovery. |
| `anthropic-handler` / `agent-sdk-transport` (handlers) | Anthropic direct-SDK and Agent-SDK transports. |
| `shared-tool-registry` (tools) | The MCP-style tool surface shared by panels and the MCP server. |
| `mcpServer-handler` (handlers) | Standalone MCP server lifecycle and HTTP surface. |
| CLI Integration Server | TCP server (`19900`–`19909`) the scripting API connects to (hosted via the bridge). |
| `extensionConfigStore` (managers) | Section-scoped reads/writes of the per-quest config files. |

> **Configuration invariant.** Any change to the configuration shape must update
> **both** `src/config/sendToChatConfig.ts` (the TypeScript shape) and
> `src/config/tom_vscode_extension.schema.json` (the JSON Schema) in lockstep.

---

## Queue and timed-request behavior

- **Prompt Queue** — one-file-per-entry YAML storage; automation toggles for flow
  behavior; repetition with prefix/suffix placeholders; answer-wait timeout for
  time-based auto-advance; watchdog health checks to recover watcher issues.
- **Todo claims** — in todo iteration (a `<prefix>*` repeat count) the runner
  writes `status: in-progress` onto the todo it dispatches, before the send,
  and records the status it overwrote. Once that dispatch's answer arrives the
  todo's status is the agent's. If the run is stopped, interrupted, errors,
  or the item is removed before the answer arrives, the runner puts the prior
  status back — only when the todo still holds the runner's `in-progress`; a
  status anyone else wrote meanwhile is left alone. A Resend of that prompt
  claims the todo again. The claim is persisted with the queue item, so a
  reload does not lose it.
- **Timed Requests** — interval and scheduled firing modes; `sendMaximum` with
  `sentCount`-based auto-pause; reminder and repeat configuration; global
  schedule-slot filtering; every fire enqueues through the Prompt Queue.

Full model: [doc/multi_transport_prompt_queue_revised.md](doc/multi_transport_prompt_queue_revised.md).

---

## Development

```bash
npm run som:pack     # first, on a fresh checkout or after the SOM packages changed; then npm install
npm run codespecs:build  # compile validate_codespecs into bin/<platform>/ (needs a Dart SDK); the CodeSpecs tests run it
npm run codespecs:check  # is that binary built from tom_specs_clitool's current source? (its build stamp)
npm run check:tom-bs     # which bridge source the prebuilt tom_bs was built from, and whether the bridge changed since
npm run binaries:report  # per platform in tom_binaries: tom_bs / validate_codespecs build stamps and whether they are older than the sources
npm run compile      # tsc -p ./ + copy config json to out/config/
npm run watch        # incremental rebuild
npm test             # every stage: lint media, each test:<area> suite, tool-coverage audit; a summary per stage at the end
```

`npm run som:pack` also removes the installed SOM packages and their lockfile
entries: npm keeps a `file:` tarball whose name and version did not change even
when its content did, so the next `npm install` would otherwise keep the old
build.

Run the extension host for manual testing: open this project in VS Code, press
`F5`, and test commands in the Extension Development Host.

> Reloading the window alone does **not** pick up source changes — it reloads the
> *installed* VSIX. Repackage + reinstall first (`compile_and_install.sh`), then
> reload.

---

## Ecosystem

- [`tom_vscode_scripting_api`](../tom_vscode_scripting_api/README.md) — the typed
  Dart client that drives this extension over the CLI Integration Server.
- [`tom_vscode_bridge`](../tom_vscode_bridge/README.md) — the Dart bridge server
  this extension launches (`tom_bs`).
- [`tom_vscode_shared`](../tom_vscode_shared/README.md) /
  [`tom_vscode_workflow`](../tom_vscode_workflow/README.md) — the shared
  TypeScript libraries the extension is built from.
- [Repository map](../README.md) — the whole Tom VS Code ecosystem at a glance.

---

## Further documentation

User-facing guides live in [`doc/`](doc/). Contributors also have the
extension's development guidelines, the `_copilot_guidelines/` folder in the
source tree; they are not part of this documentation.

| Document | Covers |
| --- | --- |
| [doc/user_guide.md](doc/user_guide.md) | Complete feature guide. |
| [doc/quick_reference.md](doc/quick_reference.md) | Shortcuts, panels, command map. |
| [doc/extension_analysis.md](doc/extension_analysis.md) | Cross-component architecture analysis. |
| [doc/anthropic_sdk_integration.md](doc/anthropic_sdk_integration.md) | Anthropic direct + Agent SDK integration. |
| [doc/mcp_server.md](doc/mcp_server.md) | Standalone MCP server — config, auth, lifecycle, security. |
| [doc/tomspecs_agent_workflow.md](doc/tomspecs_agent_workflow.md) | Recipe: editing a TomSpecs specification and taking it through Phase 4 with the tools. |
| [doc/llm_tools.md](doc/llm_tools.md) | The LLM tool surface, the TomSpecs tools in §4.23–§4.25. |
| [doc/multi_transport_prompt_queue_revised.md](doc/multi_transport_prompt_queue_revised.md) | The current prompt-queue model. |
| [doc/llm_configuration.md](doc/llm_configuration.md) | Local LLM + Anthropic + history-compaction settings. |
| [doc/placeholder_engine.md](doc/placeholder_engine.md) | Placeholder engine reference. |
| [doc/copilot_chat_tools.md](doc/copilot_chat_tools.md) | Copilot tooling. |

---

## Status

| | |
| --- | --- |
| Name / publisher | `tom-ai-extension` (`@Tom`) · `peter-nicolai-alexis-kyaw` |
| Version | 0.1.0 |
| VS Code engine | `^1.96.0` |
| Node.js | ≥ 20 (targets v25) |
| Tests | 200 test files (`npm test` runs every stage — the tools, services, utils, managers and handlers suites and the tool-coverage audit — and summarizes each) |
| License | BSD-3-Clause |

---

## Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [Chat API](https://code.visualstudio.com/api/extension-guides/chat)

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](LICENSE).
</content>
