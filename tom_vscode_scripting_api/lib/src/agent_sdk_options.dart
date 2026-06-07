/// Dart mirror of the Agent SDK input surface: [Options] (the argument to
/// `sdk.query({ prompt, options })`) plus its sealed sub-configs, value types
/// and enums.
///
/// These travel Dart → extension → `sdk.query()`, so the wire uses the SDK's
/// camelCase field names (`sdk.d.ts` ^0.2.110) and the bridge is a faithful
/// pass-through (proposal §1, §5). Every *data* field round-trips
/// (`Options.fromJson(o.toJson()).toJson() == o.toJson()`).
///
/// **Callback-bearing fields** ([Options.canUseTool], [Options.onStderr]) are
/// part of the 1:1 type surface but are *not* JSON data — they are dispatched
/// over the reverse RPC and wired in todos #5–#6, so [Options.toJson] omits
/// them. The richer callback fields (`hooks`, `onElicitation`, `sessionStore`)
/// and the bridge-managed fields (`abortController`, `executable`, …) are
/// intentionally absent — see proposal §7.0.5 and `completion_steps`.
library;

import 'agent_sdk_mcp.dart';
import 'agent_sdk_permissions.dart';

/// Where the agent loads filesystem settings from. Mirrors `SettingSource`.
enum SettingSource {
  /// User-level settings (`user`).
  user('user'),

  /// Project-level settings (`project`).
  project('project'),

  /// Local (gitignored) settings (`local`).
  local('local');

  const SettingSource(this.wire);

  /// The SDK wire string.
  final String wire;

  /// Parses an SDK wire string into a [SettingSource].
  static SettingSource fromWire(String value) =>
      values.firstWhere((e) => e.wire == value);
}

/// Reasoning-effort level. Mirrors `EffortLevel`.
enum EffortLevel {
  /// Lowest effort.
  low('low'),

  /// Medium effort.
  medium('medium'),

  /// High effort.
  high('high'),

  /// Extra-high effort.
  xhigh('xhigh'),

  /// Maximum effort.
  max('max');

  const EffortLevel(this.wire);

  /// The SDK wire string.
  final String wire;

  /// Parses an SDK wire string into an [EffortLevel].
  static EffortLevel fromWire(String value) =>
      values.firstWhere((e) => e.wire == value);
}

/// The system prompt. Mirrors `string | string[] | { type:'preset', … }`.
sealed class SystemPrompt {
  const SystemPrompt();

  /// Serializes to the SDK wire value (a string, list, or map).
  Object toWire();

  /// Parses an SDK wire value into a [SystemPrompt].
  factory SystemPrompt.fromWire(Object value) {
    if (value is String) return SystemPromptText(value);
    if (value is List) {
      return SystemPromptList(value.map((e) => e.toString()).toList());
    }
    if (value is Map) {
      final m = value.cast<String, dynamic>();
      return SystemPromptPreset(
        append: m['append'] as String?,
        excludeDynamicSections: m['excludeDynamicSections'] as bool?,
      );
    }
    throw ArgumentError('Unsupported systemPrompt value: $value');
  }
}

/// A plain-string system prompt.
final class SystemPromptText extends SystemPrompt {
  /// The prompt text.
  final String text;

  const SystemPromptText(this.text);

  @override
  Object toWire() => text;
}

/// A multi-section system prompt (string array).
final class SystemPromptList extends SystemPrompt {
  /// The prompt sections.
  final List<String> sections;

  const SystemPromptList(this.sections);

  @override
  Object toWire() => sections;
}

/// The Claude Code preset system prompt, optionally appended/trimmed.
final class SystemPromptPreset extends SystemPrompt {
  /// Extra instructions appended to the preset.
  final String? append;

  /// Whether to exclude dynamic sections.
  final bool? excludeDynamicSections;

  const SystemPromptPreset({this.append, this.excludeDynamicSections});

  @override
  Object toWire() => {
        'type': 'preset',
        'preset': 'claude_code',
        if (append != null) 'append': append,
        if (excludeDynamicSections != null)
          'excludeDynamicSections': excludeDynamicSections,
      };
}

