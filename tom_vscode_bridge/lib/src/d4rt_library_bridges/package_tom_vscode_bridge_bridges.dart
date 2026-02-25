// D4rt Bridge - Generated file, do not edit
// Sources: 2 files
// Generated: 2026-02-03T20:15:06.811704

// ignore_for_file: unused_import, deprecated_member_use

import 'package:tom_d4rt/d4rt.dart';
import 'package:tom_d4rt/tom_d4rt.dart';
import 'dart:async';

import 'package:tom_vscode_bridge/tom_vscode_bridge.dart' as $pkg;

/// Bridge class for package_tom_vscode_bridge module.
class PackageTomVscodeBridgeBridge {
  /// Returns all bridge class definitions.
  static List<BridgedClass> bridgeClasses() {
    return [
      _createBridgeLoggingBridge(),
      _createExecutionContextBridge(),
      _createVSCodeBridgeServerBridge(),
      _createVsCodeBridgeBridge(),
    ];
  }

  /// Returns a map of class names to their canonical source URIs.
  ///
  /// Used for deduplication when the same class is exported through
  /// multiple barrels (e.g., tom_core_kernel and tom_core_server).
  static Map<String, String> classSourceUris() {
    return {
      'BridgeLogging': 'package:tom_vscode_bridge/bridge_server.dart',
      'ExecutionContext': 'package:tom_vscode_bridge/bridge_server.dart',
      'VSCodeBridgeServer': 'package:tom_vscode_bridge/bridge_server.dart',
      'VsCodeBridge': 'package:tom_vscode_bridge/script_api.dart',
    };
  }

  /// Returns all bridged enum definitions.
  static List<BridgedEnumDefinition> bridgedEnums() {
    return [
    ];
  }

  /// Returns a map of enum names to their canonical source URIs.
  ///
  /// Used for deduplication when the same enum is exported through
  /// multiple barrels (e.g., tom_core_kernel and tom_core_server).
  static Map<String, String> enumSourceUris() {
    return {
    };
  }

  /// Registers all bridges with an interpreter.
  ///
  /// [importPath] is the package import path that D4rt scripts will use
  /// to access these classes (e.g., 'package:tom_build/tom.dart').
  static void registerBridges(D4rt interpreter, String importPath) {
    // Register bridged classes with source URIs for deduplication
    final classes = bridgeClasses();
    final classSources = classSourceUris();
    for (final bridge in classes) {
      interpreter.registerBridgedClass(bridge, importPath, sourceUri: classSources[bridge.name]);
    }

    // Register global variables
    registerGlobalVariables(interpreter, importPath);
  }

  /// Registers all global variables with the interpreter.
  ///
  /// [importPath] is the package import path for library-scoped registration.
  /// Collects all registration errors and throws a single exception
  /// with all error details if any registrations fail.
  static void registerGlobalVariables(D4rt interpreter, String importPath) {
    final errors = <String>[];

    try {
      interpreter.registerGlobalVariable('defaultCliServerPort', $pkg.defaultCliServerPort, importPath, sourceUri: 'package:tom_vscode_bridge/bridge_server.dart');
    } catch (e) {
      errors.add('Failed to register variable "defaultCliServerPort": $e');
    }
    try {
      interpreter.registerGlobalVariable('vsCodeBridgeDefinition', $pkg.vsCodeBridgeDefinition, importPath, sourceUri: 'package:tom_vscode_bridge/script_api.dart');
    } catch (e) {
      errors.add('Failed to register variable "vsCodeBridgeDefinition": $e');
    }

    if (errors.isNotEmpty) {
      throw StateError('Bridge registration errors (package_tom_vscode_bridge):\n${errors.join("\n")}');
    }
  }

  /// Returns a map of global function names to their native implementations.
  static Map<String, NativeFunctionImpl> globalFunctions() {
    return {};
  }

  /// Returns a map of global function names to their canonical source URIs.
  static Map<String, String> globalFunctionSourceUris() {
    return {};
  }

  /// Returns a map of global function names to their display signatures.
  static Map<String, String> globalFunctionSignatures() {
    return {};
  }

