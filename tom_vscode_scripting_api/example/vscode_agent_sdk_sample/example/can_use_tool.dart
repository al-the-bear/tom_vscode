/// Concept: the `canUseTool` permission callback.
///
/// Run:  dart run bin/run_example.dart can_use_tool
///
/// [Options.canUseTool] is a Dart callback the SDK consults *before* every tool
/// call. It receives the tool name, the proposed input, and a
/// [CanUseToolContext], and returns a [PermissionResult] — either a
/// [PermissionAllow] (optionally rewriting the input or persisting rules) or a
/// [PermissionDeny] (with a reason, optionally interrupting the run). The
/// callback is dispatched over the reverse RPC mid-query; on the wire
/// [Options.toJson] sends only a capability flag, never the function.
///
/// This concept defines a policy callback and invokes it directly against a few
/// scenarios to show each decision shape — deterministic, no live run required.
///
/// Expected output: an allow (verbatim), an allow with rewritten input, and a
/// deny — each rendered as its wire JSON; plus the `canUseTool: true` flag in
/// the serialized options.
library;

import 'dart:convert';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<bool> runCanUseToolExample(VSCodeBridgeClient client) async {
  print('  (bridge connected: ${client.isConnected}; '
      'this concept is offline-deterministic)');

  // A small policy: allow reads, sanitise risky Bash, deny writes outside cwd.
  Future<PermissionResult> policy(
    String toolName,
    Map<String, dynamic> input,
    CanUseToolContext context,
  ) async {
    if (toolName == 'Read' || toolName == 'Grep') {
      return PermissionAllow();
    }
    if (toolName == 'Bash') {
      final command = (input['command'] as String?) ?? '';
      if (command.contains('rm -rf')) {
        return PermissionDeny(
          message: 'Refusing destructive command: $command',
          interrupt: true,
        );
      }
      // Allow, but force a dry run by rewriting the input.
      return PermissionAllow(updatedInput: {...input, 'dryRun': true});
    }
    return PermissionDeny(message: 'Tool "$toolName" is not permitted.');
  }

  // Scenario 1: a read — allowed verbatim.
  final allow = await policy('Read', {'path': 'README.md'}, _ctx());
  _dump('Read -> allow', allow);

  // Scenario 2: a Bash command — allowed but rewritten to a dry run.
  final rewritten =
      await policy('Bash', {'command': 'npm test'}, _ctx());
  _dump('Bash npm test -> allow (rewritten)', rewritten);

  // Scenario 3: a destructive command — denied, interrupting the run.
  final deny =
      await policy('Bash', {'command': 'rm -rf /'}, _ctx());
  _dump('Bash rm -rf -> deny', deny);

  // On the wire, Options carries only the capability flag — never the closure.
  final options = Options(canUseTool: policy);
  final wireHasFlag = options.toJson()['canUseTool'] == true;
  print('options.toJson() canUseTool flag present (not the function): '
      '$wireHasFlag');

  final ok = allow is PermissionAllow &&
      rewritten is PermissionAllow &&
      rewritten.updatedInput?['dryRun'] == true &&
      deny is PermissionDeny &&
      deny.interrupt == true &&
      wireHasFlag;
  return ok;
}

CanUseToolContext _ctx() => const CanUseToolContext({});

void _dump(String label, PermissionResult result) {
  print('$label: ${jsonEncode(result.toJson())}');
}
