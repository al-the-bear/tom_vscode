/// Tom TODO API for scripting access to workspace todos.
///
/// Todos are the shared model of `tom_todo_model` ([TomTodo]); [TodoWire]
/// maps the extension's answers onto it. Provides CRUD operations for todos
/// at different levels:
/// - Quest todos (persistent or session-scoped)
/// - Workspace todos
/// - Session todos (window-specific)
// ignore_for_file: avoid_classes_with_only_static_members
library;

import 'package:tom_todo_model/tom_todo_model.dart';

import 'vscode_adapter.dart';

export 'package:tom_todo_model/tom_todo_model.dart'
    show
        TomTodo,
        TomTodoDecision,
        TomTodoPriority,
        TomTodoReference,
        TomTodoScope,
        TomTodoStatus;

// ============================================================================
// Types
// ============================================================================

/// Where a todo lives, as `todo.listAllVce` tags it (`_scope`).
enum TodoLevel {
  quest,
  workspace,
  session;

  static TodoLevel? fromWire(Object? value) {
    for (final level in values) {
      if (level.name == value) return level;
    }
    return null;
  }
}

/// A todo as the extension answered it: the shared [TomTodo] plus what the
/// bridge says about it and what the model has no field for.
class TodoEntry {
  /// The todo.
  final TomTodo todo;

  /// The file it was read from (`_sourceFile`): a file name, or
  /// `<quest>/<file>` / a workspace-relative path in aggregated lists.
  final String? sourceFile;

  /// The level `todo.listAllVce` tagged it with; for a session todo also
  /// recognised by its shape.
  final TodoLevel? level;

  /// Fields the todo carried that the model has none for (a hand-written
  /// key, a value that is not one the field can hold), kept so nothing the
  /// file holds is silently lost to the reader.
  final Map<String, Object?> unknownFields;

  TodoEntry({
    required this.todo,
    this.sourceFile,
    this.level,
    Map<String, Object?> unknownFields = const {},
  }) : unknownFields = Map.unmodifiable(unknownFields);
}

/// A todo in a list answer that could not be read as a [TomTodo].
class InvalidTodo {
  /// Its id, when it had one.
  final String? id;

  /// Why it could not be read.
  final String error;

  /// The todo as the extension sent it.
  final Map<String, dynamic> json;

  InvalidTodo({required this.id, required this.error, required this.json});
}

/// Maps the extension bridge's todo JSON onto the shared todo model and back.
///
/// The extension answers in two shapes. Quest and workspace todos carry their
/// YAML fields, plus `_sourceFile` and `_extra` (the keys its reader does not
/// enumerate — some of them schema fields such as `due` or `blocked_until`).
/// Session todos are `{id, title, details, priority, tags, status:
/// pending|done, createdAt, updatedAt, source}`. [TomTodo.fromMap] accepts the
/// schema's fields only, so this is where the two meet.
abstract final class TodoWire {
  static final RegExp _date = RegExp(r'^(\d{4}-\d{2}-\d{2})(T.*)?$');

  static const Set<String> _dateFields = {
    'due',
    'created',
    'updated',
    'completed_date',
    'archived',
    'deleted',
  };

  static const Set<String> _sessionKeys = {'details', 'createdAt', 'updatedAt'};

  /// Reads one todo. Throws [FormatException] when the model cannot hold it
  /// (an unknown status or priority, a malformed reference or condition).
  static TodoEntry fromBridge(Map<String, dynamic> json) {
    final level = TodoLevel.fromWire(json['_scope']);
    final status = json['status'];
    final isSession =
        level == TodoLevel.session ||
        json.keys.any(_sessionKeys.contains) ||
        status == 'pending' ||
        status == 'done';

    final fields = <String, Object?>{};
    final unknown = <String, Object?>{};
    void take(String key, Object? value) {
      if (value == null) return;
      if (!TomTodo.fields.contains(key)) {
        unknown[key] = value;
      } else if (_dateFields.contains(key)) {
        final match = value is String ? _date.firstMatch(value) : null;
        if (match == null) {
          unknown[key] = value;
        } else {
          fields[key] = match.group(1);
        }
      } else {
        fields[key] = value;
      }
    }

    for (final MapEntry(:key, :value) in json.entries) {
      switch (key) {
        case '_sourceFile' || '_scope' || '_extra':
          break;
        case 'details' when isSession:
          take('description', value);
        case 'createdAt' when isSession:
          take('created', value);
        case 'updatedAt' when isSession:
          take('updated', value);
        case 'status' when isSession:
          take('status', value == 'done' ? 'completed' : 'not-started');
        default:
          take(key, value);
      }
    }
    final extra = json['_extra'];
    if (extra is Map) {
      for (final MapEntry(:key, :value) in extra.entries) {
        take('$key', value);
      }
    }
    // The schema makes `title` optional, the model does not.
    fields['title'] ??= fields['id'];

    return TodoEntry(
      todo: TomTodo.fromMap(fields),
      sourceFile: json['_sourceFile'] as String?,
      level: level ?? (isSession ? TodoLevel.session : null),
      unknownFields: unknown,
    );
  }

