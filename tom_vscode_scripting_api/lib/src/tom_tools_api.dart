/// Tom LLM Tools API for scripting access to the extension's tool registry.
///
/// Exposes the same LLM tools the Tom VS Code extension offers to its chat
/// transports, so a script can:
///
/// - [invokeTool] — universally invoke any registered tool by name with a
///   JSON argument map, receiving the tool's string result.
/// - [getToolsJson] — generate the Anthropic-shaped tools JSON to inject into
///   a prompt. The set reflects the currently active Anthropic profile's tool
///   settings. When the configured Send-to-Chat target is Copilot, the list
///   is empty.
///
/// ## Gating contract (enforced server-side)
///
/// Both the listing ([getToolsJson]) and the invocation ([invokeTool]) are
/// scoped to the **currently active Anthropic profile**:
///
/// - The available tools are exactly the profile's tool set
///   (`toolsEnabled` / `enabledTools`).
/// - When the Send-to-Chat target is Copilot, **no** tools are available — the
///   list is empty and every invoke is refused.
///
/// The gate lives **inside the VS Code extension**, not in this Dart API. This
/// package is a thin pass-through: it performs **no** client-side filtering and
/// adds no checks of its own. A tool the active profile hides cannot be invoked
/// by passing its name to [invokeTool] — the extension refuses it before the
/// executor runs and returns an error string. The extension is the single
/// authority, so a buggy or malicious client cannot widen its own access.
// ignore_for_file: avoid_classes_with_only_static_members
library;

import 'vscode_adapter.dart';

// ============================================================================
// Types
// ============================================================================

/// An Anthropic-shaped tool definition: `{name, description, input_schema}`.
class ToolDefinitionJson {
  final String name;
  final String description;
  final Map<String, dynamic> inputSchema;

  ToolDefinitionJson({
    required this.name,
    required this.description,
    required this.inputSchema,
  });

  factory ToolDefinitionJson.fromJson(Map<String, dynamic> json) {
    return ToolDefinitionJson(
      name: json['name'] as String? ?? '',
      description: json['description'] as String? ?? '',
      inputSchema: (json['input_schema'] as Map?)?.cast<String, dynamic>() ?? {},
    );
  }

  /// Convert back to the Anthropic wire shape (`input_schema`, not
  /// `inputSchema`) so the result can be injected into a prompt verbatim.
  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'description': description,
      'input_schema': inputSchema,
    };
  }
}

// ============================================================================
// API
// ============================================================================

/// Scripting access to the Tom extension's LLM tool registry.
///
/// All methods throw [StateError] when the adapter has not been set.
abstract class TomToolsApi {
  static VSCodeAdapter? _adapter;

  /// Set the adapter for API calls.
  static void setAdapter(VSCodeAdapter adapter) {
    _adapter = adapter;
  }

  static VSCodeAdapter get _requireAdapter {
    if (_adapter == null) {
      throw StateError('TomToolsApi: adapter not set. Call setAdapter() first.');
    }
    return _adapter!;
  }

  /// Universally invoke a registered tool by name.
  ///
  /// [name] is the tool name (e.g. `tomAi_readFile`). [arguments] is the
  /// tool's argument map. Returns the tool's string result; unknown tools and
  /// execution failures surface as an error string (the tool registry never
  /// throws across the bridge for these cases).
  ///
  /// **Gated by the active Anthropic profile, enforced server-side.** Only
  /// tools the current profile permits can be invoked; a name the profile hides
  /// — or any name while the Send-to-Chat target is Copilot — is refused inside
  /// the extension **before** the executor runs, returning an error string.
  /// This package applies no filtering of its own; the extension is the sole
  /// authority. The set of invokable tools matches the names returned by
  /// [getToolsJson].
  static Future<String> invokeTool(
    String name, [
    Map<String, dynamic> arguments = const {},
  ]) async {
    final result = await _requireAdapter.sendRequest('tools.invokeVce', {
      'name': name,
      'arguments': arguments,
    });
    return result['result'] as String? ?? '';
  }

  /// Generate the Anthropic-shaped tools JSON for the active profile.
  ///
  /// Reflects the currently active Anthropic profile's tool settings
  /// (`toolsEnabled` / `enabledTools`). Returns an empty list when the
  /// configured Send-to-Chat target is Copilot.
  ///
  /// The returned set is resolved **server-side** by the extension and is the
  /// authoritative list of invokable tools: the same gate scopes [invokeTool],
  /// so a name absent from this list cannot be invoked. No Dart-side filtering
  /// is applied here.
  static Future<List<ToolDefinitionJson>> getToolsJson() async {
    final result = await _requireAdapter.sendRequest('tools.getJsonVce', {});
    final tools = result['tools'] as List? ?? [];
    return tools
        .map((t) => ToolDefinitionJson.fromJson(t as Map<String, dynamic>))
        .toList();
  }

  /// The names of the tools the active profile permits — a cheap convenience
  /// for pre-validating a name before calling [invokeTool].
  ///
  /// Backed by the same `tools.getJsonVce` op as [getToolsJson] (so it honours
  /// the identical server-side gate: active-profile scoped, empty for the
  /// Copilot target). This is an ergonomic shortcut only — the extension still
  /// re-checks on [invokeTool], so skipping the pre-check is always safe.
  static Future<List<String>> listAllowedToolNames() async {
    final tools = await getToolsJson();
    return tools.map((t) => t.name).toList();
  }
}
