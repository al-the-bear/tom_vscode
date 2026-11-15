# VS Code Bridge Test Strategy

## Overview

The testing infrastructure spans two projects:

| Project | Language | Purpose |
|---------|----------|---------|
| `tom_vscode_bridge/` | Dart | Bridge server, VS Code API wrappers, helpers |
| `tom_vscode_extension/` | TypeScript | VS Code extension, bridge client, integration tests |

---

## Current Implementation Status

### Dart Unit Tests (tom_vscode_bridge) - ✅ 42 Passing

Located in `tom_vscode_bridge/test/`:

| File | Coverage |
|------|----------|
| `vscode_window_test.dart` | Quick pick, input box, output channels, status bar, terminals, dialogs, active editor |
| `vscode_workspace_test.dart` | Workspace folders, file operations (read/write/delete/exists), configuration, documents |
| `vscode_commands_extensions_test.dart` | Command execution, command listing, extension queries, activation |
| `vscode_language_model_test.dart` | Model selection, chat requests, token counting, tools |
| `vscode_chat_test.dart` | Chat participant creation and request handling |
| `vscode_helper_test.dart` | All VsCodeHelper static methods, Progress helper, FileBatch helper |
| `fake_bridge.dart` | FakeBridge mock implementation with responders map |

**Key Testing Features:**
- `FakeBridge` class with `responders` map for mocking bridge responses
- `BridgeCall` class captures method, params, timeout, scriptName for verification
- Timeout exception handling tests for fallback scenarios
- JSON-to-model mapping validation for all type classes

### TypeScript Integration Tests (tom_vscode_extension) - ✅ Implemented

Located in `tom_vscode_extension/src/`:

| File | Description |
|------|-------------|
| `testRunner.ts` | `BridgeTestRunner` class - comprehensive VS Code API integration tests |
| `autoTestWorkflow.ts` | `AutoTestWorkflow` class - automated test/fix iteration loop |

**Test Categories in testRunner.ts:**
- Bridge connection status verification
- VS Code Window API (messages, dialogs, editors, output channels)
- Copilot Language Model API (model selection, requests)
- Chat Participant API (create/dispose)
- Error handling (invalid command handling)
- Performance (concurrent command execution)

**Commands:**
- `DartScript: Test Bridge Integration` - Run all integration tests
- `DartScript: Auto Test & Fix Workflow` - Automated test/fix loop

**Output:** Results logged to `tom_vscode_bridge/bridge_test_results_vscode.jsonl`

### Scripts run in the bridge (tom_vscode_bridge)

There are no Explorer-triggered example scripts in the repository. What runs
against a live window is `test_scripts/scripting_api_suite.dart` (a CLI client
of a running window; see `test_scripts/README.md`), and the bridge's own
behaviour is covered by the unit tests in `test/` (`testkit :test`). Scripts for
`@T: Execute File` follow the examples of the [User Guide](USER_GUIDE.md#examples),
each run through `tom_bs`.

**Script structure for a check script:** one class collects the results by
category, and `main()` — which the bridge calls with no arguments — returns
them.

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

class MyScriptTests {
  Future<Map<String, dynamic>> runAll() async {
    final results = <String, dynamic>{};
    results['workspace'] = await testWorkspace();
    return results;
  }

  Future<Map<String, dynamic>> testWorkspace() async {
    final root = await workspace.getRootPath();
    return {'ok': root != null, 'root': root};
  }
}

Future<Map<String, dynamic>> main() async {
  final suite = MyScriptTests();
  return await suite.runAll();
}
```

---

## Running Tests

### Dart Unit Tests

```bash
cd tom_vscode_bridge
dart test                              # Run all 42 tests
dart test test/vscode_window_test.dart # Run specific file
dart test --reporter expanded          # Verbose output
```

### TypeScript Integration Tests

```bash
# From VS Code:
# 1. Command Palette → "DartScript: Test Bridge Integration"
# 2. Command Palette → "DartScript: Auto Test & Fix Workflow"

# Or compile and run extension:
cd tom_vscode_extension
npm run compile
# Press F5 to launch Extension Development Host
```

### Dart Example Scripts

1. **From VS Code Explorer:** Right-click on `.dart` file → "Execute as Script in DartScript"
2. **From Command Palette:** Use "Execute as Script in DartScript" command
3. **Standalone dry-run:** `dart run example/test_helper_methods.dart`

---

## Recommended Future Improvements

### Integration tests (VS Code extension)
- Capture bridge traffic (method, params, scriptName) in the extension to assert against expected shapes
- Write snapshots alongside the repo for regression detection
- Use a small workspace fixture (e.g., a synthetic Dart project) to make workspace-dependent results deterministic

### End-to-end / manual aids
- Add a command palette entry to run all example scripts sequentially and surface a summary in an output channel with pass/fail
- Provide a `mockMode` flag on the extension side to return canned responses for LM/chat so tests can run without Copilot
- Consider injecting a virtual clipboard/output/status sink so UI-affecting calls can be asserted without rendering UI

### Code changes to improve testability
- Extract a `BridgeClient` interface and allow dependency injection into wrapper classes
- Emit structured logs (JSON) from `sendRequest`/`sendNotification` to simplify parsing
- Add an opt-in "dry run" mode for helpers that suppresses mutating commands during tests

### Test Coverage Gaps
- Bridge server lifecycle tests (start/stop/restart)
- Error recovery and timeout handling in integration scenarios
- Concurrent script execution tests
- Large file/payload handling tests

