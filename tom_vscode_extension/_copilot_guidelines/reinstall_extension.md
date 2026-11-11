# Reinstall Extension Workflow

Use this workflow after changing extension code when the runtime doesn't reflect expected behavior.

## Steps

1. Typecheck: `npx tsc --noEmit`. Fix all errors and Problems-pane warnings first.
2. Install the updated extension in the target VS Code host with
   `compile_and_install.sh` / `.ps1` — the install route on every host. It
   builds `tom_bs` from the bridge sources for that host and puts it, with
   `validate_codespecs` and `spec_checks`, into the binaries layer (below). The prebuilt `tom_bs`
   binaries in `tom_binaries` are only as current as the last from-source build
   on each platform's host, so `install_extension.*`, which bundles them, is
   only for a machine without the d4rt and bridge checkouts, and its bridge may
   lack newer scripting-API members (`npm run binaries:report` says per
   platform).
3. Reload the VS Code window (`Developer: Reload Window`). Until it is reloaded, a window runs the build it started with: its status bar says **Reload: newer Tom AI build**, and `tomAi_getWorkspaceInfo` answers `build.reloadNeeded: true` (`tomAi_getQuestWindowStatus` per window). A live check of a new feature reads that first and stops with "reload first" instead of testing old code.
4. Re-run the affected command or open the affected view.

The tom_vscode_bridge d4rt bridges: a from-source install
(`compile_and_install.*`) regenerates them and runs the versioner, then
`scripts/bridge-generated-churn.cjs` puts back every file that changed only by
its time or build stamp and names the bridge files that really changed — commit
those with the bridge; a build leaves nothing else modified. The prebuilt
install runs `npm run check:bridges` (the bridge's
BRIDGE-FRESH-01 test, ~6 s) and warns when the committed bridges lag behind the
scripting API, since the prebuilt `tom_bs` was built from them. It then says which bridge source the
host's prebuilt `tom_bs` itself was built from (`npm run check:tom-bs`,
`scripts/check-tom-bs-provenance.cjs`): `tom_bs` prints its versioner stamp
(`[BSTART] Version: 1.0.0+38.42e69c0 (…)`) when started with an empty stdin, and
the bridge files whose content changed since that commit — the stamp and the
generators' `// Generated:` lines ignored — are named in a warning. The install
goes on; `compile_and_install` builds a fresh `tom_bs`.

The tom_* resolutions of the build's locks: `tom_vscode_bridge/pubspec.lock`
and `tom_d4rt_generator/pubspec.lock` (the build runs the d4rt generator from
its own checkout, with that lock) are machine-local (gitignored) and
`dart pub get` never moves them, so a host can hold a tom_* release that meets
every declared lower bound and still lacks an API the regenerated bridges call
— which used to fail only at `dart compile exe`, after the whole build — or a
fix the generator needs (`tom_analyzer_shared` 0.8.1, whose summaries no longer
drop a package's analyzer-excluded files). `scripts/bridge-lock-preflight.cjs`
compares each hosted tom_* package of both locks (the generator's when that
checkout is there; a folder argument checks that one package only) with its
newest release: pub.dev's latest (`PUB_HOSTED_URL`
when set), or, when pub.dev cannot be reached, the newest version in the local
pub cache — a floor, since a cold cache under-reports; a package neither can
answer for is named as not measured and never counted behind. From source
(`compile_and_install.*`) it runs right after the Dart SDK is found, before
anything is built, with `--fix`: `dart pub upgrade` of the whole lock when a
tom_* package is behind (naming only those packages left them where the lock's
other packages held them: the bridge's build_runner and test kept analyzer 10
and with it tom_d4rt_generator 1.52.0), then names any package still behind (a version constraint can hold
it, which is reported, not fatal); a failing upgrade stops the install. The
prebuilt route runs it with `--warn` beside `check:bridges`: it names the
packages and the upgrade command and goes on. By hand:
`npm run check:bridge-lock` (`node scripts/bridge-lock-preflight.cjs --warn`;
add `--offline` to read only the cache). Tests: BLP-1 – BLP-7 (`bridgeLockPreflight.test.ts`).

