/// Tests for the todo facade over the shared todo model (tom_todo_model).
///
/// The extension answers in two shapes: quest and workspace todos as their
/// YAML fields plus `_sourceFile` / `_extra` (fields its reader does not
/// enumerate), session todos as `{id, title, details, status: pending|done,
/// createdAt, ...}`; `todo.listAllVce` adds `_scope`. [TodoWire] maps both
/// onto [TomTodo] and back.
///
///   TODOAPI-1 a quest todo: every schema field, `_sourceFile` kept beside it
///   TODOAPI-2 `_extra`: schema fields merged into the todo, others kept apart
///   TODOAPI-3 dates: `YYYY-MM-DD`, or the date of an ISO timestamp
///   TODOAPI-4 a todo without a title takes its id as the title
///   TODOAPI-5 a session todo: details, pending/done, createdAt/updatedAt
///   TODOAPI-6 writing: the schema map for quest/workspace, the session shape
///   TODOAPI-7 a list keeps the todos it can read and names the ones it cannot
///   TODOAPI-8 the API: ops, params, `_scope`, a missing todo is null
library;

import 'package:test/test.dart';
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

class _FakeAdapter implements VSCodeAdapter {
  String? lastMethod;
  Map<String, dynamic>? lastParams;
  final Map<String, dynamic> response;

  _FakeAdapter(this.response);

  @override
  Future<Map<String, dynamic>> sendRequest(
    String method,
    Map<String, dynamic> params, {
    String? scriptName,
    Duration timeout = const Duration(seconds: 60),
  }) async {
    lastMethod = method;
    lastParams = params;
    return response;
  }
}

Map<String, dynamic> _questJson() => {
  'id': 'vex1_ajug-add-retry',
  'title': 'Add retry',
  'description': 'Retry the send.',
  'status': 'decision-needed',
  'priority': 'high',
  'tags': ['queue'],
  'scope': {
    'project': 'tom_vscode_extension',
    'files': ['src/a.ts'],
  },
  'references': [
    {'path': 'src/a.ts', 'lines': '1-4'},
  ],
  'dependencies': ['vex0'],
  'blocked_by': ['vex2'],
  'decisions': [
    {'summary': 'How often', 'decision_needed': 'Once or twice?'},
  ],
  'notes': 'n',
  'created': '2026-10-20',
  'updated': '2026-10-21',
  'completed_by': 'x',
  'execution_role': 'software_engineer',
  'bundle_id': 'b1',
  '_sourceFile': 'todos.vscode_extension.todo.yaml',
};

