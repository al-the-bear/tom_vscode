/// Dart mirror of the Agent SDK permission surface: [PermissionMode], the
/// [CanUseTool] approval callback, its [PermissionResult] return value, and the
/// [PermissionUpdate] rule mutations.
///
/// These are caller-controlled values travelling Dart → extension, so the wire
/// uses the SDK's camelCase field names (`updatedInput`, `toolUseID`, …) and
/// the enums carry their exact SDK string values. Round-trip is
/// `T.fromJson(t.toJson()).toJson() == t.toJson()`.
library;

/// Controls how tool executions are handled. Mirrors `PermissionMode`
/// (six values; `default` is spelled [PermissionMode.default_] in Dart).
enum PermissionMode {
  /// Prompt for dangerous operations (`default`).
  default_('default'),

  /// Auto-accept file edits (`acceptEdits`).
  acceptEdits('acceptEdits'),

  /// Bypass all permission checks (`bypassPermissions`).
  bypassPermissions('bypassPermissions'),

  /// Planning mode, no tool execution (`plan`).
  plan('plan'),

  /// Deny anything not pre-approved (`dontAsk`).
  dontAsk('dontAsk'),

  /// Use a model classifier to approve/deny (`auto`).
  auto('auto');

  const PermissionMode(this.wire);

  /// The SDK wire string for this mode.
  final String wire;

  /// Parses an SDK wire string into a [PermissionMode].
  static PermissionMode fromWire(String value) =>
      values.firstWhere((e) => e.wire == value);

  /// The SDK wire string (for embedding in JSON).
  String toJson() => wire;
}

/// Behaviour applied by a permission rule. Mirrors `PermissionBehavior`.
enum PermissionBehavior {
  /// Allow the matched tool calls.
  allow('allow'),

  /// Deny the matched tool calls.
  deny('deny'),

  /// Ask the user.
  ask('ask');

  const PermissionBehavior(this.wire);

  /// The SDK wire string.
  final String wire;

  /// Parses an SDK wire string into a [PermissionBehavior].
  static PermissionBehavior fromWire(String value) =>
      values.firstWhere((e) => e.wire == value);
}

/// Where a permission update is persisted. Mirrors `PermissionUpdateDestination`.
enum PermissionUpdateDestination {
  /// User-level settings.
  userSettings('userSettings'),

  /// Project-level settings.
  projectSettings('projectSettings'),

  /// Local (gitignored) settings.
  localSettings('localSettings'),

  /// This session only.
  session('session'),

  /// A CLI argument for this invocation.
  cliArg('cliArg');

  const PermissionUpdateDestination(this.wire);

  /// The SDK wire string.
  final String wire;

  /// Parses an SDK wire string into a [PermissionUpdateDestination].
  static PermissionUpdateDestination fromWire(String value) =>
      values.firstWhere((e) => e.wire == value);
}

/// Classification of a permission decision. Mirrors
/// `PermissionDecisionClassification` (snake_case wire values).
enum PermissionDecisionClassification {
  /// Temporary user grant (`user_temporary`).
  userTemporary('user_temporary'),

  /// Permanent user grant (`user_permanent`).
  userPermanent('user_permanent'),

  /// User rejection (`user_reject`).
  userReject('user_reject');

  const PermissionDecisionClassification(this.wire);

  /// The SDK wire string.
  final String wire;

  /// Parses an SDK wire string into a [PermissionDecisionClassification].
  static PermissionDecisionClassification fromWire(String value) =>
      values.firstWhere((e) => e.wire == value);
}

/// A single tool-permission rule. Mirrors `PermissionRuleValue`.
class PermissionRuleValue {
  /// The tool the rule targets.
  final String toolName;

  /// Optional rule body (e.g. a command pattern).
  final String? ruleContent;

  PermissionRuleValue({required this.toolName, this.ruleContent});

  /// Parses a [PermissionRuleValue] from wire JSON.
  factory PermissionRuleValue.fromJson(Map<String, dynamic> json) =>
      PermissionRuleValue(
        toolName: json['toolName'] as String,
        ruleContent: json['ruleContent'] as String?,
      );

