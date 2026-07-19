/// Tests for the VS Code value-type deserializers in `vscode_types.dart`.
///
/// Regression focus: `TextEditor.fromJson` used to index `visibleRanges[0]`
/// unconditionally. When the bridge sends an editor with an EMPTY
/// `visibleRanges` array (e.g. the `showTextDocument` path, which always
/// reports `visibleRanges: []`), that threw a RangeError and the whole editor
/// snapshot failed to parse. The parser must treat an empty — or absent, or
/// non-list — `visibleRanges` as "no visible range" (null) instead.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';
import 'package:test/test.dart';

/// A minimal, valid editor JSON payload with a pluggable `visibleRanges`.
Map<String, dynamic> _editorJson(Object? visibleRanges) => {
  'document': {
    'uri': {'scheme': 'file', 'path': '/tmp/a.dart', 'fsPath': '/tmp/a.dart'},
    'fileName': '/tmp/a.dart',
    'isUntitled': false,
    'languageId': 'dart',
    'version': 1,
    'isDirty': false,
    'isClosed': false,
    'lineCount': 10,
  },
  'selection': {
    'anchor': {'line': 0, 'character': 0},
    'active': {'line': 0, 'character': 0},
    'isReversed': false,
  },
  'selections': [
    {
      'anchor': {'line': 0, 'character': 0},
      'active': {'line': 0, 'character': 0},
      'isReversed': false,
    },
  ],
  'visibleRanges': visibleRanges,
};

void main() {
  group('TextEditor.fromJson visibleRanges', () {
    test('an empty visibleRanges array parses to null (does not throw)', () {
      final editor = TextEditor.fromJson(_editorJson(<dynamic>[]));
      expect(editor.visibleRanges, isNull);
      // The rest of the snapshot still parsed.
      expect(editor.document.fileName, '/tmp/a.dart');
      expect(editor.selections, hasLength(1));
    });

    test('a missing visibleRanges key parses to null', () {
      final json = _editorJson(null)..remove('visibleRanges');
      final editor = TextEditor.fromJson(json);
      expect(editor.visibleRanges, isNull);
    });

    test('a null visibleRanges parses to null', () {
      final editor = TextEditor.fromJson(_editorJson(null));
      expect(editor.visibleRanges, isNull);
    });

    test('a non-list visibleRanges parses to null', () {
      final editor = TextEditor.fromJson(_editorJson('nonsense'));
      expect(editor.visibleRanges, isNull);
    });

    test('a populated visibleRanges parses the first range', () {
      final editor = TextEditor.fromJson(
        _editorJson([
          {
            'start': {'line': 2, 'character': 0},
            'end': {'line': 8, 'character': 4},
          },
        ]),
      );
      expect(editor.visibleRanges, isNotNull);
      expect(editor.visibleRanges!.start.line, 2);
      expect(editor.visibleRanges!.end.line, 8);
      expect(editor.visibleRanges!.end.character, 4);
    });
  });
}