/// The tool selection. Mirrors `string[] | { type:'preset', preset:'claude_code' }`.
sealed class ToolsConfig {
  const ToolsConfig();

  /// Serializes to the SDK wire value (a list or a preset map).
  Object toWire();

  /// Parses an SDK wire value into a [ToolsConfig].
  factory ToolsConfig.fromWire(Object value) {
    if (value is List) {
      return ToolsList(value.map((e) => e.toString()).toList());
    }
    if (value is Map) return const ToolsClaudeCodePreset();
    throw ArgumentError('Unsupported tools value: $value');
  }
}

/// An explicit list of tool names.
final class ToolsList extends ToolsConfig {
  /// The enabled tool names.
  final List<String> names;

  const ToolsList(this.names);

  @override
  Object toWire() => names;
}

/// The Claude Code default tool preset.
final class ToolsClaudeCodePreset extends ToolsConfig {
  const ToolsClaudeCodePreset();

  @override
  Object toWire() => {'type': 'preset', 'preset': 'claude_code'};
}

/// Extended-thinking configuration. Mirrors `ThinkingConfig`.
sealed class ThinkingConfig {
  const ThinkingConfig();

  /// Serializes to the SDK wire map.
  Map<String, dynamic> toWire();

  /// Parses an SDK wire map into a [ThinkingConfig].
  factory ThinkingConfig.fromWire(Map<String, dynamic> value) {
    switch (value['type']) {
      case 'enabled':
        return ThinkingEnabled(
          budgetTokens: (value['budgetTokens'] as num?)?.toInt(),
          display: value['display'] as String?,
        );
      case 'disabled':
        return const ThinkingDisabled();
      case 'adaptive':
        return ThinkingAdaptive(display: value['display'] as String?);
      default:
        throw ArgumentError('Unknown thinking type: ${value['type']}');
    }
  }
}

/// Adaptive thinking — the model decides (`type: 'adaptive'`).
final class ThinkingAdaptive extends ThinkingConfig {
  /// How thinking is displayed (`summarized` | `omitted`).
  final String? display;

  const ThinkingAdaptive({this.display});

  @override
  Map<String, dynamic> toWire() => {
        'type': 'adaptive',
        if (display != null) 'display': display,
      };
}

/// Fixed thinking budget (`type: 'enabled'`).
final class ThinkingEnabled extends ThinkingConfig {
  /// The thinking token budget.
  final int? budgetTokens;

  /// How thinking is displayed (`summarized` | `omitted`).
  final String? display;

  const ThinkingEnabled({this.budgetTokens, this.display});

  @override
  Map<String, dynamic> toWire() => {
        'type': 'enabled',
        if (budgetTokens != null) 'budgetTokens': budgetTokens,
        if (display != null) 'display': display,
      };
}

/// No extended thinking (`type: 'disabled'`).
final class ThinkingDisabled extends ThinkingConfig {
  const ThinkingDisabled();

  @override
  Map<String, dynamic> toWire() => {'type': 'disabled'};
}

/// The skills selection. Mirrors `string[] | 'all'`.
sealed class Skills {
  const Skills();

  /// Serializes to the SDK wire value (a list or the string `'all'`).
  Object toWire();

  /// Parses an SDK wire value into a [Skills].
  factory Skills.fromWire(Object value) {
    if (value == 'all') return const SkillsAll();
    if (value is List) {
      return SkillsList(value.map((e) => e.toString()).toList());
    }
    throw ArgumentError('Unsupported skills value: $value');
  }
}

/// An explicit list of skill names.
final class SkillsList extends Skills {
  /// The enabled skill names.
  final List<String> names;

  const SkillsList(this.names);

  @override
  Object toWire() => names;
}

/// Enable all skills (`'all'`).
final class SkillsAll extends Skills {
  const SkillsAll();

  @override
  Object toWire() => 'all';
}

