/// Tom TODO API for scripting access to workspace todos.
///
/// Provides CRUD operations for todos at different levels:
/// - Quest todos (persistent or session-scoped)
/// - Workspace todos
/// - Session todos (window-specific)
// ignore_for_file: avoid_classes_with_only_static_members
library;

import 'vscode_adapter.dart';

// ============================================================================
// Types
// ============================================================================

/// Reference within a todo item.
class TodoReference {
  final String? type;
  final String? path;
  final String? url;
  final String? description;
  final String? lines;

  TodoReference({this.type, this.path, this.url, this.description, this.lines});

  factory TodoReference.fromJson(Map<String, dynamic> json) {
    return TodoReference(
      type: json['type'] as String?,
      path: json['path'] as String?,
      url: json['url'] as String?,
      description: json['description'] as String?,
      lines: json['lines'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    if (type != null) 'type': type,
    if (path != null) 'path': path,
    if (url != null) 'url': url,
    if (description != null) 'description': description,
    if (lines != null) 'lines': lines,
  };
}

/// Scope within a todo item.
class TodoScope {
  final String? project;
  final List<String>? projects;
  final String? module;
  final String? area;
  final List<String>? files;

  TodoScope({this.project, this.projects, this.module, this.area, this.files});

  factory TodoScope.fromJson(Map<String, dynamic> json) {
    return TodoScope(
      project: json['project'] as String?,
      projects: (json['projects'] as List?)?.map((e) => e as String).toList(),
      module: json['module'] as String?,
      area: json['area'] as String?,
      files: (json['files'] as List?)?.map((e) => e as String).toList(),
    );
  }

  Map<String, dynamic> toJson() => {
    if (project != null) 'project': project,
    if (projects != null) 'projects': projects,
    if (module != null) 'module': module,
    if (area != null) 'area': area,
    if (files != null) 'files': files,
  };
}

/// Status of a todo item.
enum TodoStatus {
  notStarted('not-started'),
  inProgress('in-progress'),
  blocked('blocked'),
  completed('completed'),
  cancelled('cancelled');

  final String value;
  const TodoStatus(this.value);

  static TodoStatus fromString(String value) {
    return TodoStatus.values.firstWhere(
      (s) => s.value == value,
      orElse: () => TodoStatus.notStarted,
    );
  }
}

/// Priority of a todo item.
enum TodoPriority {
  low('low'),
  medium('medium'),
  high('high'),
  critical('critical');

  final String value;
  const TodoPriority(this.value);

  static TodoPriority? fromString(String? value) {
    if (value == null) return null;
    return TodoPriority.values.firstWhere(
      (p) => p.value == value,
      orElse: () => TodoPriority.medium,
    );
  }
}

/// A single TODO item.
class TodoItem {
  final String id;
  final String? title;
  final String description;
  final TodoStatus status;
  final TodoPriority? priority;
  final List<String>? tags;
  final TodoScope? scope;
  final List<TodoReference>? references;
  final List<String>? dependencies;
  final List<String>? blockedBy;
  final String? notes;
  final String? created;
  final String? updated;
  final String? completedDate;
  final String? completedBy;
  final String? sourceFile;

  TodoItem({
    required this.id,
    this.title,
    required this.description,
    required this.status,
    this.priority,
    this.tags,
    this.scope,
    this.references,
    this.dependencies,
    this.blockedBy,
    this.notes,
    this.created,
    this.updated,
    this.completedDate,
    this.completedBy,
    this.sourceFile,
  });

  factory TodoItem.fromJson(Map<String, dynamic> json) {
    return TodoItem(
      id: json['id'] as String,
      title: json['title'] as String?,
      description: json['description'] as String? ?? '',
      status: TodoStatus.fromString(json['status'] as String? ?? 'not-started'),
      priority: TodoPriority.fromString(json['priority'] as String?),
      tags: (json['tags'] as List?)?.map((e) => e as String).toList(),
      scope: json['scope'] != null
          ? TodoScope.fromJson(json['scope'] as Map<String, dynamic>)
          : null,
      references: (json['references'] as List?)
          ?.map((e) => TodoReference.fromJson(e as Map<String, dynamic>))
          .toList(),
      dependencies: (json['dependencies'] as List?)
          ?.map((e) => e as String)
          .toList(),
      blockedBy: (json['blocked_by'] as List?)
          ?.map((e) => e as String)
          .toList(),
      notes: json['notes'] as String?,
      created: json['created'] as String?,
      updated: json['updated'] as String?,
      completedDate: json['completed_date'] as String?,
      completedBy: json['completed_by'] as String?,
      sourceFile: json['_sourceFile'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    if (title != null) 'title': title,
    'description': description,
    'status': status.value,
    if (priority != null) 'priority': priority!.value,
    if (tags != null) 'tags': tags,
    if (scope != null) 'scope': scope!.toJson(),
    if (references != null)
      'references': references!.map((r) => r.toJson()).toList(),
    if (dependencies != null) 'dependencies': dependencies,
    if (blockedBy != null) 'blocked_by': blockedBy,
    if (notes != null) 'notes': notes,
    if (created != null) 'created': created,
    if (updated != null) 'updated': updated,
    if (completedDate != null) 'completed_date': completedDate,
    if (completedBy != null) 'completed_by': completedBy,
  };

  TodoItem copyWith({
    String? id,
    String? title,
    String? description,
    TodoStatus? status,
    TodoPriority? priority,
    List<String>? tags,
    TodoScope? scope,
    List<TodoReference>? references,
    List<String>? dependencies,
    List<String>? blockedBy,
    String? notes,
    String? created,
    String? updated,
    String? completedDate,
    String? completedBy,
    String? sourceFile,
  }) {
    return TodoItem(
      id: id ?? this.id,
      title: title ?? this.title,
      description: description ?? this.description,
      status: status ?? this.status,
      priority: priority ?? this.priority,
      tags: tags ?? this.tags,
      scope: scope ?? this.scope,
      references: references ?? this.references,
      dependencies: dependencies ?? this.dependencies,
      blockedBy: blockedBy ?? this.blockedBy,
      notes: notes ?? this.notes,
      created: created ?? this.created,
      updated: updated ?? this.updated,
      completedDate: completedDate ?? this.completedDate,
      completedBy: completedBy ?? this.completedBy,
      sourceFile: sourceFile ?? this.sourceFile,
    );
  }
}

/// Result of listing todos.
class TodoListResult {
  final List<TodoItem> todos;
  final String? questId;
  final String? file;

  TodoListResult({required this.todos, this.questId, this.file});

  factory TodoListResult.fromJson(Map<String, dynamic> json) {
    return TodoListResult(
      todos:
          (json['todos'] as List?)
              ?.map((e) => TodoItem.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
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
    return TodoFileListResult.fromJson(result as Map<String, dynamic>);
  }

  /// List todos from a specific quest (optionally from a specific file).
  static Future<TodoListResult> listQuestTodos(
    String questId, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.listQuestVce', {
      'questId': questId,
      if (file != null) 'file': file,
    });
    return TodoListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Get a specific todo item by ID from a quest.
  static Future<TodoItem?> getQuestTodo(
    String questId,
    String todoId, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.getQuestVce', {
      'questId': questId,
      'todoId': todoId,
      if (file != null) 'file': file,
    });
    if (result == null) return null;
    return TodoItem.fromJson(result as Map<String, dynamic>);
  }

  /// Create a new todo in a quest file.
  static Future<TodoItem> createQuestTodo(
    String questId,
    TodoItem todo, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.createQuestVce', {
      'questId': questId,
      'todo': todo.toJson(),
      if (file != null) 'file': file,
    });
    return TodoItem.fromJson(result as Map<String, dynamic>);
  }

  /// Update an existing todo in a quest.
  static Future<TodoItem> updateQuestTodo(
    String questId,
    TodoItem todo, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.updateQuestVce', {
      'questId': questId,
      'todo': todo.toJson(),
      if (file != null) 'file': file,
    });
    return TodoItem.fromJson(result as Map<String, dynamic>);
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
      if (file != null) 'file': file,
    });
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
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
    return TodoFileListResult.fromJson(result as Map<String, dynamic>);
  }

  /// List todos from workspace-level files.
  static Future<TodoListResult> listWorkspaceTodos({String? file}) async {
    final result = await _requireAdapter.sendRequest('todo.listWorkspaceVce', {
      if (file != null) 'file': file,
    });
    return TodoListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Get a specific todo item by ID from workspace-level.
  static Future<TodoItem?> getWorkspaceTodo(
    String todoId, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest('todo.getWorkspaceVce', {
      'todoId': todoId,
      if (file != null) 'file': file,
    });
    if (result == null) return null;
    return TodoItem.fromJson(result as Map<String, dynamic>);
  }

  /// Create a new todo in workspace-level file.
  static Future<TodoItem> createWorkspaceTodo(
    TodoItem todo, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest(
      'todo.createWorkspaceVce',
      {'todo': todo.toJson(), if (file != null) 'file': file},
    );
    return TodoItem.fromJson(result as Map<String, dynamic>);
  }

  /// Update an existing todo in workspace-level.
  static Future<TodoItem> updateWorkspaceTodo(
    TodoItem todo, {
    String? file,
  }) async {
    final result = await _requireAdapter.sendRequest(
      'todo.updateWorkspaceVce',
      {'todo': todo.toJson(), if (file != null) 'file': file},
    );
    return TodoItem.fromJson(result as Map<String, dynamic>);
  }

  /// Delete a todo from workspace-level.
  static Future<bool> deleteWorkspaceTodo(String todoId, {String? file}) async {
    final result = await _requireAdapter.sendRequest(
      'todo.deleteWorkspaceVce',
      {'todoId': todoId, if (file != null) 'file': file},
    );
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  // --------------------------------------------------------------------------
  // Session TODO Operations (window-scoped, in-memory)
  // --------------------------------------------------------------------------

  /// List all session (window) todos.
  static Future<TodoListResult> listSessionTodos() async {
    final result = await _requireAdapter.sendRequest('todo.listSessionVce', {});
    return TodoListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Get a specific session todo by ID.
  static Future<TodoItem?> getSessionTodo(String todoId) async {
    final result = await _requireAdapter.sendRequest('todo.getSessionVce', {
      'todoId': todoId,
    });
    if (result == null) return null;
    return TodoItem.fromJson(result as Map<String, dynamic>);
  }

  /// Create a new session todo.
  static Future<TodoItem> createSessionTodo(TodoItem todo) async {
    final result = await _requireAdapter.sendRequest('todo.createSessionVce', {
      'todo': todo.toJson(),
    });
    return TodoItem.fromJson(result as Map<String, dynamic>);
  }

  /// Update an existing session todo.
  static Future<TodoItem> updateSessionTodo(TodoItem todo) async {
    final result = await _requireAdapter.sendRequest('todo.updateSessionVce', {
      'todo': todo.toJson(),
    });
    return TodoItem.fromJson(result as Map<String, dynamic>);
  }

  /// Delete a session todo.
  static Future<bool> deleteSessionTodo(String todoId) async {
    final result = await _requireAdapter.sendRequest('todo.deleteSessionVce', {
      'todoId': todoId,
    });
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
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
      if (questId != null) 'questId': questId,
    });
    return TodoListResult.fromJson(result as Map<String, dynamic>);
  }
}
