# VS Code Bridge Implementation Guide

Detailed implementation guide for the tom_vscode_bridge Dart project - the server-side component that communicates with the VS Code extension.

---

## Table of Contents

- [Overview](#overview)
- [Project Structure](#project-structure)
- [Core Components](#core-components)
  - [Bridge Server](#bridge-server)
  - [JSON-RPC Protocol](#json-rpc-protocol)
  - [API Wrappers](#api-wrappers)
  - [D4rt Integration](#d4rt-integration)
- [Message Flow](#message-flow)
- [Request Handlers](#request-handlers)
- [VS Code API Access](#vs-code-api-access)
- [Error Handling](#error-handling)
- [Testing](#testing)
- [Performance Optimization](#performance-optimization)
- [Debugging](#debugging)
- [Extension Points](#extension-points)

---

## Overview

The tom_vscode_bridge project provides a Dart-based bridge server that communicates with the VS Code extension (tom_vscode_extension) via JSON-RPC over stdin/stdout. It wraps VS Code APIs in type-safe Dart classes and supports dynamic Dart script execution via D4rt.

**Key Features**:
- JSON-RPC 2.0 server over stdin/stdout
- Type-safe Dart wrappers for VS Code APIs
- D4rt integration for dynamic script execution
- Bidirectional communication (both sides can initiate requests)
- Full Copilot/Language Model integration
- Chat participant support

**Technology Stack**:
- Dart 3.0+
- D4rt for dynamic execution
- JSON-RPC 2.0 protocol
- Async/await for concurrency

---

## Project Structure

```
tom_vscode_bridge/
├── bin/
│   └── tom_vscode_bridge.dart          # Entry point
├── lib/
│   ├── tom_vscode_bridge.dart          # Main library export
│   ├── vscode_bridge.dart           # Alternative export
│   ├── bridge_server.dart           # Core bridge server
│   └── vscode_api/                  # VS Code API wrappers
│       ├── vscode.dart              # Main API aggregator
│       ├── vscode_window.dart       # Window/UI APIs
│       ├── vscode_workspace.dart    # Workspace/file APIs
│       ├── vscode_commands.dart     # Command APIs
│       ├── vscode_lm.dart           # Language Model (Copilot)
│       ├── vscode_chat.dart         # Chat participant APIs
│       ├── vscode_extensions.dart   # Extension APIs
│       ├── vscode_types.dart        # Type definitions
│       ├── d4rt_bridge.dart         # D4rt bridge registration
│       └── d4rt_helpers.dart        # Helper functions for D4rt scripts
├── test/
│   └── tom_vscode_bridge_test.dart    # Unit tests
└── pubspec.yaml                     # Package configuration
```

---

## Core Components

### Bridge Server

**File**: `lib/bridge_server.dart`

The `VSCodeBridgeServer` class is the heart of the bridge, handling all JSON-RPC communication.

#### Class Structure

```dart
class VSCodeBridgeServer {
  // Communication streams
  final StreamController<String> _outputController;
  int _messageId;
  final Map<int, Completer<dynamic>> _pendingRequests;
  
  // D4rt interpreter for dynamic execution
  late final D4rt _interpreter;
  
  VSCodeBridgeServer();
  void start();
  void dispose();
  Future<T> sendRequest<T>(String method, Map<String, dynamic> params);
  void sendNotification(String method, Map<String, dynamic> params);
}
```

#### Initialization

```dart
VSCodeBridgeServer() {
  // Initialize D4rt interpreter
  _interpreter = D4rt();
  
  // Register all VS Code API bridges with D4rt
  // This allows D4rt scripts to use VS Code API types directly
  registerVSCodeBridges(_interpreter);
}
```

**Key Points**:
- D4rt interpreter initialized on construction
- VS Code API types registered with D4rt for script access
- Stream controller for output buffering

#### Starting the Server

```dart
void start() {
  // Listen to stdin for messages from VS Code
  stdin
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .listen(_handleMessage, onError: _handleError);

  // Send output to VS Code via stdout
  _outputController.stream.listen((message) {
    stdout.writeln(message);
  });

  _sendLog('VS Code Bridge Server started');
}
```

**Process**:
1. Set up stdin listener for incoming JSON-RPC messages
2. Transform byte stream to lines
3. Connect output controller to stdout
4. Send initialization log

#### Message Handling

```dart
void _handleMessage(String line) {
  try {
    final message = jsonDecode(line) as Map<String, dynamic>;
    final method = message['method'] as String?;
    final id = message['id'] as int?;
    final params = message['params'] as Map<String, dynamic>?;

    if (method != null) {
      // This is a request from VS Code
      _handleRequest(method, params ?? {}, id);
    } else if (id != null && message.containsKey('result')) {
      // This is a response to our request
      final completer = _pendingRequests.remove(id);
      completer?.complete(message['result']);
    } else if (id != null && message.containsKey('error')) {
      // This is an error response
      final completer = _pendingRequests.remove(id);
      completer?.completeError(message['error']);
    }
  } catch (e) {
    _sendError('Failed to parse message: $e');
  }
}
```

**Message Types**:
1. **Request** (has method + id): Incoming request from VS Code
2. **Response** (has id + result): Response to our previous request
3. **Error** (has id + error): Error response to our previous request

---

### JSON-RPC Protocol

The bridge implements JSON-RPC 2.0 over stdin/stdout pipes.

#### Request Format

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "method": "getWorkspaceInfo",
  "params": {
    "workspaceRoot": "/path/to/workspace"
  }
}
```

#### Response Format

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "result": {
    "root": "/path/to/workspace",
    "projects": ["project1", "project2"],
    "projectCount": 2
  }
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

#### Sending Requests to VS Code

```dart
Future<T> sendRequest<T>(String method, Map<String, dynamic> params) {
  final id = _messageId++;
  final completer = Completer<T>();
  _pendingRequests[id] = completer;

  final message = {
    'jsonrpc': '2.0',
    'id': id,
    'method': method,
    'params': params,
  };

  _outputController.add(jsonEncode(message));
  return completer.future;
}
```

**Process**:
1. Generate unique message ID
2. Create Completer for async response
3. Store in pending requests map
4. Serialize and send via stdout
5. Return Future that completes when response arrives

---

### API Wrappers

API wrapper classes provide type-safe Dart interfaces to VS Code's JavaScript APIs.

#### Wrapper Pattern

All wrapper classes follow this pattern:

```dart
class VSCode{Namespace} {
  final VSCodeBridgeServer _bridge;
  
  VSCode{Namespace}(this._bridge);
  
  Future<ReturnType> methodName(params) async {
    final result = await _bridge.sendRequest('executeScript', {
      'script': '''
        // JavaScript code that calls VS Code API
        const result = await context.vscode.{namespace}.{method}(params.arg);
        return result;
      ''',
      'params': {'arg': params},
    });
    
    if (result['success'] == true) {
      return ReturnType.fromJson(result['result']);
    }
    throw Exception('API call failed');
  }
}
```

#### Example: VSCodeWindow

```dart
class VSCodeWindow {
  final VSCodeBridgeServer _bridge;

  VSCodeWindow(this._bridge);

  Future<String?> showInformationMessage(
    String message, {
    List<String>? items,
    MessageOptions? options,
  }) async {
    final result = await _bridge.sendRequest('executeScript', {
      'script': '''
        const opts = params.options || {};
        const result = await context.vscode.window.showInformationMessage(
          params.message,
          opts,
          ...(params.items || [])
        );
        return result || null;
      ''',
      'params': {
        'message': message,
        if (items != null) 'items': items,
        if (options != null) 'options': options.toJson(),
      },
    });

    if (result['success'] == true) {
      return result['result'] as String?;
    }
    return null;
  }
}
```

**Key Points**:
- All methods are async (return `Future`)
- JavaScript code embedded as string (executed in VS Code context)
- Parameters passed as map in `params`
- Results extracted from `result['result']`
- Type conversion from JSON to Dart types

#### Type Conversion

Complex VS Code types are represented as Dart classes:

```dart
class VSCodeUri {
  final String scheme;
  final String authority;
  final String path;
  final String query;
  final String fragment;
  final String fsPath;
  
  VSCodeUri({...});
  
  factory VSCodeUri.fromJson(Map<String, dynamic> json) {
    return VSCodeUri(
      scheme: json['scheme'] as String,
      authority: json['authority'] as String,
      path: json['path'] as String,
      query: json['query'] as String,
      fragment: json['fragment'] as String,
      fsPath: json['fsPath'] as String,
    );
  }
  
  Map<String, dynamic> toJson() {
    return {
      'scheme': scheme,
      'authority': authority,
      'path': path,
      'query': query,
      'fragment': fragment,
      'fsPath': fsPath,
    };
  }
}
```

**Benefits**:
- Type safety in Dart
- IDE autocomplete and type checking
- Validation at deserialization
- Easy debugging with toString()

---

### D4rt Integration

D4rt enables dynamic Dart code execution without compilation.

#### Initialization

```dart
// In VSCodeBridgeServer constructor
_interpreter = D4rt();

// Register VS Code API bridges
registerVSCodeBridges(_interpreter);
```

#### Registering Bridges

**File**: `lib/vscode_api/d4rt_bridge.dart`

```dart
void registerVSCodeBridges(D4rt interpreter) {
  // Register type constructors
  interpreter.registerType<VSCode>('VSCode', 
    constructor: (args) => VSCode(args[0] as VSCodeBridgeServer));
  
  interpreter.registerType<VSCodeWindow>('VSCodeWindow',
    constructor: (args) => VSCodeWindow(args[0] as VSCodeBridgeServer));
  
  interpreter.registerType<VSCodeWorkspace>('VSCodeWorkspace',
    constructor: (args) => VSCodeWorkspace(args[0] as VSCodeBridgeServer));
  
  // ... register all wrapper classes
}
```

**Purpose**: Allows D4rt scripts to instantiate and use VS Code API wrapper classes.

#### Executing Scripts

```dart
Future<Map<String, dynamic>> _executeScript(
  Map<String, dynamic> params,
) async {
  final script = params['script'] as String?;
  final executeParams = params['params'] as Map<String, dynamic>? ?? {};

  if (script == null) {
    throw Exception('script parameter is required');
  }

  _sendLog('Executing Dart script (${script.length} chars)');

  try {
    final result = await _interpreter.eval(script);
    
    return {
      'success': true,
      'result': result,
    };
  } catch (e, stackTrace) {
    return {
      'success': false,
      'error': e.toString(),
      'stack': stackTrace.toString(),
    };
  }
}
```

**Execution Flow**:
1. Extract script string and parameters
2. Pass to D4rt interpreter
3. D4rt parses and executes Dart code
4. Return result or error
5. Stack traces preserved for debugging

#### Context Injection

Scripts have access to a `context` object:

```dart
// Available in D4rt scripts
final context = {
  'bridge': VSCodeBridgeServer instance,
  'vscode': VSCode instance,
  'params': parameters passed from TypeScript
};
```

**Example D4rt Script**:
```dart
// Executed dynamically via D4rt
final vscode = context['vscode'];
final params = context['params'];

await vscode.window.showInformationMessage('Hello from D4rt!');

final files = await vscode.workspace.findFiles('**/*.dart');
return {'fileCount': files.length};
```

---

## Message Flow

### TypeScript → Dart (Request)

1. **TypeScript**: User triggers command
2. **TypeScript**: `bridgeClient.sendRequest('getWorkspaceInfo', params)`
3. **JSON-RPC**: Serialize to JSON, send via stdin
4. **Dart**: stdin listener receives line
5. **Dart**: `_handleMessage()` parses JSON
6. **Dart**: `_handleRequest()` routes to handler
7. **Dart**: Handler executes (`_getWorkspaceInfo()`)
8. **Dart**: `_sendResponse()` serializes result to JSON
9. **JSON-RPC**: Send response via stdout
10. **TypeScript**: stdout listener receives line
11. **TypeScript**: Promise resolves with result

### Dart → TypeScript (Request)

1. **Dart**: Need VS Code API (e.g., show message)
2. **Dart**: `bridge.sendRequest('executeScript', {...})`
3. **JSON-RPC**: Serialize to JSON, send via stdout
4. **TypeScript**: stdout listener receives line
5. **TypeScript**: `handleMessage()` parses JSON
6. **TypeScript**: Route to `executeScript` handler
7. **TypeScript**: Execute JavaScript in VS Code context
8. **TypeScript**: Serialize result to JSON
9. **JSON-RPC**: Send response via stdin
10. **Dart**: stdin listener receives line
11. **Dart**: Completer resolves Future

---

## Request Handlers

### Built-in Handlers

The bridge server implements several built-in request handlers:

#### getWorkspaceInfo

```dart
Future<Map<String, dynamic>> _getWorkspaceInfo(
  Map<String, dynamic> params,
) async {
  final workspaceRoot = params['workspaceRoot'] as String?;

  if (workspaceRoot == null) {
    throw Exception('workspaceRoot parameter is required');
  }

  final dir = Directory(workspaceRoot);
  if (!dir.existsSync()) {
    throw Exception('Workspace directory does not exist: $workspaceRoot');
  }

  // List top-level directories
  final projects = <String>[];
  await for (final entity in dir.list()) {
    if (entity is Directory) {
      projects.add(entity.path.split('/').last);
    }
  }

  return {
    'root': workspaceRoot,
    'projects': projects,
    'projectCount': projects.length,
  };
}
```

**Purpose**: Get information about workspace structure

#### analyzeProject

```dart
Future<Map<String, dynamic>> _analyzeProject(
  Map<String, dynamic> params,
) async {
  final projectPath = params['projectPath'] as String?;

  if (projectPath == null) {
    throw Exception('projectPath parameter is required');
  }

  _sendLog('Analyzing project: $projectPath');

  // Simulate analysis
  await Future.delayed(const Duration(seconds: 1));

  // Ask VS Code to show a message (bidirectional call)
  await sendRequest('showInfo', {
    'message': 'Analysis complete for: $projectPath',
  });

  return {
    'projectPath': projectPath,
    'analysis': 'Project analysis completed',
    'fileCount': 42,
    'lineCount': 1337,
  };
}
```

**Purpose**: Analyze Dart project and demonstrate bidirectional communication

#### executeFile

```dart
Future<Map<String, dynamic>> _executeFile(
  Map<String, dynamic> params,
) async {
  final filePath = params['filePath'] as String?;
  final args = params['args'] as List<dynamic>? ?? [];

  if (filePath == null) {
    throw Exception('filePath parameter is required');
  }

  _sendLog('Executing Dart file: $filePath');

  try {
    // Execute the Dart file as a subprocess
    final process = await Process.start(
      'dart',
      ['run', filePath, ...args.map((e) => e.toString())],
    );

    final stdout = await process.stdout.transform(utf8.decoder).join();
    final stderr = await process.stderr.transform(utf8.decoder).join();
    final exitCode = await process.exitCode;

    final result = {
      'filePath': filePath,
      'exitCode': exitCode,
      'stdout': stdout,
      'stderr': stderr,
      'success': exitCode == 0,
    };

    // Parse stdout as JSON if possible
    if (exitCode == 0 && stdout.trim().isNotEmpty) {
      try {
        result['data'] = jsonDecode(stdout);
      } catch (e) {
        // If not JSON, keep as string
      }
    }

    return result;
  } catch (e, stackTrace) {
    return {
      'filePath': filePath,
      'success': false,
      'error': e.toString(),
      'stackTrace': stackTrace.toString(),
    };
  }
}
```

**Purpose**: Execute a Dart file as a subprocess and return results

#### executeScript

```dart
Future<Map<String, dynamic>> _executeScript(
  Map<String, dynamic> params,
) async {
  final script = params['script'] as String?;
  final executeParams = params['params'] as Map<String, dynamic>? ?? {};

  if (script == null) {
    throw Exception('script parameter is required');
  }

  _sendLog('Executing Dart script (${script.length} chars)');

  try {
    final result = await _interpreter.eval(script);
    
    return {
      'success': true,
      'result': result,
    };
  } catch (e, stackTrace) {
    return {
      'success': false,
      'error': e.toString(),
      'stack': stackTrace.toString(),
    };
  }
}
```

**Purpose**: Execute Dart code dynamically via D4rt

---

## VS Code API Access

Wrapper classes use the `executeScript` mechanism to call VS Code APIs.

### Execute Script Pattern

```dart
Future<ReturnType> apiMethod(params) async {
  final result = await _bridge.sendRequest('executeScript', {
    'script': '''
      // JavaScript code executed in VS Code context
      const result = await context.vscode.{namespace}.{method}(...);
      return result;
    ''',
    'params': { /* parameters passed to script */ },
  });
  
  // Process result...
}
```

### Context Object

The `context` object available in scripts:

```typescript
{
  vscode: vscode,          // Full VS Code API
  bridge: VSCodeBridge,    // Bridge definition
  params: { /* ... */ }    // Parameters from Dart
}
```

### Example: File Operations

```dart
Future<String> readFile(String path) async {
  final result = await _bridge.sendRequest('executeScript', {
    'script': '''
      const uri = context.vscode.Uri.file(params.path);
      const bytes = await context.vscode.workspace.fs.readFile(uri);
      const decoder = new TextDecoder('utf-8');
      return decoder.decode(bytes);
    ''',
    'params': {'path': path},
  });

  if (result['success'] == true) {
    return result['result'] as String;
  }
  throw Exception('Failed to read file');
}
```

---

## Error Handling

### Exception Handling in Handlers

```dart
Future<void> _handleRequest(
  String method,
  Map<String, dynamic> params,
  int? id,
) async {
  try {
    dynamic result;

    switch (method) {
      case 'echo':
        result = {'message': params['message']};
        break;
        
      // ... other cases
        
      default:
        throw Exception('Unknown method: $method');
    }

    if (id != null) {
      _sendResponse(id, result);
    }
  } catch (e, stackTrace) {
    if (id != null) {
      _sendErrorResponse(id, e.toString(), stackTrace);
    }
  }
}
```

**Pattern**:
- Try/catch around all handler logic
- Send error response with stack trace
- Log errors to VS Code output channel

### Error Response Format

```dart
void _sendErrorResponse(int id, String error, StackTrace? stackTrace) {
  final message = {
    'jsonrpc': '2.0',
    'id': id,
    'error': {
      'message': error,
      'data': stackTrace?.toString(),
    },
  };

  _outputController.add(jsonEncode(message));
}
```

### Logging

```dart
void _sendLog(String message) {
  sendNotification('log', {'message': message, 'level': 'info'});
}

void _sendError(String message) {
  sendNotification('log', {'message': message, 'level': 'error'});
}
```

**Notifications** don't expect responses - fire and forget.

---

## Testing

### Unit Tests

**File**: `test/tom_vscode_bridge_test.dart`

```dart
import 'package:test/test.dart';
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

void main() {
  group('VSCodeBridgeServer', () {
    test('initialization', () {
      final server = VSCodeBridgeServer();
      expect(server, isNotNull);
    });
    
    test('message ID increments', () {
      final server = VSCodeBridgeServer();
      final id1 = server._messageId;
      server.sendNotification('test', {});
      final id2 = server._messageId;
      expect(id2, greaterThan(id1));
    });
  });
  
  group('API Wrappers', () {
    test('VSCodeUri.fromJson', () {
      final json = {
        'scheme': 'file',
        'authority': '',
        'path': '/path/to/file',
        'query': '',
        'fragment': '',
        'fsPath': '/path/to/file',
      };
      
      final uri = VSCodeUri.fromJson(json);
      expect(uri.scheme, equals('file'));
      expect(uri.fsPath, equals('/path/to/file'));
    });
  });
}
```

### Integration Testing

Test files in `test/` directory demonstrate bidirectional communication:

```dart
// test_from_dart.dart
import 'package:tom_vscode_bridge/tom_vscode_bridge.dart';

Future<void> main() async {
  final server = VSCodeBridgeServer();
  final vscode = VSCode(server);
  
  server.start();
  
  // Test window API
  await vscode.window.showInformationMessage('Test from Dart!');
  
  // Test workspace API
  final folders = await vscode.workspace.getWorkspaceFolders();
  print('Workspace folders: ${folders.length}');
  
  // Test commands API
  await vscode.commands.executeCommand('workbench.action.files.save');
}
```

---

## Performance Optimization

### Batching Requests

```dart
// BAD: Sequential requests (slow)
for (final file in files) {
  final content = await vscode.workspace.readFile(file);
  process(content);
}

// GOOD: Parallel requests (fast)
final contents = await Future.wait(
  files.map((f) => vscode.workspace.readFile(f))
);
for (final content in contents) {
  process(content);
}
```

### Caching

```dart
class VSCodeWorkspace {
  List<WorkspaceFolder>? _cachedFolders;
  
  Future<List<WorkspaceFolder>> getWorkspaceFolders() async {
    // Return cached if available
    if (_cachedFolders != null) {
      return _cachedFolders!;
    }
    
    // Fetch and cache
    _cachedFolders = await _fetchWorkspaceFolders();
    return _cachedFolders!;
  }
  
  void invalidateCache() {
    _cachedFolders = null;
  }
}
```

### Stream Optimization

```dart
// Use stream transformers for efficient processing
stdin
    .transform(utf8.decoder)
    .transform(const LineSplitter())
    .where((line) => line.trim().isNotEmpty)
    .listen(_handleMessage);
```

---

## Debugging

### Log Levels

```dart
enum LogLevel { debug, info, warning, error }

void _sendLog(String message, {LogLevel level = LogLevel.info}) {
  sendNotification('log', {
    'message': message,
    'level': level.toString().split('.').last,
    'timestamp': DateTime.now().toIso8601String(),
  });
}
```

### Debug Output

Enable verbose logging in development:

```dart
const bool _debugMode = true;  // Set to false in production

void _handleMessage(String line) {
  if (_debugMode) {
    _sendLog('Received: $line', level: LogLevel.debug);
  }
  // ... process message
}
```

### VS Code Output Channel

All logs sent via notifications appear in VS Code output channel:

```typescript
// In extension.ts
private handleNotification(notification: JsonRpcNotification): void {
  if (notification.method === 'log') {
    const message = notification.params.message;
    const level = notification.params.level || 'info';
    this.outputChannel.appendLine(`[${level.toUpperCase()}] ${message}`);
  }
}
```

---

## Extension Points

### Adding New API Wrapper

1. Create new file in `lib/vscode_api/`:

```dart
// vscode_debug.dart
class VSCodeDebug {
  final VSCodeBridgeServer _bridge;
  
  VSCodeDebug(this._bridge);
  
  Future<void> startDebugging(
    String name,
    Map<String, dynamic> config,
  ) async {
    await _bridge.sendRequest('executeScript', {
      'script': '''
        const folder = context.vscode.workspace.workspaceFolders[0];
        await context.vscode.debug.startDebugging(folder, params.config);
      ''',
      'params': {'config': config},
    });
  }
}
```

2. Add to main VSCode class:

```dart
class VSCode {
  // ... existing
  late final VSCodeDebug debug;
  
  VSCode(this._bridge) {
    // ... existing
    debug = VSCodeDebug(_bridge);
  }
}
```

3. Register with D4rt:

```dart
void registerVSCodeBridges(D4rt interpreter) {
  // ... existing
  interpreter.registerType<VSCodeDebug>('VSCodeDebug',
    constructor: (args) => VSCodeDebug(args[0] as VSCodeBridgeServer));
}
```

### Adding New Request Handler

```dart
Future<void> _handleRequest(
  String method,
  Map<String, dynamic> params,
  int? id,
) async {
  try {
    dynamic result;

    switch (method) {
      // ... existing cases
      
      case 'myNewHandler':
        result = await _handleMyNewMethod(params);
        break;
      
      default:
        throw Exception('Unknown method: $method');
    }

    if (id != null) {
      _sendResponse(id, result);
    }
  } catch (e, stackTrace) {
    if (id != null) {
      _sendErrorResponse(id, e.toString(), stackTrace);
    }
  }
}

Future<Map<String, dynamic>> _handleMyNewMethod(
  Map<String, dynamic> params,
) async {
  // Implementation...
  return {'success': true};
}
```

---

## Best Practices

1. **Always use async/await** for I/O operations
2. **Handle errors gracefully** with try/catch
3. **Log important events** for debugging
4. **Validate parameters** before processing
5. **Use type-safe wrappers** instead of raw executeScript
6. **Batch operations** when possible for performance
7. **Clean up resources** in dispose methods
8. **Document public APIs** with dartdoc comments
9. **Test bidirectional communication** thoroughly
10. **Version your protocol** for compatibility

---

## See Also

- [API Reference](./API_REFERENCE.md) - Complete API documentation
- [Architecture Documentation](../tom_vscode_extension/_copilot_guidelines/architecture.md) - System architecture
- [Project Documentation](./PROJECT.md) - Project overview
- [VS Code Integration Implementation](../tom_vscode_extension/_copilot_guidelines/implementation.md) - TypeScript side implementation
