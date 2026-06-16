/// Concept: read todos across scopes (quest / workspace / session).
///
/// Run:  dart run bin/run_example.dart todos
///
/// `TomTodoApi` is CRUD over the three todo scopes plus a combined view. This
/// concept stays read-only — it lists the combined set and breaks it down by
/// status — so it never disturbs real quest or session todos. (The full API
/// also offers create / update / delete / move per scope.)
///
/// Expected output:
///   12 todos across all scopes.
///   By status: not-started=7, in-progress=2, completed=3
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: set the adapter, list all todos, tally by status.
Future<bool> runTodosExample(VSCodeAdapter adapter) async {
  TomTodoApi.setAdapter(adapter);

  final all = await TomTodoApi.listAllTodos();
  print('${all.todos.length} todos across all scopes.');

  final counts = <TodoStatus, int>{};
  for (final todo in all.todos) {
    counts.update(todo.status, (n) => n + 1, ifAbsent: () => 1);
  }
  final breakdown = counts.entries
      .map((e) => '${e.key.value}=${e.value}')
      .join(', ');
  print('By status: ${breakdown.isEmpty ? '<no todos>' : breakdown}');

  // Listing succeeds even when the workspace has zero todos; the call
  // returning without throwing is the success condition.
  return true;
}
