/// Concept: inspect the LLM tool registry the active profile exposes.
///
/// Run:  dart run bin/run_example.dart tools
///
/// `TomToolsApi` exposes the same LLM tools the Tom extension offers its chat
/// transports. A script can list them (`getToolsJson` / `listAllowedToolNames`)
/// and invoke any of them by name (`invokeTool`). The set is gated server-side
/// by the **active Anthropic profile**: it is exactly that profile's tool set,
/// and it is *empty* when the Send-to-Chat target is Copilot.
///
/// This concept lists the allowed tools and prints the first few names. It does
/// **not** invoke a tool — invocation has effects that depend on the tool, and
/// the point here is to show the gated registry, not to run something. (When the
/// list is empty — the Copilot target, or a profile with no tools — that is a
/// valid configuration, not a failure.)
///
/// Expected output:
///   18 tools available to the active profile.
///   First 5: tomAi_readFile, tomAi_listProjects, tomAi_getWorkspaceInfo, …
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: set the adapter, list the profile's allowed tool names.
Future<bool> runToolsExample(VSCodeAdapter adapter) async {
  TomToolsApi.setAdapter(adapter);

  final names = await TomToolsApi.listAllowedToolNames();
  print('${names.length} tools available to the active profile.');

  if (names.isEmpty) {
    // Empty is a valid state: the Send-to-Chat target is Copilot, or the
    // active profile enables no tools. The gate lives in the extension.
    print('First 5: <none — Copilot target or no tools enabled>');
  } else {
    final first = names.take(5).join(', ');
    print('First 5: $first${names.length > 5 ? ', …' : ''}');
  }

  // Listing succeeds regardless of how many tools the profile permits; the call
  // returning without throwing is the success condition.
  return true;
}
