/// Tom Workspace API for scripting access to workspace structure.
///
/// Provides operations for:
/// - Listing projects in the workspace
/// - Listing quests
/// - Getting current active quest
/// - Workspace metadata and configuration
// ignore_for_file: avoid_classes_with_only_static_members
library;

import 'vscode_adapter.dart';

// ============================================================================
// Types
// ============================================================================

/// Type of project detected in the workspace.
enum ProjectType {
  dart('dart'),
  flutter('flutter'),
  node('node'),
  python('python'),
  other('other');

  final String value;
  const ProjectType(this.value);

  static ProjectType fromString(String value) {
    return ProjectType.values.firstWhere(
      (t) => t.value == value,
      orElse: () => ProjectType.other,
    );
  }
}

/// Information about a project in the workspace.
class ProjectInfo {
  final String id;
  final String name;
  final String path;
  final String relativePath;
  final ProjectType type;
  final String? description;
  final String? version;
  final List<String>? tags;
  final String? repository;
  final bool isSubWorkspace;

  ProjectInfo({
    required this.id,
    required this.name,
    required this.path,
    required this.relativePath,
    required this.type,
    this.description,
    this.version,
    this.tags,
    this.repository,
    this.isSubWorkspace = false,
  });

  factory ProjectInfo.fromJson(Map<String, dynamic> json) {
    return ProjectInfo(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      path: json['path'] as String? ?? '',
      relativePath: json['relativePath'] as String? ?? '',
      type: ProjectType.fromString(json['type'] as String? ?? 'other'),
      description: json['description'] as String?,
      version: json['version'] as String?,
      tags: (json['tags'] as List?)?.map((e) => e as String).toList(),
      repository: json['repository'] as String?,
      isSubWorkspace: json['isSubWorkspace'] as bool? ?? false,
    );
  }
}

/// Result of listing projects.
class ProjectListResult {
  final List<ProjectInfo> projects;
  final int totalCount;

  ProjectListResult({required this.projects, required this.totalCount});

  factory ProjectListResult.fromJson(Map<String, dynamic> json) {
    return ProjectListResult(
      projects:
          (json['projects'] as List?)
              ?.map((e) => ProjectInfo.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      totalCount: json['totalCount'] as int? ?? 0,
    );
  }
}

/// Information about a quest.
class QuestInfo {
  final String id;
  final String name;
  final String path;
  final String? description;
  final String? status;
  final bool hasOverview;
  final bool hasTodos;
  final int? todoCount;
  final int? completedTodoCount;

  QuestInfo({
    required this.id,
    required this.name,
    required this.path,
    this.description,
    this.status,
    this.hasOverview = false,
    this.hasTodos = false,
    this.todoCount,
    this.completedTodoCount,
  });

  factory QuestInfo.fromJson(Map<String, dynamic> json) {
    return QuestInfo(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      path: json['path'] as String? ?? '',
      description: json['description'] as String?,
      status: json['status'] as String?,
      hasOverview: json['hasOverview'] as bool? ?? false,
      hasTodos: json['hasTodos'] as bool? ?? false,
      todoCount: json['todoCount'] as int?,
      completedTodoCount: json['completedTodoCount'] as int?,
    );
  }
}

/// Result of listing quests.
class QuestListResult {
  final List<QuestInfo> quests;
  final int totalCount;
  final String? activeQuestId;

  QuestListResult({
    required this.quests,
    required this.totalCount,
    this.activeQuestId,
  });

  factory QuestListResult.fromJson(Map<String, dynamic> json) {
    return QuestListResult(
      quests:
          (json['quests'] as List?)
              ?.map((e) => QuestInfo.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      totalCount: json['totalCount'] as int? ?? 0,
      activeQuestId: json['activeQuestId'] as String?,
    );
  }
}

/// Workspace metadata.
class WorkspaceInfo {
  final String name;
  final String rootPath;
  final String? workspaceFile;
  final int projectCount;
  final int questCount;
  final String? activeQuestId;
  final String? windowId;
  final Map<String, dynamic>? metadata;

  WorkspaceInfo({
    required this.name,
    required this.rootPath,
    this.workspaceFile,
    required this.projectCount,
    required this.questCount,
    this.activeQuestId,
    this.windowId,
    this.metadata,
  });

  factory WorkspaceInfo.fromJson(Map<String, dynamic> json) {
    return WorkspaceInfo(
      name: json['name'] as String? ?? '',
      rootPath: json['rootPath'] as String? ?? '',
      workspaceFile: json['workspaceFile'] as String?,
      projectCount: json['projectCount'] as int? ?? 0,
      questCount: json['questCount'] as int? ?? 0,
      activeQuestId: json['activeQuestId'] as String?,
      windowId: json['windowId'] as String?,
      metadata: json['metadata'] as Map<String, dynamic>?,
    );
  }
}

/// Chat variable value.
class ChatVariable {
  final String name;
  final String? value;
  final String? source;

  ChatVariable({required this.name, this.value, this.source});

  factory ChatVariable.fromJson(Map<String, dynamic> json) {
    return ChatVariable(
      name: json['name'] as String? ?? '',
      value: json['value'] as String?,
      source: json['source'] as String?,
    );
  }
}

/// Result of listing chat variables.
class ChatVariableListResult {
  final List<ChatVariable> variables;
  final String? activeQuestId;

  ChatVariableListResult({required this.variables, this.activeQuestId});

