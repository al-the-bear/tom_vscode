# VS Code Bridge User Guide

Complete guide to writing Dart scripts that control VS Code through the bridge system.

## Table of Contents

- [VS Code Bridge User Guide](#vs-code-bridge-user-guide)
  - [Table of Contents](#table-of-contents)
  - [Getting Started](#getting-started)
    - [Basic Script Template](#basic-script-template)
    - [Using Helper Functions](#using-helper-functions)
  - [Window Operations](#window-operations)
    - [Show Messages](#show-messages)
    - [User Input](#user-input)
    - [Quick Pick Dialogs](#quick-pick-dialogs)
    - [Progress Indicators](#progress-indicators)
  - [Workspace Operations](#workspace-operations)
    - [Get Workspace Information](#get-workspace-information)
    - [Find Files](#find-files)
    - [Read and Write Files](#read-and-write-files)
    - [Watch Files](#watch-files)
  - [Editor Operations](#editor-operations)
    - [Open Files](#open-files)
    - [Get Active Editor](#get-active-editor)
    - [Edit Text](#edit-text)
    - [Get Selections](#get-selections)
  - [Terminal Operations](#terminal-operations)
    - [Create Terminal](#create-terminal)
    - [Send Commands](#send-commands)
    - [Run Shell Commands](#run-shell-commands)
  - [Command Execution](#command-execution)
    - [Execute VS Code Commands](#execute-vs-code-commands)
    - [Register Custom Commands](#register-custom-commands)
  - [Testing Operations](#testing-operations)
    - [Discover Tests](#discover-tests)
    - [Run Tests](#run-tests)
    - [Get Test Results](#get-test-results)
  - [Copilot Integration](#copilot-integration)
    - [Ask Copilot Questions](#ask-copilot-questions)
    - [Select Language Models](#select-language-models)
    - [Stream Responses](#stream-responses)
  - [Chat Integration](#chat-integration)
    - [Create Chat Participants](#create-chat-participants)
    - [Send Chat Messages](#send-chat-messages)
    - [Handle Chat Requests](#handle-chat-requests)
  - [Search Operations](#search-operations)
    - [Text Search](#text-search)
    - [File Search](#file-search)
    - [Search and Replace](#search-and-replace)
  - [Extension Operations](#extension-operations)
    - [Get Installed Extensions](#get-installed-extensions)
    - [Check Extension Status](#check-extension-status)
  - [Advanced Patterns](#advanced-patterns)
    - [Batch Operations](#batch-operations)
    - [Error Handling](#error-handling)
    - [Async Patterns](#async-patterns)
  - [Complete Example Scripts](#complete-example-scripts)
    - [Project Analyzer](#project-analyzer)
    - [Test Runner](#test-runner)
    - [Documentation Generator](#documentation-generator)
  - [See Also](#see-also)

---

## Getting Started

### Basic Script Template

Every Dart script must have an `execute` function:

```dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  // Get VS Code API
  final vscode = context['vscode'] as VSCode;
  
  // Your code here
  
  return {
    'success': true,
    'result': 'Script completed'
  };
}
```

### Using Helper Functions

Import helpers for convenience functions:

```dart
import 'package:tom_vscode_bridge/d4rt_helpers.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  // Initialize helpers
  await initializeVSCode(context);
  
  // Use convenience functions
  await showInfo('Hello from Dart!');
  
  return {'success': true};
}
```

---

## Window Operations

### Show Messages

**Information Messages:**

```dart
// Using wrapper
await vscode.window.showInformationMessage('Operation successful!');

// Using helper
await showInfo('Operation successful!');

// With action buttons
final result = await vscode.window.showInformationMessage(
  'Do you want to continue?',
  items: ['Yes', 'No']
);

if (result == 'Yes') {
  // User clicked Yes
}
```

**Warning Messages:**

```dart
// Using wrapper
await vscode.window.showWarningMessage('This action cannot be undone');

// Using helper
await showWarning('This action cannot be undone');
```

**Error Messages:**

```dart
// Using wrapper
await vscode.window.showErrorMessage('Failed to save file');

// Using helper
await showError('Failed to save file');
```

### User Input

**Input Box:**

```dart
// Using wrapper
final name = await vscode.window.showInputBox(
  prompt: 'Enter your name',
  placeHolder: 'John Doe',
  value: 'Default Name',
);

if (name != null) {
  await showInfo('Hello, $name!');
}

// Using helper
final fileName = await inputBox(
  prompt: 'Enter file name',
  placeHolder: 'example.dart',
);
```

**Input Box with Validation:**

```dart
final port = await vscode.window.showInputBox(
  prompt: 'Enter port number',
  placeHolder: '8080',
  validateInput: (value) {
    if (value.isEmpty) return 'Port cannot be empty';
    final portNum = int.tryParse(value);
    if (portNum == null) return 'Must be a number';
    if (portNum < 1024 || portNum > 65535) {
      return 'Port must be between 1024 and 65535';
    }
    return null; // Valid
  },
);
```

### Quick Pick Dialogs

**Simple Selection:**

```dart
// Using wrapper
final choice = await vscode.window.showQuickPick(
  items: ['Option 1', 'Option 2', 'Option 3'],
  placeHolder: 'Select an option',
);

// Using helper
final action = await quickPick(
  ['Create', 'Update', 'Delete'],
  placeHolder: 'Select action',
);
```

**Multi-Select:**

```dart
final selected = await vscode.window.showQuickPick(
  items: ['Feature A', 'Feature B', 'Feature C'],
  canPickMany: true,
  placeHolder: 'Select features to enable',
);

if (selected != null && selected.isNotEmpty) {
  await showInfo('Selected: ${selected.join(", ")}');
}
```

**Quick Pick with Details:**

```dart
final items = [
  {
    'label': 'Development',
    'description': 'Local development environment',
    'detail': 'Uses localhost:3000'
  },
  {
    'label': 'Production',
    'description': 'Production environment',
    'detail': 'Uses production.example.com'
  },
];

final choice = await vscode.window.showQuickPick(
  items: items.map((i) => i['label'] as String).toList(),
  placeHolder: 'Select environment',
);
```

### Progress Indicators

**Simple Progress:**

```dart
await vscode.window.withProgress(
  location: 'Notification',
  title: 'Processing files...',
  cancellable: true,
  task: (progress, token) async {
    progress.report(message: 'Step 1 of 3', increment: 33);
    await Future.delayed(Duration(seconds: 1));
    
    progress.report(message: 'Step 2 of 3', increment: 66);
    await Future.delayed(Duration(seconds: 1));
    
    progress.report(message: 'Complete!', increment: 100);
  },
);
```

**Progress with Cancellation:**

```dart
// Using helper
final progressHelper = Progress();
await progressHelper.show('Processing...', cancellable: true);

for (var i = 0; i < 10; i++) {
  if (await progressHelper.isCancelled()) {
    await showWarning('Operation cancelled');
    break;
  }
  
  await progressHelper.report(
    message: 'Processing item ${i + 1}/10',
    increment: (i + 1) * 10,
  );
  
  await Future.delayed(Duration(milliseconds: 500));
}

await progressHelper.close();
```

---

## Workspace Operations

### Get Workspace Information

```dart
// Get workspace root
final wsRoot = await vscode.workspace.getWorkspaceFolders();
if (wsRoot.isNotEmpty) {
  final rootPath = wsRoot[0]['uri'];
  await showInfo('Workspace: $rootPath');
}

// Using helper
final root = getWorkspaceRoot();
```

### Find Files

**Find All Dart Files:**

```dart
// Using wrapper
final files = await vscode.workspace.findFiles(
  include: '**/*.dart',
  exclude: '**/.*',
);

await showInfo('Found ${files.length} Dart files');

// Using helper
final dartFiles = await findFiles('**/*.dart');
```

**Find with Limits:**

```dart
final files = await vscode.workspace.findFiles(
  include: '**/*.{dart,yaml}',
  exclude: '{**/node_modules,**/.dart_tool}',
  maxResults: 100,
);
```

**Find Files in Specific Directory:**

```dart
final libFiles = await findFiles('lib/**/*.dart');
final testFiles = await findFiles('test/**/*_test.dart');
```

### Read and Write Files

**Read File:**

```dart
// Using wrapper
final content = await vscode.workspace.readFile('lib/main.dart');
final lines = content.split('\n');
await showInfo('File has ${lines.length} lines');

// Using helper
final content = await readFile('lib/main.dart');
```

**Write File:**

```dart
// Using wrapper
await vscode.workspace.writeFile(
  'output/result.txt',
  'Generated content\nLine 2\nLine 3',
);

// Using helper
await writeFile('output/result.txt', 'Generated content');
```

**Create Directory:**

```dart
await vscode.workspace.createDirectory('output/reports');
```

**Delete File:**

```dart
await vscode.workspace.deleteFile('temp/old_file.txt');
```

### Watch Files

**Watch for File Changes:**

```dart
final watcher = await vscode.workspace.createFileSystemWatcher(
  globPattern: '**/*.dart',
);

// Note: Actual watching happens on TypeScript side
// You'll receive notifications through the bridge
```

---

## Editor Operations

### Open Files

**Open File in Editor:**

```dart
await vscode.window.showTextDocument('lib/main.dart');

// Using helper
await openFile('lib/main.dart');
```

**Open at Specific Line:**

```dart
await vscode.window.showTextDocument(
  'lib/main.dart',
  selection: {'start': {'line': 10, 'character': 0}},
);
```

**Open to Side:**

```dart
await vscode.window.showTextDocument(
  'lib/utils.dart',
  viewColumn: 'Beside',
);
```

### Get Active Editor

```dart
final activeEditor = await vscode.window.getActiveTextEditor();
if (activeEditor != null) {
  final filePath = activeEditor['document']['uri'];
  final languageId = activeEditor['document']['languageId'];
  await showInfo('Editing: $filePath ($languageId)');
}
```

### Edit Text

**Insert Text:**

```dart
final editor = await vscode.window.getActiveTextEditor();
if (editor != null) {
  await vscode.window.editTextDocument(
    editor['document']['uri'],
    edits: [
      {
        'range': {
          'start': {'line': 0, 'character': 0},
          'end': {'line': 0, 'character': 0},
        },
        'newText': '// Generated comment\n',
      }
    ],
  );
}
```

**Replace Text:**

```dart
await vscode.window.editTextDocument(
  'lib/config.dart',
  edits: [
    {
      'range': {
        'start': {'line': 5, 'character': 0},
        'end': {'line': 5, 'character': 100},
      },
      'newText': 'const apiUrl = "https://api.example.com";',
    }
  ],
);
```

### Get Selections

```dart
final editor = await vscode.window.getActiveTextEditor();
if (editor != null) {
  final selections = editor['selections'] as List;
  
  for (var selection in selections) {
    final start = selection['start'];
    final end = selection['end'];
    await showInfo('Selected: Line ${start['line']} to ${end['line']}');
  }
}
```

---

## Terminal Operations

### Create Terminal

```dart
final terminal = await vscode.window.createTerminal(
  name: 'My Terminal',
  cwd: getWorkspaceRoot(),
);
```

### Send Commands

```dart
// Create and show terminal
final terminal = await vscode.window.createTerminal(name: 'Build');
await vscode.window.showTerminal(terminal['id']);

// Send command
await vscode.window.sendTextToTerminal(
  terminal['id'],
  'dart pub get\n',
);
```

### Run Shell Commands

**Run Command and Get Output:**

```dart
final result = await vscode.workspace.executeShellCommand(
  'dart --version',
);

await showInfo('Dart version: ${result['stdout']}');
```

**Run Multiple Commands:**

```dart
final commands = [
  'dart pub get',
  'dart analyze',
  'dart test',
];

for (var cmd in commands) {
  await showInfo('Running: $cmd');
  
  final result = await vscode.workspace.executeShellCommand(cmd);
  
  if (result['exitCode'] != 0) {
    await showError('Command failed: ${result['stderr']}');
    break;
  }
  
  await showInfo('Output: ${result['stdout']}');
}
```

---

## Command Execution

### Execute VS Code Commands

**Built-in Commands:**

```dart
// Save all files
await vscode.commands.executeCommand('workbench.action.files.saveAll');

// Format document
await vscode.commands.executeCommand('editor.action.formatDocument');

// Open settings
await vscode.commands.executeCommand('workbench.action.openSettings');
```

**Commands with Arguments:**

```dart
// Open file
await vscode.commands.executeCommand(
  'vscode.open',
  args: ['file:///path/to/file.dart'],
);

// Go to line
await vscode.commands.executeCommand(
  'revealLine',
  args: [{'lineNumber': 42, 'at': 'center'}],
);
```

### Register Custom Commands

```dart
// Note: Command registration happens on TypeScript side
// You can trigger commands from Dart

// Execute custom command
await vscode.commands.executeCommand('myExtension.myCommand');
```

---

## Testing Operations

### Discover Tests

```dart
// Get test controller
final tests = await vscode.commands.executeCommand(
  'vscode.resolveTestItems',
);

await showInfo('Found ${tests.length} test suites');
```

### Run Tests

**Run All Tests:**

```dart
await vscode.commands.executeCommand('testing.runAll');
```

**Run Specific Test File:**

```dart
// Open test file first
await openFile('test/widget_test.dart');

// Run tests in current file
await vscode.commands.executeCommand('testing.runCurrentFile');
```

**Run Tests via Terminal:**

```dart
final result = await vscode.workspace.executeShellCommand(
  'dart test test/my_test.dart',
);

if (result['exitCode'] == 0) {
  await showInfo('All tests passed!');
} else {
  await showError('Tests failed:\n${result['stderr']}');
}
```

### Get Test Results

```dart
// Run tests and parse output
final result = await vscode.workspace.executeShellCommand(
  'dart test --reporter json',
);

// Parse JSON output
final output = result['stdout'] as String;
// Process test results...
```

---

## Copilot Integration

### Ask Copilot Questions

**Simple Question:**

```dart
// Using helper
final answer = await askCopilot('What is the singleton pattern in Dart?');
await showInfo('Copilot says: $answer');
```

**Question with Context:**

```dart
final code = await readFile('lib/service.dart');

final prompt = '''
Analyze this Dart code and suggest improvements:

$code

Focus on:
1. Error handling
2. Performance
3. Code organization
''';

final suggestions = await askCopilot(prompt);
await writeFile('analysis/suggestions.md', suggestions);
```

### Select Language Models

```dart
// Using wrapper
final models = await vscode.lm.selectChatModels(
  vendor: 'copilot',
  family: 'gpt-4o',
);

if (models.isNotEmpty) {
  await showInfo('Using model: ${models[0]['id']}');
}
```

### Stream Responses

```dart
final model = (await vscode.lm.selectChatModels(
  vendor: 'copilot',
))[0];

final messages = [
  {'role': 'user', 'content': 'Explain async/await in Dart'}
];

final response = await vscode.lm.sendChatRequest(
  model['id'],
  messages: messages,
);

// Response is streamed - collect all chunks
final fullResponse = response['text'];
await showInfo('Copilot response: $fullResponse');
```

---

## Chat Integration

### Create Chat Participants

**Register Chat Participant:**

```dart
// Registration happens on TypeScript side
// This is the Dart handler for chat requests

Future<Map<String, dynamic>> handleChatRequest(
  Map<String, dynamic> request,
  dynamic context,
) async {
  await initializeVSCode(context);
  
  final prompt = request['prompt'] as String;
  
  // Process the chat request
  if (prompt.contains('analyze')) {
    return {
      'response': 'Analyzing project structure...',
      'suggestions': ['Run tests', 'Check dependencies']
    };
  }
  
  return {'response': 'Chat request processed'};
}
```

### Send Chat Messages

```dart
// Send message to chat
await vscode.chat.sendMessage(
  'Copilot',
  'Generate unit tests for the current file',
);
```

### Handle Chat Requests

```dart
// Handle incoming chat request
final prompt = params['prompt'] as String;
final files = await findFiles('**/*.dart');

final response = await askCopilot('''
Project has ${files.length} Dart files.
User asked: $prompt

Provide a helpful response.
''');

return {
  'markdown': response,
  'commands': [
    {'title': 'Open File', 'command': 'vscode.open'}
  ],
};
```

---

## Search Operations

### Text Search

**Search in Files:**

```dart
// Find all TODO comments
final todos = <String>[];
final dartFiles = await findFiles('**/*.dart');

for (var file in dartFiles) {
  final content = await readFile(file);
  final lines = content.split('\n');
  
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].contains('// TODO')) {
      todos.add('$file:${i + 1}: ${lines[i].trim()}');
    }
  }
}

await showInfo('Found ${todos.length} TODOs');
```

**Regex Search:**

```dart
final pattern = RegExp(r'class\s+(\w+)\s+extends');
final classes = <String>[];

final files = await findFiles('lib/**/*.dart');
for (var file in files) {
  final content = await readFile(file);
  final matches = pattern.allMatches(content);
  
  for (var match in matches) {
    classes.add(match.group(1)!);
  }
}

await showInfo('Found classes: ${classes.join(", ")}');
```

### File Search

**Find Files by Pattern:**

```dart
// Find all test files
final testFiles = await findFiles('test/**/*_test.dart');

// Find configuration files
final configs = await findFiles('**/{pubspec.yaml,analysis_options.yaml}');

// Find recently modified files (use shell command)
final result = await vscode.workspace.executeShellCommand(
  'find . -name "*.dart" -mtime -1',
);

final recentFiles = result['stdout'].toString().split('\n');
```

### Search and Replace

**Replace in File:**

```dart
final file = 'lib/config.dart';
final content = await readFile(file);

// Replace old API URL with new one
final updated = content.replaceAll(
  'https://old-api.example.com',
  'https://new-api.example.com',
);

await writeFile(file, updated);
await showInfo('Updated $file');
```

**Replace in Multiple Files:**

```dart
final files = await findFiles('lib/**/*.dart');
var replacedCount = 0;

for (var file in files) {
  final content = await readFile(file);
  
  if (content.contains('oldFunction')) {
    final updated = content.replaceAll('oldFunction', 'newFunction');
    await writeFile(file, updated);
    replacedCount++;
  }
}

await showInfo('Updated $replacedCount files');
```

---

## Extension Operations

### Get Installed Extensions

```dart
final extensions = await vscode.extensions.getExtensions();

await showInfo('Installed extensions: ${extensions.length}');

for (var ext in extensions) {
  final id = ext['id'];
  final version = ext['packageJSON']['version'];
  print('$id: $version');
}
```

### Check Extension Status

```dart
final dartExt = await vscode.extensions.getExtension('Dart-Code.dart-code');

if (dartExt != null) {
  final isActive = dartExt['isActive'];
  await showInfo('Dart extension active: $isActive');
} else {
  await showWarning('Dart extension not installed');
}
```

---

## Advanced Patterns

### Batch Operations

**Process Files in Batches:**

```dart
// Using helper
final batch = FileBatch();

final files = await findFiles('**/*.dart');
for (var file in files) {
  batch.add(file);
}

await batch.process((file) async {
  final content = await readFile(file);
  // Process file...
  return {'file': file, 'lines': content.split('\n').length};
});

final results = batch.results;
await showInfo('Processed ${results.length} files');
```

**Parallel Processing:**

```dart
final files = await findFiles('lib/**/*.dart');

final futures = files.map((file) async {
  final content = await readFile(file);
  return content.split('\n').length;
});

final lineCounts = await Future.wait(futures);
final total = lineCounts.reduce((a, b) => a + b);

await showInfo('Total lines: $total');
```

### Error Handling

**Try-Catch Pattern:**

```dart
try {
  final content = await readFile('non_existent.dart');
  await showInfo(content);
} catch (e) {
  await showError('Failed to read file: $e');
  return {'success': false, 'error': e.toString()};
}
```

**Graceful Degradation:**

```dart
// Try Copilot, fall back to simple analysis
String analysis;

try {
  analysis = await askCopilot('Analyze this project');
} catch (e) {
  // Copilot not available, do basic analysis
  final files = await findFiles('**/*.dart');
  analysis = 'Project has ${files.length} Dart files';
}

await showInfo(analysis);
```

### Async Patterns

**Sequential Operations:**

```dart
await showInfo('Step 1: Analyzing...');
final files = await findFiles('**/*.dart');

await showInfo('Step 2: Reading files...');
final contents = <String>[];
for (var file in files) {
  contents.add(await readFile(file));
}

await showInfo('Step 3: Processing...');
// Process contents...
```

**Concurrent Operations:**

```dart
// Run multiple independent operations
final results = await Future.wait([
  findFiles('**/*.dart'),
  findFiles('**/*.yaml'),
  vscode.workspace.getWorkspaceFolders(),
]);

final dartFiles = results[0] as List;
final yamlFiles = results[1] as List;
final workspaces = results[2] as List;
```

---

## Complete Example Scripts

### Project Analyzer

```dart
import 'package:tom_vscode_bridge/d4rt_helpers.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  await initializeVSCode(context);
  
  final progress = Progress();
  await progress.show('Analyzing project...', cancellable: false);
  
  try {
    // Count files
    progress.report(message: 'Counting files...', increment: 25);
    final dartFiles = await findFiles('**/*.dart');
    final testFiles = await findFiles('test/**/*_test.dart');
    
    // Count lines
    progress.report(message: 'Counting lines...', increment: 50);
    var totalLines = 0;
    for (var file in dartFiles) {
      final content = await readFile(file);
      totalLines += content.split('\n').length;
    }
    
    // Ask Copilot for insights
    progress.report(message: 'Getting AI insights...', increment: 75);
    final insights = await askCopilot('''
Project statistics:
- ${dartFiles.length} Dart files
- ${testFiles.length} test files
- $totalLines total lines of code

Provide 3 recommendations for improving this project.
''');
    
    progress.report(message: 'Complete!', increment: 100);
    await progress.close();
    
    // Show results
    final report = '''
# Project Analysis

## Statistics
- Dart files: ${dartFiles.length}
- Test files: ${testFiles.length}
- Total lines: $totalLines
- Test coverage: ${(testFiles.length / dartFiles.length * 100).toStringAsFixed(1)}%

## AI Insights
$insights
''';
    
    await writeFile('analysis/report.md', report);
    await openFile('analysis/report.md');
    
    return {
      'success': true,
      'files': dartFiles.length,
      'tests': testFiles.length,
      'lines': totalLines,
    };
    
  } catch (e) {
    await progress.close();
    await showError('Analysis failed: $e');
    return {'success': false, 'error': e.toString()};
  }
}
```

### Test Runner

```dart
import 'package:tom_vscode_bridge/d4rt_helpers.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  await initializeVSCode(context);
  
  final testFile = params['testFile'] as String?;
  
  await showInfo('Running tests${testFile != null ? " in $testFile" : ""}...');
  
  final command = testFile != null
      ? 'dart test $testFile'
      : 'dart test';
  
  final result = await executeShellCommand(command);
  
  if (result['exitCode'] == 0) {
    await showInfo('✅ All tests passed!');
    return {'success': true, 'output': result['stdout']};
  } else {
    await showError('❌ Tests failed');
    await writeFile('test_results.txt', result['stderr']);
    await openFile('test_results.txt');
    return {'success': false, 'errors': result['stderr']};
  }
}
```

### Documentation Generator

```dart
import 'package:tom_vscode_bridge/d4rt_helpers.dart';

Future<Map<String, dynamic>> execute(
  Map<String, dynamic> params,
  dynamic context,
) async {
  await initializeVSCode(context);
  
  final file = params['file'] as String;
  final content = await readFile(file);
  
  final prompt = '''
Generate comprehensive documentation for this Dart file:

```dart
$content
```

Include:
1. Overview
2. Classes and methods
3. Usage examples
4. Dependencies
''';
  
  await showInfo('Generating documentation with Copilot...');
  
  final docs = await askCopilot(prompt);
  
  final docFile = file.replaceAll('.dart', '_docs.md');
  await writeFile(docFile, docs);
  await openFile(docFile);
  
  await showInfo('Documentation saved to $docFile');
  
  return {'success': true, 'docFile': docFile};
}
```

---

## See Also

- [API Reference](./API_REFERENCE.md) - Complete API documentation
- [Implementation Guide](./IMPLEMENTATION.md) - Implementation details
- [Project Overview](./PROJECT.md) - Project structure and getting started
- [JavaScript User Guide](../tom_vscode_extension/doc/user_guide.md) - JavaScript side