  /// Serializes to wire JSON.
  Map<String, dynamic> toJson() => {
    'toolName': toolName,
    if (ruleContent != null) 'ruleContent': ruleContent,
  };
}

/// A permission-rule mutation. Mirrors `PermissionUpdate` (six variants).
sealed class PermissionUpdate {
  const PermissionUpdate();

  /// The update `type` discriminator.
  String get type;

  /// Serializes to wire JSON.
  Map<String, dynamic> toJson();

  /// Parses [json] into the matching [PermissionUpdate] variant.
  factory PermissionUpdate.fromJson(Map<String, dynamic> json) {
    final destination = PermissionUpdateDestination.fromWire(
      json['destination'] as String,
    );
    switch (json['type']) {
      case 'addRules':
        return PermissionUpdateRules._('addRules', json, destination);
      case 'replaceRules':
        return PermissionUpdateRules._('replaceRules', json, destination);
      case 'removeRules':
        return PermissionUpdateRules._('removeRules', json, destination);
      case 'setMode':
        return PermissionUpdateSetMode(
          mode: PermissionMode.fromWire(json['mode'] as String),
          destination: destination,
        );
      case 'addDirectories':
        return PermissionUpdateDirectories._(
          'addDirectories',
          json,
          destination,
        );
      case 'removeDirectories':
        return PermissionUpdateDirectories._(
          'removeDirectories',
          json,
          destination,
        );
      default:
        throw ArgumentError('Unknown PermissionUpdate type: ${json['type']}');
    }
  }
}

/// `addRules` / `replaceRules` / `removeRules` updates.
final class PermissionUpdateRules extends PermissionUpdate {
  @override
  final String type;

  /// The rules being added/replaced/removed.
  final List<PermissionRuleValue> rules;

  /// The behaviour applied to the rules.
  final PermissionBehavior behavior;

  /// Where the update is persisted.
  final PermissionUpdateDestination destination;

  PermissionUpdateRules({
    required this.type,
    required this.rules,
    required this.behavior,
    required this.destination,
  });

  PermissionUpdateRules._(
    this.type,
    Map<String, dynamic> json,
    this.destination,
  ) : rules = ((json['rules'] as List?) ?? const [])
          .whereType<Map>()
          .map((m) => PermissionRuleValue.fromJson(m.cast<String, dynamic>()))
          .toList(),
      behavior = PermissionBehavior.fromWire(json['behavior'] as String);

  @override
  Map<String, dynamic> toJson() => {
    'type': type,
    'rules': rules.map((r) => r.toJson()).toList(),
    'behavior': behavior.wire,
    'destination': destination.wire,
  };
}

/// `setMode` update.
final class PermissionUpdateSetMode extends PermissionUpdate {
  /// The mode to switch to.
  final PermissionMode mode;

  /// Where the update is persisted.
  final PermissionUpdateDestination destination;

  PermissionUpdateSetMode({required this.mode, required this.destination});

  @override
  String get type => 'setMode';

  @override
  Map<String, dynamic> toJson() => {
    'type': type,
    'mode': mode.wire,
    'destination': destination.wire,
  };
}

/// `addDirectories` / `removeDirectories` updates.
final class PermissionUpdateDirectories extends PermissionUpdate {
  @override
  final String type;

  /// The directories being added/removed.
  final List<String> directories;

  /// Where the update is persisted.
  final PermissionUpdateDestination destination;

  PermissionUpdateDirectories({
    required this.type,
    required this.directories,
    required this.destination,
  });

  PermissionUpdateDirectories._(
    this.type,
    Map<String, dynamic> json,
    this.destination,
  ) : directories = ((json['directories'] as List?) ?? const [])
          .map((e) => e.toString())
          .toList();

  @override
  Map<String, dynamic> toJson() => {
    'type': type,
    'directories': directories,
    'destination': destination.wire,
  };
}

/// The result returned by a [CanUseTool] callback. Mirrors `PermissionResult`
/// (an allow/deny union).
sealed class PermissionResult {
  const PermissionResult();

  /// `allow` or `deny`.
  String get behavior;

  /// Serializes to wire JSON.
  Map<String, dynamic> toJson();