/// A settings reference. Mirrors `string | Settings` (a path or an inline map).
sealed class SettingsRef {
  const SettingsRef();

  /// Serializes to the SDK wire value (a path string or an inline map).
  Object toWire();

  /// Parses an SDK wire value into a [SettingsRef].
  factory SettingsRef.fromWire(Object value) {
    if (value is String) return SettingsPath(value);
    if (value is Map) return SettingsInline(value.cast<String, dynamic>());
    throw ArgumentError('Unsupported settings value: $value');
  }
}

/// A path to a settings file.
final class SettingsPath extends SettingsRef {
  /// The settings file path.
  final String path;

  const SettingsPath(this.path);

  @override
  Object toWire() => path;
}

/// Inline settings.
final class SettingsInline extends SettingsRef {
  /// The settings map.
  final Map<String, dynamic> settings;

  const SettingsInline(this.settings);

  @override
  Object toWire() => settings;
}

/// Structured output configuration. Mirrors `{ type:'json_schema', schema }`.
class OutputFormat {
  /// The JSON Schema the result must conform to.
  final Map<String, dynamic> schema;

  OutputFormat({required this.schema});

  /// Parses from wire JSON.
  factory OutputFormat.fromJson(Map<String, dynamic> json) => OutputFormat(
        schema: (json['schema'] as Map?)?.cast<String, dynamic>() ?? const {},
      );

  /// Serializes to wire JSON.
  Map<String, dynamic> toJson() => {'type': 'json_schema', 'schema': schema};
}

/// A task budget. Mirrors `{ total }`.
class TaskBudget {
  /// The total budget.
  final num total;

  TaskBudget({required this.total});

  /// Parses from wire JSON.
  factory TaskBudget.fromJson(Map<String, dynamic> json) =>
      TaskBudget(total: json['total'] as num);

  /// Serializes to wire JSON.
  Map<String, dynamic> toJson() => {'total': total};
}

/// A local plugin configuration. Mirrors `SdkPluginConfig`.
class PluginConfig {
  /// The plugin directory path.
  final String path;

  PluginConfig({required this.path});

  /// Parses from wire JSON.
  factory PluginConfig.fromJson(Map<String, dynamic> json) =>
      PluginConfig(path: json['path'] as String);

  /// Serializes to wire JSON.
  Map<String, dynamic> toJson() => {'type': 'local', 'path': path};
}

/// A programmatic sub-agent definition. Mirrors `AgentDefinition`.
class AgentDefinition {
  /// A description of when to use the agent.
  final String description;

  /// The agent's system prompt.
  final String prompt;

  /// The tool names the agent may use.
  final List<String>? tools;

  /// The model the agent runs on.
  final String? model;

  AgentDefinition({
    required this.description,
    required this.prompt,
    this.tools,
    this.model,
  });

  /// Parses from wire JSON.
  factory AgentDefinition.fromJson(Map<String, dynamic> json) =>
      AgentDefinition(
        description: json['description'] as String,
        prompt: json['prompt'] as String,
        tools: (json['tools'] as List?)?.map((e) => e.toString()).toList(),
        model: json['model'] as String?,
      );

  /// Serializes to wire JSON.
  Map<String, dynamic> toJson() => {
        'description': description,
        'prompt': prompt,
        if (tools != null) 'tools': tools,
        if (model != null) 'model': model,
      };
}

/// Options for an Agent SDK query. Mirrors the SDK's `Options` type.
///
/// Only data fields are serialized; see the library docs for the callback and
/// bridge-managed fields that are intentionally excluded.
class Options {
  /// The primary model id.
  final String? model;

  /// A fallback model id.
  final String? fallbackModel;

  /// The system prompt.
  final SystemPrompt? systemPrompt;

  /// The tool selection.
  final ToolsConfig? tools;

  /// Explicitly allowed tool names.
  final List<String>? allowedTools;

  /// Explicitly disallowed tool names.
  final List<String>? disallowedTools;

  /// MCP servers, keyed by name.
  final Map<String, McpServerConfig>? mcpServers;

