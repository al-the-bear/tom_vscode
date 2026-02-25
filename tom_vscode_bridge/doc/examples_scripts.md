# VS Code Bridge Examples

This directory contains examples demonstrating the VS Code Bridge API usage patterns.

## Example Categories

### 1. Helper-First Examples (`VsCodeHelper`)

**File:** [d4rt_helpers_demo.dart](d4rt_helpers_demo.dart)

Uses `VsCodeHelper` static methods for simplified, script-friendly access to VS Code APIs.

**Categories Covered:**
- **Window & UI:** `showInfo`, `showWarning`, `showError`, `quickPick`, `inputBox`, `createOutput`, `appendOutput`, `setStatus`
- **Workspace:** `getWorkspaceRoot`, `getWorkspaceFolders`, `findFiles`, `readFile`, `writeFile`, `fileExists`, `deleteFile`, `getConfig`, `setConfig`
- **Development:** `getProjectType`, `getGitRoot`, `getDiagnostics`, `searchInWorkspace`
- **Copilot/AI:** `getCopilotModels`, `askCopilot`, `reviewCode`, `explainCode`, `generateTests`, `fixCode`
- **Advanced Editor:** `getSelection`, `getCursorPosition`, `copyToClipboard`, `readClipboard`
- **Testing/Debugging:** `getBreakpoints`, `getTestResults`, `runTests`
- **Batch Processing:** `Progress`, `FileBatch` helper classes

### 2. Direct API Examples (`VSCode`)

**File:** [test_vscode_api.dart](test_vscode_api.dart)

Uses the `VSCode` class and its namespaced properties for full API access.

**Categories Covered:**
- **Window:** `vscode.window.showQuickPick`, `showInputBox`, `createOutputChannel`, `setStatusBarMessage`, `createTerminal`, `sendTextToTerminal`, `showTerminal`
- **Dialogs:** `vscode.window.showSaveDialog`, `showOpenDialog`
- **Workspace:** `vscode.workspace.getWorkspaceFolders`, `findFilePaths`, `getConfiguration`, `getRootPath`
- **Commands:** `vscode.commands.executeCommand`, `getCommands`
- **Extensions:** `vscode.extensions.getAll`, `getExtension`, `getExtensionVersion`
- **Language Model:** `vscode.lm.selectChatModels`, `sendRequest`, `countTokens`

### 3. Copilot-Focused Examples

**File:** [copilot_example.dart](copilot_example.dart)

Demonstrates language model (Copilot) interactions in depth.

### 4. Explorer-Triggered Test Scripts

Scripts designed to be run from the VS Code Explorer with a defined class structure:

| File | Description | API Style |
|------|-------------|-----------|
| [test_helper_methods.dart](test_helper_methods.dart) | Tests `VsCodeHelper` methods: window, workspace, files, clipboard, editor | Helper |
| [test_context_menu.dart](test_context_menu.dart) | Tests direct API methods: window, workspace, commands | Direct |
| [test_inline_context_menu.dart](test_inline_context_menu.dart) | Tests language model/Copilot features | Direct |
| [test_advanced_features.dart](test_advanced_features.dart) | Tests terminal, dialogs, extensions, LM | Direct |
| [test_testing_debugging.dart](test_testing_debugging.dart) | Tests diagnostics, breakpoints, batch processing | Helper |

Each test script follows this pattern:
```dart
class MyScriptTests {
  Future<void> testMethod1() async { ... }
  Future<void> testMethod2() async { ... }
  
  Future<void> runAll() async {
    await testMethod1();
    await testMethod2();
  }
}

Future<Map<String, dynamic>> main() async {
  final tests = MyScriptTests();
  await tests.runAll();
  return {'status': 'complete'};
}
```

## Access Type Summary

| Access Type | When to Use |
|------------|-------------|
| `VsCodeHelper.method()` | Simple scripts, quick automation, most common use cases |
| `VSCode(bridge).namespace.method()` | Full control, advanced features, terminal/dialogs |

## Running Examples

Examples can be run via the D4rt bridge:

1. **From VS Code Command Palette:** Use "Run D4rt Script" command
2. **From Explorer Context Menu:** Right-click on a `.dart` file and select "Run as D4rt Script"
3. **Programmatically:** Via the bridge server API

## See Also

- [vscode_api_cleanup_recommendation.md](../vscode_api_cleanup_recommendation.md) - API cleanup recommendations
- [test_strategy_proposals.md](../test_strategy_proposals.md) - Testing strategy documentation
