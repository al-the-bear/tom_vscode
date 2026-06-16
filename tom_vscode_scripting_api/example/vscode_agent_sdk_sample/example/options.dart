/// Concept: the `Options` input surface for `query()`.
///
/// Run:  dart run bin/run_example.dart options
///
/// [Options] is the Dart mirror of the SDK's `Options` argument to
/// `sdk.query({ prompt, options })`. It travels Dart → extension → the real
/// SDK as a faithful pass-through, so [Options.toJson] uses the SDK's own
/// camelCase wire field names. This concept builds a few representative option
/// sets and prints the exact JSON that crosses the bridge — deterministic, and
/// the clearest way to see how the sealed sub-configs (`SystemPrompt`,
/// `ToolsConfig`, `ThinkingConfig`, `PermissionMode`, `EffortLevel`) serialize.
///
/// Expected output: three option sets rendered as their wire JSON.
library;

import 'dart:convert';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<bool> runOptionsExample(VSCodeBridgeClient client) async {
  print('  (bridge connected: ${client.isConnected}; '
      'this concept is offline-deterministic)');

  // 1. A minimal run: pick a model, cap the turns, plan-only (no tool exec).
  final minimal = Options(
    model: 'claude-sonnet-4-5',
    maxTurns: 1,
    permissionMode: PermissionMode.plan,
  );
  _dump('minimal', minimal);

  // 2. Constrained tools + an appended preset system prompt + a budget.
  final constrained = Options(
    systemPrompt: const SystemPromptPreset(
      append: 'Prefer terse answers.',
    ),
    tools: const ToolsList(['Read', 'Grep']),
    allowedTools: const ['Read', 'Grep'],
    disallowedTools: const ['Bash'],
    maxBudgetUsd: 0.50,
    permissionMode: PermissionMode.acceptEdits,
  );
  _dump('constrained', constrained);

  // 3. Extended thinking + reasoning effort + partial-message streaming.
  final thinking = Options(
    thinking: const ThinkingEnabled(budgetTokens: 4000, display: 'summarized'),
    effort: EffortLevel.high,
    includePartialMessages: true,
    additionalDirectories: const ['/extra/context'],
  );
  _dump('thinking', thinking);

  // Round-trip guarantee: data fields survive toJson → fromJson → toJson.
  final roundTrips =
      jsonEncode(Options.fromJson(constrained.toJson()).toJson()) ==
          jsonEncode(constrained.toJson());
  print('constrained options round-trip: $roundTrips');

  return roundTrips;
}

void _dump(String label, Options options) {
  const encoder = JsonEncoder.withIndent('  ');
  print('$label options.toJson():');
  print(encoder.convert(options.toJson()));
}
