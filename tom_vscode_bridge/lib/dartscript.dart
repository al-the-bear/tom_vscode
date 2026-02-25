// D4rt Bridge - Generated file, do not edit
// Dartscript registration for tom_vscode_bridge
// Generated: 2026-02-03T20:15:08.494917

/// D4rt Bridge Registration for tom_vscode_bridge
library;

import 'package:tom_d4rt/d4rt.dart';
import 'src/d4rt_bridges/tom_vscode_bridge_bridges.dart' as all_bridges;

/// Combined bridge registration for tom_vscode_bridge.
class TomDartscriptBridgeBridges {
  /// Register all bridges with D4rt interpreter.
  static void register([D4rt? interpreter]) {
    final d4rt = interpreter ?? D4rt();

    all_bridges.AllBridge.registerBridges(
      d4rt,
      'tom_vscode_bridge.dart',
    );
  }

  /// Get import block for all modules.
  static String getImportBlock() {
    final buffer = StringBuffer();
    buffer.writeln(all_bridges.AllBridge.getImportBlock());
    return buffer.toString();
  }
}