void main() {
  group('TodoWire.fromBridge', () {
    test('TODOAPI-1: a quest todo with every field it carries', () {
      final entry = TodoWire.fromBridge(_questJson());
      final todo = entry.todo;
      expect(todo.id, 'vex1_ajug-add-retry');
      expect(todo.title, 'Add retry');
      expect(todo.status, TomTodoStatus.decisionNeeded);
      expect(todo.priority, TomTodoPriority.high);
      expect(todo.scope!.files, ['src/a.ts']);
      expect(todo.references.single.lines, '1-4');
      expect(todo.blockedBy, ['vex2']);
      expect(todo.decisions.single.isOpen, isTrue);
      expect(todo.executionRole, 'software_engineer');
      expect(todo.bundleId, 'b1');
      expect(TomTodo.encodeDate(todo.created!), '2026-10-20');
      expect(entry.sourceFile, 'todos.vscode_extension.todo.yaml');
      expect(entry.level, isNull);
      expect(entry.unknownFields, isEmpty);
    });

    test('TODOAPI-2: _extra fields the schema has join the todo', () {
      final json = _questJson()
        ..['_extra'] = {
          'due': '2026-11-01',
          'estimate': 'PT2H',
          'blocked_until': ['tom_todo_model >= 1.1.0'],
          'author': 'me',
          'my_own_key': 42,
        };
      final entry = TodoWire.fromBridge(json);
      expect(TomTodo.encodeDate(entry.todo.due!), '2026-11-01');
      expect(entry.todo.estimate, 'PT2H');
      expect(entry.todo.blockedUntil, ['tom_todo_model >= 1.1.0']);
      expect(entry.todo.author, 'me');
      expect(entry.unknownFields, {'my_own_key': 42});
    });

    test('TODOAPI-3: dates are dates, a timestamp gives its date', () {
      final json = _questJson()
        ..['created'] = '2026-10-20T13:45:00.000Z'
        ..['completed_date'] = '2026-10-21';
      final todo = TodoWire.fromBridge(json).todo;
      expect(TomTodo.encodeDate(todo.created!), '2026-10-20');
      expect(TomTodo.encodeDate(todo.completedDate!), '2026-10-21');
      final bad = TodoWire.fromBridge(_questJson()..['updated'] = 'yesterday');
      expect(bad.todo.updated, isNull);
      expect(bad.unknownFields, {'updated': 'yesterday'});
    });

    test('TODOAPI-4: no title: the id stands in', () {
      final json = _questJson()..remove('title');
      expect(TodoWire.fromBridge(json).todo.title, 'vex1_ajug-add-retry');
    });

    test('TODOAPI-5: a session todo', () {
      final entry = TodoWire.fromBridge({
        'id': 'wt-3',
        'title': 'Look at the log',
        'details': 'after the build',
        'priority': 'medium',
        'tags': ['later'],
        'status': 'done',
        'createdAt': '2026-10-19T08:00:00.000Z',
        'updatedAt': '2026-10-21T09:30:00.000Z',
        'source': 'copilot',
        '_scope': 'session',
      });
      expect(entry.level, TodoLevel.session);
      expect(entry.todo.description, 'after the build');
      expect(entry.todo.status, TomTodoStatus.completed);
      expect(TomTodo.encodeDate(entry.todo.created!), '2026-10-19');
      expect(TomTodo.encodeDate(entry.todo.updated!), '2026-10-21');
      expect(entry.unknownFields, {'source': 'copilot'});
      final pending = TodoWire.fromBridge({
        'id': 'wt-4',
        'title': 't',
        'status': 'pending',
        'priority': 'low',
        'tags': <String>[],
        'createdAt': '2026-10-19T08:00:00.000Z',
        'updatedAt': '2026-10-19T08:00:00.000Z',
        'source': 'user',
      });
      expect(pending.level, TodoLevel.session, reason: 'known by its shape');
      expect(pending.todo.status, TomTodoStatus.notStarted);
    });
  });

  group('TodoWire.toBridge', () {
    test('TODOAPI-6: the schema map, and the session shape', () {
      final todo = TodoWire.fromBridge(_questJson()).todo;
      final map = TodoWire.toBridge(todo);
      expect(map, todo.toMap());
      expect(map.containsKey('_sourceFile'), isFalse);

      final session = TomTodo(
        id: 'wt-5',
        title: 'Check',
        description: 'the queue',
        status: TomTodoStatus.completed,
        priority: TomTodoPriority.high,
        tags: ['q'],
      );
      expect(TodoWire.toSessionBridge(session), {
        'id': 'wt-5',
        'title': 'Check',
        'details': 'the queue',
        'status': 'done',
        'priority': 'high',
        'tags': ['q'],
      });
      session.status = TomTodoStatus.inProgress;
      expect(TodoWire.toSessionBridge(session)['status'], 'pending');
    });
  });

  group('TomTodoApi', () {
    test('TODOAPI-7: a list keeps what it can read, names the rest', () async {
      TomTodoApi.setAdapter(
        _FakeAdapter({
          'todos': [
            _questJson(),
            {'id': 'broken', 'title': 't', 'status': 'someday'},
          ],
          'questId': 'vscode_extension',
        }),
      );
      final result = await TomTodoApi.listQuestTodos('vscode_extension');
      expect(result.todos.map((t) => t.id), ['vex1_ajug-add-retry']);
      expect(result.entries.single.sourceFile, isNotNull);
      expect(result.questId, 'vscode_extension');
      expect(result.invalid.single.id, 'broken');
      expect(result.invalid.single.error, contains('someday'));
    });

    test('TODOAPI-8: ops, params, scope and a missing todo', () async {
      final adapter = _FakeAdapter({
        'todos': [
          _questJson()..['_scope'] = 'quest',
          {
            'id': 'wt-1',
            'title': 's',
            'status': 'pending',
            'priority': 'medium',
            'tags': <String>[],
            'createdAt': '2026-10-21T00:00:00.000Z',
            'updatedAt': '2026-10-21T00:00:00.000Z',
            'source': 'user',
            '_scope': 'session',
          },
        ],
      });
      TomTodoApi.setAdapter(adapter);
      final all = await TomTodoApi.listAllTodos(includeWorkspace: false);
      expect(adapter.lastMethod, 'todo.listAllVce');
      expect(adapter.lastParams!['includeWorkspace'], isFalse);
      expect(all.entries.map((e) => e.level), [
        TodoLevel.quest,
        TodoLevel.session,
      ]);

      final created = _FakeAdapter(_questJson());
      TomTodoApi.setAdapter(created);
      final todo = TomTodo(id: 'n1', title: 'New', description: 'd');
      final entry = await TomTodoApi.createQuestTodo(
        'vscode_extension',
        todo,
        file: 'f.todo.yaml',
      );
      expect(created.lastMethod, 'todo.createQuestVce');
      expect(created.lastParams!['todo'], todo.toMap());
      expect(created.lastParams!['file'], 'f.todo.yaml');
      expect(entry.todo.id, 'vex1_ajug-add-retry');

      final session = _FakeAdapter({
        'id': 'wt-2',
        'title': 'New',
        'details': 'd',
        'status': 'pending',
        'priority': 'medium',
        'tags': <String>[],
        'createdAt': '2026-10-21T00:00:00.000Z',
        'updatedAt': '2026-10-21T00:00:00.000Z',
        'source': 'copilot',
      });
      TomTodoApi.setAdapter(session);
      await TomTodoApi.createSessionTodo(todo);
      expect(session.lastMethod, 'todo.createSessionVce');
      expect(session.lastParams!['todo'], TodoWire.toSessionBridge(todo));

      // The extension answers a missing todo with null, which reaches the
      // adapter as an empty map.
      TomTodoApi.setAdapter(_FakeAdapter({}));
      expect(await TomTodoApi.getQuestTodo('q', 'none'), isNull);
      expect(await TomTodoApi.getSessionTodo('none'), isNull);
    });
  });
}
