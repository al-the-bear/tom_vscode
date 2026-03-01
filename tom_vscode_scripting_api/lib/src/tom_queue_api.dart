/// Tom Queue API for scripting access to the prompt queue.
///
/// Provides operations for managing the Copilot prompt queue:
/// - List queued prompts
/// - Add prompts to the queue
/// - Remove prompts from the queue
/// - Reorder queue items
/// - Manage follow-up prompts
// ignore_for_file: avoid_classes_with_only_static_members
library;

import 'vscode_adapter.dart';

// ============================================================================
// Types
// ============================================================================

/// Status of a queued prompt.
enum QueuedPromptStatus {
  staged('staged'),
  pending('pending'),
  sending('sending'),
  sent('sent'),
  error('error');

  final String value;
  const QueuedPromptStatus(this.value);

  static QueuedPromptStatus fromString(String value) {
    return QueuedPromptStatus.values.firstWhere(
      (s) => s.value == value,
      orElse: () => QueuedPromptStatus.pending,
    );
  }
}

/// Type of a queued prompt.
enum QueuedPromptType {
  normal('normal'),
  timed('timed'),
  reminder('reminder');

  final String value;
  const QueuedPromptType(this.value);

  static QueuedPromptType fromString(String value) {
    return QueuedPromptType.values.firstWhere(
      (t) => t.value == value,
      orElse: () => QueuedPromptType.normal,
    );
  }
}

/// A follow-up prompt attached to a queue item.
class QueuedFollowUp {
  final String id;
  final String originalText;
  final String? template;
  final String? reminderTemplateId;
  final int? reminderTimeoutMinutes;
  final bool? reminderRepeat;
  final bool? reminderEnabled;
  final String createdAt;

  QueuedFollowUp({
    required this.id,
    required this.originalText,
    this.template,
    this.reminderTemplateId,
    this.reminderTimeoutMinutes,
    this.reminderRepeat,
    this.reminderEnabled,
    required this.createdAt,
  });

