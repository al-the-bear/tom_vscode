/// Tests for the pure canUseTool dispatch (todo #6): converts an incoming
/// `agentSdk.canUseTool` reverse-RPC request into a [CanUseTool] invocation and
/// serializes the returned [PermissionResult] back to wire JSON.
///
/// The dispatch is pure (no socket) so it is unit-testable on its own and is
/// reused by the bridge-backed transport's request handler.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';
import 'package:test/test.dart';

void main() {
  group('dispatchCanUseTool', () {
    test('passes toolName, input and suggestions to the callback', () async {
      late String seenTool;
      late Map<String, dynamic> seenInput;
      late List<PermissionUpdate> seenSuggestions;

      Future<PermissionResult> callback(
        String toolName,
        Map<String, dynamic> input,
        CanUseToolContext context,
      ) async {
        seenTool = toolName;
        seenInput = input;
        seenSuggestions = context.suggestions;
        return PermissionAllow();
      }

      await dispatchCanUseTool(callback, {
        'streamId': 's1',
        'toolName': 'Bash',
        'input': {'command': 'ls'},
        'suggestions': [
          {'type': 'setMode', 'mode': 'acceptEdits', 'destination': 'session'},
        ],
      });

      expect(seenTool, 'Bash');
      expect(seenInput, {'command': 'ls'});
      expect(seenSuggestions, hasLength(1));
      expect(seenSuggestions.single, isA<PermissionUpdateSetMode>());
    });

    test('serializes an allow decision (incl. updatedInput)', () async {
      Future<PermissionResult> callback(
        String toolName,
        Map<String, dynamic> input,
        CanUseToolContext context,
      ) async => PermissionAllow(updatedInput: {'command': 'ls -la'});

      final json = await dispatchCanUseTool(callback, {
        'streamId': 's1',
        'toolName': 'Bash',
        'input': {'command': 'ls'},
      });

      expect(json, {
        'behavior': 'allow',
        'updatedInput': {'command': 'ls -la'},
      });
    });

    test('serializes a deny decision', () async {
      Future<PermissionResult> callback(
        String toolName,
        Map<String, dynamic> input,
        CanUseToolContext context,
      ) async => PermissionDeny(message: 'not allowed');

      final json = await dispatchCanUseTool(callback, {
        'streamId': 's1',
        'toolName': 'Bash',
        'input': <String, dynamic>{},
      });

      expect(json, {'behavior': 'deny', 'message': 'not allowed'});
    });

    test('tolerates a missing input map', () async {
      Future<PermissionResult> callback(
        String toolName,
        Map<String, dynamic> input,
        CanUseToolContext context,
      ) async {
        expect(input, isEmpty);
        return PermissionAllow();
      }

      final json = await dispatchCanUseTool(callback, {
        'streamId': 's1',
        'toolName': 'Bash',
      });
      expect(json['behavior'], 'allow');
    });
  });
}