  /// A quest or workspace todo as the extension writes it: its schema map.
  static Map<String, Object?> toBridge(TomTodo todo) => todo.toMap();

  /// A session todo as the extension writes it: the description becomes its
  /// details, a completed todo is `done` and any other `pending`.
  static Map<String, Object?> toSessionBridge(TomTodo todo) => {
    'id': todo.id,
    'title': todo.title,
    if (todo.description != null) 'details': todo.description,
    'status': todo.status == TomTodoStatus.completed ? 'done' : 'pending',
    if (todo.priority != null) 'priority': todo.priority!.wire,
    'tags': List.of(todo.tags),
  };

  /// One todo answer, or null when the extension found none (it answers
  /// `null`, which reaches the adapter as an empty map).
  static TodoEntry? fromBridgeOrNull(Map<String, dynamic> json) =>
      json['id'] == null ? null : fromBridge(json);
}

/// Result of listing todos.
class TodoListResult {
  /// Every todo that could be read, in the order the extension sent them.
  final List<TodoEntry> entries;

  /// The todos it could not read, with the reason.
  final List<InvalidTodo> invalid;

  final String? questId;
  final String? file;

  TodoListResult({
    required this.entries,
    this.invalid = const [],
    this.questId,
    this.file,
  });

  /// The todos themselves.
  List<TomTodo> get todos => [for (final e in entries) e.todo];

  factory TodoListResult.fromJson(Map<String, dynamic> json) {
    final entries = <TodoEntry>[];
    final invalid = <InvalidTodo>[];
    for (final raw in (json['todos'] as List?) ?? const []) {
      final item = Map<String, dynamic>.from(raw as Map);
      try {
        entries.add(TodoWire.fromBridge(item));
      } on FormatException catch (e) {
        // One hand-edited todo the model cannot hold must not hide the rest
        // of the file; it is reported, not dropped.
        invalid.add(
          InvalidTodo(id: item['id'] as String?, error: e.message, json: item),
        );
      }
    }
    return TodoListResult(
      entries: entries,
      invalid: invalid,
      questId: json['questId'] as String?,
      file: json['file'] as String?,
    );
  }
}

/// Result of listing todo files.
class TodoFileListResult {
  final List<String> files;
  final String? questId;

  TodoFileListResult({required this.files, this.questId});

  factory TodoFileListResult.fromJson(Map<String, dynamic> json) {
    return TodoFileListResult(
      files: (json['files'] as List?)?.map((e) => e as String).toList() ?? [],
      questId: json['questId'] as String?,
    );
  }
}

// ============================================================================
// API Class
// ============================================================================

/// API for managing TODO items across quest, workspace, and session scopes.
///
/// All methods throw [Exception] on bridge communication errors.
abstract class TomTodoApi {
  static VSCodeAdapter? _adapter;

  /// Set the adapter for API calls.
  static void setAdapter(VSCodeAdapter adapter) {
    _adapter = adapter;
  }

  static VSCodeAdapter get _requireAdapter {
    if (_adapter == null) {
      throw StateError('TomTodoApi: adapter not set. Call setAdapter() first.');
    }
    return _adapter!;
  }

  // --------------------------------------------------------------------------
  // Quest TODO Operations
  // --------------------------------------------------------------------------

  /// List all todo files for a quest.
  static Future<TodoFileListResult> listQuestTodoFiles(String questId) async {
    final result = await _requireAdapter.sendRequest('todo.listFilesVce', {
      'questId': questId,
    });
    return TodoFileListResult.fromJson(result);
  }

