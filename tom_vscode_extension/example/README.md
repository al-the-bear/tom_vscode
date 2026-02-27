# VS Code Integration Examples

Examples demonstrating the VS Code extension capabilities, including bridge communication, Copilot integration, and testing.

## Table of Contents

- [JavaScript Examples](#javascript-examples)
- [TypeScript Examples](#typescript-examples)
- [Testing Commands](#testing-commands)
- [Running Examples](#running-examples)

---

## JavaScript Examples

### example_script.js

A JavaScript file that can be executed via `executeFile`. Demonstrates:
- Accessing VS Code API through context
- Making nested calls back to Dart bridge
- Returning structured results

```javascript
module.exports = async function execute(params, context) {
    const { vscode, bridge, console } = context;
    
    // Access workspace folders
    const folders = vscode.workspace.workspaceFolders;
    
    // Make nested call to Dart
    const dartInfo = await bridge.sendRequest('getWorkspaceInfo', {...});
    
    return { success: true, data: dartInfo };
};
```

**Usage from Dart**:
```dart
final result = await vscode.workspace.executeFile(
  filePath: 'example/example_script.js',
  params: {'verbose': true},
);
```

### example_inline_script.js

An inline script for `executeScript`. Shows:
- Accessing parameters directly
- Using VS Code API without module exports
- Returning values from inline code

**Usage from Dart**:
```dart
final result = await vscode.workspace.executeScript(
  script: '<script content>',
  params: {'name': 'World'},
);
```

---

## TypeScript Examples

### nested_execution_example.ts

Demonstrates complex nested execution flows:
1. TypeScript calls Dart method
2. Dart calls back to TypeScript (multiple times)
3. Each nested call completes before returning
4. Final result includes all nested results

**Key Pattern**:
```typescript
const result = await bridge.sendRequest<any>('analyzeAndDocumentProject', {
    projectPath: workspaceRoot
});
// Result contains structured data from all nested calls
```

---

## Testing Commands

The extension includes a built-in test runner (in `tests.ts`):

### Run Bridge Tests

**Command**: `@T: Run Test Script on Bridge`

Runs all D4rt test scripts from `tom_vscode_bridge/test/` directory:

1. Clears `test_results/` directory
2. Executes each `.dart` test file via the bridge
3. Saves individual results to `test_results/{name}_results.json`
4. Displays summary in output channel

---

## Running Examples

### From Command Palette

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run `@T: Run Test Script on Bridge`
3. View results in output channel and test_results/ folder

### From Context Menu

1. Right-click on a `.dart` file in Explorer
2. Select **Execute in D4rt** or **Execute as Script**

### From TypeScript Code

```typescript
import { BridgeTestRunner } from '../src/tests';

// Run tests programmatically
const runner = new BridgeTestRunner(context);
await runner.runAllTests();
```

---

## Test Results Format

Results are saved to `test_results/{name}_results.json`:

```json
{
  "testFile": "01_test_vscode_api.dart",
  "testName": "01_test_vscode_api",
  "passed": true,
  "duration": 150,
  "result": { ... },
  "timestamp": "2026-01-07T10:30:00.000Z"
}
```

This makes it easy to:
- Parse programmatically
- Filter by test name
- Calculate statistics
- Track test history over time