  /// Parses [json] into [PermissionAllow] or [PermissionDeny].
  factory PermissionResult.fromJson(Map<String, dynamic> json) {
    final classification = json['decisionClassification'];
    final decision = classification is String
        ? PermissionDecisionClassification.fromWire(classification)
        : null;
    if (json['behavior'] == 'deny') {
      return PermissionDeny(
        message: json['message'] as String? ?? '',
        interrupt: json['interrupt'] as bool?,
        toolUseId: json['toolUseID'] as String?,
        decisionClassification: decision,
      );
    }
    final updatedPermissions = json['updatedPermissions'];
    return PermissionAllow(
      updatedInput: (json['updatedInput'] as Map?)?.cast<String, dynamic>(),
      updatedPermissions: updatedPermissions is List
          ? updatedPermissions
                .whereType<Map>()
                .map(
                  (m) => PermissionUpdate.fromJson(m.cast<String, dynamic>()),
                )
                .toList()
          : null,
      toolUseId: json['toolUseID'] as String?,
      decisionClassification: decision,
    );
  }
}

/// Allow result (`behavior: 'allow'`).
final class PermissionAllow extends PermissionResult {
  /// Replacement tool input, if the callback rewrote it.
  final Map<String, dynamic>? updatedInput;

  /// Permission rules to persist as a side effect of allowing.
  final List<PermissionUpdate>? updatedPermissions;

  /// The tool-use id this decision applies to (`toolUseID`).
  final String? toolUseId;

  /// How to classify this decision.
  final PermissionDecisionClassification? decisionClassification;

  PermissionAllow({
    this.updatedInput,
    this.updatedPermissions,
    this.toolUseId,
    this.decisionClassification,
  });

  @override
  String get behavior => 'allow';

  @override
  Map<String, dynamic> toJson() => {
    'behavior': behavior,
    if (updatedInput != null) 'updatedInput': updatedInput,
    if (updatedPermissions != null)
      'updatedPermissions': updatedPermissions!.map((u) => u.toJson()).toList(),
    if (toolUseId != null) 'toolUseID': toolUseId,
    if (decisionClassification != null)
      'decisionClassification': decisionClassification!.wire,
  };
}

/// Deny result (`behavior: 'deny'`).
final class PermissionDeny extends PermissionResult {
  /// The reason shown to the model/user.
  final String message;

  /// Whether to interrupt the run.
  final bool? interrupt;

  /// The tool-use id this decision applies to (`toolUseID`).
  final String? toolUseId;

  /// How to classify this decision.
  final PermissionDecisionClassification? decisionClassification;

  PermissionDeny({
    required this.message,
    this.interrupt,
    this.toolUseId,
    this.decisionClassification,
  });

  @override
  String get behavior => 'deny';

  @override
  Map<String, dynamic> toJson() => {
    'behavior': behavior,
    'message': message,
    if (interrupt != null) 'interrupt': interrupt,
    if (toolUseId != null) 'toolUseID': toolUseId,
    if (decisionClassification != null)
      'decisionClassification': decisionClassification!.wire,
  };
}

/// Context passed to a [CanUseTool] callback. Mirrors the SDK's
/// `{ suggestions?, signal }` argument; the payload is kept opaque ([raw])
/// until the reverse-RPC wiring (todos #4–#6) gives it structure.
class CanUseToolContext {
  /// The full context payload as received over the bridge.
  final Map<String, dynamic> raw;

  const CanUseToolContext(this.raw);

  /// Suggested permission updates, if the SDK provided any.
  List<PermissionUpdate> get suggestions {
    final list = raw['suggestions'];
    if (list is List) {
      return list
          .whereType<Map>()
          .map((m) => PermissionUpdate.fromJson(m.cast<String, dynamic>()))
          .toList();
    }
    return const [];
  }
}

/// Tool-approval callback. Mirrors `CanUseTool`.
///
/// Declared here as part of the 1:1 type surface; the reverse-RPC dispatch that
/// invokes it mid-query is wired in todo #6.
typedef CanUseTool =
    Future<PermissionResult> Function(
      String toolName,
      Map<String, dynamic> input,
      CanUseToolContext context,
    );
