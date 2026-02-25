# VS Code Bridge

A Dart-based JSON-RPC bridge server that enables Dart code to interact with the VS Code API through a TypeScript extension. Part of the DartScript system.

## Overview

The VS Code Bridge provides comprehensive access to VS Code's API from Dart code, enabling:

- **Dynamic Dart Execution**: Run Dart code via D4rt interpreter with VS Code API access
- **Full API Coverage**: Window, Workspace, Commands, Language Model, Chat, and Extensions
- **JSON-RPC Communication**: Bidirectional communication over stdin/stdout
- **Type-Safe Wrappers**: Dart classes mirror VS Code TypeScript API

## Key Features

- 🚀 **D4rt Integration**: Execute Dart scripts dynamically with full VS Code API access
- 🔌 **JSON-RPC 2.0**: Standard protocol for reliable communication
- 📦 **Comprehensive API**: All major VS Code namespaces wrapped
- 🤖 **Copilot Access**: Use GitHub Copilot Language Model from Dart
- 💬 **Chat Integration**: Create chat participants and handle conversations
- 🔧 **Helper Functions**: Convenience functions for common operations

## Quick Start

### 1. Add Dependency

```yaml
# pubspec.yaml
dependencies:
  tom_vscode_bridge:
    path: ../tom_vscode_bridge
```

### 2. Write a Script

```dart
// hello.dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  // Initialize VS Code API
  final vscode = context['vscode'] as VSCode;
  
  // Use Window API
  await vscode.window.showInformationMessage('Hello from Dart!');
  
  // Use Workspace API
  final files = await vscode.workspace.findFiles('**/*.dart');
  
  return {
    'success': true,
    'dartFilesFound': files.length
  };
}
```

### 3. Execute via Extension

Right-click on `hello.dart` and select "Execute in DartScript", or run programmatically:

```typescript
const result = await bridgeClient.sendRequest('executeFile', {
    filePath: '/path/to/hello.dart',
    params: {}
});
```

## Example: Ask Copilot

```dart
import 'package:tom_vscode_bridge/d4rt_helpers.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  await initializeVSCode(context);
  
  // Ask Copilot a question
  final response = await askCopilot(
    'Explain the singleton pattern in Dart',
  );
  
  // Show response
  await showInfo('Copilot says: $response');
  
  return {'response': response};
}
```

## Example: Analyze Workspace

```dart
import 'package:tom_vscode_bridge/d4rt_helpers.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  await initializeVSCode(context);
  
  final wsRoot = getWorkspaceRoot();
  final dartFiles = await findFiles('**/*.dart');
  
  int totalLines = 0;
  for (final file in dartFiles) {
    final content = await readFile(file);
    totalLines += content.split('\n').length;
  }
  
  await showInfo('Found ${dartFiles.length} Dart files with $totalLines total lines');
  
  return {
    'files': dartFiles.length,
    'lines': totalLines,
  };
}
```

## Example: Interactive Input

```dart
import 'package:tom_vscode_bridge/d4rt_helpers.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  await initializeVSCode(context);
  
  // Show quick pick
  final choice = await quickPick(
    ['Create file', 'Delete file', 'Rename file'],
    placeHolder: 'Select an action',
  );
  
  if (choice == null) return {'cancelled': true};
  
  // Get user input
  final fileName = await inputBox(
    prompt: 'Enter file name',
    placeHolder: 'example.dart',
  );
  
  if (fileName == null) return {'cancelled': true};
  
  await showInfo('You selected: $choice for $fileName');
  
  return {
    'action': choice,
    'fileName': fileName,
  };
}
```

## Documentation

- **[PROJECT.md](./PROJECT.md)**: Project overview and getting started
- **[API_REFERENCE.md](./API_REFERENCE.md)**: Complete API documentation with examples
- **[IMPLEMENTATION.md](./IMPLEMENTATION.md)**: Implementation details and architecture
- **[architecture.md](../tom_vscode_extension/_copilot_guidelines/architecture.md)**: System architecture (both sides)

## Architecture