The install scripts (`install_extension.sh` / `.ps1`, `compile_and_install.*`)
build the TomSpecs SOM packages from the sibling `tom_ai/ai_build/` checkout
(`npm run som:pack`) before `npm install`. An install fails at that step when
ai_build is missing or does not build; `TOM_SOM_AI_BUILD` points it at another
location. Working by hand, run `npm run som:pack` before `npm install` whenever
the SOM sources changed: npm otherwise keeps the old tarball. The script packs
ai_build's working tree and warns about uncommitted changes in it; another
session's work in progress would otherwise end up in the extension. Use
`npm run som:pack -- --from-head` to pack only what is committed. Right after
`npm install` the scripts run `scripts/check-som-installed.cjs`
(`npm run som:check`): the installed model's `modelHash` must equal the one the
pack recorded, so an install never ships a model npm kept from an earlier pack.
Between installs, the CodeSpecs freshness test (CS-2b) fails once ai_build's
model moves on; `npm run som:pack && npm install` (what every install does)
brings the checkout level. The install
scripts also compile `validate_codespecs` and `spec_checks` (tom_specs_clitool) into
`bin/<platform>/` (`npm run codespecs:build`) with the Dart SDK. Both install
scripts look for it first (`scripts/find-dart.cjs`): `dart` on
PATH, then `DART_SDK`, `FLUTTER_ROOT`, the folder of `flutter` on PATH, and
known locations (`~/Desktop/development/flutter/bin`, `~/flutter/bin`,
`/opt/homebrew/bin`, …; on Windows `~\flutter\bin`, `C:\src\flutter\bin`,
`C:\tools\dart-sdk\bin`, …), and put the found folder on PATH for the rest of
the install. When none holds `dart` (or `--no-dart` / `-NoDart` is given,
or `TOM_NO_DART=1`), the install goes on in no-Dart mode: the bridge-lock
preflight, the from-source bridge build, the bridge freshness checks and the
`validate_codespecs` / `spec_checks` build are skipped, and the scripts end with a red warning
before and after the Finished line. `TOM_FIND_DART_DISABLE=1` makes
`find-dart.cjs` find nothing, to take the not-found route on a machine with
Dart. The wrappers (`compile_and_install.*`) settle the mode before calling the
base script and print the closing lines (`scripts/install_summary.sh` / `.ps1`):
the VSIX path, the warning, the finish time, the warning again. Beside each binary the build writes
`<name>.build.json` (`validate_codespecs.build.json`, `spec_checks.build.json`), a hash of its source; `npm run codespecs:check`
(and the test CV-8) say when tom_specs_clitool moved on since, so the binaries
need `npm run codespecs:build` again. The stamps are not packaged. After packaging,
`node scripts/check-vsix-contents.cjs` confirms that the VSIX carries the SOM
packages as real files and no symlinks, and lists per platform which of
`tom_bs` / `validate_codespecs` / `spec_checks` it carries (informational: a VSIX without them
is valid). It fails a VSIX that carries a provider SDK (anything under
`node_modules/@anthropic-ai/`, or a `bin/<platform>/claude[.exe]`). Both help
pages it requires (`resources/dart_binaries/missing_dart_binaries.md`,
`resources/agent_sdk/missing_agent_sdk_cli.md`) are what a window shows when
one of those is missing; it also requires the provider manifest and the
Provider SDKs page.

**Provider SDKs are not packaged.** `@anthropic-ai/sdk` and
`@anthropic-ai/claude-agent-sdk` are devDependencies (types, tests), which
vsce leaves out. The extension installs them on request (Provider SDKs page,
`src/handlers/providerSdks-handler.ts`; `src/services/providerInstaller.ts`:
tarballs from the npm registry, integrity-checked, unpacked into a staging
folder, swapped in, recorded in `providers-state.json`) into
`<globalStorage>/providers/<provider>/node_modules`, at the versions of
`resources/providers/providers.json`. That manifest is written from
`package-lock.json` by `npm run providers:manifest`
(`scripts/build-provider-manifest.cjs`): every provider's roots, their
dependency closure, the per-platform CLI packages (os / cpu / libc), each with
tarball URL and integrity. After an `npm install` that moves an SDK version,
run it again and commit the manifest (`npm run providers:check`, test PS-1).
At run time `src/services/providerRuntime.ts` loads `@anthropic-ai/sdk` with a
`require` rooted in the provider folder and the Agent SDK by its `sdk.mjs` file
URL; the CLI is handed to the SDK as `pathToClaudeCodeExecutable`. In a
development checkout, when no provider is installed, the devDependencies
stand in (`TOM_PROVIDER_SDKS_NO_DEV_FALLBACK=1` turns that off, as a VSIX
runs). Tests: `providerSdks.test.ts` (PS-1 – PS-6, a local registry),
`providerSdksPage.test.ts` (PP-1 – PP-4), `agentSdkCli.test.ts` (AC-1 – AC-5).

