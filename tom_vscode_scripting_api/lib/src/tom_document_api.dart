/// Tom Document API for scripting access to workspace documents.
///
/// Provides operations for accessing and manipulating:
/// - Saved prompts: the active quest's `_ai/quests/{questId}/prompt/` folder
///   (the prompt operations throw in a window without a quest)
/// - The trail: the prompt/answer turns of a quest's host trail
///   (`_ai/quests/{questId}/history/trail.{host}.md`)
/// - Guidelines: the root's and the workspace folder's guidelines folder
///   (`_agent_guidelines/`, or the older `_copilot_guidelines/`)
/// - Quest documents (_ai/quests/{questId}/)
// ignore_for_file: avoid_classes_with_only_static_members
library;

import 'vscode_adapter.dart';

// ============================================================================
// Types
// ============================================================================

/// Type of document folder.
enum DocumentFolder {
  prompt('prompt'),
  trail('trail'),
  guidelines('guidelines'),
  quest('quest');

  final String value;
  const DocumentFolder(this.value);

  static DocumentFolder fromString(String value) {
    return DocumentFolder.values.firstWhere(
      (f) => f.value == value,
      orElse: () => DocumentFolder.quest,
    );
  }
}

/// Metadata about a document file.
class DocumentInfo {
  final String name;
  final String path;
  final String relativePath;
  final bool isDirectory;
  final int? size;
  final String? modified;
  final String? created;

  DocumentInfo({
    required this.name,
    required this.path,
    required this.relativePath,
    required this.isDirectory,
    this.size,
    this.modified,
    this.created,
  });

  factory DocumentInfo.fromJson(Map<String, dynamic> json) {
    return DocumentInfo(
      name: json['name'] as String? ?? '',
      path: json['path'] as String? ?? '',
      relativePath: json['relativePath'] as String? ?? '',
      isDirectory: json['isDirectory'] as bool? ?? false,
      size: json['size'] as int?,
      modified: json['modified'] as String?,
      created: json['created'] as String?,
    );
  }
}

/// Result of listing documents.
class DocumentListResult {
  final List<DocumentInfo> documents;
  final String folder;
  final String? subfolder;

  DocumentListResult({
    required this.documents,
    required this.folder,
    this.subfolder,
  });

  factory DocumentListResult.fromJson(Map<String, dynamic> json) {
    return DocumentListResult(
      documents:
          (json['documents'] as List?)
              ?.map((e) => DocumentInfo.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      folder: json['folder'] as String? ?? '',
      subfolder: json['subfolder'] as String?,
    );
  }
}

/// Content of a document.
class DocumentContent {
  final String path;
  final String content;
  final String? encoding;
  final int size;
  final String? modified;

  DocumentContent({
    required this.path,
    required this.content,
    this.encoding,
    required this.size,
    this.modified,
  });

  factory DocumentContent.fromJson(Map<String, dynamic> json) {
    return DocumentContent(
      path: json['path'] as String? ?? '',
      content: json['content'] as String? ?? '',
      encoding: json['encoding'] as String?,
      size: json['size'] as int? ?? 0,
      modified: json['modified'] as String?,
    );
  }
}

/// One prompt/answer turn of a quest's host trail
/// (`_ai/quests/{questId}/history/trail.{host}.md`): the prompt as the user or
/// the queue sent it and the turn's final answer.
class TrailEntry {
  /// The request id the prompt was sent with (unique per turn).
  final String id;

  /// The quest whose trail holds the turn.
  final String questId;

  /// The host trail file the turn is in.
  final String file;

  /// ISO time the prompt was sent.
  final String time;

  /// The machine (host slug) that sent it.
  final String host;

  /// The session it ran in, e.g. `default@default`.
  final String session;

  /// The Anthropic profile it ran with.
  final String profile;

  /// The model that answered.
  final String model;

  /// The prompt as sent.
  final String prompt;

  /// The turn's final answer.
  final String answer;

  TrailEntry({
    required this.id,
    required this.questId,
    required this.file,
    required this.time,
    required this.host,
    required this.session,
    required this.profile,
    required this.model,
    required this.prompt,
    required this.answer,
  });

  factory TrailEntry.fromJson(Map<String, dynamic> json) {
    String text(String key) => json[key] as String? ?? '';
    return TrailEntry(
      id: text('id'),
      questId: text('questId'),
      file: text('file'),
      time: text('time'),
      host: text('host'),
      session: text('session'),
      profile: text('profile'),
      model: text('model'),
      prompt: text('prompt'),
      answer: text('answer'),
    );
  }

