/// Tests for the document API's trail operations and folders.
///
/// The extension answers the trail from the quest's host trail
/// `_ai/quests/<quest>/history/trail.<host>.md`: a turn is
/// `{id, questId, file, time, host, session, profile, model, prompt, answer}`;
/// a lookup that finds nothing answers `null` (an empty map here).
///
///   DOCAPI-1 listTrail: the op, its parameters (only those given), every
///            field of a turn, totalCount, questId, host
///   DOCAPI-2 getTrailEntry / findTrailByRequestId: the ops and parameters;
///            a turn, or null when the extension found none
///   DOCAPI-3 the document folders: prompt, trail, guidelines, quest — no
///            bot_conversations or send_to_chat
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

Map<String, dynamic> _turn(String id) => {
  'id': id,
  'questId': 'q1',
  'file': '/ws/_ai/quests/q1/history/trail.mbp.md',
  'time': '2026-11-26T09:00:01.000Z',
  'host': 'mbp',
  'session': 'idea@collab',
  'profile': 'opus',
  'model': 'claude-opus-5-5',
  'prompt': 'the prompt',
  'answer': 'the answer',
};

void main() {
  test('DOCAPI-1: listTrail', () async {
    final adapter = _FakeAdapter({
      'entries': [_turn('r2'), _turn('r1')],
      'totalCount': 7,
      'questId': 'q1',
      'host': 'mbp',
    });
    TomDocumentApi.setAdapter(adapter);
    final result = await TomDocumentApi.listTrail(
      limit: 2,
      since: '2026-11-26T08:00:00Z',
    );
    expect(adapter.lastMethod, 'doc.listTrailVce');
    expect(adapter.lastParams, {'limit': 2, 'since': '2026-11-26T08:00:00Z'});
    expect(result.entries.map((e) => e.id), ['r2', 'r1']);
    expect(result.totalCount, 7);
    expect(result.questId, 'q1');
    expect(result.host, 'mbp');
    final turn = result.entries.first;
    expect(
      [
        turn.questId,
        turn.file,
        turn.time,
        turn.host,
        turn.session,
        turn.profile,
        turn.model,
        turn.prompt,
        turn.answer,
      ],
      [
        'q1',
        '/ws/_ai/quests/q1/history/trail.mbp.md',
        '2026-11-26T09:00:01.000Z',
        'mbp',
        'idea@collab',
        'opus',
        'claude-opus-5-5',
        'the prompt',
        'the answer',
      ],
    );

    await TomDocumentApi.listTrail(questId: 'q2');
    expect(adapter.lastParams, {'questId': 'q2'});
  });

  test('DOCAPI-2: a turn by its id, or null', () async {
    final found = _FakeAdapter(_turn('r1'));
    TomDocumentApi.setAdapter(found);
    final byId = await TomDocumentApi.getTrailEntry('r1');
    expect(found.lastMethod, 'doc.getTrailEntryVce');
    expect(found.lastParams, {'entryId': 'r1'});
    expect(byId?.answer, 'the answer');
    final byRequest = await TomDocumentApi.findTrailByRequestId(
      'r1',
      questId: 'q1',
    );
    expect(found.lastMethod, 'doc.findTrailByRequestIdVce');
    expect(found.lastParams, {'requestId': 'r1', 'questId': 'q1'});
    expect(byRequest?.id, 'r1');

    TomDocumentApi.setAdapter(_FakeAdapter({}));
    expect(await TomDocumentApi.getTrailEntry('missing'), isNull);
    expect(await TomDocumentApi.findTrailByRequestId('missing'), isNull);
  });

  test('DOCAPI-3: the document folders', () {
    expect(DocumentFolder.values.map((f) => f.value), [
      'prompt',
      'trail',
      'guidelines',
      'quest',
    ]);
  });
}
