/// Concept: read workspace metadata — info, projects, quests, active quest.
///
/// Run:  dart run bin/run_example.dart workspace_metadata
///
/// `TomWorkspaceApi` is the extension's view of the *workspace as a Tom
/// project tree*: the workspace name and root, the registered projects, the
/// quests, and which quest is active. It is the API the discovery helpers
/// themselves use (`workspace.getInfoVce`) to tell one window from another.
///
/// Like every API in this sample it is a static-method class — call
/// `TomWorkspaceApi.setAdapter(adapter)` once before use. This concept is
/// strictly read-only.
///
/// Expected output:
///   Workspace "tom_agent_container" — 120 projects, 38 quests.
///   Active quest: vscode_extension
///   First 3 projects: tom_basics, tom_build_base, tom_crypto
///   First 3 quests: build_tom, c2dart, cli_dartbridge
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: set the adapter, then read info / projects / quests.
Future<bool> runWorkspaceMetadataExample(VSCodeAdapter adapter) async {
  TomWorkspaceApi.setAdapter(adapter);

  final info = await TomWorkspaceApi.getInfo();
  print(
    'Workspace "${info.name}" — ${info.projectCount} projects, '
    '${info.questCount} quests.',
  );

  final active = await TomWorkspaceApi.getActiveQuest();
  print('Active quest: ${active?.id ?? '<none>'}');

  final projects = await TomWorkspaceApi.listProjects();
  final projectNames = projects.projects.take(3).map((p) => p.id).join(', ');
  print('First 3 projects: ${projectNames.isEmpty ? '<none>' : projectNames}');

  final quests = await TomWorkspaceApi.listQuests();
  final questIds = quests.quests.take(3).map((q) => q.id).join(', ');
  print('First 3 quests: ${questIds.isEmpty ? '<none>' : questIds}');

  // A populated workspace reports at least one project.
  return projects.projects.isNotEmpty;
}
