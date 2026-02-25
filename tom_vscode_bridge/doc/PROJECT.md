# Tom VS Code Bridge System

The tom_vscode_bridge provides Dart wrappers for the VS Code Extension API, enabling developers to build VS Code extensions using Dart instead of TypeScript through a JSON-RPC bridge.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Core Components](#core-components)
- [VS Code API Wrappers](#vs-code-api-wrappers)
- [D4rt Integration](#d4rt-integration)
- [Communication Protocol](#communication-protocol)
- [Error Handling](#error-handling)
- [Best Practices](#best-practices)

---

## Overview

The Tom VS Code Bridge System consists of three main components:

1. **VSCodeBridgeServer**: JSON-RPC server managing stdin/stdout communication with the VS Code extension
2. **API Wrappers**: Type-safe Dart classes wrapping VS Code's JavaScript APIs
3. **D4rt Integration**: Dynamic Dart execution engine for runtime script evaluation

### Why Use VS Code Bridge?

- **Type Safety**: Strong typing in Dart vs JavaScript's dynamic nature
- **Unified Language**: Write extensions in the same language as your Dart projects
- **Dynamic Execution**: Run Dart code without compilation via D4rt
- **Bidirectional**: Both sides can initiate requests
- **Copilot Native**: Full access to GitHub Copilot APIs
- **Reusable Code**: Share logic between extensions and applications

### How It Works

```
┌─────────────┐                          ┌──────────────────┐
│   VS Code   │                          │  Dart Process    │
│  Extension  │◄────JSON-RPC (stdio)────►│  Bridge Server   │
│ (TypeScript)│                          │  + D4rt Engine   │
└─────────────┘                          └──────────────────┘
```

The VS Code extension spawns the Dart bridge as a child process. Communication happens via JSON-RPC 2.0 over stdin/stdout pipes. Both sides can send requests and receive responses.

---

## Quick Start

### 1. Add Dependency

```yaml
# pubspec.yaml
dependencies:
  tom_vscode_bridge: ^1.0.0
  d4rt: ^1.0.0
```

### 2. Create Bridge Server

```dart
// bin/my_extension.dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

void main() {
  // Create and start bridge server
  final server = VSCodeBridgeServer();
  final vscode = VSCode(server);
  
  server.start();
  
  // Now you can use VS Code APIs from Dart!
  runExtension(vscode);
}

Future<void> runExtension(VSCode vscode) async {
  // Show a message
  await vscode.window.showInformationMessage('Hello from Dart!');
  
  // Get workspace folders
  final folders = await vscode.workspace.getWorkspaceFolders();
  print('Workspace has ${folders.length} folders');
  
  // Find Dart files
  final dartFiles = await vscode.workspace.findFilePaths(
    include: '**/*.dart',
  );
  print('Found ${dartFiles.length} Dart files');
}
```

### 3. Run from VS Code Extension

The TypeScript extension spawns the Dart process:

```typescript
import { spawn } from 'child_process';

const process = spawn('dart', ['run', 'bin/my_extension.dart'], {
    stdio: ['pipe', 'pipe', 'pipe']
});

// Now communicate via JSON-RPC over stdin/stdout
```

---

## Core Components

### VSCodeBridgeServer

The main server class handling JSON-RPC communication.

```dart
class VSCodeBridgeServer {
  VSCodeBridgeServer();
  
  void start();              // Start listening on stdin
  void dispose();            // Clean up resources
  
  // Send request to VS Code and await response
  Future<T> sendRequest<T>(String method, Map<String, dynamic> params);
  
  // Send notification (no response expected)
  void sendNotification(String method, Map<String, dynamic> params);
}
```

**Usage**:
```dart
final server = VSCodeBridgeServer();
server.start();

// Send request to VS Code
final result = await server.sendRequest('executeScript', {
  'script': 'return context.vscode.version;',
  'params': {},
});
```

### VSCode (Main API)

Aggregates all VS Code API namespaces.

```dart
class VSCode {
  VSCodeWorkspace get workspace;
  VSCodeWindow get window;
  VSCodeCommands get commands;
  VSCodeLanguageModel get lm;
  VSCodeChat get chat;
  VSCodeExtensions get extensions;
  
  Future<String> getVersion();
  Future<Map<String, dynamic>> getEnv();
  Future<bool> openExternal(String uri);
}
```

**Usage**:
```dart
final vscode = VSCode(server);

// Use any namespace
await vscode.window.showInformationMessage('Hello!');
final folders = await vscode.workspace.getWorkspaceFolders();
await vscode.commands.executeCommand('editor.action.formatDocument');
```

---

## VS Code API Wrappers

Type-safe Dart wrappers for VS Code's JavaScript APIs.

### Window API

UI operations: messages, dialogs, editors.

```dart
// Show messages
await vscode.window.showInformationMessage('Success!');
await vscode.window.showWarningMessage('Warning!');
await vscode.window.showErrorMessage('Error!');

// Show dialogs
final choice = await vscode.window.showQuickPick(
  ['Option 1', 'Option 2', 'Option 3'],
  placeHolder: 'Choose an option',
);

final input = await vscode.window.showInputBox(
  prompt: 'Enter your name',
);

// Get active editor
final editor = await vscode.window.getActiveTextEditor();
if (editor != null) {
  print('Active file: ${editor.document.fileName}');
}
```

### Workspace API

File operations and workspace access.

```dart
// Get workspace folders
final folders = await vscode.workspace.getWorkspaceFolders();

// Find files
final dartFiles = await vscode.workspace.findFilePaths(
  include: '**/*.dart',
  exclude: '**/build/**',
);

// File I/O
final content = await vscode.workspace.readFile('/path/to/file.dart');
await vscode.workspace.writeFile('/path/to/output.txt', 'Hello!');

// Configuration
final config = await vscode.workspace.getConfiguration('editor');
print('Tab size: ${config["tabSize"]}');
```

### Commands API

Execute VS Code commands.

```dart
// Format document
await vscode.commands.executeCommand('editor.action.formatDocument');

// Save all files
await vscode.commands.executeCommand('workbench.action.files.saveAll');

// Open file
await vscode.commands.executeCommand('vscode.open', [
  'file:///path/to/file.dart'
]);

// Get all commands
final commands = await vscode.commands.getCommands();
print('Available commands: ${commands.length}');
```

### Language Model API (Copilot)

Access GitHub Copilot and other language models.

```dart
// Select Copilot model
final models = await vscode.lm.selectChatModels(
  vendor: 'copilot',
  family: 'gpt-4',
);

if (models.isNotEmpty) {
  final model = models.first;
  
  // Send chat request
  final response = await model.sendRequest(
    vscode.bridge,
    [
      LanguageModelChatMessage.user('Explain async/await in Dart'),
    ],
    modelOptions: {'temperature': 0.7},
  );
  
  print('Copilot says: ${response.text}');
}
```

### Chat API

Create chat participants for Copilot Chat.

```dart
// Create chat participant
await vscode.chat.createChatParticipant(
  'dart-helper',
  description: 'Helps with Dart development',
  fullName: 'Dart Development Assistant',
  handler: (request, context, stream) async {
    // Handle chat request
    await stream.markdown('## Processing: ${request.prompt}\n\n');
    await stream.progress('Analyzing...');
    
    // Process and respond
    final result = await processRequest(request.prompt);
    await stream.markdown(result);
    
    return ChatResult(metadata: {'processed': true});
  },
);
```

---

## D4rt Integration

D4rt enables dynamic Dart code execution without compilation.

### Basic Script Execution

```dart
// D4rt is initialized automatically in VSCodeBridgeServer
final result = await server.sendRequest('executeScript', {
  'script': '''
    final vscode = context['vscode'];
    await vscode.window.showInformationMessage('From D4rt!');
    return {'success': true};
  ''',
  'params': {},
});
```

### Helper Functions

Use convenience functions in D4rt scripts:

```dart
import 'package:tom_vscode_bridge/vscode_api/d4rt_helpers.dart';

// In D4rt script:
await showInfo('Hello from D4rt!');
await showWarning('Warning!');
await showError('Error!');

final name = await inputBox(prompt: 'Enter name');
final choice = await quickPick(['A', 'B', 'C']);

final files = await findFiles(include: '**/*.dart');
final content = await readFile('lib/main.dart');
await writeFile('output.txt', 'Generated content');
```

### Batch Processing

```dart
// Process all Dart files
final batch = await FileBatch.fromPattern(
  include: '**/*.dart',
  exclude: '**/build/**',
);

final results = await batch.process((path, content) async {
  // Process each file
  final lines = content.split('\n').length;
  return {'path': path, 'lines': lines};
});

print('Processed ${results.length} files');
```

---

## Communication Protocol

### JSON-RPC 2.0

All communication uses JSON-RPC 2.0 over stdin/stdout.

#### Request Format

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "method": "window.showInformationMessage",
  "params": {
    "message": "Hello World",
    "items": ["OK", "Cancel"]
  }
}
```

#### Response Format

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "result": "OK"
}
```

#### Error Format

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "error": {
    "message": "Error description",
    "data": "Stack trace..."
  }
}
```

### Bidirectional Communication

**Dart → VS Code** (Wrapper methods):
```dart
await vscode.window.showInformationMessage('Hello!');
```

**VS Code → Dart** (Request handlers):
```dart
// Implemented in bridge_server.dart
case 'getWorkspaceInfo':
  result = await _getWorkspaceInfo(params);
  break;
```

---

## Error Handling

### Exception Handling

```dart
try {
  final result = await vscode.workspace.readFile('/path/to/file.dart');
  // Process result...
} catch (e) {
  await vscode.window.showErrorMessage('Failed to read file: $e');
}
```

### Request Timeouts

Requests automatically timeout after 30 seconds:

```dart
// This will timeout if no response in 30s
try {
  final result = await server.sendRequest('longOperation', {});
} on TimeoutException {
  print('Request timed out');
}
```

### Logging

Send logs to VS Code output channel:

```dart
// In bridge_server.dart
_sendLog('Processing file: $filePath');
_sendError('Failed to process: $error');
```

---

## Best Practices

### 1. Use Type-Safe Wrappers

```dart
// GOOD: Type-safe wrapper
await vscode.window.showInformationMessage('Hello!');

// BAD: Raw executeScript
await server.sendRequest('executeScript', {
  'script': 'context.vscode.window.showInformationMessage("Hello!");',
});
```

### 2. Batch Operations

```dart
// GOOD: Parallel execution
final contents = await Future.wait(
  files.map((f) => vscode.workspace.readFile(f))
);

// BAD: Sequential execution (slow)
for (final file in files) {
  final content = await vscode.workspace.readFile(file);
}
```

### 3. Handle Errors Gracefully

```dart
try {
  final result = await someOperation();
  return result;
} catch (e, stackTrace) {
  _sendError('Operation failed: $e');
  return {'success': false, 'error': e.toString()};
}
```

### 4. Clean Up Resources

```dart
void dispose() {
  _outputController.close();
  _pendingRequests.clear();
}
```

### 5. Use Helper Functions in D4rt

```dart
// GOOD: Use helpers
await showInfo('Success!');
final files = await findFiles(include: '**/*.dart');

// BAD: Manual VS Code API calls
final vscode = getVSCode();
await vscode.window.showInformationMessage('Success!');
await vscode.workspace.findFilePaths(include: '**/*.dart');
```

### 6. Validate Parameters

```dart
Future<Map<String, dynamic>> _handleRequest(Map<String, dynamic> params) async {
  final path = params['path'] as String?;
  if (path == null) {
    throw Exception('path parameter is required');
  }
  // Process...
}
```

### 7. Document Public APIs

```dart
/// Show an information message to the user
///
/// [message]: Message text to display
/// [items]: Optional list of button labels
///
/// Returns the selected button label or null if dismissed
Future<String?> showInformationMessage(
  String message, {
  List<String>? items,
}) async {
  // Implementation...
}
```

---

## See Also

- [API Reference](./API_REFERENCE.md) - Complete API documentation
- [Implementation Guide](./IMPLEMENTATION.md) - Implementation details
- [Architecture Documentation](../tom_vscode_extension/_copilot_guidelines/architecture.md) - System architecture
- [VS Code Integration Project](../tom_vscode_extension/_copilot_guidelines/project.md) - Extension side