  factory QueuedFollowUp.fromJson(Map<String, dynamic> json) {
    return QueuedFollowUp(
      id: json['id'] as String,
      originalText: json['originalText'] as String? ?? '',
      template: json['template'] as String?,
      reminderTemplateId: json['reminderTemplateId'] as String?,
      reminderTimeoutMinutes: json['reminderTimeoutMinutes'] as int?,
      reminderRepeat: json['reminderRepeat'] as bool?,
      reminderEnabled: json['reminderEnabled'] as bool?,
      createdAt: json['createdAt'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'originalText': originalText,
    if (template != null) 'template': template,
    if (reminderTemplateId != null) 'reminderTemplateId': reminderTemplateId,
    if (reminderTimeoutMinutes != null)
      'reminderTimeoutMinutes': reminderTimeoutMinutes,
    if (reminderRepeat != null) 'reminderRepeat': reminderRepeat,
    if (reminderEnabled != null) 'reminderEnabled': reminderEnabled,
    'createdAt': createdAt,
  };
}

/// A queued prompt item.
class QueuedPrompt {
  final String id;
  final String template;
  final bool? answerWrapper;
  final String originalText;
  final String expandedText;
  final QueuedPromptStatus status;
  final QueuedPromptType type;
  final String createdAt;
  final String? sentAt;
  final String? error;
  final String? reminderTemplateId;
  final int? reminderTimeoutMinutes;
  final bool? reminderRepeat;
  final bool? reminderEnabled;
  final bool? reminderQueued;
  final int? reminderSentCount;
  final String? lastReminderAt;
  final String? requestId;
  final String? expectedRequestId;
  final List<QueuedFollowUp>? followUps;
  final int? followUpIndex;

  QueuedPrompt({
    required this.id,
    required this.template,
    this.answerWrapper,
    required this.originalText,
    required this.expandedText,
    required this.status,
    required this.type,
    required this.createdAt,
    this.sentAt,
    this.error,
    this.reminderTemplateId,
    this.reminderTimeoutMinutes,
    this.reminderRepeat,
    this.reminderEnabled,
    this.reminderQueued,
    this.reminderSentCount,
    this.lastReminderAt,
    this.requestId,
    this.expectedRequestId,
    this.followUps,
    this.followUpIndex,
  });

  factory QueuedPrompt.fromJson(Map<String, dynamic> json) {
    return QueuedPrompt(
      id: json['id'] as String,
      template: json['template'] as String? ?? '(None)',
      answerWrapper: json['answerWrapper'] as bool?,
      originalText: json['originalText'] as String? ?? '',
      expandedText: json['expandedText'] as String? ?? '',
      status: QueuedPromptStatus.fromString(
        json['status'] as String? ?? 'pending',
      ),
      type: QueuedPromptType.fromString(json['type'] as String? ?? 'normal'),
      createdAt: json['createdAt'] as String? ?? '',
      sentAt: json['sentAt'] as String?,
      error: json['error'] as String?,
      reminderTemplateId: json['reminderTemplateId'] as String?,
      reminderTimeoutMinutes: json['reminderTimeoutMinutes'] as int?,
      reminderRepeat: json['reminderRepeat'] as bool?,
      reminderEnabled: json['reminderEnabled'] as bool?,
      reminderQueued: json['reminderQueued'] as bool?,
      reminderSentCount: json['reminderSentCount'] as int?,
      lastReminderAt: json['lastReminderAt'] as String?,
      requestId: json['requestId'] as String?,
      expectedRequestId: json['expectedRequestId'] as String?,
      followUps: (json['followUps'] as List?)
          ?.map((e) => QueuedFollowUp.fromJson(e as Map<String, dynamic>))
          .toList(),
      followUpIndex: json['followUpIndex'] as int?,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'template': template,
    if (answerWrapper != null) 'answerWrapper': answerWrapper,
    'originalText': originalText,
    'expandedText': expandedText,
    'status': status.value,
    'type': type.value,
    'createdAt': createdAt,
    if (sentAt != null) 'sentAt': sentAt,
    if (error != null) 'error': error,
    if (reminderTemplateId != null) 'reminderTemplateId': reminderTemplateId,
    if (reminderTimeoutMinutes != null)
      'reminderTimeoutMinutes': reminderTimeoutMinutes,
    if (reminderRepeat != null) 'reminderRepeat': reminderRepeat,
    if (reminderEnabled != null) 'reminderEnabled': reminderEnabled,
    if (reminderQueued != null) 'reminderQueued': reminderQueued,
    if (reminderSentCount != null) 'reminderSentCount': reminderSentCount,
    if (lastReminderAt != null) 'lastReminderAt': lastReminderAt,
    if (requestId != null) 'requestId': requestId,
    if (expectedRequestId != null) 'expectedRequestId': expectedRequestId,
    if (followUps != null)
      'followUps': followUps!.map((f) => f.toJson()).toList(),
    if (followUpIndex != null) 'followUpIndex': followUpIndex,
  };
}

/// Result of listing queue items.
class QueueListResult {
  final List<QueuedPrompt> items;
  final int totalCount;
  final int pendingCount;
  final int sentCount;

  QueueListResult({
    required this.items,
    required this.totalCount,
    required this.pendingCount,
    required this.sentCount,
  });

  factory QueueListResult.fromJson(Map<String, dynamic> json) {
    return QueueListResult(
      items:
          (json['items'] as List?)
              ?.map((e) => QueuedPrompt.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      totalCount: json['totalCount'] as int? ?? 0,
      pendingCount: json['pendingCount'] as int? ?? 0,
      sentCount: json['sentCount'] as int? ?? 0,
    );
  }
}

/// Input for creating a new queue item.
class QueueItemInput {
  final String promptText;
  final String? template;
  final bool? answerWrapper;
  final bool? reminderEnabled;
  final String? reminderTemplateId;
  final int? reminderTimeoutMinutes;
  final bool? reminderRepeat;

  QueueItemInput({
    required this.promptText,
    this.template,
    this.answerWrapper,
    this.reminderEnabled,
    this.reminderTemplateId,
    this.reminderTimeoutMinutes,
    this.reminderRepeat,
  });

  Map<String, dynamic> toJson() => {
    'promptText': promptText,
    if (template != null) 'template': template,
    if (answerWrapper != null) 'answerWrapper': answerWrapper,
    if (reminderEnabled != null) 'reminderEnabled': reminderEnabled,
    if (reminderTemplateId != null) 'reminderTemplateId': reminderTemplateId,
    if (reminderTimeoutMinutes != null)
      'reminderTimeoutMinutes': reminderTimeoutMinutes,
    if (reminderRepeat != null) 'reminderRepeat': reminderRepeat,
  };
}

/// Input for adding a follow-up prompt to a queue item.
class FollowUpInput {
  final String promptText;
  final String? template;
  final bool? reminderEnabled;
  final String? reminderTemplateId;
  final int? reminderTimeoutMinutes;
  final bool? reminderRepeat;

  FollowUpInput({
    required this.promptText,
    this.template,
    this.reminderEnabled,
    this.reminderTemplateId,
    this.reminderTimeoutMinutes,
    this.reminderRepeat,
  });

  Map<String, dynamic> toJson() => {
    'promptText': promptText,
    if (template != null) 'template': template,
    if (reminderEnabled != null) 'reminderEnabled': reminderEnabled,
    if (reminderTemplateId != null) 'reminderTemplateId': reminderTemplateId,
    if (reminderTimeoutMinutes != null)
      'reminderTimeoutMinutes': reminderTimeoutMinutes,
    if (reminderRepeat != null) 'reminderRepeat': reminderRepeat,
  };
}

// ============================================================================
// API Class
// ============================================================================

/// API for managing the prompt queue.
///
/// All methods throw [Exception] on bridge communication errors.
abstract class TomQueueApi {
  static VSCodeAdapter? _adapter;

  /// Set the adapter for API calls.
  static void setAdapter(VSCodeAdapter adapter) {
    _adapter = adapter;
  }

  static VSCodeAdapter get _requireAdapter {
    if (_adapter == null) {
      throw StateError(
        'TomQueueApi: adapter not set. Call setAdapter() first.',
      );
    }
    return _adapter!;
  }

  // --------------------------------------------------------------------------
  // Queue List Operations
  // --------------------------------------------------------------------------

  /// List all items in the prompt queue.
  static Future<QueueListResult> list({
    bool includeSent = false,
    int? limit,
  }) async {
    final result = await _requireAdapter.sendRequest('queue.listVce', {
      'includeSent': includeSent,
      if (limit != null) 'limit': limit,
    });
    return QueueListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Get a specific queue item by ID.
  static Future<QueuedPrompt?> get(String itemId) async {
    final result = await _requireAdapter.sendRequest('queue.getVce', {
      'itemId': itemId,
    });
    if (result == null) return null;
    return QueuedPrompt.fromJson(result as Map<String, dynamic>);
  }

  // --------------------------------------------------------------------------
  // Queue Add/Remove Operations
  // --------------------------------------------------------------------------

  /// Add a new prompt to the queue.
  static Future<QueuedPrompt> add(QueueItemInput input) async {
    final result = await _requireAdapter.sendRequest('queue.addVce', {
      ...input.toJson(),
    });
    return QueuedPrompt.fromJson(result as Map<String, dynamic>);
  }

  /// Remove a prompt from the queue.
  static Future<bool> remove(String itemId) async {
    final result = await _requireAdapter.sendRequest('queue.removeVce', {
      'itemId': itemId,
    });
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  /// Clear all pending items from the queue.
  static Future<int> clearPending() async {
    final result = await _requireAdapter.sendRequest(
      'queue.clearPendingVce',
      {},
    );
    return (result as Map<String, dynamic>)['removedCount'] as int? ?? 0;
  }

  /// Clear all sent items from the queue history.
  static Future<int> clearSent() async {
    final result = await _requireAdapter.sendRequest('queue.clearSentVce', {});
    return (result as Map<String, dynamic>)['removedCount'] as int? ?? 0;
  }

  // --------------------------------------------------------------------------
  // Queue Update Operations
  // --------------------------------------------------------------------------

  /// Update the status of a queue item.
  static Future<QueuedPrompt> updateStatus(
    String itemId,
    QueuedPromptStatus status,
  ) async {
    final result = await _requireAdapter.sendRequest('queue.updateStatusVce', {
      'itemId': itemId,
      'status': status.value,
    });
    return QueuedPrompt.fromJson(result as Map<String, dynamic>);
  }

  /// Update the prompt text of a queue item.
  static Future<QueuedPrompt> updateText(String itemId, String text) async {
    final result = await _requireAdapter.sendRequest('queue.updateTextVce', {
      'itemId': itemId,
      'text': text,
    });
    return QueuedPrompt.fromJson(result as Map<String, dynamic>);
  }

  /// Update reminder settings for a queue item.
  static Future<QueuedPrompt> updateReminder(
    String itemId, {
    bool? enabled,
    String? templateId,
    int? timeoutMinutes,
    bool? repeat,
  }) async {
    final result = await _requireAdapter
        .sendRequest('queue.updateReminderVce', {
          'itemId': itemId,
          if (enabled != null) 'enabled': enabled,
          if (templateId != null) 'templateId': templateId,
          if (timeoutMinutes != null) 'timeoutMinutes': timeoutMinutes,
          if (repeat != null) 'repeat': repeat,
        });
    return QueuedPrompt.fromJson(result as Map<String, dynamic>);
  }

  // --------------------------------------------------------------------------
  // Queue Reorder Operations
  // --------------------------------------------------------------------------

  /// Move an item to a specific position in the queue.
  static Future<bool> moveTo(String itemId, int newIndex) async {
    final result = await _requireAdapter.sendRequest('queue.moveToVce', {
      'itemId': itemId,
      'newIndex': newIndex,
    });
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  /// Move an item up one position.
  static Future<bool> moveUp(String itemId) async {
    final result = await _requireAdapter.sendRequest('queue.moveUpVce', {
      'itemId': itemId,
    });
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  /// Move an item down one position.
  static Future<bool> moveDown(String itemId) async {
    final result = await _requireAdapter.sendRequest('queue.moveDownVce', {
      'itemId': itemId,
    });
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  // --------------------------------------------------------------------------
  // Follow-up Operations
  // --------------------------------------------------------------------------

  /// Add a follow-up prompt to a queue item.
  static Future<QueuedFollowUp> addFollowUp(
    String itemId,
    FollowUpInput input,
  ) async {
    final result = await _requireAdapter.sendRequest('queue.addFollowUpVce', {
      'itemId': itemId,
      ...input.toJson(),
    });
    return QueuedFollowUp.fromJson(result as Map<String, dynamic>);
  }

  /// Remove a follow-up prompt from a queue item.
  static Future<bool> removeFollowUp(String itemId, String followUpId) async {
    final result = await _requireAdapter.sendRequest(
      'queue.removeFollowUpVce',
      {'itemId': itemId, 'followUpId': followUpId},
    );
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  /// Update a follow-up prompt.
  static Future<QueuedFollowUp> updateFollowUp(
    String itemId,
    String followUpId, {
    String? text,
    String? template,
    bool? reminderEnabled,
    String? reminderTemplateId,
    int? reminderTimeoutMinutes,
    bool? reminderRepeat,
  }) async {
    final result = await _requireAdapter
        .sendRequest('queue.updateFollowUpVce', {
          'itemId': itemId,
          'followUpId': followUpId,
          if (text != null) 'text': text,
          if (template != null) 'template': template,
          if (reminderEnabled != null) 'reminderEnabled': reminderEnabled,
          if (reminderTemplateId != null)
            'reminderTemplateId': reminderTemplateId,
          if (reminderTimeoutMinutes != null)
            'reminderTimeoutMinutes': reminderTimeoutMinutes,
          if (reminderRepeat != null) 'reminderRepeat': reminderRepeat,
        });
    return QueuedFollowUp.fromJson(result as Map<String, dynamic>);
  }

  // --------------------------------------------------------------------------
  // Queue Processing Operations
  // --------------------------------------------------------------------------

  /// Trigger sending the next pending prompt to Copilot.
  static Future<bool> sendNext() async {
    final result = await _requireAdapter.sendRequest('queue.sendNextVce', {});
    return (result as Map<String, dynamic>)['sent'] as bool? ?? false;
  }

  /// Pause automatic queue processing.
  static Future<void> pause() async {
    await _requireAdapter.sendRequest('queue.pauseVce', {});
  }

  /// Resume automatic queue processing.
  static Future<void> resume() async {
    await _requireAdapter.sendRequest('queue.resumeVce', {});
  }

  /// Get current queue processing status.
  static Future<bool> isPaused() async {
    final result = await _requireAdapter.sendRequest('queue.isPausedVce', {});
    return (result as Map<String, dynamic>)['paused'] as bool? ?? false;
  }
}
