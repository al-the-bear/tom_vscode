// D4rt Bridge - Generated file, do not edit
// Delegating barrel for all
// Generated: 2026-02-03T20:15:08.493315

// ignore_for_file: unused_import, deprecated_member_use

import 'package:tom_d4rt/d4rt.dart';
import 'package:tom_d4rt/tom_d4rt.dart';

import '../d4rt_library_bridges/package_tom_vscode_bridge_bridges.dart' as pkg_tom_vscode_bridge;
import '../d4rt_library_bridges/package_tom_vscode_scripting_api_bridges.dart' as pkg_tom_vscode_scripting_api;

/// Bridge class for all module.
class AllBridge {
  /// Returns all bridge class definitions.
  static List<BridgedClass> bridgeClasses() {
    return [
      ...pkg_tom_vscode_bridge.PackageTomVscodeBridgeBridge.bridgeClasses(),
      ...pkg_tom_vscode_scripting_api.PackageTomVscodeScriptingApiBridge.bridgeClasses(),
    ];
  }

  /// Returns a map of class names to their canonical source URIs.
  ///
  /// Used for deduplication when the same class is exported through
  /// multiple barrels (e.g., tom_core_kernel and tom_core_server).
  static Map<String, String> classSourceUris() {
    return {
      ...pkg_tom_vscode_bridge.PackageTomVscodeBridgeBridge.classSourceUris(),
      ...pkg_tom_vscode_scripting_api.PackageTomVscodeScriptingApiBridge.classSourceUris(),
    };
  }

  /// Returns all bridged enum definitions.
  static List<BridgedEnumDefinition> bridgedEnums() {
    return [
      ...pkg_tom_vscode_bridge.PackageTomVscodeBridgeBridge.bridgedEnums(),
      ...pkg_tom_vscode_scripting_api.PackageTomVscodeScriptingApiBridge.bridgedEnums(),
    ];
  }

  /// Returns all global functions.
  static Map<String, NativeFunctionImpl> globalFunctions() {
    return {
      ...pkg_tom_vscode_bridge.PackageTomVscodeBridgeBridge.globalFunctions(),
      ...pkg_tom_vscode_scripting_api.PackageTomVscodeScriptingApiBridge.globalFunctions(),
    };
  }

  /// Register all bridges with the interpreter.
  static void registerBridges(D4rt interpreter, String importPath) {
    pkg_tom_vscode_bridge.PackageTomVscodeBridgeBridge.registerBridges(interpreter, importPath);
    pkg_tom_vscode_scripting_api.PackageTomVscodeScriptingApiBridge.registerBridges(interpreter, importPath);
  }

  /// Returns the import block for scripts.
  static String getImportBlock() {
    return "import 'tom_vscode_bridge.dart';\n";
  }
}