  /// A turn answer, or null when the extension found none (it answers `null`,
  /// which reaches the adapter as an empty map).
  static TrailEntry? fromJsonOrNull(Map<String, dynamic> json) =>
      json['id'] == null ? null : TrailEntry.fromJson(json);
}

/// Result of listing the trail: this host's turns of a quest, newest first.
class TrailListResult {
  final List<TrailEntry> entries;

  /// Every turn after `since` (all without it), before the limit.
  final int totalCount;

  /// The quest whose trail was listed.
  final String? questId;

  /// The host whose trail was listed (this machine).
  final String? host;

  TrailListResult({
    required this.entries,
    required this.totalCount,
    this.questId,
    this.host,
  });

  factory TrailListResult.fromJson(Map<String, dynamic> json) {
    return TrailListResult(
      entries:
          (json['entries'] as List?)
              ?.map((e) => TrailEntry.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      totalCount: json['totalCount'] as int? ?? 0,
      questId: json['questId'] as String?,
      host: json['host'] as String?,
    );
  }
}

/// Guideline document info.
class GuidelineInfo {
  final String name;
  final String path;
  final String relativePath;
  final String? category; // 'dart', 'cloud', 'd4rt', or root level
  final String? description;

  GuidelineInfo({
    required this.name,
    required this.path,
    required this.relativePath,
    this.category,
    this.description,
  });

  factory GuidelineInfo.fromJson(Map<String, dynamic> json) {
    return GuidelineInfo(
      name: json['name'] as String? ?? '',
      path: json['path'] as String? ?? '',
      relativePath: json['relativePath'] as String? ?? '',
      category: json['category'] as String?,
      description: json['description'] as String?,
    );
  }
}

/// Result of listing guidelines.
class GuidelineListResult {
  final List<GuidelineInfo> guidelines;
  final List<String> categories;

  GuidelineListResult({required this.guidelines, required this.categories});

  factory GuidelineListResult.fromJson(Map<String, dynamic> json) {
    return GuidelineListResult(
      guidelines:
          (json['guidelines'] as List?)
              ?.map((e) => GuidelineInfo.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      categories:
          (json['categories'] as List?)?.map((e) => e as String).toList() ?? [],
    );
  }
}

// ============================================================================
// API Class
// ============================================================================

/// API for accessing workspace documents.
///
/// All methods throw [Exception] on bridge communication errors.
abstract class TomDocumentApi {
  static VSCodeAdapter? _adapter;

  /// Set the adapter for API calls.
  static void setAdapter(VSCodeAdapter adapter) {
    _adapter = adapter;
  }

  static VSCodeAdapter get _requireAdapter {
    if (_adapter == null) {
      throw StateError(
        'TomDocumentApi: adapter not set. Call setAdapter() first.',
      );
    }
    return _adapter!;
  }

  // --------------------------------------------------------------------------
  // Generic Document Operations
  // --------------------------------------------------------------------------

  /// List documents in a specific folder.
  static Future<DocumentListResult> list(
    DocumentFolder folder, {
    String? subfolder,
    String? pattern,
    bool recursive = false,
  }) async {
    final result = await _requireAdapter.sendRequest('doc.listVce', {
      'folder': folder.value,
      'subfolder': ?subfolder,
      'pattern': ?pattern,
      'recursive': recursive,
    });
    return DocumentListResult.fromJson(result);
  }

  /// Read a document's content.
  static Future<DocumentContent> read(String path) async {
    final result = await _requireAdapter.sendRequest('doc.readVce', {
      'path': path,
    });
    return DocumentContent.fromJson(result);
  }

  /// Write content to a document.
  static Future<bool> write(String path, String content) async {
    final result = await _requireAdapter.sendRequest('doc.writeVce', {
      'path': path,
      'content': content,
    });
    return (result)['success'] as bool? ?? false;
  }

  /// Delete a document.
  static Future<bool> delete(String path) async {
    final result = await _requireAdapter.sendRequest('doc.deleteVce', {
      'path': path,
    });
    return (result)['success'] as bool? ?? false;
  }

  /// Check if a document exists.
  static Future<bool> exists(String path) async {
    final result = await _requireAdapter.sendRequest('doc.existsVce', {
      'path': path,
    });
    return (result)['exists'] as bool? ?? false;
  }

  // --------------------------------------------------------------------------
  // Prompt Operations
  // --------------------------------------------------------------------------

