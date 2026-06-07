/// Dart-side dispatch for the SDK's `canUseTool` approval callback (proposal
/// §7.5/§7.7, todo #6).
///
/// A query's [Options.canUseTool] is a Dart [CanUseTool] callback. It does not
/// cross the bridge as data — [Options.toJson] emits only a `canUseTool: true`
/// capability flag, and the extension installs a real callback that, whenever
/// the model requests a tool, issues an `agentSdk.canUseTool` request back over
/// the #4 reverse RPC. [AgentSdkClient] routes that request here.
///
/// This function is the bridge half: it turns the incoming request `params`
/// into a [CanUseTool] invocation and serializes the returned
/// [PermissionResult] back to wire JSON. It is pure (no socket, no `dart:io`)
/// so it is unit-testable on its own and reused by the bridge-backed transport.
library;

import 'agent_sdk_permissions.dart';

/// Invokes [callback] for an incoming `agentSdk.canUseTool` request and returns
/// its [PermissionResult] as wire JSON.
///
/// [params] carries `toolName`, `input`, and optional `suggestions` (plus the
/// routing `streamId`, unused here). The full payload is exposed to the
/// callback via [CanUseToolContext] so `context.suggestions` resolves.
Future<Map<String, dynamic>> dispatchCanUseTool(
  CanUseTool callback,
  Map<String, dynamic> params,
) async {
  final toolName = params['toolName'] as String? ?? '';
  final input = (params['input'] as Map?)?.cast<String, dynamic>() ?? const {};
  final result = await callback(toolName, input, CanUseToolContext(params));
  return result.toJson();
}
