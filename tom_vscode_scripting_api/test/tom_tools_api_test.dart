/// Tests for the scripting-side tool facade.
///
/// The gating itself is enforced server-side in the extension (covered there);
/// these tests pin the Dart pass-through behaviour: which bridge op each method
/// calls and how it shapes the response. A fake adapter records the last call
/// and returns canned JSON — the apiKeyAuthHeader test seam, Dart-side.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';
import 'package:test/test.dart';

/// Records the last request and replays a canned response.
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

void main() {
  group('TomToolsApi.listAllowedToolNames', () {
    test('calls tools.getJsonVce and returns just the tool names', () async {
      final adapter = _FakeAdapter({
        'tools': [
          {'name': 'tomAi_readFile', 'description': 'r', 'input_schema': {}},
          {'name': 'tomAi_applyEdit', 'description': 'w', 'input_schema': {}},
        ],
      });
      TomToolsApi.setAdapter(adapter);

      final names = await TomToolsApi.listAllowedToolNames();

      expect(adapter.lastMethod, 'tools.getJsonVce');
      expect(names, ['tomAi_readFile', 'tomAi_applyEdit']);
    });

    test('empty / missing tools list yields an empty name list', () async {
      TomToolsApi.setAdapter(_FakeAdapter({}));
      expect(await TomToolsApi.listAllowedToolNames(), isEmpty);

      TomToolsApi.setAdapter(_FakeAdapter({'tools': []}));
      expect(await TomToolsApi.listAllowedToolNames(), isEmpty);
    });

    test('shares the gate with getToolsJson (same op, same names)', () async {
      final adapter = _FakeAdapter({
        'tools': [
          {'name': 'tomAi_readFile', 'description': 'r', 'input_schema': {}},
        ],
      });
      TomToolsApi.setAdapter(adapter);

      final fromJson = (await TomToolsApi.getToolsJson())
          .map((t) => t.name)
          .toList();
      final fromNames = await TomToolsApi.listAllowedToolNames();

      expect(fromNames, fromJson);
    });
  });
}
