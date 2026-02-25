// D4rt Bridge - Generated file, do not edit
// Dartscript registration for tom_vscode_bridge
// Generated: 2026-02-14T16:27:28.092782

/// D4rt Bridge Registration for tom_vscode_bridge
library;

import 'package:tom_d4rt/d4rt.dart';
import 'src/d4rt_bridges/tom_vscode_bridge_bridges.b.dart' as all_bridges;

/// Combined bridge registration for tom_vscode_bridge.
class TomVscodeBridgeBridges {
  /// Register all bridges with D4rt interpreter.
  static void register([D4rt? interpreter]) {
    final d4rt = interpreter ?? D4rt();

    all_bridges.AllBridge.registerBridges(
      d4rt,
      'tom_vscode_bridge.dart',
    );
    all_bridges.AllBridge.registerBridges(
      d4rt,
      'lib/tom_vscode_bridge.dart',
    );
    // Register under sub-package barrels for direct imports
    for (final barrel in all_bridges.AllBridge.subPackageBarrels()) {
      all_bridges.AllBridge.registerBridges(d4rt, barrel);
    }
  }

  /// Get import block for all modules.
  static String getImportBlock() {
    final buffer = StringBuffer();
    buffer.writeln(all_bridges.AllBridge.getImportBlock());
    return buffer.toString();
  }
}
