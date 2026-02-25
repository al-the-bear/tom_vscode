/// VS Code Bridge API for script execution
/// 
/// This library provides the runtime API for scripts executed through the bridge.

import 'package:tom_d4rt/d4rt.dart';
import 'bridge_server.dart';

/// Bridge class for script execution with params and context
class VsCodeBridge {
  Map<String, dynamic>? _params;
  Map<String, dynamic>? _context;

  /// Internal method to set execution parameters (called by bridge server)
  void setExecutionContext(
    Map<String, dynamic> params, 
    Map<String, dynamic> context,
    {VSCodeBridgeServer? bridgeServer}
  ) {
    _params = params;
    _context = context;
  }

  /// Execute a script function with params and context
  void execute(dynamic Function(Map<String, dynamic> params, Map<String, dynamic> context) handler) {
    try {
      final result = handler(_params ?? {}, _context ?? {});
      print('__BRIDGE_RESULT__:${_jsonEncode(result)}');
    } catch (e, stackTrace) {
      print('__BRIDGE_ERROR__:${_jsonEncode({
        'error': e.toString(),
        'stackTrace': stackTrace.toString(),
      })}');
    }
  }

  String _jsonEncode(dynamic value) {
    // Simple JSON encoding for basic types
    if (value == null) return 'null';
    if (value is String) return '"${value.replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"';
    if (value is num || value is bool) return value.toString();
    if (value is List) {
      return '[${value.map(_jsonEncode).join(',')}]';
    }
    if (value is Map) {
      final entries = value.entries.map((e) => '"${e.key}":${_jsonEncode(e.value)}');
      return '{${entries.join(',')}}';
    }
    return '"${value.toString()}"';
  }
}

/// D4rt bridge definition for VsCodeBridge
final vsCodeBridgeDefinition = BridgedClass(
  nativeType: VsCodeBridge,
  name: 'VsCodeBridge',
  constructors: {
    '': (visitor, positionalArgs, namedArgs) {
      if (positionalArgs.isNotEmpty || namedArgs.isNotEmpty) {
        throw ArgumentError(
          'VsCodeBridge constructor expects no arguments, '
          'got ${positionalArgs.length} positional and ${namedArgs.length} named arguments',
        );
      }
      return VsCodeBridge();
    },
  },
  methods: {
    'execute': (visitor, target, positionalArgs, namedArgs, typeArgs) {
      // Validate target type
      if (target is! VsCodeBridge) {
        throw ArgumentError(
          'Invalid target: Expected VsCodeBridge, got ${target.runtimeType}',
        );
      }
      
      // Validate argument count
      if (positionalArgs.length != 1) {
        throw ArgumentError(
          'execute expects exactly 1 argument (Function handler), '
          'got ${positionalArgs.length}',
        );
      }
      
      // Validate argument type
      if (positionalArgs[0] is! Function) {
        throw ArgumentError(
          'execute: Argument must be a Function, '
          'got ${positionalArgs[0]?.runtimeType}',
        );
      }
      
      // Execute method
      final handler = positionalArgs[0] as Function;
      target.execute((params, context) => handler(params, context));
      return null;
    },
  },
);
