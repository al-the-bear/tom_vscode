# Tom VS Code Bridge - Copilot Guidelines

## Bridge Generation

The d4rt bridges are regenerated from the package's public API whenever that API
changes. Generation is driven by the `d4rtgen:` section of `buildkit.yaml` (it
bridges the classes reachable from the `lib/tom_vscode_bridge.dart` barrel).

### How to Regenerate Bridges

Run the `d4rtgen` tool from the `tom_vscode_bridge` directory:

```bash
d4rtgen
```

This regenerates the generated artefacts configured in `buildkit.yaml`:

- `lib/src/d4rt_bridges/tom_vscode_bridge_bridges.b.dart` — the bridge
  registrations (`TomVscodeBridgeBridges`),
- `lib/d4rt_bridges.b.dart` — the barrel,
- `lib/dartscript.dart` — the dartscript registration,
- `bin/d4rtrun.b.dart` — the generated test runner.

Inspect the effective config with `d4rtgen --dump-config` or
`d4rtgen --list --show`.

### When to Regenerate

Regenerate bridges when:
- Adding new methods to existing bridge source classes (e.g., `VsCodeHelper`)
- Adding new classes that should be bridged
- Modifying method signatures in bridge source classes
- After updating the `tom_d4rt` dependency
- After bumping `tom_vscode_scripting_api` (its API is bridged into the
  interpreter at compile time)

### Dependencies

This project links `tom_vscode_scripting_api` and `tom_d4rt` at compile time.
When either is updated:
1. Update the version constraint in `pubspec.yaml`
2. `dart pub upgrade <package>` (move the lock)
3. Regenerate bridges with `d4rtgen`
4. `dart analyze`
5. Recompile the `tom_bs` binary (see below)

## Building the `tom_bs` binary

`buildkit :compiler` compiles `bin/tom_bs.dart` into
`$TOM_BINARY_PATH/<platform>/tom_bs` per the `compiler:` section of
`buildkit.yaml`:

```bash
buildkit :compiler -t linux-x64
```

Only the host platform compiles natively; darwin / win32 binaries are built on
their own hosts. If the target binary is in use by a running VS Code window the
compile fails with `Text file busy` — compile to a temp path and `mv` it into
place (rename works over a busy executable on Linux). `install_extension.sh`
bundles whatever `tom_bs` binaries are present under `$TOM_BINARY_PATH/`.

## Live scripting tests

`test_scripts/` holds live integration scripts (e.g.
`scripting_api_suite.dart`) that drive a running window through the CLI
Integration Server. They require a live window, so they are kept out of `test/`
and are not run by `dart test` / `testkit`. See `test_scripts/README.md`.

## Extension Reinstallation

When testing changes to the bridge or extension, use the dedicated reinstallation script:

```bash
cd ../tom_vscode_extension
./install_extension.sh
```

After reinstallation, the user must manually reload VS Code:
- `Cmd+Shift+P` → `Developer: Reload Window`

Wait for `!reload finished` prompt before continuing testing.
