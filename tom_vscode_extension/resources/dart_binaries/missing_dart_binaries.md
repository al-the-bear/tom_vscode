# Missing Dart binaries: DartScript and CodeSpecs validation

Two features of the Tom AI extension run programs compiled from Dart:

- **DartScript** runs `tom_bs`, the Dart bridge.
- **CodeSpecs validation** runs `validate_codespecs`.

A VSIX carries them only for the platforms it was built with. A VSIX built
without a Dart SDK has none, and one built on macOS has none for Windows or
Linux.

## This machine

Platform: **{{platform}}**. Missing: {{missing}}.

{{statusTable}}

Run **@T: Missing Dart Binaries (DartScript / CodeSpecs validation)** from the
Command Palette to see this page again; the Status Page has the same table in
its **Dart binaries** section.

## What does not work without them

Without `tom_bs` (DartScript):

- the Dart bridge (**@T: Restart Bridge**, **@T: Switch Bridge Profile...**);
- running `.dart` and D4rt scripts (**@T: Execute File**, **@T: Execute as
  Script**, the `.dart` menus);
- the CLI integration server (**@T: Start Tom CLI Integration Server**);
- the bridge-side Agent SDK (Dart code asking the Agent SDK);
- **@T: Toggle Bridge Debug Logging**, **@T: Start Tom Process Monitor**,
  **@T: Print Configuration**, **@T: Run Tests**;
- the scripting tools that work through the bridge.

Without `validate_codespecs` (CodeSpecs validation):

- `tomAi_specCodeSpecsValidate` (the 41 checks over a generated trio);
- the agreement part of `tomAi_specCodeSpecsTrace` over code folders;
- the validation stage of `tomAi_specCodeSpecsStatus`.

## What keeps working

Everything else: the chat panels and their transports, the prompt queue and
timed requests, the tools, quests, todos and processes, TomSpecs editing, and
the CodeSpecs steps that need no binary — extraction, the gate, the verdicts
and the todo planning.

## Install the Dart SDK

Dart **3.10.4 or newer** (below 4.0). The official instructions are at
<https://dart.dev/get-dart>. A Flutter SDK works too: it carries Dart in its
`bin/` folder.

- **macOS** (Homebrew):

  ```sh
  brew tap dart-lang/dart
  brew install dart
  ```

- **Windows**: Chocolatey `choco install dart-sdk`, or with winget look up the
  package with `winget search "Dart SDK"` and install it; or unpack the SDK
  zip from <https://dart.dev/get-dart/archive> and put its `bin` on `Path`.
- **Linux** (Debian / Ubuntu, apt):

  ```sh
  sudo apt-get update && sudo apt-get install apt-transport-https
  wget -qO- https://dl-ssl.google.com/linux/linux_signing_key.pub \
    | sudo gpg --dearmor -o /usr/share/keyrings/dart.gpg
  REPO=https://storage.googleapis.com/download.dartlang.org/linux/debian
  KEY=/usr/share/keyrings/dart.gpg
  echo "deb [signed-by=$KEY arch=amd64] $REPO stable main" \
    | sudo tee /etc/apt/sources.list.d/dart_stable.list
  sudo apt-get update && sudo apt-get install dart
  ```

The extension never needs Dart at run time: Dart only builds the binaries.

## Build the binaries on this machine

A binary runs only on the platform it was compiled on, so build them on this
machine. With the workspace checked out (`tom_ai/vscode`, `tom_ai/ai_build`,
`tom_ai/d4rt`), from `tom_ai/vscode/tom_vscode_extension/`:

- `./compile_and_install.sh` (macOS, Linux) or `.\compile_and_install.ps1`
  (Windows) builds both, packages a new VSIX and installs it;
- `npm run codespecs:build` builds only `validate_codespecs`, into the
  checkout's `bin/{{platform}}/`.

Without the full workspace, compile each one where its sources are:

```sh
# tom_bs, in tom_ai/vscode/tom_vscode_bridge
dart pub get
dart compile exe bin/tom_bs.dart -o tom_bs

# validate_codespecs, in tom_ai/ai_build/tom_specs_clitool
dart pub get
dart compile exe bin/validate_codespecs.dart -o validate_codespecs
```

On Windows name the outputs `tom_bs.exe` and `validate_codespecs.exe`.

## Use binaries you already have

Either way, the extension checks again on the next command; for the bridge run
**@T: Restart Bridge**.

### Configure them

In the workspace's `.tom/tom_vscode_extension.json`, give each binary a path
per platform in `bridge.executables`. The key is the platform
(`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`), a
family wildcard (`darwin-*`) or `*`. A configured file that exists is used
before the bundled one.

```json
{
  "bridge": {
    "executables": {
      "tom_bs": {
        "darwin-arm64": "~/.tom/bin/darwin-arm64/tom_bs",
        "linux-x64": "/opt/tom/bin/tom_bs",
        "win32-x64": "C:\\tools\\tom\\tom_bs.exe"
      },
      "validate_codespecs": {
        "darwin-arm64": "~/.tom/bin/darwin-arm64/validate_codespecs",
        "linux-x64": "/opt/tom/bin/validate_codespecs",
        "win32-x64": "C:\\tools\\tom\\validate_codespecs.exe"
      }
    }
  }
}
```

The values may use `~`, `${home}`, `${workspaceFolder}`, `${env:NAME}` and
`${binaryPath}` (the per-platform folder in `bridge.binaryPath`). `tom_bs` is
the executable the bridge profile names (`bridge.profiles.<profile>.executable`,
normally `tom_bs`).

### Or copy them into the extension

Put them into this platform's folder of the installed extension:

`{{binDir}}`

On macOS and Linux make them executable (`chmod +x`). On macOS a downloaded
file may also need `xattr -d com.apple.quarantine <file>`. Installing a new
VSIX replaces this folder, so configuring them is the lasting way.