  /// Returns the list of canonical source library URIs.
  ///
  /// These are the actual source locations of all elements in this bridge,
  /// used for deduplication when the same libraries are exported through
  /// multiple barrels.
  static List<String> sourceLibraries() {
    return [
      'package:tom_vscode_bridge/bridge_server.dart',
      'package:tom_vscode_bridge/script_api.dart',
    ];
  }

}

// =============================================================================
// BridgeLogging Bridge
// =============================================================================

BridgedClass _createBridgeLoggingBridge() {
  return BridgedClass(
    nativeType: $pkg.BridgeLogging,
    name: 'BridgeLogging',
    constructors: {
      '': (visitor, positional, named) {
        return $pkg.BridgeLogging();
      },
    },
    staticGetters: {
      'debugTraceLogging': (visitor) => $pkg.BridgeLogging.debugTraceLogging,
      'debugLogging': (visitor) => $pkg.BridgeLogging.debugLogging,
    },
    staticMethods: {
      'setDebugLogging': (visitor, positional, named, typeArgs) {
        D4.requireMinArgs(positional, 1, 'setDebugLogging');
        final enabled = D4.getRequiredArg<bool>(positional, 0, 'enabled', 'setDebugLogging');
        return $pkg.BridgeLogging.setDebugLogging(enabled);
      },
    },
    constructorSignatures: {
      '': 'BridgeLogging()',
    },
    staticMethodSignatures: {
      'setDebugLogging': 'void setDebugLogging(bool enabled)',
    },
    staticGetterSignatures: {
      'debugTraceLogging': 'bool get debugTraceLogging',
      'debugLogging': 'bool get debugLogging',
    },
    staticSetterSignatures: {
      'debugTraceLogging': 'set debugTraceLogging(dynamic value)',
      'debugLogging': 'set debugLogging(dynamic value)',
    },
  );
}

// =============================================================================
// ExecutionContext Bridge
// =============================================================================

BridgedClass _createExecutionContextBridge() {
  return BridgedClass(
    nativeType: $pkg.ExecutionContext,
    name: 'ExecutionContext',
    constructors: {
      '': (visitor, positional, named) {
        return $pkg.ExecutionContext();
      },
    },
    getters: {
      'logs': (visitor, target) => D4.validateTarget<$pkg.ExecutionContext>(target, 'ExecutionContext').logs,
      'exceptionMessage': (visitor, target) => D4.validateTarget<$pkg.ExecutionContext>(target, 'ExecutionContext').exceptionMessage,
      'exceptionStackTrace': (visitor, target) => D4.validateTarget<$pkg.ExecutionContext>(target, 'ExecutionContext').exceptionStackTrace,
      'hasException': (visitor, target) => D4.validateTarget<$pkg.ExecutionContext>(target, 'ExecutionContext').hasException,
    },
    setters: {
      'exceptionMessage': (visitor, target, value) => 
        D4.validateTarget<$pkg.ExecutionContext>(target, 'ExecutionContext').exceptionMessage = value as String?,
      'exceptionStackTrace': (visitor, target, value) => 
        D4.validateTarget<$pkg.ExecutionContext>(target, 'ExecutionContext').exceptionStackTrace = value as String?,
    },
    methods: {
      'log': (visitor, target, positional, named, typeArgs) {
        final t = D4.validateTarget<$pkg.ExecutionContext>(target, 'ExecutionContext');
        D4.requireMinArgs(positional, 1, 'log');
        final message = D4.getRequiredArg<String>(positional, 0, 'message', 'log');
        t.log(message);
        return null;
      },
      'recordException': (visitor, target, positional, named, typeArgs) {
        final t = D4.validateTarget<$pkg.ExecutionContext>(target, 'ExecutionContext');
        D4.requireMinArgs(positional, 2, 'recordException');
        final error = D4.getRequiredArg<Object>(positional, 0, 'error', 'recordException');
        final stackTrace = D4.getRequiredArg<StackTrace>(positional, 1, 'stackTrace', 'recordException');
        t.recordException(error, stackTrace);
        return null;
      },
    },
    constructorSignatures: {
      '': 'ExecutionContext()',
    },
    methodSignatures: {
      'log': 'void log(String message)',
      'recordException': 'void recordException(Object error, StackTrace stackTrace)',
    },
    getterSignatures: {
      'logs': 'List<String> get logs',
      'exceptionMessage': 'String? get exceptionMessage',
      'exceptionStackTrace': 'String? get exceptionStackTrace',
      'hasException': 'bool get hasException',
    },
    setterSignatures: {
      'exceptionMessage': 'set exceptionMessage(dynamic value)',
      'exceptionStackTrace': 'set exceptionStackTrace(dynamic value)',
    },
  );
}

