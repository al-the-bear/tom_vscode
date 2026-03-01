/// Tom Document API for scripting access to workspace documents.
///
/// Provides operations for accessing and manipulating:
/// - Prompts (_ai/prompt/)
/// - Answers (_ai/answers/)
/// - Notes (_ai/notes/)
/// - Trail entries (_ai/trail/)
/// - Guidelines (_copilot_guidelines/)
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
  answers('answers'),
  notes('notes'),
  trail('trail'),
  guidelines('guidelines'),
  quest('quest'),
  clarifications('clarifications'),
  botConversations('bot_conversations'),
  sendToChat('send_to_chat');

  final String value;
  const DocumentFolder(this.value);

  static DocumentFolder fromString(String value) {
    return DocumentFolder.values.firstWhere(
      (f) => f.value == value,
      orElse: () => DocumentFolder.notes,
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

/// Trail entry (prompt/answer pair).
class TrailEntry {
  final String id;
  final String? requestId;
  final String promptFile;
  final String? answerFile;
  final String? promptContent;
  final String? answerContent;
  final String? timestamp;
  final String? questId;

  TrailEntry({
    required this.id,
    this.requestId,
    required this.promptFile,
    this.answerFile,
    this.promptContent,
    this.answerContent,
    this.timestamp,
    this.questId,
  });

  factory TrailEntry.fromJson(Map<String, dynamic> json) {
    return TrailEntry(
      id: json['id'] as String? ?? '',
      requestId: json['requestId'] as String?,
      promptFile: json['promptFile'] as String? ?? '',
      answerFile: json['answerFile'] as String?,
      promptContent: json['promptContent'] as String?,
      answerContent: json['answerContent'] as String?,
      timestamp: json['timestamp'] as String?,
      questId: json['questId'] as String?,
    );
  }
}

/// Result of listing trail entries.
class TrailListResult {
  final List<TrailEntry> entries;
  final int totalCount;
  final String? questId;

  TrailListResult({
    required this.entries,
    required this.totalCount,
    this.questId,
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
      if (subfolder != null) 'subfolder': subfolder,
      if (pattern != null) 'pattern': pattern,
      'recursive': recursive,
    });
    return DocumentListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Read a document's content.
  static Future<DocumentContent> read(String path) async {
    final result = await _requireAdapter.sendRequest('doc.readVce', {
      'path': path,
    });
    return DocumentContent.fromJson(result as Map<String, dynamic>);
  }

  /// Write content to a document.
  static Future<bool> write(String path, String content) async {
    final result = await _requireAdapter.sendRequest('doc.writeVce', {
      'path': path,
      'content': content,
    });
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  /// Delete a document.
  static Future<bool> delete(String path) async {
    final result = await _requireAdapter.sendRequest('doc.deleteVce', {
      'path': path,
    });
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  /// Check if a document exists.
  static Future<bool> exists(String path) async {
    final result = await _requireAdapter.sendRequest('doc.existsVce', {
      'path': path,
    });
    return (result as Map<String, dynamic>)['exists'] as bool? ?? false;
  }

  // --------------------------------------------------------------------------
  // Prompt Operations
  // --------------------------------------------------------------------------

  /// List prompt files.
  static Future<DocumentListResult> listPrompts({String? pattern}) async {
    final result = await _requireAdapter.sendRequest('doc.listPromptsVce', {
      if (pattern != null) 'pattern': pattern,
    });
    return DocumentListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Read a prompt file.
  static Future<DocumentContent> readPrompt(String filename) async {
    final result = await _requireAdapter.sendRequest('doc.readPromptVce', {
      'filename': filename,
    });
    return DocumentContent.fromJson(result as Map<String, dynamic>);
  }

  /// Create a new prompt file.
  static Future<String> createPrompt(String content, {String? filename}) async {
    final result = await _requireAdapter.sendRequest('doc.createPromptVce', {
      'content': content,
      if (filename != null) 'filename': filename,
    });
    return (result as Map<String, dynamic>)['path'] as String? ?? '';
  }

  // --------------------------------------------------------------------------
  // Answer Operations
  // --------------------------------------------------------------------------

  /// List answer files.
  static Future<DocumentListResult> listAnswers({
    String? subfolder,
    String? pattern,
  }) async {
    final result = await _requireAdapter.sendRequest('doc.listAnswersVce', {
      if (subfolder != null) 'subfolder': subfolder,
      if (pattern != null) 'pattern': pattern,
    });
    return DocumentListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Read an answer file.
  static Future<DocumentContent> readAnswer(String path) async {
    final result = await _requireAdapter.sendRequest('doc.readAnswerVce', {
      'path': path,
    });
    return DocumentContent.fromJson(result as Map<String, dynamic>);
  }

  // --------------------------------------------------------------------------
  // Trail Operations
  // --------------------------------------------------------------------------

  /// List trail entries (prompt/answer pairs).
  static Future<TrailListResult> listTrail({
    String? questId,
    int? limit,
    String? since,
  }) async {
    final result = await _requireAdapter.sendRequest('doc.listTrailVce', {
      if (questId != null) 'questId': questId,
      if (limit != null) 'limit': limit,
      if (since != null) 'since': since,
    });
    return TrailListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Get a specific trail entry by ID.
  static Future<TrailEntry?> getTrailEntry(String entryId) async {
    final result = await _requireAdapter.sendRequest('doc.getTrailEntryVce', {
      'entryId': entryId,
    });
    if (result == null) return null;
    return TrailEntry.fromJson(result as Map<String, dynamic>);
  }

  /// Find trail entry by request ID.
  static Future<TrailEntry?> findTrailByRequestId(String requestId) async {
    final result = await _requireAdapter.sendRequest(
      'doc.findTrailByRequestIdVce',
      {'requestId': requestId},
    );
    if (result == null) return null;
    return TrailEntry.fromJson(result as Map<String, dynamic>);
  }

  // --------------------------------------------------------------------------
  // Guideline Operations
  // --------------------------------------------------------------------------

  /// List all guidelines.
  static Future<GuidelineListResult> listGuidelines({String? category}) async {
    final result = await _requireAdapter.sendRequest('doc.listGuidelinesVce', {
      if (category != null) 'category': category,
    });
    return GuidelineListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Read a guideline document.
  static Future<DocumentContent> readGuideline(String name) async {
    final result = await _requireAdapter.sendRequest('doc.readGuidelineVce', {
      'name': name,
    });
    return DocumentContent.fromJson(result as Map<String, dynamic>);
  }

  // --------------------------------------------------------------------------
  // Notes Operations
  // --------------------------------------------------------------------------

  /// List note files.
  static Future<DocumentListResult> listNotes({String? pattern}) async {
    final result = await _requireAdapter.sendRequest('doc.listNotesVce', {
      if (pattern != null) 'pattern': pattern,
    });
    return DocumentListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Read a note file.
  static Future<DocumentContent> readNote(String filename) async {
    final result = await _requireAdapter.sendRequest('doc.readNoteVce', {
      'filename': filename,
    });
    return DocumentContent.fromJson(result as Map<String, dynamic>);
  }

  /// Write a note file.
  static Future<bool> writeNote(String filename, String content) async {
    final result = await _requireAdapter.sendRequest('doc.writeNoteVce', {
      'filename': filename,
      'content': content,
    });
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
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
      if (pattern != null) 'pattern': pattern,
    });
    return DocumentListResult.fromJson(result as Map<String, dynamic>);
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
    return DocumentContent.fromJson(result as Map<String, dynamic>);
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
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }
}