  /// Maximum number of agent turns.
  final int? maxTurns;

  /// Maximum spend in USD.
  final double? maxBudgetUsd;

  /// A structured task budget.
  final TaskBudget? taskBudget;

  /// The permission mode.
  final PermissionMode? permissionMode;

  /// Extra instructions shown in plan mode.
  final String? planModeInstructions;

  /// Whether to allow bypassing permissions.
  final bool? allowDangerouslySkipPermissions;

  /// The name of a tool used to prompt for permissions.
  final String? permissionPromptToolName;

  /// Where to load filesystem settings from.
  final List<SettingSource>? settingSources;

  /// User settings (path or inline).
  final SettingsRef? settings;

  /// Managed settings (path or inline).
  final SettingsRef? managedSettings;

  /// The working directory.
  final String? cwd;

  /// Additional accessible directories.
  final List<String>? additionalDirectories;

  /// Whether to continue the most recent session (`continue`).
  final bool? continueSession;

  /// The session id to resume.
  final String? resume;

  /// An explicit session id to use.
  final String? sessionId;

  /// A point in a session to resume at.
  final String? resumeSessionAt;

  /// Whether to fork the resumed session.
  final bool? forkSession;

  /// Whether to persist the session.
  final bool? persistSession;

  /// A custom session title.
  final String? title;

  /// Environment variables for the run.
  final Map<String, String>? env;

  /// Extra CLI arguments (values may be null for flags).
  final Map<String, String?>? extraArgs;

  /// Whether to use strict MCP config validation.
  final bool? strictMcpConfig;

  /// A single named agent to run.
  final String? agent;

  /// Named sub-agent definitions.
  final Map<String, AgentDefinition>? agents;

  /// The skills selection.
  final Skills? skills;

  /// Local plugins to load.
  final List<PluginConfig>? plugins;

  /// API beta flags.
  final List<String>? betas;

  /// Structured output format.
  final OutputFormat? outputFormat;

  /// Opaque tool configuration.
  final Map<String, dynamic>? toolConfig;

  /// Extended-thinking configuration.
  final ThinkingConfig? thinking;

  /// Reasoning effort level.
  final EffortLevel? effort;

  /// Deprecated thinking-token budget (use [thinking]).
  final int? maxThinkingTokens;

  /// Whether to stream partial assistant messages.
  final bool? includePartialMessages;

  /// Whether to emit hook events as messages.
  final bool? includeHookEvents;

  /// Whether to forward sub-agent text.
  final bool? forwardSubagentText;

  /// Whether to emit prompt suggestions.
  final bool? promptSuggestions;

  /// Whether to emit agent progress summaries.
  final bool? agentProgressSummaries;

  /// Whether to enable file checkpointing.
  final bool? enableFileCheckpointing;

  /// Opaque sandbox settings (`SandboxSettings`).
  final Map<String, dynamic>? sandbox;

  /// Whether to enable debug logging.
  final bool? debug;

  /// A file to write debug logs to.
  final String? debugFile;

  /// SDK load timeout in milliseconds.
  final int? loadTimeoutMs;

  /// Tool-approval callback (wired in todo #6; never serialized).
  final CanUseTool? canUseTool;

  /// Stderr line callback (wired in todo #6; never serialized).
  final void Function(String line)? onStderr;

  Options({
    this.model,
    this.fallbackModel,
    this.systemPrompt,
    this.tools,
    this.allowedTools,
    this.disallowedTools,
    this.mcpServers,
    this.maxTurns,
    this.maxBudgetUsd,
    this.taskBudget,
    this.permissionMode,
    this.planModeInstructions,
    this.allowDangerouslySkipPermissions,
    this.permissionPromptToolName,
    this.settingSources,
    this.settings,
    this.managedSettings,
    this.cwd,
    this.additionalDirectories,
    this.continueSession,
    this.resume,
    this.sessionId,
    this.resumeSessionAt,
    this.forkSession,
    this.persistSession,
    this.title,
    this.env,
    this.extraArgs,
    this.strictMcpConfig,
    this.agent,
    this.agents,
    this.skills,
    this.plugins,
    this.betas,
    this.outputFormat,
    this.toolConfig,
    this.thinking,
    this.effort,
    this.maxThinkingTokens,
    this.includePartialMessages,
    this.includeHookEvents,
    this.forwardSubagentText,
    this.promptSuggestions,
    this.agentProgressSummaries,
    this.enableFileCheckpointing,
    this.sandbox,
    this.debug,
    this.debugFile,
    this.loadTimeoutMs,
    this.canUseTool,
    this.onStderr,
  });