```
┌─────────────────────────┐
│  VS Code Extension      │
│  (TypeScript)           │
│  - Spawns bridge        │
│  - Manages lifecycle    │
│  - Handles VS Code API  │
└───────────┬─────────────┘
            │ JSON-RPC 2.0
            │ stdin/stdout
┌───────────▼─────────────┐
│  Bridge Server          │
│  (Dart)                 │
│  - JSON-RPC handler     │
│  - API wrappers         │
│  - D4rt integration     │
└───────────┬─────────────┘
            │
    ┌───────┴────────┐
    │                │
┌───▼────┐    ┌──────▼──────┐
│ API    │    │ D4rt Script │
│ Calls  │    │ Executor    │
└────────┘    └─────────────┘
```

## License

Copyright (c) 2024 DartScript. All rights reserved.

The VS Code Bridge uses a **child process communication model** where:
- The VS Code extension spawns a Dart process
- They communicate bidirectionally via JSON-RPC over stdin/stdout
- Dart can call VS Code APIs
- VS Code can call Dart functions

This approach is similar to how Language Server Protocol (LSP) works.

## Architecture

```
VS Code Extension (TypeScript)
    ↓ spawn process
Dart Bridge Server (tom_vscode_bridge.dart)
    ↕ JSON-RPC over stdin/stdout
Bidirectional Communication:
  - TypeScript → Dart: workspace operations, analysis requests
  - Dart → TypeScript: VS Code API calls (Copilot, file ops, UI)
```

## Protocol

Communication uses **JSON-RPC 2.0** format:

### Request (from either side):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "methodName",
  "params": { "key": "value" }
}
```

### Response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "key": "value" }
}
```

### Notification (no response expected):
```json
{
  "jsonrpc": "2.0",
  "method": "log",
  "params": { "message": "info", "level": "info" }
}
```

## Usage

### From VS Code Extension

1. Open the Command Palette (`Cmd+Shift+P`)
2. Run: **DartScript: Execute Dart Script with Bridge**
3. The extension will:
   - Spawn the Dart bridge process
   - Send requests to Dart
   - Display results

### Dart Methods (callable from TypeScript)

Implement in `bridge_server.dart`:

```dart
// Handle request from VS Code
Future<void> _handleRequest(
  String method,
  Map<String, dynamic> params,
  int? id,
) async {
  switch (method) {
    case 'getWorkspaceInfo':
      result = await _getWorkspaceInfo(params);
      break;
    case 'analyzeProject':
      result = await _analyzeProject(params);
      break;
    // Add your methods here
  }
  
  if (id != null) {
    _sendResponse(id, result);
  }
}
```

### VS Code APIs (callable from Dart)

Dart can request VS Code operations:

```dart
// Ask Copilot
final response = await sendRequest<String>('askCopilot', {
  'prompt': 'Explain this code...',
});

// Show message
await sendRequest('showInfo', {
  'message': 'Analysis complete!',
});

// Read file
final content = await sendRequest<String>('readFile', {
  'path': '/path/to/file.dart',
});

// Write file
await sendRequest('writeFile', {
  'path': '/path/to/output.md',
  'content': 'Documentation content',
});

// Open file in editor
await sendRequest('openFile', {
  'path': '/path/to/file.dart',
});
```

## Available Methods

### Standard Methods

#### TypeScript → Dart

- `getWorkspaceInfo` - Get workspace root and project list
- `analyzeProject` - Analyze a Dart project  
- `generateDocs` - Generate documentation with Copilot
- **`executeFile`** - Execute a Dart file and get JSON result
- **`executeScript`** - Execute inline Dart code and get JSON result

#### Dart → TypeScript (VS Code APIs)

- `showInfo(message)` - Show information message
- `showError(message)` - Show error message
- `showWarning(message)` - Show warning message
- `askCopilot(prompt)` - Ask GitHub Copilot
- `readFile(path)` - Read file content
- `writeFile(path, content)` - Write file
- `openFile(path)` - Open file in editor
- **`executeFile(filePath, args)` - Execute a Node.js/TypeScript file**
- **`executeScript(script, language)` - Execute inline JavaScript/TypeScript**
- `log(message, level)` - Log to output channel

### Special Execution Methods

