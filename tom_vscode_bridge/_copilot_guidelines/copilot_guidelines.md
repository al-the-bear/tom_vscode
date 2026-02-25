# Tom VS Code Bridge - Copilot Guidelines

## Bridge Generation

When working on this project, bridges need to be regenerated after modifying source classes in the `vscode_api` folder.

### How to Regenerate Bridges

Run the following command from the `tom_vscode_bridge` directory:

```bash
dart run tool/generate_bridge.dart --all
```

This will regenerate the bridge file at `lib/vscode_api/vscode_api_bridge_generated.dart`.

### When to Regenerate

Regenerate bridges when:
- Adding new methods to existing bridge source classes (e.g., `VsCodeHelper`)
- Adding new classes that should be bridged
- Modifying method signatures in bridge source classes
- After updating the `tom_d4rt` dependency

### Bridge Source Files

The bridge generator processes classes in:
- `lib/vscode_api/*.dart` - VS Code API wrapper classes

### Generated Output

- `lib/vscode_api/vscode_api_bridge_generated.dart` - Contains all generated bridge registrations

### Dependencies

This project depends on `tom_d4rt` for the D4rt interpreter. When `tom_d4rt` is updated:
1. Update the version in `pubspec.yaml`
2. Run `dart pub get`
3. Regenerate bridges with `dart run tool/generate_bridge.dart --all`

## Extension Reinstallation

When testing changes to the bridge or extension, use the dedicated reinstallation script:

```bash
cd /Users/alexiskyaw/Desktop/Code/tom2/tom_vscode_extension
./reinstall_for_testing.sh
```

**Do NOT use** `install_tom_vscode_extension.sh` from the workspace root - use `reinstall_for_testing.sh` instead.

After reinstallation, the user must manually reload VS Code:
- `Cmd+Shift+P` → `Developer: Reload Window`

Wait for `!reload finished` prompt before continuing testing.
