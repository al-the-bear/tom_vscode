/// Tom Timed API for scripting access to timed/scheduled requests.
///
/// Provides operations for managing timed and scheduled prompts:
/// - List timed request entries
/// - Create/update/delete timed entries
/// - Configure schedule (interval or specific times)
/// - Enable/disable entries
// ignore_for_file: avoid_classes_with_only_static_members
library;

import 'vscode_adapter.dart';

// ============================================================================
// Types
// ============================================================================

/// Status of a timed request entry.
enum TimedRequestStatus {
  active('active'),
  paused('paused'),
  completed('completed');

  final String value;
  const TimedRequestStatus(this.value);

  static TimedRequestStatus fromString(String value) {
    return TimedRequestStatus.values.firstWhere(
      (s) => s.value == value,
      orElse: () => TimedRequestStatus.active,
    );
  }
}

/// Schedule mode for timed requests.
enum ScheduleMode {
  interval('interval'),
  scheduled('scheduled');

  final String value;
  const ScheduleMode(this.value);

  static ScheduleMode fromString(String value) {
    return ScheduleMode.values.firstWhere(
      (m) => m.value == value,
      orElse: () => ScheduleMode.interval,
    );
  }
}

/// A scheduled time slot.
class ScheduledTime {
  final String time; // "HH:MM"
  final String? date; // "YYYY-MM-DD" — one-shot if present

  ScheduledTime({required this.time, this.date});

