````markdown
# Test and Fix Workflow for VS Code Bridge

This document provides a comprehensive guide for developing, testing, and debugging the VS Code extension (`tom_vscode_extension`) and the Dart bridge (`tom_vscode_bridge`).

---

## Overview

When working on the VS Code extension or Dart bridge, changes require either a full reinstall/reload cycle or a bridge restart to take effect, depending on which component was modified.

---

## Quick Reference Table

| Action | Command/Location |
|--------|------------------|
| Extension source | `tom_vscode_extension/src/` |
| Bridge source | `tom_vscode_bridge/lib/` |
| Reinstall extension | `cd tom_vscode_extension && ./reinstall_for_testing.sh` |
| Reload window | `dartscript.reloadWindow` command |
| Restart bridge only | `dartscript.restartBridge` command |
| Run tests | `dartscript.runTests` command |
| Test results | `tom_vscode_bridge/test_results/` (per-test JSON files) |
| Test files | `tom_vscode_bridge/test/` |
| View extension logs | Output panel → "DartScript" |
| View console errors | Help → Toggle Developer Tools → Console |

---

## Reinstall and Reload Process

### When to Use Full Reinstall

Use the full reinstall when changes were made to **tom_vscode_extension/src/** (TypeScript extension code):

1. **Run the reinstall script:**
   ```bash
   cd tom_vscode_extension && ./reinstall_for_testing.sh
   ```

2. **Reload the VS Code window** by sending the `workbench.action.reloadWindow` command

3. **Wait for confirmation** - After reload, the extension sends a special prompt `!!!Reload finished` to Copilot Chat, indicating:
   - TypeScript compiled successfully
   - Extension packaged and installed
   - Dart bridge restarted with latest code

### When to Restart Bridge Only

If changes were made **only** to **tom_vscode_bridge/lib/** (Dart bridge code):

- Send the command `dartscript.restartBridge` to VS Code
- This kills the bridge process and starts it again with the latest changes
- Window reload is **not** necessary in this case

---

## Test-Driven Development Workflow

### 1. Make Code Changes

Edit files in either:
- **TypeScript extension**: `tom_vscode_extension/src/`
- **Dart bridge**: `tom_vscode_bridge/lib/`

### 2. Create/Update Tests

Tests are located in: **`tom_vscode_bridge/test/`**

Example test file structure:

```dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

Future<void> main() async {
  // Your test code here
  await VsCodeHelper.showInfo('Test running!');
  
  // Get data from VS Code
  final workspaceInfo = await VSCode.vsCode.workspace.getWorkspaceFolders();
  
  // Return results
  VSCodeBridgeServer.setResult({
    'status': 'ok',
    'message': 'Test passed',
    'data': workspaceInfo,
  });
}
```

### 3. Reinstall/Reload or Restart Bridge

Depending on which files were changed (see above).

### 4. Run Tests

**From Command Palette:**
- Open VS Code Command Palette (Cmd+Shift+P)
- Run `DartScript: Run Test Script on Bridge`

**From Copilot:**
- Send the `dartscript.runTests` command to VS Code

The test runner finds all tests in `tom_vscode_bridge/test/` and runs them in numerical order.

### 5. Check Results

Results are saved to `tom_vscode_bridge/test_results/` as individual JSON files per test:

```
test_results/
├── 01_basic_test_results.json
├── 02_workspace_test_results.json
└── 03_vscode_api_test_results.json
```

Each result file contains:

```json
{
  "testFile": "01_basic_test.dart",
  "testName": "01_basic_test",
  "passed": true,
  "duration": 150,
  "result": {
    "status": "ok",
    "message": "Test passed"
  },
  "logs": [
    "[print] Test running!"
  ],
  "timestamp": "2026-01-07T10:30:00.000Z"
}
```

**Note:** The `test_results/` folder is cleared before each test run, ensuring you always see fresh results.

### 6. Identify and Fix Issues

If tests fail:
1. Check the error message and logs in the individual `test_results/{testname}_results.json` files
2. Check the DartScript output channel for detailed logs
3. Look at VS Code Developer Console (Help → Toggle Developer Tools → Console)
4. Make necessary code fixes
5. Repeat from step 3 (Reinstall/Reload or Restart Bridge)

---

## Test Examples

### Bridge Health Check

```dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

Future<void> main() async {
  VSCodeBridgeServer.setResult({
    'status': 'healthy',
    'timestamp': DateTime.now().toIso8601String()
  });
}
```

### VS Code Interaction Test

```dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

Future<void> main() async {
  final folders = await VSCode.vsCode.workspace.getWorkspaceFolders();
  await VsCodeHelper.showInfo('Found ${folders?.length ?? 0} workspace folders');
  
  VSCodeBridgeServer.setResult({
    'workspaceFolders': folders,
    'count': folders?.length ?? 0
  });
}
```

### File Operations Test

```dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';
import 'dart:io';

Future<void> main() async {
  final testFile = File('test_output.txt');
  await testFile.writeAsString('Test at ${DateTime.now()}');
  
  final exists = await testFile.exists();
  
  VSCodeBridgeServer.setResult({
    'fileCreated': exists,
    'path': testFile.absolute.path
  });
}
```

---

## Handling the "!!!Reload finished" Prompt

When you receive a prompt containing `!!!Reload finished` in Copilot Chat, this indicates:

- The extension has just been reinstalled and the window reloaded
- Both the VS Code extension and Dart bridge are now running with the latest code
- You should **continue testing** or **resume the previous task** that was in progress before the reload
- Typically continue with sending `dartscript.runTests` to trigger testing, then check results to continue fixing remaining issues

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Extension not responding | Check DartScript output channel for errors; try restart bridge |
| Bridge not starting | Check for port conflicts; ensure Dart is on PATH |
| Tests not found | Verify test files are in `tom_vscode_bridge/test/` |
| Changes not taking effect | Full reinstall + reload may be needed instead of bridge restart |
| TypeScript compile errors | Check terminal output after running `reinstall_for_testing.sh` |

````