#### executeFile - Run a file on the other side

**From TypeScript (execute Dart file):**
```typescript
const result = await bridge.sendRequest('executeFile', {
    filePath: '/path/to/script.dart',
    args: ['--verbose', '--output=json']
});
// Result: { exitCode, stdout, stderr, success, data }
```

**From Dart (execute Node.js file):**
```dart
final result = await server.sendRequest('executeFile', {
  'filePath': '/path/to/script.js',
  'args': ['--config', 'prod']
});
// Result: { exitCode, stdout, stderr, success, data }
```

#### executeScript - Run inline code on the other side

**From TypeScript (execute Dart code):**
```typescript
const result = await bridge.sendRequest('executeScript', {
    script: `
import 'dart:convert';
void main() {
  print(jsonEncode({'result': 42}));
}
`,
    mainFunction: 'main'
});
// Result: { exitCode, stdout, stderr, success, data }
```

**From Dart (execute TypeScript/JavaScript):**
```dart
final result = await server.sendRequest('executeScript', {
  'script': '''
    const files = await vscode.workspace.findFiles('**/*.dart');
    return { fileCount: files.length };
  ''',
  'language': 'javascript'
});
// Result: { success, data, language }
```

**Result Structure:**
Both `executeFile` and `executeScript` return structured JSON:
- `exitCode`: Process exit code (for file execution)
- `stdout`: Standard output
- `stderr`: Standard error  
- `success`: Boolean indicating success
- `data`: Parsed JSON if output is valid JSON (automatic)

The `data` field is automatically populated by parsing stdout as JSON, making it easy to return structured data from executed scripts.
- `askCopilot(prompt)` - Ask GitHub Copilot
- `readFile(path)` - Read file content
- `writeFile(path, content)` - Write file
- `openFile(path)` - Open file in editor
- **`executeFile(filePath, args)` - Execute a Node.js/TypeScript file**
- **`executeScript(script, language)` - Execute inline JavaScript/TypeScript**
- `log(message, level)` - Log to output channel

### Special Execution Methods

#### executeFile - Run a file on the other side

**From TypeScript (execute Dart file):**
```typescript
const result = await bridge.sendRequest('executeFile', {
    filePath: '/path/to/script.dart',
    args: ['--verbose', '--output=json']
});
// Result: { exitCode, stdout, stderr, success, data }
```

**From Dart (execute Node.js file):**
```dart
final result = await server.sendRequest('executeFile', {
  'filePath': '/path/to/script.js',
  'args': ['--config', 'prod']
});
// Result: { exitCode, stdout, stderr, success, data }
```

#### executeScript - Run inline code on the other side

**From TypeScript (execute Dart code):**
```typescript
const result = await bridge.sendRequest('executeScript', {
    script: `
import 'dart:convert';
void main() {
  print(jsonEncode({'result': 42}));
}
`,
    mainFunction: 'main'
});
// Result: { exitCode, stdout, stderr, success, data }
```

**From Dart (execute TypeScript/JavaScript):**
```dart
final result = await server.sendRequest('executeScript', {
  'script': '''
    const files = await vscode.workspace.findFiles('**/*.dart');
    return { fileCount: files.length };
  ''',
  'language': 'javascript'
});
// Result: { success, data, language }
```

**Result Structure:**
Both `executeFile` and `executeScript` return structured JSON:
- `exitCode`: Process exit code (for file execution)
- `stdout`: Standard output
- `stderr`: Standard error
- `success`: Boolean indicating success
- `data`: Parsed JSON if output is valid JSON (automatic)

The `data` field is automatically populated by parsing stdout as JSON, making it easy to return structured data from executed scripts.

## Example: Complete Workflow

### 1. Dart Bridge Server

