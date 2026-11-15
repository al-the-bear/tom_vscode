// executeExpressionVcb in the plain bridge (qrfix18).
//
// An expression is evaluated after the interpreter's init source
// (`VSCodeBridgeServer.defaultInitSource`) has run once. That source imported
// packages the plain `tom_bs` has no bridges for (tom_basics, tom_core_kernel,
// …), so every expression failed with "Package module source not preloaded".
// The default init source now leaves out the `package:` imports the
// interpreter cannot serve (`initSourceFor`).
//
//   * `1 + 2` answers 3; a second expression reuses the context;
//   * an expression sees the init source's libraries: dart:math, dart:io;
//   * initSourceFor keeps `dart:` imports, the registered `package:` imports
//     and every other line, and drops the unregistered `package:` imports.

import 'package:test/test.dart';
import 'package:tom_vscode_bridge/bridge_server.dart';

void main() {
  late VSCodeBridgeServer bridge;
  var n = 0;

  setUpAll(() {
    bridge = VSCodeBridgeServer();
  });

  Future<Map<String, dynamic>?> evaluate(String expression) =>
      bridge.handleCliRequest('executeExpressionVcb', {'expression': expression}, 'eval-${n++}', (_) {});

  test('1 + 2 answers 3, and the next expression too', () async {
    final first = await evaluate('1 + 2');
    expect(first?['success'], isTrue, reason: '${first?['error']}');
    expect(first?['result'], 3);
    final second = await evaluate('"ab" * 2');
    expect(second?['success'], isTrue, reason: '${second?['error']}');
    expect(second?['result'], 'abab');
  });

  test("an expression sees the init source's dart: libraries", () async {
    final maxed = await evaluate('max(2, 5)');
    expect(maxed?['success'], isTrue, reason: '${maxed?['error']}');
    expect(maxed?['result'], 5);
    final cwd = await evaluate('Directory.current.path.isNotEmpty');
    expect(cwd?['success'], isTrue, reason: '${cwd?['error']}');
    expect(cwd?['result'], isTrue);
  });

  test('initSourceFor drops the package imports without bridges', () {
    const source = '''
import 'dart:io';
import 'package:registered/a.dart';

import 'package:missing/b.dart';
void main() {}
''';
    final out = VSCodeBridgeServer.initSourceFor(source, {'package:registered/a.dart'});
    expect(out, contains("import 'dart:io';"));
    expect(out, contains("import 'package:registered/a.dart';"));
    expect(out, isNot(contains('package:missing')));
    expect(out, contains('void main() {}'));
    final plain = VSCodeBridgeServer.initSourceFor(VSCodeBridgeServer.defaultInitSource, {'package:tom_dcli/dcli.dart'});
    expect(plain, contains("import 'package:tom_dcli/dcli.dart';"));
    expect(plain, isNot(contains('package:tom_basics')));
    expect(plain, contains("import 'dart:math';"));
  });
}
