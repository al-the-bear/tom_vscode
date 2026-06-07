/// Dart mirror of the Anthropic Agent SDK *output* surface: the `SDKMessage`
/// union and content blocks streamed by `sdk.query()`.
///
/// These values originate in the extension and cross the bridge unchanged, so
/// the design (proposal §7.0.3) is **raw-preserving**: every message and block
/// keeps its full original JSON in [raw], and `toJson()` returns it verbatim —
/// nothing is lost even for fields this mirror does not type. The five primary
/// message types are modelled with typed accessors; the long tail of
/// `type: 'system'` subtypes collapses into [SdkSystemEvent], and any future
/// top-level `type` lands in [SdkUnknownMessage].
///
/// Wire field names are the SDK's own (snake_case on messages/blocks).
library;

/// A single message yielded by an Agent SDK query stream.
///
/// Mirrors `SDKMessage`. Use [SdkMessage.fromJson] to parse a wire payload into
/// the appropriate typed subclass; [toJson] always reproduces [raw].
sealed class SdkMessage {
  /// The full original wire JSON for this message.
  final Map<String, dynamic> raw;

  const SdkMessage(this.raw);

  /// The SDK `type` discriminator (`assistant`, `user`, `result`, …).
  String get type => raw['type'] as String? ?? '';

  /// The session id the message belongs to (`session_id`).
  String? get sessionId => raw['session_id'] as String?;

  /// The message's unique id (`uuid`).
  String? get uuid => raw['uuid'] as String?;

  /// Reproduces the original wire JSON verbatim.
  Map<String, dynamic> toJson() => raw;

  /// Parses [json] into the matching [SdkMessage] subclass.
  factory SdkMessage.fromJson(Map<String, dynamic> json) {
    switch (json['type']) {
      case 'assistant':
        return SdkAssistantMessage(json);
      case 'user':
        return SdkUserMessage(json);
      case 'result':
        return SdkResultMessage(json);
      case 'system':
        return json['subtype'] == 'init'
            ? SdkSystemMessage(json)
            : SdkSystemEvent(json);
      case 'stream_event':
        return SdkPartialAssistantMessage(json);
      default:
        return SdkUnknownMessage(json);
    }
  }
}

/// Mirrors `SDKAssistantMessage` (`type: 'assistant'`).
final class SdkAssistantMessage extends SdkMessage {
  SdkAssistantMessage(super.raw);

  /// Id of the parent tool use, if this assistant turn is a sub-agent reply.
  String? get parentToolUseId => raw['parent_tool_use_id'] as String?;

  /// Optional error discriminator (`SDKAssistantMessageError`).
  String? get error => raw['error'] as String?;

  /// The underlying Anthropic message object.
  Map<String, dynamic>? get message =>
      (raw['message'] as Map?)?.cast<String, dynamic>();

  /// The assistant content blocks (`message.content`).
  List<ContentBlock> get content => _blocksOf(message?['content']);
}

/// Mirrors `SDKUserMessage` (`type: 'user'`, incl. the replay variant).
final class SdkUserMessage extends SdkMessage {
  SdkUserMessage(super.raw);

  /// Id of the parent tool use, if any.
  String? get parentToolUseId => raw['parent_tool_use_id'] as String?;

  /// Whether this is a replayed message (`isReplay`).
  bool get isReplay => raw['isReplay'] == true;

  /// The underlying Anthropic `MessageParam`.
  Map<String, dynamic>? get message =>
      (raw['message'] as Map?)?.cast<String, dynamic>();

  /// User content blocks when `message.content` is a block list (it may also be
  /// a plain string, in which case this is empty).
  List<ContentBlock> get content => _blocksOf(message?['content']);
}

/// Mirrors `SDKResultMessage` (`type: 'result'`, success or error subtype).
final class SdkResultMessage extends SdkMessage {
  SdkResultMessage(super.raw);

  /// `success` or `error`.
  String? get subtype => raw['subtype'] as String?;

  /// Whether the run ended in error (`is_error`).
  bool get isError => raw['is_error'] == true;

  /// The final textual result.
  String? get result => raw['result'] as String?;

  /// Number of model turns taken (`num_turns`).
  int? get numTurns => (raw['num_turns'] as num?)?.toInt();

  /// Total wall-clock duration in ms (`duration_ms`).
  int? get durationMs => (raw['duration_ms'] as num?)?.toInt();

  /// API duration in ms (`duration_api_ms`).
  int? get durationApiMs => (raw['duration_api_ms'] as num?)?.toInt();

  /// Stop reason reported by the model (`stop_reason`).
  String? get stopReason => raw['stop_reason'] as String?;

  /// Total cost of the run in USD (`total_cost_usd`).
  double? get totalCostUsd => (raw['total_cost_usd'] as num?)?.toDouble();

  /// Aggregate token usage.
  Map<String, dynamic>? get usage =>
      (raw['usage'] as Map?)?.cast<String, dynamic>();
}

/// Mirrors `SDKSystemMessage` (`type: 'system'`, `subtype: 'init'`).
final class SdkSystemMessage extends SdkMessage {
  SdkSystemMessage(super.raw);

  /// Always `init` for this message.
  String? get subtype => raw['subtype'] as String?;