  /// Parses [Options] from its wire JSON (data fields only; callbacks are not
  /// transported).
  factory Options.fromJson(Map<String, dynamic> json) {
    Object? v(String key) => json[key];
    return Options(
      model: v('model') as String?,
      fallbackModel: v('fallbackModel') as String?,
      systemPrompt: v('systemPrompt') == null
          ? null
          : SystemPrompt.fromWire(v('systemPrompt')!),
      tools: v('tools') == null ? null : ToolsConfig.fromWire(v('tools')!),
      allowedTools: _strings(v('allowedTools')),
      disallowedTools: _strings(v('disallowedTools')),
      mcpServers: (v('mcpServers') as Map?)?.map(
        (k, val) => MapEntry(
          '$k',
          McpServerConfig.fromJson((val as Map).cast<String, dynamic>()),
        ),
      ),
      maxTurns: (v('maxTurns') as num?)?.toInt(),
      maxBudgetUsd: (v('maxBudgetUsd') as num?)?.toDouble(),
      taskBudget: v('taskBudget') == null
          ? null
          : TaskBudget.fromJson((v('taskBudget') as Map).cast<String, dynamic>()),
      permissionMode: v('permissionMode') == null
          ? null
          : PermissionMode.fromWire(v('permissionMode') as String),
      planModeInstructions: v('planModeInstructions') as String?,
      allowDangerouslySkipPermissions:
          v('allowDangerouslySkipPermissions') as bool?,
      permissionPromptToolName: v('permissionPromptToolName') as String?,
      settingSources: (v('settingSources') as List?)
          ?.map((e) => SettingSource.fromWire(e as String))
          .toList(),
      settings: v('settings') == null
          ? null
          : SettingsRef.fromWire(v('settings')!),
      managedSettings: v('managedSettings') == null
          ? null
          : SettingsRef.fromWire(v('managedSettings')!),
      cwd: v('cwd') as String?,
      additionalDirectories: _strings(v('additionalDirectories')),
      continueSession: v('continue') as bool?,
      resume: v('resume') as String?,
      sessionId: v('sessionId') as String?,
      resumeSessionAt: v('resumeSessionAt') as String?,
      forkSession: v('forkSession') as bool?,
      persistSession: v('persistSession') as bool?,
      title: v('title') as String?,
      env: (v('env') as Map?)?.map((k, val) => MapEntry('$k', '$val')),
      extraArgs: (v('extraArgs') as Map?)
          ?.map((k, val) => MapEntry('$k', val as String?)),
      strictMcpConfig: v('strictMcpConfig') as bool?,
      agent: v('agent') as String?,
      agents: (v('agents') as Map?)?.map(
        (k, val) => MapEntry(
          '$k',
          AgentDefinition.fromJson((val as Map).cast<String, dynamic>()),
        ),
      ),
      skills: v('skills') == null ? null : Skills.fromWire(v('skills')!),
      plugins: (v('plugins') as List?)
          ?.whereType<Map>()
          .map((m) => PluginConfig.fromJson(m.cast<String, dynamic>()))
          .toList(),
      betas: _strings(v('betas')),
      outputFormat: v('outputFormat') == null
          ? null
          : OutputFormat.fromJson(
              (v('outputFormat') as Map).cast<String, dynamic>()),
      toolConfig: (v('toolConfig') as Map?)?.cast<String, dynamic>(),
      thinking: v('thinking') == null
          ? null
          : ThinkingConfig.fromWire((v('thinking') as Map).cast<String, dynamic>()),
      effort: v('effort') == null
          ? null
          : EffortLevel.fromWire(v('effort') as String),
      maxThinkingTokens: (v('maxThinkingTokens') as num?)?.toInt(),
      includePartialMessages: v('includePartialMessages') as bool?,
      includeHookEvents: v('includeHookEvents') as bool?,
      forwardSubagentText: v('forwardSubagentText') as bool?,
      promptSuggestions: v('promptSuggestions') as bool?,
      agentProgressSummaries: v('agentProgressSummaries') as bool?,
      enableFileCheckpointing: v('enableFileCheckpointing') as bool?,
      sandbox: (v('sandbox') as Map?)?.cast<String, dynamic>(),
      debug: v('debug') as bool?,
      debugFile: v('debugFile') as String?,
      loadTimeoutMs: (v('loadTimeoutMs') as num?)?.toInt(),
    );
  }

