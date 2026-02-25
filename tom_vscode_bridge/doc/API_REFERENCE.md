# VS Code Bridge API Reference

Complete API reference for the tom_vscode_bridge Dart library, following Tom Framework API guidelines.

---

## Table of Contents

- [Overview](#overview)
- [VSCode (Main API)](#vscode-main-api)
- [VSCodeWindow (UI & Messages)](#vscodewindow-ui--messages)
- [VSCodeWorkspace (Files & Folders)](#vscodeworkspace-files--folders)
- [VSCodeCommands (Commands)](#vscodecommands-commands)
- [VSCodeLanguageModel (Copilot/LM)](#vscodelanguagemodel-copilotlm)
- [VSCodeChat (Chat Participants)](#vscodechat-chat-participants)
- [VSCodeExtensions (Extensions)](#vscodeextensions-extensions)
- [Types](#types)
- [D4rt Helper Functions](#d4rt-helper-functions)
- [VSCodeBridgeServer](#vscodebridgeserver)
- [Usage Examples](#usage-examples)

---

## Overview

The VS Code Bridge API provides Dart wrappers for the VS Code Extension API, enabling you to build VS Code extensions using Dart. All APIs communicate with VS Code via JSON-RPC over stdin/stdout.

**Basic Usage**:
```dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

void main() {
  final server = VSCodeBridgeServer();
  final vscode = VSCode(server);
  
  server.start();
  
  // Now use the APIs
  await vscode.window.showInformationMessage('Hello from Dart!');
}
```

---

## VSCode (Main API)

Main entry point for all VS Code APIs. Aggregates all namespaces into a single object.

### Class: VSCode

```dart
class VSCode {
  VSCode(VSCodeBridgeServer bridge);
  
  // Namespace properties
  VSCodeWorkspace get workspace;
  VSCodeWindow get window;
  VSCodeCommands get commands;
  VSCodeExtensions get extensions;
  VSCodeLanguageModel get lm;
  VSCodeChat get chat;
  VSCodeBridgeServer get bridge;
  
  // Environment methods
  Future<String> getVersion();
  Future<Map<String, dynamic>> getEnv();
  Future<bool> openExternal(String uri);
  Future<void> copyToClipboard(String text);
  Future<String> readFromClipboard();
}
```

### Methods

#### getVersion()
```dart
Future<String> getVersion()
```
Returns the current VS Code version string.

**Returns**: VS Code version (e.g., "1.85.0")

**Example**:
```dart
final version = await vscode.getVersion();
print('VS Code version: $version');
```

---

#### getEnv()
```dart
Future<Map<String, dynamic>> getEnv()
```
Get environment information about the VS Code instance.

**Returns**: Map containing:
- `appName`: Application name
- `appRoot`: Application root directory
- `language`: UI language
- `machineId`: Machine identifier
- `sessionId`: Session identifier
- `remoteName`: Remote name (if in remote session)
- `shell`: Default shell path
- `uiKind`: UI kind (1 = desktop, 2 = web)

**Example**:
```dart
final env = await vscode.getEnv();
print('App: ${env["appName"]}, Language: ${env["language"]}');
```

---

#### openExternal()
```dart
Future<bool> openExternal(String uri)
```
Open an external URI (typically opens in default browser).

**Parameters**:
- `uri`: URI to open (e.g., "https://example.com")

**Returns**: `true` if successful

**Example**:
```dart
await vscode.openExternal('https://github.com');
```

---

#### copyToClipboard()
```dart
Future<void> copyToClipboard(String text)
```
Copy text to system clipboard.

**Parameters**:
- `text`: Text to copy

**Example**:
```dart
await vscode.copyToClipboard('Hello World');
```

---

#### readFromClipboard()
```dart
Future<String> readFromClipboard()
```
Read text from system clipboard.

**Returns**: Current clipboard text

**Example**:
```dart
final clipText = await vscode.readFromClipboard();
print('Clipboard: $clipText');
```

---

## VSCodeWindow (UI & Messages)

Window and UI-related functionality including messages, dialogs, editors, and output channels.

### Class: VSCodeWindow

```dart
class VSCodeWindow {
  VSCodeWindow(VSCodeBridgeServer bridge);
  
  // Message methods
  Future<String?> showInformationMessage(String message, {List<String>? items, MessageOptions? options});
  Future<String?> showWarningMessage(String message, {List<String>? items, MessageOptions? options});
  Future<String?> showErrorMessage(String message, {List<String>? items, MessageOptions? options});
  
  // Dialog methods
  Future<String?> showQuickPick(List<String> items, {String? placeHolder, bool canPickMany = false});
  Future<String?> showInputBox({String? prompt, String? placeHolder, String? value, bool password = false});
  Future<List<String>?> showOpenDialog({String? defaultUri, bool canSelectFiles = true, bool canSelectFolders = false, bool canSelectMany = false, String? title, Map<String, List<String>>? filters});
  Future<String?> showSaveDialog({String? defaultUri, String? title, Map<String, List<String>>? filters});
  
  // Editor methods
  Future<TextEditor?> getActiveTextEditor();
  Future<List<TextEditor>> getVisibleTextEditors();
  Future<void> showTextDocument(String uri, {int? viewColumn, bool preserveFocus = false, bool preview = true});
  
  // Output channel methods
  Future<String> createOutputChannel(String name);
  Future<void> appendToOutputChannel(String name, String text);
  Future<void> appendLineToOutputChannel(String name, String text);
  Future<void> clearOutputChannel(String name);
  Future<void> showOutputChannel(String name, {bool preserveFocus = false});
  Future<void> hideOutputChannel(String name);
  Future<void> disposeOutputChannel(String name);
  
  // Status bar methods
  Future<void> setStatusBarMessage(String message, {int? timeout});
  Future<String> createStatusBarItem({int? alignment, int? priority});
  Future<void> updateStatusBarItem(String id, {String? text, String? tooltip, String? command, String? color});
  Future<void> showStatusBarItem(String id);
  Future<void> hideStatusBarItem(String id);
  Future<void> disposeStatusBarItem(String id);
  
  // Terminal methods
  Future<String> createTerminal({String? name, String? shellPath, List<String>? shellArgs, Map<String, String>? env});
  Future<void> showTerminal(String id);
  Future<void> hideTerminal(String id);
  Future<void> sendTextToTerminal(String id, String text, {bool addNewLine = true});
  Future<void> disposeTerminal(String id);
}
```

### Methods

#### showInformationMessage()
```dart
Future<String?> showInformationMessage(
  String message, 
  {List<String>? items, MessageOptions? options}
)
```
Show an information message with optional buttons.

**Parameters**:
- `message`: Message text to display
- `items`: Optional list of button labels
- `options`: Optional message options (modal, detail)

**Returns**: Selected button label or `null` if dismissed

**Example**:
```dart
final choice = await vscode.window.showInformationMessage(
  'Save changes?',
  items: ['Save', 'Don\'t Save', 'Cancel'],
);
if (choice == 'Save') {
  // Save logic...
}
```

---

#### showWarningMessage()
```dart
Future<String?> showWarningMessage(
  String message,
  {List<String>? items, MessageOptions? options}
)
```
Show a warning message with optional buttons.

**Parameters**:
- `message`: Warning text to display
- `items`: Optional list of button labels
- `options`: Optional message options

**Returns**: Selected button label or `null`

**Example**:
```dart
final result = await vscode.window.showWarningMessage(
  'This action cannot be undone',
  items: ['Proceed', 'Cancel'],
);
```

---

#### showErrorMessage()
```dart
Future<String?> showErrorMessage(
  String message,
  {List<String>? items, MessageOptions? options}
)
```
Show an error message with optional buttons.

**Parameters**:
- `message`: Error text to display
- `items`: Optional list of button labels
- `options`: Optional message options

**Returns**: Selected button label or `null`

**Example**:
```dart
await vscode.window.showErrorMessage('Failed to process file');
```

---

#### showQuickPick()
```dart
Future<String?> showQuickPick(
  List<String> items,
  {String? placeHolder, bool canPickMany = false}
)
```
Show a quick pick dialog with selectable items.

**Parameters**:
- `items`: List of items to choose from
- `placeHolder`: Placeholder text in the input field
- `canPickMany`: Allow multiple selections

**Returns**: Selected item(s) or `null`

**Example**:
```dart
final action = await vscode.window.showQuickPick(
  ['Build', 'Test', 'Deploy', 'Clean'],
  placeHolder: 'Choose an action',
);
```

---

#### showInputBox()
```dart
Future<String?> showInputBox({
  String? prompt,
  String? placeHolder,
  String? value,
  bool password = false
})
```
Show an input box to get text input from the user.

**Parameters**:
- `prompt`: Descriptive text above the input
- `placeHolder`: Placeholder text in the input field
- `value`: Pre-filled value
- `password`: Mask input (for passwords)

**Returns**: User input or `null` if cancelled

**Example**:
```dart
final name = await vscode.window.showInputBox(
  prompt: 'Enter project name',
  placeHolder: 'my_project',
);
```

---

#### getActiveTextEditor()
```dart
Future<TextEditor?> getActiveTextEditor()
```
Get the currently active text editor.

**Returns**: `TextEditor` object or `null` if no editor is active

**Example**:
```dart
final editor = await vscode.window.getActiveTextEditor();
if (editor != null) {
  print('Active file: ${editor.document.fileName}');
  print('Line count: ${editor.document.lineCount}');
}
```

---

#### showTextDocument()
```dart
Future<void> showTextDocument(
  String uri,
  {int? viewColumn, bool preserveFocus = false, bool preview = true}
)
```
Open and show a text document in the editor.

**Parameters**:
- `uri`: File URI or path
- `viewColumn`: Editor column (1, 2, or 3)
- `preserveFocus`: Keep focus on current editor
- `preview`: Open in preview mode

**Example**:
```dart
await vscode.window.showTextDocument('/path/to/file.dart');
```

---

#### createOutputChannel()
```dart
Future<String> createOutputChannel(String name)
```
Create a new output channel for logging.

**Parameters**:
- `name`: Channel name

**Returns**: Channel ID

**Example**:
```dart
final channel = await vscode.window.createOutputChannel('My Extension');
await vscode.window.appendToOutputChannel(channel, 'Starting...\n');
await vscode.window.showOutputChannel(channel);
```

---

## VSCodeWorkspace (Files & Folders)

Workspace-related functionality for working with files, folders, and configurations.

### Class: VSCodeWorkspace

```dart
class VSCodeWorkspace {
  VSCodeWorkspace(VSCodeBridgeServer bridge);
  
  // Workspace folder methods
  Future<List<WorkspaceFolder>> getWorkspaceFolders();
  Future<WorkspaceFolder?> getWorkspaceFolder(VSCodeUri uri);
  Future<String?> getRootPath();
  
  // File operations
  Future<TextDocument?> openTextDocument(String path);
  Future<bool> saveTextDocument(String path);
  Future<List<VSCodeUri>> findFiles(String include, {String? exclude, int? maxResults});
  Future<List<String>> findFilePaths({required String include, String? exclude, int? maxResults});
  
  Future<String> readFile(String path);
  Future<bool> writeFile(String path, String content);
  Future<bool> deleteFile(String path);
  Future<bool> createFile(String path);
  Future<bool> renameFile(String oldPath, String newPath);
  Future<bool> copyFile(String sourcePath, String destPath);
  Future<bool> fileExists(String path);
  Future<FileStat?> statFile(String path);
  
  // Directory operations
  Future<bool> createDirectory(String path);
  Future<bool> deleteDirectory(String path, {bool recursive = false});
  Future<List<String>> readDirectory(String path);
  
  // Configuration
  Future<dynamic> getConfiguration(String section, [String? scope]);
  Future<bool> updateConfiguration(String section, String key, dynamic value, {bool global = true});
}
```

### Methods

#### getWorkspaceFolders()
```dart
Future<List<WorkspaceFolder>> getWorkspaceFolders()
```
Get all workspace folders in the current workspace.

**Returns**: List of `WorkspaceFolder` objects

**Example**:
```dart
final folders = await vscode.workspace.getWorkspaceFolders();
for (final folder in folders) {
  print('Folder: ${folder.name} (${folder.uri.fsPath})');
}
```

---

#### findFiles()
```dart
Future<List<VSCodeUri>> findFiles(
  String include,
  {String? exclude, int? maxResults}
)
```
Find files in the workspace using glob patterns.

**Parameters**:
- `include`: Glob pattern for files to include (e.g., `**/*.dart`)
- `exclude`: Glob pattern for files to exclude
- `maxResults`: Maximum number of results

**Returns**: List of file URIs

**Example**:
```dart
// Find all Dart files
final dartFiles = await vscode.workspace.findFiles('**/*.dart');

// Find config files, excluding node_modules
final configs = await vscode.workspace.findFiles(
  '**/config.json',
  exclude: '**/node_modules/**',
);
```

---

#### readFile()
```dart
Future<String> readFile(String path)
```
Read file contents as a string.

**Parameters**:
- `path`: File path (absolute or workspace-relative)

**Returns**: File contents

**Example**:
```dart
final content = await vscode.workspace.readFile('/path/to/file.txt');
print(content);
```

---

#### writeFile()
```dart
Future<bool> writeFile(String path, String content)
```
Write string content to a file.

**Parameters**:
- `path`: File path (absolute or workspace-relative)
- `content`: Content to write

**Returns**: `true` if successful

**Example**:
```dart
await vscode.workspace.writeFile(
  '/path/to/output.txt',
  'Generated content...',
);
```

---

#### getConfiguration()
```dart
Future<dynamic> getConfiguration(String section, [String? scope])
```
Get workspace or user configuration settings.

**Parameters**:
- `section`: Configuration section (e.g., `'editor'`, `'files'`)
- `scope`: Optional URI for workspace-specific config

**Returns**: Configuration value(s)

**Example**:
```dart
// Get all editor settings
final editorConfig = await vscode.workspace.getConfiguration('editor');
print('Tab size: ${editorConfig["tabSize"]}');

// Get specific setting
final autoSave = await vscode.workspace.getConfiguration('files');
print('Auto save: ${autoSave["autoSave"]}');
```

---

## VSCodeCommands (Commands)

Execute and manage VS Code commands.

### Class: VSCodeCommands

```dart
class VSCodeCommands {
  VSCodeCommands(VSCodeBridgeServer bridge);
  
  Future<dynamic> executeCommand(String command, [List<dynamic>? args]);
  Future<List<String>> getCommands({bool filterInternal = false});
  Future<bool> registerCommand(String command, String handlerScript);
}
```

### Methods

#### executeCommand()
```dart
Future<dynamic> executeCommand(String command, [List<dynamic>? args])
```
Execute a VS Code command.

**Parameters**:
- `command`: Command ID (e.g., `'editor.action.formatDocument'`)
- `args`: Optional command arguments

**Returns**: Command result (type varies by command)

**Example**:
```dart
// Format current document
await vscode.commands.executeCommand('editor.action.formatDocument');

// Open file
await vscode.commands.executeCommand('vscode.open', [
  'file:///path/to/file.dart'
]);

// Save all files
await vscode.commands.executeCommand('workbench.action.files.saveAll');
```

---

#### getCommands()
```dart
Future<List<String>> getCommands({bool filterInternal = false})
```
Get list of all registered commands.

**Parameters**:
- `filterInternal`: Filter out internal commands (starting with `_`)

**Returns**: List of command IDs

**Example**:
```dart
final commands = await vscode.commands.getCommands(filterInternal: true);
print('Available commands: ${commands.length}');
```

---

### Common Commands

Use `VSCodeCommonCommands` class for well-known command constants:

```dart
class VSCodeCommonCommands {
  static const String openFile = 'vscode.open';
  static const String saveFile = 'workbench.action.files.save';
  static const String saveAllFiles = 'workbench.action.files.saveAll';
  static const String formatDocument = 'editor.action.formatDocument';
  static const String organizeImports = 'editor.action.organizeImports';
  static const String goToDefinition = 'editor.action.revealDefinition';
  static const String renameSymbol = 'editor.action.rename';
  static const String toggleTerminal = 'workbench.action.terminal.toggleTerminal';
  static const String findInFiles = 'workbench.action.findInFiles';
  // ... and more
}
```

**Example**:
```dart
import 'package:tom_vscode_bridge/vscode_api/vscode_commands.dart';

await vscode.commands.executeCommand(VSCodeCommonCommands.formatDocument);
```

---

## VSCodeLanguageModel (Copilot/LM)

Access to GitHub Copilot and other language models.

### Class: VSCodeLanguageModel

```dart
class VSCodeLanguageModel {
  VSCodeLanguageModel(VSCodeBridgeServer bridge);
  
  Future<List<LanguageModelChat>> selectChatModels({String? vendor, String? family, String? id, String? version});
  Future<LanguageModelToolResult> invokeTool(String name, Map<String, dynamic> options);
  Future<void> registerTool(String name, Map<String, dynamic> tool);
  Future<List<LanguageModelToolInformation>> getTools();
}
```

### Class: LanguageModelChat

```dart
class LanguageModelChat {
  final String id;
  final String vendor;
  final String family;
  final String version;
  final String name;
  final int maxInputTokens;
  
  Future<LanguageModelChatResponse> sendRequest(
    VSCodeBridgeServer bridge,
    List<LanguageModelChatMessage> messages,
    {Map<String, dynamic>? modelOptions}
  );
  
  Future<int> countTokens(VSCodeBridgeServer bridge, String text);
}
```

### Class: LanguageModelChatMessage

```dart
class LanguageModelChatMessage {
  final String role;  // 'user' or 'assistant'
  final String content;
  final String? name;
  
  factory LanguageModelChatMessage.user(String content, {String? name});
  factory LanguageModelChatMessage.assistant(String content, {String? name});
}
```

### Methods

#### selectChatModels()
```dart
Future<List<LanguageModelChat>> selectChatModels({
  String? vendor,
  String? family,
  String? id,
  String? version
})
```
Select language models matching criteria.

**Parameters**:
- `vendor`: Model vendor (e.g., `'copilot'`)
- `family`: Model family (e.g., `'gpt-4'`, `'gpt-3.5-turbo'`)
- `id`: Specific model ID
- `version`: Model version

**Returns**: List of available models

**Example**:
```dart
// Get all available models
final models = await vscode.lm.selectChatModels();

// Get Copilot GPT-4 models
final gpt4Models = await vscode.lm.selectChatModels(
  vendor: 'copilot',
  family: 'gpt-4',
);

if (gpt4Models.isNotEmpty) {
  final model = gpt4Models.first;
  print('Using: ${model.name} (max tokens: ${model.maxInputTokens})');
}
```

---

#### sendRequest()
```dart
Future<LanguageModelChatResponse> sendRequest(
  VSCodeBridgeServer bridge,
  List<LanguageModelChatMessage> messages,
  {Map<String, dynamic>? modelOptions}
)
```
Send a chat request to the language model.

**Parameters**:
- `bridge`: Bridge server instance
- `messages`: Conversation history
- `modelOptions`: Optional model parameters (temperature, maxTokens, etc.)

**Returns**: Model response

**Example**:
```dart
// Get model
final models = await vscode.lm.selectChatModels(family: 'gpt-4');
final model = models.first;

// Send request
final response = await model.sendRequest(
  vscode.bridge,
  [
    LanguageModelChatMessage.user('Explain async/await in Dart'),
  ],
  modelOptions: {
    'temperature': 0.7,
    'maxTokens': 500,
  },
);

print('Response: ${response.text}');
```

---

#### countTokens()
```dart
Future<int> countTokens(VSCodeBridgeServer bridge, String text)
```
Count tokens in text for this model.

**Parameters**:
- `bridge`: Bridge server instance
- `text`: Text to count tokens for

**Returns**: Token count

**Example**:
```dart
final model = (await vscode.lm.selectChatModels()).first;
final tokens = await model.countTokens(vscode.bridge, 'Hello world');
print('Token count: $tokens');
```

---

## VSCodeChat (Chat Participants)

Create chat participants for Copilot Chat.

### Class: VSCodeChat

```dart
class VSCodeChat {
  VSCodeChat(VSCodeBridgeServer bridge);
  
  Future<ChatParticipant> createChatParticipant(
    String id,
    {required ChatRequestHandler handler, String? description, String? fullName}
  );
}
```

### Type: ChatRequestHandler

```dart
typedef ChatRequestHandler = Future<ChatResult?> Function(
  ChatRequest request,
  ChatContext context,
  ChatResponseStream stream,
);
```

### Class: ChatRequest

```dart
class ChatRequest {
  final String prompt;
  final String command;
  final List<ChatPromptReference> references;
}
```

### Class: ChatResponseStream

```dart
class ChatResponseStream {
  Future<void> markdown(String text);
  Future<void> anchor(String uri, {String? title});
  Future<void> button(String command, {String? title, List<dynamic>? arguments});
  Future<void> filetree(List<String> files, {String? baseUri});
  Future<void> progress(String value);
  Future<void> reference(String uri, {String? title});
  Future<void> error(String message);
}
```

### Methods

#### createChatParticipant()
```dart
Future<ChatParticipant> createChatParticipant(
  String id,
  {required ChatRequestHandler handler,
   String? description,
   String? fullName}
)
```
Create a chat participant that appears in Copilot Chat.

**Parameters**:
- `id`: Participant ID (e.g., `'myExtension.helper'`)
- `handler`: Function to handle chat requests
- `description`: Short description
- `fullName`: Full name displayed in UI

**Returns**: `ChatParticipant` object

**Example**:
```dart
final participant = await vscode.chat.createChatParticipant(
  'dart-helper',
  description: 'Helps with Dart code',
  fullName: 'Dart Code Helper',
  handler: (request, context, stream) async {
    // Send markdown response
    await stream.markdown('## Processing: ${request.prompt}\n\n');
    
    // Show progress
    await stream.progress('Analyzing code...');
    
    // Process request
    final result = await processRequest(request.prompt);
    
    // Send final response
    await stream.markdown(result);
    
    // Return metadata
    return ChatResult(metadata: {'processed': true});
  },
);

print('Participant created: ${participant.id}');
```

---

## VSCodeExtensions (Extensions)

Query information about installed extensions.

### Class: VSCodeExtensions

```dart
class VSCodeExtensions {
  VSCodeExtensions(VSCodeBridgeServer bridge);
  
  Future<List<Map<String, dynamic>>> getAllExtensions();
  Future<Map<String, dynamic>?> getExtension(String extensionId);
}
```

### Methods

#### getAllExtensions()
```dart
Future<List<Map<String, dynamic>>> getAllExtensions()
```
Get information about all installed extensions.

**Returns**: List of extension objects

**Example**:
```dart
final extensions = await vscode.extensions.getAllExtensions();
print('Total extensions: ${extensions.length}');

for (final ext in extensions) {
  print('${ext["id"]}: ${ext["packageJSON"]["displayName"]}');
}
```

---

#### getExtension()
```dart
Future<Map<String, dynamic>?> getExtension(String extensionId)
```
Get information about a specific extension.

**Parameters**:
- `extensionId`: Extension identifier (e.g., `'dart-code.dart-code'`)

**Returns**: Extension object or `null` if not found

**Example**:
```dart
final dartExt = await vscode.extensions.getExtension('Dart-Code.dart-code');
if (dartExt != null) {
  print('Dart extension version: ${dartExt["packageJSON"]["version"]}');
}
```

---

## Types

Common data types used throughout the API.

### VSCodeUri

```dart
class VSCodeUri {
  final String scheme;
  final String authority;
  final String path;
  final String query;
  final String fragment;
  final String fsPath;
  
  factory VSCodeUri.fromJson(Map<String, dynamic> json);
  Map<String, dynamic> toJson();
  
  static VSCodeUri file(String path);
  static VSCodeUri parse(String uri);
}
```

**Example**:
```dart
final uri = VSCodeUri.file('/path/to/file.dart');
print('Path: ${uri.fsPath}');
print('Scheme: ${uri.scheme}'); // 'file'
```

---

### WorkspaceFolder

```dart
class WorkspaceFolder {
  final VSCodeUri uri;
  final String name;
  final int index;
  
  factory WorkspaceFolder.fromJson(Map<String, dynamic> json);
  Map<String, dynamic> toJson();
}
```

---

### TextDocument

```dart
class TextDocument {
  final VSCodeUri uri;
  final String fileName;
  final bool isUntitled;
  final String languageId;
  final int version;
  final bool isDirty;
  final bool isClosed;
  final int lineCount;
  
  factory TextDocument.fromJson(Map<String, dynamic> json);
  Map<String, dynamic> toJson();
}
```

---

### TextEditor

```dart
class TextEditor {
  final TextDocument document;
  final Selection selection;
  final List<Selection> selections;
  final List<Range> visibleRanges;
  final Map<String, dynamic> options;
  final int? viewColumn;
  
  factory TextEditor.fromJson(Map<String, dynamic> json);
  Map<String, dynamic> toJson();
}
```

---

### Position

```dart
class Position {
  final int line;
  final int character;
  
  Position(this.line, this.character);
  
  factory Position.fromJson(Map<String, dynamic> json);
  Map<String, dynamic> toJson();
}
```

---

### Range

```dart
class Range {
  final Position start;
  final Position end;
  
  Range(this.start, this.end);
  
  factory Range.fromJson(Map<String, dynamic> json);
  Map<String, dynamic> toJson();
  
  bool contains(Position position);
  bool intersects(Range range);
}
```

---

### Selection

```dart
class Selection extends Range {
  final Position anchor;
  final Position active;
  final bool isReversed;
  
  Selection(this.anchor, this.active, this.isReversed) 
    : super(
        isReversed ? active : anchor, 
        isReversed ? anchor : active
      );
  
  factory Selection.fromJson(Map<String, dynamic> json);
}
```

---

### MessageOptions

```dart
class MessageOptions {
  final bool? modal;
  final String? detail;
  
  MessageOptions({this.modal, this.detail});
  
  Map<String, dynamic> toJson();
}
```

---

### FileStat

```dart
class FileStat {
  final int type; // 1 = file, 2 = directory
  final int ctime; // Creation timestamp
  final int mtime; // Modification timestamp
  final int size;  // Size in bytes
  
  factory FileStat.fromJson(Map<String, dynamic> json);
}
```

---

## D4rt Helper Functions

Convenience functions for use in D4rt scripts. Import from `vscode_api/d4rt_helpers.dart`.

### Initialization

```dart
/// Initialize VS Code API in D4rt script
VSCode initializeVSCode(dynamic context);

/// Get current VSCode instance
VSCode getVSCode();
```

**Example**:
```dart
Future<Map<String, dynamic>> execute(params, context) async {
  final vscode = initializeVSCode(context);
  
  // Now use VS Code APIs...
  await showInfo('Script started!');
  
  return {'success': true};
}
```

---

### Message Functions

```dart
Future<String?> showInfo(String message, {List<String>? choices});
Future<String?> showWarning(String message, {List<String>? choices});
Future<String?> showError(String message, {List<String>? choices});
```

**Example**:
```dart
await showInfo('Operation completed successfully!');

final choice = await showWarning(
  'Delete this file?',
  choices: ['Delete', 'Cancel'],
);
```

---

### Dialog Functions

```dart
Future<String?> quickPick(
  List<String> items,
  {String? placeholder, bool canPickMany = false}
);

Future<String?> inputBox({
  String? prompt,
  String? placeholder,
  String? defaultValue,
  bool password = false
});
```

**Example**:
```dart
final framework = await quickPick(
  ['Flutter', 'Angular', 'React', 'Vue'],
  placeholder: 'Select a framework',
);

final projectName = await inputBox(
  prompt: 'Enter project name',
  placeholder: 'my_awesome_project',
);
```

---

### Workspace Functions

```dart
Future<String?> getWorkspaceRoot();
Future<List<String>> findFiles({required String include, String? exclude, int? maxResults});
Future<String> readFile(String path);
Future<bool> writeFile(String path, String content);
Future<bool> deleteFile(String path);
Future<bool> fileExists(String path);
```

**Example**:
```dart
// Find all Dart files
final dartFiles = await findFiles(include: '**/*.dart');

// Read file
final content = await readFile('lib/main.dart');

// Write file
await writeFile('output.txt', 'Generated content');
```

---

### Command & Config Functions

```dart
Future<dynamic> executeCommand(String command, [List<dynamic>? args]);
Future<dynamic> getConfig(String section, [String? key]);
Future<bool> setConfig(String section, String key, dynamic value, {bool global = true});
```

**Example**:
```dart
// Execute command
await executeCommand('editor.action.formatDocument');

// Get config
final tabSize = await getConfig('editor', 'tabSize');

// Set config
await setConfig('editor', 'fontSize', 14);
```

---

### UI Functions

```dart
Future<void> setStatus(String message, {int? timeout});
Future<String> createOutput(String name, {String? initialContent});
Future<void> appendOutput(String channel, String text);
Future<void> openFile(String path);
```

**Example**:
```dart
await setStatus('Processing files...', timeout: 3000);

final output = await createOutput('My Tool');
await appendOutput(output, 'Starting analysis...\n');
```

---

### Clipboard Functions

```dart
Future<void> copyToClipboard(String text);
Future<String> readClipboard();
```

**Example**:
```dart
await copyToClipboard('Copied text!');
final clip = await readClipboard();
```

---

### Helper Classes

#### Progress

```dart
class Progress {
  static Future<Progress> create(String name);
  Future<void> report(String message);
  Future<void> complete();
  Future<void> error(String message);
}
```

**Example**:
```dart
final progress = await Progress.create('File Processor');

await progress.report('Processing file 1/10');
await progress.report('Processing file 2/10');
// ...
await progress.complete();
```

---

#### FileBatch

```dart
class FileBatch {
  static Future<FileBatch> fromPattern({
    required String include,
    String? exclude,
    int? maxResults
  });
  
  Future<List<T>> process<T>(
    Future<T> Function(String path, String content) processor
  );
  
  Future<List<String>> filter(
    bool Function(String path, String content) predicate
  );
  
  Future<void> modify(
    Future<String> Function(String path, String content) transformer
  );
}
```

**Example**:
```dart
// Process all Dart files
final batch = await FileBatch.fromPattern(include: '**/*.dart');

final results = await batch.process((path, content) async {
  final lines = content.split('\n').length;
  return {'path': path, 'lines': lines};
});

// Modify files
await batch.modify((path, content) async {
  return content.replaceAll('// TODO', '// DONE');
});
```

---

## VSCodeBridgeServer

The bridge server handles JSON-RPC communication with VS Code.

### Class: VSCodeBridgeServer

```dart
class VSCodeBridgeServer {
  VSCodeBridgeServer();
  
  void start();
  void dispose();
  
  Future<T> sendRequest<T>(String method, Map<String, dynamic> params);
  void sendNotification(String method, Map<String, dynamic> params);
}
```

### Methods

#### start()
```dart
void start()
```
Start the bridge server and begin listening for messages on stdin.

**Example**:
```dart
final server = VSCodeBridgeServer();
server.start();
```

---

#### sendRequest()
```dart
Future<T> sendRequest<T>(String method, Map<String, dynamic> params)
```
Send a request to VS Code and wait for response.

**Parameters**:
- `method`: Method name
- `params`: Method parameters

**Returns**: Method result

**Example**:
```dart
final result = await server.sendRequest('executeScript', {
  'script': 'return context.vscode.version;',
  'params': {},
});
```

---

#### sendNotification()
```dart
void sendNotification(String method, Map<String, dynamic> params)
```
Send a notification (no response expected).

**Parameters**:
- `method`: Method name
- `params`: Method parameters

**Example**:
```dart
server.sendNotification('log', {'message': 'Script started'});
```

---

## Usage Examples

### Complete Extension Example

```dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

void main() {
  final server = VSCodeBridgeServer();
  final vscode = VSCode(server);
  
  server.start();
  
  // Register custom handlers
  registerHandlers(vscode);
}

void registerHandlers(VSCode vscode) {
  // Handler will be called from VS Code extension
}

// Example handler for analyzing workspace
Future<Map<String, dynamic>> analyzeWorkspace() async {
  final vscode = getVSCode();
  
  // Get workspace folders
  final folders = await vscode.workspace.getWorkspaceFolders();
  
  // Find Dart files
  final dartFiles = await vscode.workspace.findFilePaths(
    include: '**/*.dart',
    exclude: '**/.*/**',
  );
  
  // Count total lines
  int totalLines = 0;
  for (final file in dartFiles) {
    final content = await vscode.workspace.readFile(file);
    totalLines += content.split('\n').length;
  }
  
  return {
    'folders': folders.length,
    'dartFiles': dartFiles.length,
    'totalLines': totalLines,
  };
}
```

---

### Copilot Integration Example

```dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

Future<void> askCopilotToAnalyzeCode() async {
  final vscode = getVSCode();
  
  // Select Copilot model
  final models = await vscode.lm.selectChatModels(
    vendor: 'copilot',
    family: 'gpt-4',
  );
  
  if (models.isEmpty) {
    await showError('Copilot not available');
    return;
  }
  
  final model = models.first;
  
  // Get current file
  final editor = await vscode.window.getActiveTextEditor();
  if (editor == null) {
    await showWarning('No file open');
    return;
  }
  
  // Read file content
  final content = await vscode.workspace.readFile(
    editor.document.fileName,
  );
  
  // Ask Copilot to analyze
  final response = await model.sendRequest(
    vscode.bridge,
    [
      LanguageModelChatMessage.user(
        'Analyze this Dart code and suggest improvements:\n\n$content',
      ),
    ],
    modelOptions: {'temperature': 0.3},
  );
  
  // Show results
  await showInfo('Analysis complete!');
  
  // Create output channel with results
  final output = await createOutput('Code Analysis');
  await appendOutput(output, response.text);
}
```

---

### Chat Participant Example

```dart
Future<void> createDartHelperParticipant() async {
  final vscode = getVSCode();
  
  await vscode.chat.createChatParticipant(
    'dart.helper',
    description: 'Helps with Dart development',
    fullName: 'Dart Development Assistant',
    handler: (request, context, stream) async {
      // Parse command
      switch (request.command) {
        case 'analyze':
          await handleAnalyze(request, stream);
          break;
          
        case 'refactor':
          await handleRefactor(request, stream);
          break;
          
        default:
          await handleGeneral(request, stream);
      }
      
      return ChatResult(metadata: {'handled': true});
    },
  );
}

Future<void> handleAnalyze(ChatRequest request, ChatResponseStream stream) async {
  await stream.progress('Analyzing workspace...');
  
  final analysis = await analyzeWorkspace();
  
  await stream.markdown('''
## Workspace Analysis

- **Folders**: ${analysis['folders']}
- **Dart Files**: ${analysis['dartFiles']}
- **Total Lines**: ${analysis['totalLines']}
''');
}
```

---

### File Processing Example

```dart
Future<void> processAllDartFiles() async {
  final progress = await Progress.create('Dart Formatter');
  
  // Find all Dart files
  final batch = await FileBatch.fromPattern(
    include: '**/*.dart',
    exclude: '**/build/**',
  );
  
  int processed = 0;
  final results = await batch.process((path, content) async {
    processed++;
    await progress.report('Processing $processed: $path');
    
    // Format the file
    await executeCommand('editor.action.formatDocument', [path]);
    
    return path;
  });
  
  await progress.complete();
  await showInfo('Formatted ${results.length} files');
}
```

---

## Best Practices

### Error Handling

```dart
try {
  final result = await vscode.workspace.readFile('/path/to/file.dart');
  // Process result...
} catch (e) {
  await showError('Failed to read file: $e');
}
```

### Resource Cleanup

```dart
// Create output channel
final channel = await vscode.window.createOutputChannel('My Tool');

try {
  // Use channel...
  await vscode.window.appendToOutputChannel(channel, 'Processing...\n');
} finally {
  // Cleanup
  await vscode.window.disposeOutputChannel(channel);
}
```

### Performance

```dart
// BAD: Sequential file reads (slow)
for (final file in files) {
  final content = await vscode.workspace.readFile(file);
  process(content);
}

// GOOD: Parallel file reads (fast)
final contents = await Future.wait(
  files.map((f) => vscode.workspace.readFile(f))
);
for (final content in contents) {
  process(content);
}
```

### Type Safety

```dart
// Use strongly typed wrappers instead of raw executeScript
// BAD:
final result = await vscode.bridge.sendRequest('executeScript', {
  'script': 'return context.vscode.window.showInformationMessage(params.msg);',
  'params': {'msg': 'Hello'},
});

// GOOD:
final result = await vscode.window.showInformationMessage('Hello');
```

---

## See Also

- [Architecture Documentation](../tom_vscode_extension/_copilot_guidelines/architecture.md) - System architecture
- [Implementation Guide](./IMPLEMENTATION.md) - Implementation details
- [Project Documentation](./PROJECT.md) - Project overview
- [VS Code API Documentation](https://code.visualstudio.com/api/references/vscode-api) - Official VS Code API reference