```dart
// lib/bridge_server.dart
class VSCodeBridgeServer {
  Future<Map<String, dynamic>> _analyzeProject(
    Map<String, dynamic> params,
  ) async {
    final projectPath = params['projectPath'] as String;
    
    // Show message in VS Code
    await sendRequest('showInfo', {
      'message': 'Analyzing: $projectPath',
    });
    
    // Do analysis...
    final result = performAnalysis(projectPath);
    
    // Ask Copilot for suggestions
    final suggestions = await sendRequest('askCopilot', {
      'prompt': 'Suggest improvements for: $result',
    });
    
    // Write report
    await sendRequest('writeFile', {
      'path': '$projectPath/analysis.md',
      'content': suggestions,
    });
    
    // Open the report
    await sendRequest('openFile', {
      'path': '$projectPath/analysis.md',
    });
    
    return {'success': true};
  }
}
```

### 2. TypeScript Extension

```typescript
// src/extension.ts
const bridge = new DartBridgeClient(context);
await bridge.start(workspaceRoot);

// Call Dart method
const result = await bridge.sendRequest('analyzeProject', {
  projectPath: '/path/to/project'
});

// Dart will call back to VS Code APIs automatically
// (showInfo, askCopilot, writeFile, openFile)

bridge.stop();
```

## Development

### Running the Bridge

```bash
# Compile TypeScript
cd tom_vscode_extension
npm run compile

# Test from VS Code
# 1. Press F5 to launch extension
# 2. Cmd+Shift+P → "DartScript: Execute Dart Script with Bridge"
```

### Debugging

- **TypeScript**: Set breakpoints in `src/vscode-bridge.ts`
- **Dart**: Add print statements (they appear in Output channel)
- **Messages**: Check "Dart Bridge" output channel in VS Code

### Adding New Methods

1. **Add Dart handler**:
   ```dart
   // lib/bridge_server.dart
   case 'myNewMethod':
     result = await _myNewMethod(params);
     break;
   ```

2. **Call from TypeScript**:
   ```typescript
   const result = await bridge.sendRequest('myNewMethod', {
     param1: 'value1'
   });
   ```

3. **Or add VS Code API**:
   ```typescript
   // src/vscode-bridge.ts
   private async handleDartRequest(method: string, params: any, id?: number) {
     case 'myVSCodeAPI':
       result = await this.myVSCodeAPI(params);
       break;
   }
   ```

## GitHub Copilot API Usage

### Basic Copilot Queries

```dart
import 'package:tom_vscode_bridge/vscode_api/d4rt_helpers.dart';

// Ask Copilot a question
final answer = await askCopilot(
  'Explain the difference between async and await in Dart',
);

// Get code suggestion
final code = await getCopilotSuggestion(
  'Write a function to merge two sorted lists',
  language: 'dart',
);

// Explain code
final explanation = await explainCode('''
  Future<void> fetchData() async {
    final response = await http.get(url);
    return json.decode(response.body);
  }
''');
```

### Advanced Copilot Features

```dart
// Generate tests
final tests = await generateTests('''
  int calculateDiscount(int price, double rate) {
    return (price * (1 - rate)).round();
  }
''', testFramework: 'dart test');

// Review code
final review = await reviewCode('''
  void process(data) {
    for (var i = 0; i < data.length; i++) {
      print(data[i]);
    }
  }
''');

// Fix code with error message
final fixed = await fixCode('''
  String getName() {
    return name; // Error: undefined
  }
''', errorMessage: 'Undefined name: name');
```

### Language Model API (Direct Access)

```dart
import 'package:tom_vscode_bridge/vscode_api/vscode.dart';
import 'package:tom_vscode_bridge/vscode_api/vscode_lm.dart';

final vscode = getVSCode();

// Select a Copilot model
final models = await vscode.lm.selectChatModels(
  vendor: 'copilot',
  family: 'gpt-4',
);

if (models.isNotEmpty) {
  final model = models.first;
  
  // Send chat request
  final messages = [
    LanguageModelChatMessage.user('Explain closures in Dart'),
  ];
  
  final response = await model.sendRequest(
    vscode.bridge,
    messages,
  );
  
  print('Response: ${response.text}');
  
  // Count tokens
  final tokens = await model.countTokens(
    vscode.bridge,
    'This is a test message',
  );
  print('Token count: $tokens');
}
```

## Helper Functions Reference

### Group 1: Dart/Flutter Development