  /// List todos from a specific quest (optionally from a specific file).
  static Future<TodoListResult> listQuestTodos(
    String questId, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.listQuestVce', {
      'questId': questId,
      'file': ?file,
    });
    return TodoListResult.fromJson(result);
  }

  /// Get a specific todo item by ID from a quest.
  static Future<TodoEntry?> getQuestTodo(
    String questId,
    String todoId, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.getQuestVce', {
      'questId': questId,
      'todoId': todoId,
      'file': ?file,
    });
    return TodoWire.fromBridgeOrNull(result);
  }

  /// Create a new todo in a quest file.
  static Future<TodoEntry> createQuestTodo(
    String questId,
    TomTodo todo, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.createQuestVce', {
      'questId': questId,
      'todo': TodoWire.toBridge(todo),
      'file': ?file,
    });
    return TodoWire.fromBridge(result);
  }

  /// Update an existing todo in a quest.
  static Future<TodoEntry> updateQuestTodo(
    String questId,
    TomTodo todo, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.updateQuestVce', {
      'questId': questId,
      'todo': TodoWire.toBridge(todo),
      'file': ?file,
    });
    return TodoWire.fromBridge(result);
  }

  /// Delete a todo from a quest.
  static Future<bool> deleteQuestTodo(
    String questId,
    String todoId, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.deleteQuestVce', {
      'questId': questId,
      'todoId': todoId,
      'file': ?file,
    });
    return (result)['success'] as bool? ?? false;
  }

  // --------------------------------------------------------------------------
  // Workspace TODO Operations
  // --------------------------------------------------------------------------

  /// List all workspace-level todo files.
  static Future<TodoFileListResult> listWorkspaceTodoFiles() async {
    final result = await _requireAdapter.sendRequest(
      'todo.listWorkspaceFilesVce',
      {},
    );
    return TodoFileListResult.fromJson(result);
  }

  /// List todos from workspace-level files.
  static Future<TodoListResult> listWorkspaceTodos({String? file}) async {
    final result = await _requireAdapter.sendRequest('todo.listWorkspaceVce', {
      'file': ?file,
    });
    return TodoListResult.fromJson(result);
  }

  /// Get a specific todo item by ID from workspace-level.
  static Future<TodoEntry?> getWorkspaceTodo(
    String todoId, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.getWorkspaceVce', {
      'todoId': todoId,
      'file': ?file,
    });
    return TodoWire.fromBridgeOrNull(result);
  }

  /// Create a new todo in workspace-level file.
  static Future<TodoEntry> createWorkspaceTodo(
    TomTodo todo, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest(
      'todo.createWorkspaceVce',
      {'todo': TodoWire.toBridge(todo), 'file': ?file},
    );
    return TodoWire.fromBridge(result);
  }

  /// Update an existing todo in workspace-level.
  static Future<TodoEntry> updateWorkspaceTodo(
    TomTodo todo, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest(
      'todo.updateWorkspaceVce',
      {'todo': TodoWire.toBridge(todo), 'file': ?file},
    );
    return TodoWire.fromBridge(result);
  }

  /// Delete a todo from workspace-level.
  static Future<bool> deleteWorkspaceTodo(String todoId, {String? file}) async {
    final result = await _requireAdapter.sendRequest(
      'todo.deleteWorkspaceVce',
      {'todoId': todoId, 'file': ?file},
    );
    return (result)['success'] as bool? ?? false;
  }

  // --------------------------------------------------------------------------
  // Session TODO Operations (window-scoped, in-memory)
  // --------------------------------------------------------------------------

  /// List all session (window) todos.
  static Future<TodoListResult> listSessionTodos() async {
    final result = await _requireAdapter.sendRequest('todo.listSessionVce', {});
    return TodoListResult.fromJson(result);
  }

  /// Get a specific session todo by ID.
  static Future<TodoEntry?> getSessionTodo(String todoId) async {
    final result = await _requireAdapter.sendRequest('todo.getSessionVce', {
      'todoId': todoId,
    });
    return TodoWire.fromBridgeOrNull(result);
  }

  /// Create a new session todo.
  static Future<TodoEntry> createSessionTodo(TomTodo todo) async {
    final result = await _requireAdapter.sendRequest('todo.createSessionVce', {
      'todo': TodoWire.toSessionBridge(todo),
    });
    return TodoWire.fromBridge(result);
  }

  /// Update an existing session todo.
  static Future<TodoEntry> updateSessionTodo(TomTodo todo) async {
    final result = await _requireAdapter.sendRequest('todo.updateSessionVce', {
      'todo': TodoWire.toSessionBridge(todo),
    });
    return TodoWire.fromBridge(result);
  }

  /// Delete a session todo.
  static Future<bool> deleteSessionTodo(String todoId) async {
    final result = await _requireAdapter.sendRequest('todo.deleteSessionVce', {
      'todoId': todoId,
    });
    return (result)['success'] as bool? ?? false;
  }

  // --------------------------------------------------------------------------
  // All Todos Query
  // --------------------------------------------------------------------------

  /// List all todos from specified scope(s).
  /// Combines quest, workspace, and/or session todos.
  static Future<TodoListResult> listAllTodos({
    bool includeQuest = true,
    bool includeWorkspace = true,
    bool includeSession = true,
    String? questId,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.listAllVce', {
      'includeQuest': includeQuest,
      'includeWorkspace': includeWorkspace,
      'includeSession': includeSession,
      'questId': ?questId,
    });
    return TodoListResult.fromJson(result);
  }
}