  factory ChatVariableListResult.fromJson(Map<String, dynamic> json) {
    return ChatVariableListResult(
      variables:
          (json['variables'] as List?)
              ?.map((e) => ChatVariable.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      activeQuestId: json['activeQuestId'] as String?,
    );
  }
}

// ============================================================================
// API Class
// ============================================================================

/// API for accessing workspace structure and configuration.
///
/// All methods throw [Exception] on bridge communication errors.
abstract class TomWorkspaceApi {
  static VSCodeAdapter? _adapter;

  /// Set the adapter for API calls.
  static void setAdapter(VSCodeAdapter adapter) {
    _adapter = adapter;
  }

  static VSCodeAdapter get _requireAdapter {
    if (_adapter == null) {
      throw StateError(
        'TomWorkspaceApi: adapter not set. Call setAdapter() first.',
      );
    }
    return _adapter!;
  }

  // --------------------------------------------------------------------------
  // Workspace Info
  // --------------------------------------------------------------------------

  /// Get workspace information.
  static Future<WorkspaceInfo> getInfo() async {
    final result = await _requireAdapter.sendRequest(
      'workspace.getInfoVce',
      {},
    );
    return WorkspaceInfo.fromJson(result as Map<String, dynamic>);
  }

  /// Get the workspace root path.
  static Future<String> getRootPath() async {
    final result = await _requireAdapter.sendRequest(
      'workspace.getRootPathVce',
      {},
    );
    return (result as Map<String, dynamic>)['rootPath'] as String? ?? '';
  }

  /// Get the window ID.
  static Future<String?> getWindowId() async {
    final result = await _requireAdapter.sendRequest(
      'workspace.getWindowIdVce',
      {},
    );
    return (result as Map<String, dynamic>)['windowId'] as String?;
  }

  // --------------------------------------------------------------------------
  // Project Operations
  // --------------------------------------------------------------------------

  /// List all projects in the workspace.
  static Future<ProjectListResult> listProjects({
    ProjectType? type,
    bool includeSubWorkspaces = true,
  }) async {
    final result = await _requireAdapter
        .sendRequest('workspace.listProjectsVce', {
          if (type != null) 'type': type.value,
          'includeSubWorkspaces': includeSubWorkspaces,
        });
    return ProjectListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Get information about a specific project.
  static Future<ProjectInfo?> getProject(String projectId) async {
    final result = await _requireAdapter.sendRequest(
      'workspace.getProjectVce',
      {'projectId': projectId},
    );
    if (result == null) return null;
    return ProjectInfo.fromJson(result as Map<String, dynamic>);
  }

  /// Find projects by path pattern.
  static Future<ProjectListResult> findProjects(String pattern) async {
    final result = await _requireAdapter.sendRequest(
      'workspace.findProjectsVce',
      {'pattern': pattern},
    );
    return ProjectListResult.fromJson(result as Map<String, dynamic>);
  }

  // --------------------------------------------------------------------------
  // Quest Operations
  // --------------------------------------------------------------------------

  /// List all quests in the workspace.
  static Future<QuestListResult> listQuests({
    bool includeTodoCounts = false,
  }) async {
    final result = await _requireAdapter.sendRequest(
      'workspace.listQuestsVce',
      {'includeTodoCounts': includeTodoCounts},
    );
    return QuestListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Get information about a specific quest.
  static Future<QuestInfo?> getQuest(String questId) async {
    final result = await _requireAdapter.sendRequest('workspace.getQuestVce', {
      'questId': questId,
    });
    if (result == null) return null;
    return QuestInfo.fromJson(result as Map<String, dynamic>);
  }

  /// Get the currently active quest.
  static Future<QuestInfo?> getActiveQuest() async {
    final result = await _requireAdapter.sendRequest(
      'workspace.getActiveQuestVce',
      {},
    );
    if (result == null) return null;
    return QuestInfo.fromJson(result as Map<String, dynamic>);
  }

  /// Set the active quest.
  static Future<bool> setActiveQuest(String questId) async {
    final result = await _requireAdapter.sendRequest(
      'workspace.setActiveQuestVce',
      {'questId': questId},
    );
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  // --------------------------------------------------------------------------
  // Chat Variables
  // --------------------------------------------------------------------------

  /// List all chat variables.
  static Future<ChatVariableListResult> listChatVariables() async {
    final result = await _requireAdapter.sendRequest(
      'workspace.listChatVariablesVce',
      {},
    );
    return ChatVariableListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Get a specific chat variable.
  static Future<ChatVariable?> getChatVariable(String name) async {
    final result = await _requireAdapter.sendRequest(
      'workspace.getChatVariableVce',
      {'name': name},
    );
    if (result == null) return null;
    return ChatVariable.fromJson(result as Map<String, dynamic>);
  }

  /// Set a chat variable value.
  static Future<bool> setChatVariable(String name, String value) async {
    final result = await _requireAdapter.sendRequest(
      'workspace.setChatVariableVce',
      {'name': name, 'value': value},
    );
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  /// Get workspace configuration section.
  static Future<Map<String, dynamic>> getConfig(String section) async {
    final result = await _requireAdapter.sendRequest('workspace.getConfigVce', {
      'section': section,
    });
    return (result as Map<String, dynamic>)['config']
            as Map<String, dynamic>? ??
        {};
  }

  /// Update workspace configuration.
  static Future<bool> updateConfig(
    String section,
    Map<String, dynamic> values,
  ) async {
    final result = await _requireAdapter.sendRequest(
      'workspace.updateConfigVce',
      {'section': section, 'values': values},
    );
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }
}