// =============================================================================
// VSCodeBridgeServer Bridge
// =============================================================================

BridgedClass _createVSCodeBridgeServerBridge() {
  return BridgedClass(
    nativeType: $pkg.VSCodeBridgeServer,
    name: 'VSCodeBridgeServer',
    constructors: {
      '': (visitor, positional, named) {
        return $pkg.VSCodeBridgeServer();
      },
    },
    methods: {
      'start': (visitor, target, positional, named, typeArgs) {
        final t = D4.validateTarget<$pkg.VSCodeBridgeServer>(target, 'VSCodeBridgeServer');
        t.start();
        return null;
      },
      'handleCliRequest': (visitor, target, positional, named, typeArgs) {
        final t = D4.validateTarget<$pkg.VSCodeBridgeServer>(target, 'VSCodeBridgeServer');
        D4.requireMinArgs(positional, 4, 'handleCliRequest');
        final method = D4.getRequiredArg<String>(positional, 0, 'method', 'handleCliRequest');
        if (positional.length <= 1) {
          throw ArgumentError('handleCliRequest: Missing required argument "params" at position 1');
        }
        final params = D4.coerceMap<String, dynamic>(positional[1], 'params');
        final id = D4.getRequiredArg<Object?>(positional, 2, 'id', 'handleCliRequest');
        if (positional.length <= 3) {
          throw ArgumentError('handleCliRequest: Missing required argument "sendLogToSocket" at position 3');
        }
        final sendLogToSocketRaw = positional[3];
        return t.handleCliRequest(method, params, id, (String p0) { (sendLogToSocketRaw as InterpretedFunction).call(visitor, [p0]); });
      },
      'sendRequest': (visitor, target, positional, named, typeArgs) {
        final t = D4.validateTarget<$pkg.VSCodeBridgeServer>(target, 'VSCodeBridgeServer');
        D4.requireMinArgs(positional, 2, 'sendRequest');
        final method = D4.getRequiredArg<String>(positional, 0, 'method', 'sendRequest');
        if (positional.length <= 1) {
          throw ArgumentError('sendRequest: Missing required argument "params" at position 1');
        }
        final params = D4.coerceMap<String, dynamic>(positional[1], 'params');
        final scriptName = D4.getOptionalNamedArg<String?>(named, 'scriptName');
        final timeout = D4.getNamedArgWithDefault<Duration>(named, 'timeout', const Duration(seconds: 30));
        return t.sendRequest(method, params, scriptName: scriptName, timeout: timeout);
      },
      'sendRequestGeneric': (visitor, target, positional, named, typeArgs) {
        final t = D4.validateTarget<$pkg.VSCodeBridgeServer>(target, 'VSCodeBridgeServer');
        D4.requireMinArgs(positional, 2, 'sendRequestGeneric');
        final method = D4.getRequiredArg<String>(positional, 0, 'method', 'sendRequestGeneric');
        if (positional.length <= 1) {
          throw ArgumentError('sendRequestGeneric: Missing required argument "params" at position 1');
        }
        final params = D4.coerceMap<String, dynamic>(positional[1], 'params');
        final scriptName = D4.getOptionalNamedArg<String?>(named, 'scriptName');
        final timeout = D4.getNamedArgWithDefault<Duration>(named, 'timeout', const Duration(seconds: 30));
        final callId = D4.getOptionalNamedArg<String?>(named, 'callId');
        return t.sendRequestGeneric(method, params, scriptName: scriptName, timeout: timeout, callId: callId);
      },
      'sendNotification': (visitor, target, positional, named, typeArgs) {
        final t = D4.validateTarget<$pkg.VSCodeBridgeServer>(target, 'VSCodeBridgeServer');
        D4.requireMinArgs(positional, 2, 'sendNotification');
        final method = D4.getRequiredArg<String>(positional, 0, 'method', 'sendNotification');
        if (positional.length <= 1) {
          throw ArgumentError('sendNotification: Missing required argument "params" at position 1');
        }
        final params = D4.coerceMap<String, dynamic>(positional[1], 'params');
        t.sendNotification(method, params);
        return null;
      },
    },
    staticGetters: {
      'params': (visitor) => $pkg.VSCodeBridgeServer.params,
    },
    staticMethods: {
      'setResult': (visitor, positional, named, typeArgs) {
        D4.requireMinArgs(positional, 1, 'setResult');
        final result = D4.getRequiredArg<Object?>(positional, 0, 'result', 'setResult');
        return $pkg.VSCodeBridgeServer.setResult(result);
      },
    },
    constructorSignatures: {
      '': 'VSCodeBridgeServer()',
    },
    methodSignatures: {
      'start': 'void start()',
      'handleCliRequest': 'Future<Map<String, dynamic>?> handleCliRequest(String method, Map<String, dynamic> params, Object? id, void Function(String message) sendLogToSocket)',
      'sendRequest': 'Future<Map<String, dynamic>> sendRequest(String method, Map<String, dynamic> params, {String? scriptName, Duration timeout = const Duration(seconds: 30)})',
      'sendRequestGeneric': 'Future<T> sendRequestGeneric(String method, Map<String, dynamic> params, {String? scriptName, Duration timeout = const Duration(seconds: 30), String? callId})',
      'sendNotification': 'void sendNotification(String method, Map<String, dynamic> params)',
    },
    staticMethodSignatures: {
      'setResult': 'void setResult(Object? result)',
    },
    staticGetterSignatures: {
      'params': 'Map<String, dynamic> get params',
    },
  );
}