  /// Active model id.
  String? get model => raw['model'] as String?;

  /// Working directory.
  String? get cwd => raw['cwd'] as String?;

  /// Available tool names.
  List<String> get tools => _stringList(raw['tools']);

  /// Initial permission mode (`permissionMode`).
  String? get permissionMode => raw['permissionMode'] as String?;

  /// Available slash commands (`slash_commands`).
  List<String> get slashCommands => _stringList(raw['slash_commands']);

  /// Where the API key came from (`apiKeySource`).
  String? get apiKeySource => raw['apiKeySource'] as String?;

  /// Connected MCP servers (`mcp_servers`).
  List<Map<String, dynamic>> get mcpServers {
    final list = raw['mcp_servers'];
    if (list is List) {
      return list
          .whereType<Map>()
          .map((m) => m.cast<String, dynamic>())
          .toList();
    }
    return const [];
  }
}

/// Mirrors `SDKPartialAssistantMessage` (`type: 'stream_event'`), emitted only
/// when `includePartialMessages` is set.
final class SdkPartialAssistantMessage extends SdkMessage {
  SdkPartialAssistantMessage(super.raw);

  /// The raw streaming event payload (`event`).
  Map<String, dynamic>? get event =>
      (raw['event'] as Map?)?.cast<String, dynamic>();

  /// Id of the parent tool use, if any.
  String? get parentToolUseId => raw['parent_tool_use_id'] as String?;
}

/// Carrier for the long tail of `type: 'system'` events that are not `init`
/// (e.g. `compact_boundary`, `status`, `task_progress`, `rate_limit`, …).
///
/// The [subtype] is exposed; the full payload remains in [raw].
final class SdkSystemEvent extends SdkMessage {
  SdkSystemEvent(super.raw);

  /// The system event subtype.
  String? get subtype => raw['subtype'] as String?;
}

/// Forward-compatible fallback for any top-level `type` this mirror does not
/// model. Preserves the full payload in [raw].
final class SdkUnknownMessage extends SdkMessage {
  SdkUnknownMessage(super.raw);
}

/// A content block inside an assistant or user message.
///
/// Mirrors the Anthropic Beta content-block union. Raw-preserving like
/// [SdkMessage]: [toJson] reproduces the original JSON.
sealed class ContentBlock {
  /// The full original wire JSON for this block.
  final Map<String, dynamic> raw;

  const ContentBlock(this.raw);

  /// The block `type` discriminator.
  String get type => raw['type'] as String? ?? '';

  /// Reproduces the original wire JSON verbatim.
  Map<String, dynamic> toJson() => raw;

  /// Parses [json] into the matching [ContentBlock] subclass.
  factory ContentBlock.fromJson(Map<String, dynamic> json) {
    switch (json['type']) {
      case 'text':
        return TextBlock(json);
      case 'thinking':
        return ThinkingBlock(json);
      case 'tool_use':
        return ToolUseBlock(json);
      case 'tool_result':
        return ToolResultBlock(json);
      default:
        return UnknownBlock(json);
    }
  }
}

/// Mirrors a `text` content block.
final class TextBlock extends ContentBlock {
  TextBlock(super.raw);

  /// The text content.
  String get text => raw['text'] as String? ?? '';
}

/// Mirrors a `thinking` content block.
final class ThinkingBlock extends ContentBlock {
  ThinkingBlock(super.raw);

  /// The thinking text.
  String get thinking => raw['thinking'] as String? ?? '';

  /// The optional cryptographic signature.
  String? get signature => raw['signature'] as String?;
}

/// Mirrors a `tool_use` content block.
final class ToolUseBlock extends ContentBlock {
  ToolUseBlock(super.raw);

  /// The tool-use id.
  String get id => raw['id'] as String? ?? '';

  /// The invoked tool name.
  String get name => raw['name'] as String? ?? '';

  /// The tool input arguments.
  Map<String, dynamic> get input =>
      (raw['input'] as Map?)?.cast<String, dynamic>() ?? const {};
}

/// Mirrors a `tool_result` content block.
final class ToolResultBlock extends ContentBlock {
  ToolResultBlock(super.raw);

  /// The id of the tool use this result answers (`tool_use_id`).
  String get toolUseId => raw['tool_use_id'] as String? ?? '';

  /// The result content — either a plain string or a list of nested blocks.
  Object? get content => raw['content'];

  /// Whether the tool reported an error (`is_error`).
  bool get isError => raw['is_error'] == true;
}

/// Forward-compatible fallback for any content block type this mirror does not
/// model (`redacted_thinking`, `server_tool_use`, image, …).
final class UnknownBlock extends ContentBlock {
  UnknownBlock(super.raw);
}

/// Parses a `message.content` value into typed blocks, ignoring non-list
/// content (e.g. a plain string body).
List<ContentBlock> _blocksOf(Object? content) {
  if (content is List) {
    return content
        .whereType<Map>()
        .map((b) => ContentBlock.fromJson(b.cast<String, dynamic>()))
        .toList();
  }
  return const [];
}

/// Coerces a JSON value into a `List<String>`, tolerating null/non-list.
List<String> _stringList(Object? value) {
  if (value is List) {
    return value.map((e) => e.toString()).toList();
  }
  return const [];
}