  /// List the saved prompts of the active quest (`_ai/quests/{questId}/prompt/`).
  static Future<DocumentListResult> listPrompts({String? pattern}) async {
    final result = await _requireAdapter.sendRequest('doc.listPromptsVce', {
      'pattern': ?pattern,
    });
    return DocumentListResult.fromJson(result);
  }

  /// Read a saved prompt of the active quest by its file name.
  static Future<DocumentContent> readPrompt(String filename) async {
    final result = await _requireAdapter.sendRequest('doc.readPromptVce', {
      'filename': filename,
    });
    return DocumentContent.fromJson(result);
  }

  /// Save a new prompt in the active quest's `prompt/` folder; answers its path.
  static Future<String> createPrompt(String content, {String? filename}) async {
    final result = await _requireAdapter.sendRequest('doc.createPromptVce', {
      'content': content,
      'filename': ?filename,
    });
    return (result)['path'] as String? ?? '';
  }

  // --------------------------------------------------------------------------
  // Trail Operations
  // --------------------------------------------------------------------------

  /// This host's turns of a quest's trail, newest first.
  ///
  /// [questId] defaults to the window's quest (the call throws in a window
  /// without one); [since] (an ISO date-time) keeps the turns sent after it;
  /// [limit] caps the list (default 20 — a turn holds the whole prompt and
  /// answer). [TrailListResult.totalCount] counts every turn after [since].
  static Future<TrailListResult> listTrail({
    String? questId,
    int? limit,
    String? since,
  }) async {
    final result = await _requireAdapter.sendRequest('doc.listTrailVce', {
      'questId': ?questId,
      'limit': ?limit,
      'since': ?since,
    });
    return TrailListResult.fromJson(result);
  }

  /// The turn whose id is [entryId] in any host's trail of the quest
  /// ([questId], default the window's quest), or null.
  static Future<TrailEntry?> getTrailEntry(
    String entryId, {
    String? questId,
  }) async {
    final result = await _requireAdapter.sendRequest('doc.getTrailEntryVce', {
      'entryId': entryId,
      'questId': ?questId,
    });
    return TrailEntry.fromJsonOrNull(result);
  }

  /// The turn sent with the request id [requestId] in any host's trail of the
  /// quest ([questId], default the window's quest), or null. A turn's id is its
  /// request id, so this is [getTrailEntry] by another name.
  static Future<TrailEntry?> findTrailByRequestId(
    String requestId, {
    String? questId,
  }) async {
    final result = await _requireAdapter.sendRequest(
      'doc.findTrailByRequestIdVce',
      {'requestId': requestId, 'questId': ?questId},
    );
    return TrailEntry.fromJsonOrNull(result);
  }

  // --------------------------------------------------------------------------
  // Guideline Operations
  // --------------------------------------------------------------------------

  /// List all guidelines.
  static Future<GuidelineListResult> listGuidelines({String? category}) async {
    final result = await _requireAdapter.sendRequest('doc.listGuidelinesVce', {
      'category': ?category,
    });
    return GuidelineListResult.fromJson(result);
  }

  /// Read a guideline document.
  static Future<DocumentContent> readGuideline(String name) async {
    final result = await _requireAdapter.sendRequest('doc.readGuidelineVce', {
      'name': name,
    });
    return DocumentContent.fromJson(result);
  }

  // --------------------------------------------------------------------------
  // Quest Document Operations
  // --------------------------------------------------------------------------

  /// List documents in a quest folder.
  static Future<DocumentListResult> listQuestDocuments(
    String questId, {
    String? pattern,
  }) async {
    final result = await _requireAdapter.sendRequest('doc.listQuestDocsVce', {
      'questId': questId,
      'pattern': ?pattern,
    });
    return DocumentListResult.fromJson(result);
  }

  /// Read a quest document.
  static Future<DocumentContent> readQuestDocument(
    String questId,
    String filename,
  ) async {
    final result = await _requireAdapter.sendRequest('doc.readQuestDocVce', {
      'questId': questId,
      'filename': filename,
    });
    return DocumentContent.fromJson(result);
  }

  /// Write a quest document.
  static Future<bool> writeQuestDocument(
    String questId,
    String filename,
    String content,
  ) async {
    final result = await _requireAdapter.sendRequest('doc.writeQuestDocVce', {
      'questId': questId,
      'filename': filename,
      'content': content,
    });
    return (result)['success'] as bool? ?? false;
  }
}