```dart
// Package management
await runPubGet();
await runPubUpgrade();
await addDependency('http', dev: false);

// Code quality
final diagnostics = await getDiagnostics('lib/main.dart');
await formatDocument('lib/main.dart');
await organizeImports('lib/main.dart');

// Flutter development
await hotReload();
await hotRestart();
final devices = await getFlutterDevices();
await runFlutterApp(deviceId: 'chrome');
```

### Group 2: Copilot Integration

```dart
// AI assistance
final answer = await askCopilot('How do I use streams in Dart?');
final suggestion = await getCopilotSuggestion('implement quicksort');
final explanation = await explainCode(myCode);
final review = await reviewCode(myCode);
final tests = await generateTests(myCode);
final fixed = await fixCode(buggyCode, errorMessage: error);

// Model management
final models = await getCopilotModels();
await selectCopilotModel('gpt-4');
```

### Group 3: Advanced Editor

```dart
// Text manipulation
await replaceText('old text', 'new text');
await insertSnippet('for (var i = 0; i < ${1:10}; i++) {\n\t$0\n}');
await applyWorkspaceEdit(editData);

// Selection management
final selection = await getSelection();
await setSelection(startLine: 0, startChar: 0, endLine: 5, endChar: 10);
final cursor = await getCursorPosition();
```

### Group 4: Workspace & Project

```dart
// Project information
final files = await getProjectFiles(pattern: '**/*.dart');
final gitRoot = await getGitRoot();
final projectType = await getProjectType();

// Search and replace
final results = await searchInWorkspace('TODO');
await replaceInWorkspace('oldText', 'newText', filePattern: '*.dart');
```

### Group 5: Testing & Debugging

```dart
// Test execution
await runTests();
await runTestsWithCoverage();
final results = await getTestResults();

// Debugging
await startDebugging('Dart & Flutter', {'program': 'lib/main.dart'});
await stopDebugging();

// Breakpoints
await setBreakpoint('lib/main.dart', 42);
await removeBreakpoint('lib/main.dart', 42);
final breakpoints = await getBreakpoints();
```

## D4rt Bridge Classes

The bridge system exposes 26 VS Code API classes for direct use in D4rt scripts:

**Core APIs:**
- `VSCode` - Main API wrapper
- `VSCodeWindow` - Window management
- `VSCodeWorkspace` - Workspace operations
- `VSCodeCommands` - Command execution
- `VSCodeExtensions` - Extension management

**Language Model APIs:**
- `VSCodeLanguageModel` - AI model access
- `LanguageModelChat` - Chat model interface
- `LanguageModelChatMessage` - Chat messages
- `LanguageModelChatResponse` - AI responses
- `VSCodeChat` - Chat participant creation
- `ChatParticipant` - Chat participant interface

**Type Classes:**
- `TextDocument`, `TextEditor`, `Selection`, `Range`, `Position`
- `WorkspaceFolder`, `Extension`
- `QuickPickItem`, `InputBoxOptions`, `MessageOptions`

**Helper Classes:**
- `Progress` - Progress reporting
- `FileBatch` - Batch file operations

All classes support automatic JSON serialization for seamless data transfer.

## Why Not D4rt?

**D4rt** is a Dart-to-Dart interpreter (runs Dart in Dart). It's not available as an npm package for Node.js/TypeScript.

**Our Solution**: JSON-RPC over stdin/stdout
- ✅ Standard protocol used by LSP
- ✅ Works with any language combination
- ✅ Full bidirectional communication
- ✅ No external dependencies needed
- ✅ Efficient and reliable

## Next Steps

- [x] JSON-RPC communication protocol
- [x] Bidirectional Dart ↔ TypeScript bridge
- [x] VS Code API integration
- [x] GitHub Copilot integration
- [ ] Add more VS Code APIs (terminal, git, etc.)
- [ ] Support for multiple concurrent Dart processes
- [ ] Hot reload for Dart code changes
- [ ] Debug adapter protocol integration

## Integration with DartScript

This bridge is part of the DartScript system:
- Execute Dart scripts from VS Code
- Access workspace metadata
- Generate documentation with AI
- Automate build workflows

See the main [DartScript documentation](../tom_ai_build/ai_build_guidelines/) for more information.