  factory ScheduledTime.fromJson(Map<String, dynamic> json) {
    return ScheduledTime(
      time: json['time'] as String? ?? '00:00',
      date: json['date'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'time': time,
    if (date != null) 'date': date,
  };
}

/// A timed request entry.
class TimedRequest {
  final String id;
  final bool enabled;
  final String template;
  final bool? answerWrapper;
  final String originalText;
  final ScheduleMode scheduleMode;
  final int? intervalMinutes;
  final List<ScheduledTime>? scheduledTimes;
  final bool? reminderEnabled;
  final String? reminderTemplateId;
  final int? reminderTimeoutMinutes;
  final bool? reminderRepeat;
  final String? lastSentAt;
  final TimedRequestStatus status;

  TimedRequest({
    required this.id,
    required this.enabled,
    required this.template,
    this.answerWrapper,
    required this.originalText,
    required this.scheduleMode,
    this.intervalMinutes,
    this.scheduledTimes,
    this.reminderEnabled,
    this.reminderTemplateId,
    this.reminderTimeoutMinutes,
    this.reminderRepeat,
    this.lastSentAt,
    required this.status,
  });

  factory TimedRequest.fromJson(Map<String, dynamic> json) {
    return TimedRequest(
      id: json['id'] as String,
      enabled: json['enabled'] as bool? ?? true,
      template: json['template'] as String? ?? '(None)',
      answerWrapper: json['answerWrapper'] as bool?,
      originalText: json['originalText'] as String? ?? '',
      scheduleMode: ScheduleMode.fromString(
        json['scheduleMode'] as String? ?? 'interval',
      ),
      intervalMinutes: json['intervalMinutes'] as int?,
      scheduledTimes: (json['scheduledTimes'] as List?)
          ?.map((e) => ScheduledTime.fromJson(e as Map<String, dynamic>))
          .toList(),
      reminderEnabled: json['reminderEnabled'] as bool?,
      reminderTemplateId: json['reminderTemplateId'] as String?,
      reminderTimeoutMinutes: json['reminderTimeoutMinutes'] as int?,
      reminderRepeat: json['reminderRepeat'] as bool?,
      lastSentAt: json['lastSentAt'] as String?,
      status: TimedRequestStatus.fromString(
        json['status'] as String? ?? 'active',
      ),
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'enabled': enabled,
    'template': template,
    if (answerWrapper != null) 'answerWrapper': answerWrapper,
    'originalText': originalText,
    'scheduleMode': scheduleMode.value,
    if (intervalMinutes != null) 'intervalMinutes': intervalMinutes,
    if (scheduledTimes != null)
      'scheduledTimes': scheduledTimes!.map((t) => t.toJson()).toList(),
    if (reminderEnabled != null) 'reminderEnabled': reminderEnabled,
    if (reminderTemplateId != null) 'reminderTemplateId': reminderTemplateId,
    if (reminderTimeoutMinutes != null)
      'reminderTimeoutMinutes': reminderTimeoutMinutes,
    if (reminderRepeat != null) 'reminderRepeat': reminderRepeat,
    if (lastSentAt != null) 'lastSentAt': lastSentAt,
    'status': status.value,
  };
}

/// Result of listing timed requests.
class TimedRequestListResult {
  final List<TimedRequest> entries;
  final int totalCount;
  final int activeCount;
  final int pausedCount;
  final bool timerActivated;

  TimedRequestListResult({
    required this.entries,
    required this.totalCount,
    required this.activeCount,
    required this.pausedCount,
    required this.timerActivated,
  });

  factory TimedRequestListResult.fromJson(Map<String, dynamic> json) {
    return TimedRequestListResult(
      entries:
          (json['entries'] as List?)
              ?.map((e) => TimedRequest.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      totalCount: json['totalCount'] as int? ?? 0,
      activeCount: json['activeCount'] as int? ?? 0,
      pausedCount: json['pausedCount'] as int? ?? 0,
      timerActivated: json['timerActivated'] as bool? ?? true,
    );
  }
}

/// Input for creating a new timed request.
class TimedRequestInput {
  final String promptText;
  final String? template;
  final bool? answerWrapper;
  final ScheduleMode scheduleMode;
  final int? intervalMinutes;
  final List<ScheduledTime>? scheduledTimes;
  final bool? reminderEnabled;
  final String? reminderTemplateId;
  final int? reminderTimeoutMinutes;
  final bool? reminderRepeat;

  TimedRequestInput({
    required this.promptText,
    this.template,
    this.answerWrapper,
    required this.scheduleMode,
    this.intervalMinutes,
    this.scheduledTimes,
    this.reminderEnabled,
    this.reminderTemplateId,
    this.reminderTimeoutMinutes,
    this.reminderRepeat,
  });

  Map<String, dynamic> toJson() => {
    'promptText': promptText,
    if (template != null) 'template': template,
    if (answerWrapper != null) 'answerWrapper': answerWrapper,
    'scheduleMode': scheduleMode.value,
    if (intervalMinutes != null) 'intervalMinutes': intervalMinutes,
    if (scheduledTimes != null)
      'scheduledTimes': scheduledTimes!.map((t) => t.toJson()).toList(),
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

/// API for managing timed/scheduled requests.
///
/// All methods throw [Exception] on bridge communication errors.
abstract class TomTimedApi {
  static VSCodeAdapter? _adapter;

  /// Set the adapter for API calls.
  static void setAdapter(VSCodeAdapter adapter) {
    _adapter = adapter;
  }

  static VSCodeAdapter get _requireAdapter {
    if (_adapter == null) {
      throw StateError(
        'TomTimedApi: adapter not set. Call setAdapter() first.',
      );
    }
    return _adapter!;
  }

  // --------------------------------------------------------------------------
  // List Operations
  // --------------------------------------------------------------------------

  /// List all timed request entries.
  static Future<TimedRequestListResult> list() async {
    final result = await _requireAdapter.sendRequest('timed.listVce', {});
    return TimedRequestListResult.fromJson(result as Map<String, dynamic>);
  }

  /// Get a specific timed request entry by ID.
  static Future<TimedRequest?> get(String entryId) async {
    final result = await _requireAdapter.sendRequest('timed.getVce', {
      'entryId': entryId,
    });
    if (result == null) return null;
    return TimedRequest.fromJson(result as Map<String, dynamic>);
  }

  // --------------------------------------------------------------------------
  // CRUD Operations
  // --------------------------------------------------------------------------

  /// Create a new timed request entry.
  static Future<TimedRequest> create(TimedRequestInput input) async {
    final result = await _requireAdapter.sendRequest('timed.createVce', {
      ...input.toJson(),
    });
    return TimedRequest.fromJson(result as Map<String, dynamic>);
  }

  /// Update an existing timed request entry.
  static Future<TimedRequest> update(
    String entryId, {
    String? promptText,
    String? template,
    bool? answerWrapper,
    ScheduleMode? scheduleMode,
    int? intervalMinutes,
    List<ScheduledTime>? scheduledTimes,
    bool? reminderEnabled,
    String? reminderTemplateId,
    int? reminderTimeoutMinutes,
    bool? reminderRepeat,
    TimedRequestStatus? status,
  }) async {
    final result = await _requireAdapter.sendRequest('timed.updateVce', {
      'entryId': entryId,
      if (promptText != null) 'promptText': promptText,
      if (template != null) 'template': template,
      if (answerWrapper != null) 'answerWrapper': answerWrapper,
      if (scheduleMode != null) 'scheduleMode': scheduleMode.value,
      if (intervalMinutes != null) 'intervalMinutes': intervalMinutes,
      if (scheduledTimes != null)
        'scheduledTimes': scheduledTimes.map((t) => t.toJson()).toList(),
      if (reminderEnabled != null) 'reminderEnabled': reminderEnabled,
      if (reminderTemplateId != null) 'reminderTemplateId': reminderTemplateId,
      if (reminderTimeoutMinutes != null)
        'reminderTimeoutMinutes': reminderTimeoutMinutes,
      if (reminderRepeat != null) 'reminderRepeat': reminderRepeat,
      if (status != null) 'status': status.value,
    });
    return TimedRequest.fromJson(result as Map<String, dynamic>);
  }

  /// Delete a timed request entry.
  static Future<bool> delete(String entryId) async {
    final result = await _requireAdapter.sendRequest('timed.deleteVce', {
      'entryId': entryId,
    });
    return (result as Map<String, dynamic>)['success'] as bool? ?? false;
  }

  // --------------------------------------------------------------------------
  // Enable/Disable Operations
  // --------------------------------------------------------------------------

  /// Enable a timed request entry.
  static Future<TimedRequest> enable(String entryId) async {
    final result = await _requireAdapter.sendRequest('timed.enableVce', {
      'entryId': entryId,
    });
    return TimedRequest.fromJson(result as Map<String, dynamic>);
  }

  /// Disable a timed request entry.
  static Future<TimedRequest> disable(String entryId) async {
    final result = await _requireAdapter.sendRequest('timed.disableVce', {
      'entryId': entryId,
    });
    return TimedRequest.fromJson(result as Map<String, dynamic>);
  }

  // --------------------------------------------------------------------------
  // Timer Engine Operations
  // --------------------------------------------------------------------------

  /// Get whether the timer engine is activated.
  static Future<bool> isTimerActivated() async {
    final result = await _requireAdapter.sendRequest(
      'timed.isActivatedVce',
      {},
    );
    return (result as Map<String, dynamic>)['activated'] as bool? ?? true;
  }

  /// Activate the timer engine.
  static Future<void> activateTimer() async {
    await _requireAdapter.sendRequest('timed.activateVce', {});
  }

  /// Deactivate the timer engine.
  static Future<void> deactivateTimer() async {
    await _requireAdapter.sendRequest('timed.deactivateVce', {});
  }

  /// Trigger immediate check for due entries.
  static Future<int> triggerCheck() async {
    final result = await _requireAdapter.sendRequest(
      'timed.triggerCheckVce',
      {},
    );
    return (result as Map<String, dynamic>)['processedCount'] as int? ?? 0;
  }
}