  /// Serializes the data fields to wire JSON. Callback fields are omitted (they
  /// are dispatched over the reverse RPC, not as data).
  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{};
    void put(String key, Object? value) {
      if (value != null) json[key] = value;
    }

    put('model', model);
    put('fallbackModel', fallbackModel);
    put('systemPrompt', systemPrompt?.toWire());
    put('tools', tools?.toWire());
    put('allowedTools', allowedTools);
    put('disallowedTools', disallowedTools);
    put('mcpServers',
        mcpServers?.map((k, val) => MapEntry(k, val.toJson())));
    put('maxTurns', maxTurns);
    put('maxBudgetUsd', maxBudgetUsd);
    put('taskBudget', taskBudget?.toJson());
    put('permissionMode', permissionMode?.wire);
    put('planModeInstructions', planModeInstructions);
    put('allowDangerouslySkipPermissions', allowDangerouslySkipPermissions);
    put('permissionPromptToolName', permissionPromptToolName);
    put('settingSources', settingSources?.map((s) => s.wire).toList());
    put('settings', settings?.toWire());
    put('managedSettings', managedSettings?.toWire());
    put('cwd', cwd);
    put('additionalDirectories', additionalDirectories);
    put('continue', continueSession);
    put('resume', resume);
    put('sessionId', sessionId);
    put('resumeSessionAt', resumeSessionAt);
    put('forkSession', forkSession);
    put('persistSession', persistSession);
    put('title', title);
    put('env', env);
    put('extraArgs', extraArgs);
    put('strictMcpConfig', strictMcpConfig);
    put('agent', agent);
    put('agents', agents?.map((k, val) => MapEntry(k, val.toJson())));
    put('skills', skills?.toWire());
    put('plugins', plugins?.map((p) => p.toJson()).toList());
    put('betas', betas);
    put('outputFormat', outputFormat?.toJson());
    put('toolConfig', toolConfig);
    put('thinking', thinking?.toWire());
    put('effort', effort?.wire);
    put('maxThinkingTokens', maxThinkingTokens);
    put('includePartialMessages', includePartialMessages);
    put('includeHookEvents', includeHookEvents);
    put('forwardSubagentText', forwardSubagentText);
    put('promptSuggestions', promptSuggestions);
    put('agentProgressSummaries', agentProgressSummaries);
    put('enableFileCheckpointing', enableFileCheckpointing);
    put('sandbox', sandbox);
    put('debug', debug);
    put('debugFile', debugFile);
    put('loadTimeoutMs', loadTimeoutMs);
    // Callback-bearing field: cross the wire as a capability flag (proposal
    // §7.7), never the function. The extension installs a real callback that
    // calls back into Dart over the #4 reverse RPC when it sees this flag.
    if (canUseTool != null) put('canUseTool', true);
    return json;
  }
}

/// Coerces a JSON value into a `List<String>?`, tolerating null/non-list.
List<String>? _strings(Object? value) {
  if (value is List) return value.map((e) => e.toString()).toList();
  return null;
}