Before packaging, both installers build the workspace template
(`scripts/build-workspace-template.cjs`, `npm run template:build`): from the
workspace, the config (its issue / test panel repositories and command lines
emptied: `genericConfig`), `_copilot_guidelines/` without this workspace's
projects and checks guidelines and the ones that only point into its packages,
CLAUDE.md,
`.github/copilot-instructions.md` and `_ai` roles / processes / schemas /
prompt / format-version.yaml and the starting quest `tomai_introduction`,
plus `.tom/workspace_template.json` (its type, `dart`). From the quest it
leaves out what its use on this machine writes (`history/`, `session-todo.*`,
the host's `extension_config`, `process-state`); anywhere else such host-bound
files, and literal secrets, make it refuse and write nothing. The result is
`resources/workspace_template.zip` (in the VSIX, required by
`check-vsix-contents.cjs`) and a copy beside the VSIX; @T: Setup New Workspace
Folder unpacks it. Markdown is packed without its `<!-- workspace-specific -->`
blocks (CLAUDE.md and its mirror end with the workspace's own part, which the
template leaves out) and without list items or table rows linking to a
left-out file, and the Active Quests table keeps only `tomai_introduction`
(`templateFileData`, `EXCLUDED_PATHS`).

**Packaging without installing** (private distribution): `create_vsix.sh` /
`.ps1` build from source with the Dart binaries for this platform,
`create_vsix_nodart.sh` / `.ps1` without the Dart step; both run
`install_extension.*` in its package-only mode (`--package-only` / `-PackageOnly` / `TOM_PACKAGE_ONLY=1`:
no uninstall, no prompt, no `code --install-extension`). They end with the
VSIX path, the template path and the per-platform report of
`check-vsix-contents.cjs`. Tests: `createVsixScripts.test.ts` (CS-1 – CS-5).

**The VSIX as a download.** Every `create_*_vsix` script (sh and ps1) ends
with `scripts/vsix-release.cjs` (`tom_release_precheck` / `tom_release_publish`
in `scripts/install_summary.sh`, `Get-TomReleasePrecheck` / `Publish-TomRelease`
in the `.ps1` one): at its start `precheck` records whether the tom_vscode
checkout is clean and pushed (the release must name a commit anyone can check
out); at its end `publish` uploads the VSIX as the asset `tom-ai-extension.vsix`
of the GitHub Release `vscode-extension-latest` of `al-the-bear/tom_binaries`
(`gh release create` the first time, `gh release upload --clobber` and `gh
release edit` after) — link https://github.com/al-the-bear/tom_binaries/releases/download/vscode-extension-latest/tom-ai-extension.vsix — and writes
`vscode_extension/vsix/README.md` there (commit, date, size, script, the
platforms whose Dart binaries it carries with their stamps), committed and
pushed in the tom_binaries checkout, else through the GitHub API. Skipped with
a warning, the VSIX left local and the script still succeeding: `--no-release`
/ `-NoRelease`, a dirty or unpushed checkout, HEAD moved during the build, no
`gh`, no login that may push. Before bundling from the layer, `install_extension.*`
runs `binaries-layer.cjs sync` (`TOM_LAYER_NO_SYNC=1` skips it). Tests:
`vsixRelease.test.ts` (VR-1 – VR-5), `binariesLayer.test.ts` (BL-7).

**The binaries layer** (`tom_binaries/tom/<platform>/`): every from-source build
(`TOM_BRIDGE_FROM_SOURCE=1`: `compile_and_install.*`, `create_vsix.*`) ends its
Dart part with `node scripts/binaries-layer.cjs publish`: it copies this host's
`tom_bs` and each clitool binary (`validate_codespecs`, `spec_checks`) with its `<name>.build.json` there, writes
`tom_bs.build.json` (the versioner stamp `tom_bs` prints on start, its build
time, the host, and `bridgeSourceHash`: the bridge's lib/ and bin/ Dart files
and pubspec.yaml as built, without the versioner file and the `// Generated:`
lines, CRLF normalised; kept when the binary is byte-identical), commits exactly those
files (`git commit -- <paths>`, nothing else in the layer) and pushes. A refused
push exits 3: the commit stays local, the install goes on, and nothing pulls
the layer. Such commits pile up, one per install, and the refusal scrolls past
mid-build, so the closing lines of every install (`install_extension.*`,
`compile_and_install.*`, also with `--binaries-only`) repeat it:
`binaries-layer.cjs unpushed` fetches, counts the layer's commits not on its
remote and says to push them with `/tom_push_binaries`; silent when the layer
is level. It never merges, rebases or pushes. `--no-layer` / `-NoLayer` / `TOM_NO_LAYER=1` skips it.
`--binaries-only` / `-BinariesOnly` (`TOM_BINARIES_ONLY=1`) builds only the two
binaries and publishes them: SOM pack, npm, TypeScript, the Agent SDK CLI, the
template and vsce are skipped. `--layer-binaries` / `-LayerBinaries`
(`TOM_LAYER_BINARIES=1`, `TOM_LAYER_PLATFORMS=a,b`) builds nothing with Dart
and bundles every platform's two binaries from the layer
(`binaries-layer.cjs bundle`; the stamps stay out of the VSIX).
`binaries-layer.cjs report` (`npm run binaries:report`) gives, per platform,
each binary's stamp and whether it is older than the sources here: `tom_bs`
is current when its `bridgeSourceHash` is the bridge sources' hash here
(uncommitted edits included), else `check-tom-bs-provenance.cjs`'s
`changedSince` on its stamp's commit decides,
each clitool binary through its stamp's source hash against
`codespecs-binary-stamp.cjs`'s `sourceHash` (of that binary) now.

On top of it, two private-distribution scripts:
`create_currentbinaries_vsix.sh` / `.ps1` (this host's binaries built with
`--binaries-only`, then one `--package-only` run with `TOM_LAYER_BINARIES=1`)
and `create_fleetcompiled_vsix.sh` / `.ps1`, which first runs
`scripts/fleet-binaries.cjs`: the `build: true` hosts of the `fleet_hosts`
registry (`al_the_bear/repo_structure.md`), a read-only preflight over SSH
(reached; `tom_ai/vscode`, `tom_ai/d4rt`, `tom_ai/ai_build` at this host's
commits; a Dart SDK found by `find-dart.cjs`; Node), then
`compile_and_install --binaries-only` with `TOM_LAYER_FF=1` on each — this
host first, Linux at nice 10, Windows as `powershell -File
compile_and_install.ps1 -BinariesOnly` — where `publish --ff` fast-forwards
the layer first (refused when it has commits of its own) and every failure is
fatal; then this host's layer is fast-forwarded. A host that is not level stops
the run before anything is built: the reconcile is the user's. Tests:
`createVsixScripts.test.ts` (CS-6 – CS-10), `binariesLayer.test.ts` (BL-1 –
BL-4 against throw-away git repositories, FB-1 – FB-3 the fleet helpers).

For a machine without Dart there is `create_layerbinaries_vsix.sh` / `.ps1`:
it builds the VSIX from source with no Dart step, bundling every platform's
`tom_bs`, `validate_codespecs` and `spec_checks` from a binaries layer — the workspace's
`tom_binaries` checkout, `--layer <dir>` (`-Layer`), or with `--clone`
(`-Clone`) a shallow clone of the public `al-the-bear/tom_binaries` into
`.tom_binaries/`. The layer is public, so its build stamps and commit messages
name the platform, never the host. Binaries are built and bundled for the
fleet's build platforms only — darwin-arm64, linux-x64, win32-x64
(`binaries-layer.cjs` `DEFAULT_PLATFORMS`, which `fleet-binaries.cjs` reads).

`vsce package` rewrites the README's relative links into absolute ones for the
extension's details page. Every installer passes the base URLs from
`node scripts/vsix-base-url.cjs content|images`, which reads package.json's
`repository` (the tom_vscode repo, folder `tom_vscode_extension`, branch
`main`). vsce's own guess from that field would drop the folder, so the URLs are
never hard-coded in a script and never left to vsce (VB-1 – VB-3).

## When required

- Changes to `package.json` contributions (commands, menus, keybindings, custom editors, activation events).
- Activation-time wiring changes (new handlers, new service singletons).
- Webview resource / runtime mismatches (changed HTML builders, new codicon / script references).
- Stale command metadata in host instance after renames.
- JSON Schema changes in `config/tom_vscode_extension.schema.json` (settings UI caches schemas).

## What doesn't need reinstall

- Pure logic changes inside handler methods — a reload window is usually enough.
- Markdown doc updates — no reload needed.
- Config file edits under `_ai/` — hot-reloaded by file watchers.

## Verification

- Command appears with updated title / keybinding in the palette.
- Panel / view naming and sections are updated (`@CHAT`, `@WS`, `@TOM`).
- No activation errors in "Extension Host" output or "Tom Debug" output channel.
- For chat changes: send a test prompt and confirm trails land in the session's folder, `_ai/quests/<quest>/history/sessions/<session>/` (`live-trail.md`, `trail/`).

## Unattended runs on Windows (over SSH)

`compile_and_install.ps1` runs unattended: it sets `TOM_BRIDGE_FROM_SOURCE=1`,
which also auto-confirms the package prompt. Running it with its output sent to
a log works under Windows PowerShell 5.1 and PowerShell 7:

```powershell
& .\compile_and_install.ps1 *> C:\Code\al_the_bear\inhouse\second_wind\enterprise_flutter\tom_agent_container\ztmp\<quest>_<yymmdd>_<todo-id>_install.log
```

`install_extension.ps1` keeps `$ErrorActionPreference = "Stop"`. Under PS 5.1
that preference turns any line a native program writes to stderr into a
terminating `NativeCommandError`, but only when output is redirected. For that
reason every native call (`npm`, `dart`, `node`, `nvm`, `vsce`, `code`) runs
through the script's `Invoke-Native { ... }`, which sets `Continue` for that
call alone, and is followed by a `$LASTEXITCODE` check. The extension test
`src/utils/__tests__/installScriptNativeCalls.test.ts` fails if a native call is
added without the wrapper. If you add a native call, wrap it and check its exit
code.

A build takes several minutes, so start it in a way that outlives the SSH
session:

- **Use a WMI-created process.** `Invoke-CimMethod -ClassName Win32_Process
  -MethodName Create` starts a process that is not a child of the SSH session,
  so it keeps running after the session closes. Do the redirection at the
  `cmd.exe` level, so that PowerShell's stream handling does not decide what
  reaches the log:

  ```powershell
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = 'cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Code\al_the_bear\inhouse\second_wind\enterprise_flutter\tom_agent_container\tom_ai\vscode\tom_vscode_extension\compile_and_install.ps1 > C:\Code\al_the_bear\inhouse\second_wind\enterprise_flutter\tom_agent_container\ztmp\<quest>_<yymmdd>_<todo-id>_install.log 2>&1'
    CurrentDirectory = 'C:\Code\al_the_bear\inhouse\second_wind\enterprise_flutter\tom_agent_container\tom_ai\vscode\tom_vscode_extension'
  }
  ```

  (The container sits at `C:\Code\al_the_bear\inhouse\second_wind\enterprise_flutter\tom_agent_container` on legiondary01: the
  workspace is mirrored at the same shape under every fleet root.) Name the log
  by the ztmp rule (`<quest>_<yymmdd>_<todo-id>_install.log`). The log is
  UTF-8 (cmd.exe's redirection), apart from PowerShell's error records.
  Then follow the log (`Get-Content ...\<quest>_<yymmdd>_<todo-id>_install.log -Tail 20`), and delete it once the todo is done. The run has
  succeeded when the log ends with `Installation complete!` and the
  `Finished at` line.
- **Do not use `Start-Process`** from an SSH session for this. Its process is a
  child of the session and is killed when the session ends, which leaves a
  half-built `bin/` and no error.
- `npm install` has no timeout. If the log stops moving for several minutes at
  `Installing npm dependencies...`, kill the process tree and start the run
  again.

## Pattern prompt

When the user issues `!!!reload finished` after a reload, the extension changes are in effect and you can resume the task. See [restart_debugging_flow.backup.md](restart_debugging_flow.backup.md) if the reload doesn't fix the issue.