// =============================================================================
// VsCodeBridge Bridge
// =============================================================================

BridgedClass _createVsCodeBridgeBridge() {
  return BridgedClass(
    nativeType: $pkg.VsCodeBridge,
    name: 'VsCodeBridge',
    constructors: {
      '': (visitor, positional, named) {
        return $pkg.VsCodeBridge();
      },
    },
    methods: {
      'setExecutionContext': (visitor, target, positional, named, typeArgs) {
        final t = D4.validateTarget<$pkg.VsCodeBridge>(target, 'VsCodeBridge');
        D4.requireMinArgs(positional, 2, 'setExecutionContext');
        if (positional.isEmpty) {
          throw ArgumentError('setExecutionContext: Missing required argument "params" at position 0');
        }
        final params = D4.coerceMap<String, dynamic>(positional[0], 'params');
        if (positional.length <= 1) {
          throw ArgumentError('setExecutionContext: Missing required argument "context" at position 1');
        }
        final context = D4.coerceMap<String, dynamic>(positional[1], 'context');
        final bridgeServer = D4.getOptionalNamedArg<$pkg.VSCodeBridgeServer?>(named, 'bridgeServer');
        t.setExecutionContext(params, context, bridgeServer: bridgeServer);
        return null;
      },
      'execute': (visitor, target, positional, named, typeArgs) {
        final t = D4.validateTarget<$pkg.VsCodeBridge>(target, 'VsCodeBridge');
        D4.requireMinArgs(positional, 1, 'execute');
        if (positional.isEmpty) {
          throw ArgumentError('execute: Missing required argument "handler" at position 0');
        }
        final handlerRaw = positional[0];
        t.execute((Map<String, dynamic> p0, Map<String, dynamic> p1) { return (handlerRaw as InterpretedFunction).call(visitor, [p0, p1]) as dynamic; });
        return null;
      },
    },
    constructorSignatures: {
      '': 'VsCodeBridge()',
    },
    methodSignatures: {
      'setExecutionContext': 'void setExecutionContext(Map<String, dynamic> params, Map<String, dynamic> context, {VSCodeBridgeServer? bridgeServer})',
      'execute': 'void execute(dynamic Function(Map<String, dynamic> params, Map<String, dynamic> context) handler)',
    },
  );
}

