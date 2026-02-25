import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:tom_vscode_bridge/script_api.dart';
import 'package:tom_vscode_bridge/src/cli_integration_server.dart';
import 'package:tom_dartscript_bridges/tom_dartscript_bridges.dart';

/// Default port for CLI integration server
const int defaultCliServerPort = 19900;

/// Global debug logging switches for VS Code Bridge
/// 
/// - [debugTraceLogging]: Enables detailed logging of raw message transmission
/// - [debugLogging]: Enables logging of request/response handling after message parsing
class BridgeLogging {
  /// Enable trace-level logging for raw data transmission (JSON messages)
  static bool debugTraceLogging = false;
  
  /// Enable debug logging for request handling and responses
  static bool debugLogging = false;
  
  /// Set both debug logging flags at once
  static void setDebugLogging(bool enabled) {
    debugLogging = enabled;
    debugTraceLogging = enabled;
  }
}

/// Collects log messages and exception information during script execution.
/// 
/// This class captures all logging output and exceptions during a script's 
/// execution so they can be included in the response sent back to VS Code.
class ExecutionContext {
  final List<String> logs = [];
  String? exceptionMessage;
  String? exceptionStackTrace;
  
  /// Add a log message
  void log(String message) {
    logs.add(message);
  }
  
  /// Record an exception
  void recordException(Object error, StackTrace stackTrace) {
    exceptionMessage = error.toString();
    exceptionStackTrace = stackTrace.toString();
  }
  
  /// Check if an exception was recorded
  bool get hasException => exceptionMessage != null;
}

/// JSON-RPC based bridge server for VS Code communication
///
/// This server communicates with the VS Code extension via stdin/stdout
/// using a JSON-RPC-like protocol.
/// 
/// Implements [VSCodeAdapter] to provide the bridge for VS Code API wrappers.
class VSCodeBridgeServer implements VSCodeAdapter {

  final StreamController<String> _outputController = StreamController<String>();
  int _messageId = 0;
  final Map<String, Completer<dynamic>> _pendingRequests = {};
  late final D4rt _interpreter;
  late final VsCodeBridge _vsCodeBridge;
  bool _hasExecutionContext = false;
  
  /// CLI integration server for Tom CLI connections
  CliIntegrationServer? _cliServer;

  String? _currentCallId() => Zone.current['callId'] as String?;
  
  static void setResult( Object? result ) {
    final resultMap = Zone.current['result'] as Map<String,dynamic>?;
    resultMap?['result'] = result;
    final bridgeServer = Zone.current['bridgeServer'] as VSCodeBridgeServer?;
    if( bridgeServer != null && BridgeLogging.debugLogging ) {
      print('[SETRES] Setting script result: $result');
    }
  }

  /// Get the current execution params from the zone
  /// This allows scripts to access parameters passed during execution
  static Map<String, dynamic> get params {
    return Zone.current['params'] as Map<String, dynamic>? ?? {};
  }

  VSCodeBridgeServer() {

        // Initialize the static VSCode instance with this adapter
    VSCode.initialize(this);
    
    // Register VsCodeBridge for script execution
    _vsCodeBridge = VsCodeBridge();

    // Initialize D4rt interpreter for dynamic Dart execution
    // Note: D4rt sandboxing configuration is handled through the interpreter's
    // runtime configuration. For full local development access including dart:io
    // and dart:isolate, ensure D4rt is configured appropriately.
    // See: https://pub.dev/packages/d4rt for configuration options
    _interpreter = D4rt();
    
    // Grant all permissions for VS Code bridge local development
    // This gives scripts full access to system resources
    _interpreter.grant(FilesystemPermission.any);   // File operations (dart:io)
    _interpreter.grant(NetworkPermission.any);      // Network connections
    _interpreter.grant(ProcessRunPermission.any);   // Process execution
    _interpreter.grant(IsolatePermission.any);      // Isolate operations (dart:isolate)
    _interpreter.grant(DangerousPermission.any);    // Code evaluation, native plugins
    
    // register bridges
    TomDartscriptBridges.register(_interpreter);
    _interpreter.registerBridgedClass(vsCodeBridgeDefinition, 'package:vscode_bridge/vscode_bridge.dart');
    
    // Register global variables for script access
    // These are available in scripts that import the vscode_bridge package
    final vsCodeInstance = VSCode.instance;
    const vsCodeLib = 'package:vscode_bridge/vscode_bridge.dart';
    _interpreter.registerGlobalVariable('vscode', vsCodeInstance, vsCodeLib);
    _interpreter.registerGlobalVariable('window', vsCodeInstance.window, vsCodeLib);
    _interpreter.registerGlobalVariable('workspace', vsCodeInstance.workspace, vsCodeLib);
    _interpreter.registerGlobalVariable('commands', vsCodeInstance.commands, vsCodeLib);
    _interpreter.registerGlobalVariable('extensions', vsCodeInstance.extensions, vsCodeLib);
    _interpreter.registerGlobalVariable('lm', vsCodeInstance.lm, vsCodeLib);
    _interpreter.registerGlobalVariable('chat', vsCodeInstance.chat, vsCodeLib);
    
    // Log the interpreter configuration for debugging
    _logInterpreterConfigurationConcise();
    
    // Note: Bridge initialization scripts (imports for other packages) should be
    // added here once bridge generation is set up for the relevant packages.
    // For now, all VS Code globals are registered above via registerGlobalVariable().
  }

  static const String _defaultInitSource = '''
import 'dart:async';
import 'dart:io';
import 'dart:convert';
import 'dart:math';
import 'dart:collection';
import 'dart:typed_data';
import 'dart:isolate';
import 'package:tom_d4rt_dcli/tom_d4rt_cli_api.dart';

import 'package:dcli/dcli.dart';

import 'package:tom_basics/tom_basics.dart';

import 'package:tom_reflection/generated.dart';

import 'package:tom_process_monitor/tom_process_monitor.dart';

import 'package:tom_core_kernel/tom_core_kernel.dart';

import 'package:tom_core_server/tom_core_server.dart';

import 'package:tom_build/tom_build.dart';

import 'package:tom_vscode_scripting_api/script_globals.dart';

import 'package:tom_dist_ledger/tom_dist_ledger.dart';

import 'package:tom_build_cli/tom_cli_api.dart';

void main() {}
''';

  void _ensureExecutionContext() {
    if (_hasExecutionContext) {
      return;
    }

    _interpreter.execute(source: _defaultInitSource);
    _hasExecutionContext = true;
  }

  /// Logs the interpreter configuration in concise format for startup.
  /// 
  /// This provides a quick overview of available packages, variables, and classes.
  /// For detailed configuration, use the "DartScript: Print Configuration" command.
  void _logInterpreterConfigurationConcise() {
    final config = _interpreter.getConfiguration();
    
    print('[D4RT] DartScript interpreter ready');
    
    // 1. List of packages (import paths), alphabetical
    final packages = config.imports.map((i) => i.importPath).toList()..sort();
    print('[D4RT] Packages: ${packages.join(', ')}');
    
    // 2. List of global variables, alphabetical
    final vars = config.globalVariables.map((v) => v.name).toList()..sort();
    if (vars.isNotEmpty) {
      print('[D4RT] Globals: ${vars.join(', ')}');
    }
    
    // 3. List of global getters, alphabetical  
    final getters = config.globalGetters.map((g) => g.name).toList()..sort();
    if (getters.isNotEmpty) {
      print('[D4RT] Global getters: ${getters.join(', ')}');
    }
    
    // 4. List of global functions, alphabetical
    final funcs = config.globalFunctions.map((f) => f.name).toList()..sort();
    if (funcs.isNotEmpty) {
      print('[D4RT] Functions: ${funcs.join(', ')}');
    }
    
    // 5. Per package: list of classes on a single line
    for (final import in config.imports) {
      final classNames = import.classes.map((c) => c.name).toList()..sort();
      final enumNames = import.enums.map((e) => e.name).toList()..sort();
      final allTypes = [...classNames, ...enumNames];
      if (allTypes.isNotEmpty) {
        // Extract short package name from import path
        final shortName = import.importPath.split('/').last.replaceAll('.dart', '');
        print('[D4RT] $shortName: ${allTypes.join(', ')}');
      }
    }
  }

  /// Logs the detailed interpreter configuration.
  /// 
  /// This is called via the "DartScript: Print Configuration" command
  /// and provides full details about all classes, methods, constructors, etc.
  void _logInterpreterConfigurationDetailed() {
    final config = _interpreter.getConfiguration();
    
    print('[D4RT CONFIG] ═══════════════════════════════════════════════════════');
    print('[D4RT CONFIG] Detailed DartScript Configuration');
    print('[D4RT CONFIG] ═══════════════════════════════════════════════════════');
    
    // Log imports with classes and enums
    for (final import in config.imports) {
      print('[D4RT CONFIG]');
      print('[D4RT CONFIG] Import: ${import.importPath}');
      for (final cls in import.classes) {
        final ctors = cls.constructors.map((c) => c.isEmpty ? '""' : c).join(', ');
        final methods = cls.methods.join(', ');
        final getters = cls.getters.join(', ');
        final setters = cls.setters.join(', ');
        final staticMethods = cls.staticMethods.join(', ');
        final staticGetters = cls.staticGetters.join(', ');
        final staticSetters = cls.staticSetters.join(', ');
        
        print('[D4RT CONFIG]   Class: ${cls.name}');
        if (ctors.isNotEmpty) print('[D4RT CONFIG]     constructors: $ctors');
        if (methods.isNotEmpty) print('[D4RT CONFIG]     methods: $methods');
        if (getters.isNotEmpty) print('[D4RT CONFIG]     getters: $getters');
        if (setters.isNotEmpty) print('[D4RT CONFIG]     setters: $setters');
        if (staticMethods.isNotEmpty) print('[D4RT CONFIG]     staticMethods: $staticMethods');
        if (staticGetters.isNotEmpty) print('[D4RT CONFIG]     staticGetters: $staticGetters');
        if (staticSetters.isNotEmpty) print('[D4RT CONFIG]     staticSetters: $staticSetters');
      }
      for (final enm in import.enums) {
        final values = enm.values.join(', ');
        print('[D4RT CONFIG]   Enum: ${enm.name} = $values');
      }
    }
    
    // Log global variables
    if (config.globalVariables.isNotEmpty) {
      print('[D4RT CONFIG]');
      print('[D4RT CONFIG] Global variables:');
      for (final v in config.globalVariables) {
        print('[D4RT CONFIG]   ${v.name}: ${v.valueType}');
      }
    }
    
    // Log global getters
    if (config.globalGetters.isNotEmpty) {
      final getters = config.globalGetters.map((g) => g.name).join(', ');
      print('[D4RT CONFIG]');
      print('[D4RT CONFIG] Global getters: $getters');
    }
    
    // Log global functions
    if (config.globalFunctions.isNotEmpty) {
      final funcs = config.globalFunctions.map((f) => f.name).join(', ');
      print('[D4RT CONFIG]');
      print('[D4RT CONFIG] Global functions: $funcs');
    }
    
    // Log permissions
    if (config.permissions.isNotEmpty) {
      final perms = config.permissions.map((p) => p.type).join(', ');
      print('[D4RT CONFIG]');
      print('[D4RT CONFIG] Permissions: $perms');
    }
    
    print('[D4RT CONFIG]');
    print('[D4RT CONFIG] Debug enabled: ${config.debugEnabled}');
    print('[D4RT CONFIG] ═══════════════════════════════════════════════════════');
  }

  /// Start the bridge server
  void start() {
    // Listen to stdin for messages from VS Code
    stdin
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(_handleMessage, onError: _handleError);

    // Send output to VS Code via stdout
    _outputController.stream.listen((message) {
      stdout.writeln(message);
    });

    print('[BSTART] VS Code Bridge Server started');
  }

  /// Handle incoming messages from VS Code
  void _handleMessage(String line) {
    try {
      final message = jsonDecode(line) as Map<String, dynamic>;
      final method = message['method'] as String?;
      final idRaw = message['id'];
      final responseKey = idRaw?.toString();
      final params = message['params'] as Map<String, dynamic>?;

      if (method != null) {
        // This is a request from VS Code
        try {
        unawaited(_handleVSCodeRequest(method, params ?? {}, idRaw));
        } catch (e, stackTrace) {
          if (idRaw != null) {
            _sendErrorResponse(idRaw, e.toString(), stackTrace);
          }
        };
      } else if (responseKey != null && message.containsKey('result')) {
        final completer = _pendingRequests.remove(responseKey);
        if (completer != null && !completer.isCompleted) {
          completer.complete(message['result']);
          if (BridgeLogging.debugLogging) {
            print('[RSPFULL] Received response for request id: $responseKey ${jsonEncode(message)}');
          } else if (BridgeLogging.debugTraceLogging) {
            print('[RSP] ← id: $responseKey (${_truncate(message['result']?.toString() ?? '', 100)})');
          }
        } else {
          print('[RSPNPC] Received response with no pending completer for id: $responseKey');
        }
      } else if (responseKey != null && message.containsKey('error')) {
        final completer = _pendingRequests.remove(responseKey);
        if (completer != null && !completer.isCompleted) {
          completer.completeError(message['error']);
          if (BridgeLogging.debugLogging) {
            print('[ERRFULL] Received error response for request id: $responseKey ${jsonEncode(message['error'])}');
          } else if (BridgeLogging.debugTraceLogging) {
            print('[ERR] ← id: $responseKey (${_truncate(message['error']?.toString() ?? '', 100)})');
          }
        } else {
          print('[ERRNPC] Received error response with no pending completer for id: $responseKey');
        }
      }
    } catch (e) {
      _sendError('Failed to parse message: $e');
    }
  }

  /// Handle errors from stdin
  void _handleError(dynamic error) {
    _sendError('Stdin error: $error');
  }

  /// Handle a request from VS Code (stdin/stdout)
  /// Runs in a zone that redirects print() to stderr for VS Code Output pane visibility
  Future<void> _handleVSCodeRequest(
    String method,
    Map<String, dynamic> params,
    Object? id,
  ) async {
    final callId = id?.toString();
    return runZoned(
      () => _handleRequestInternal(method, params, id),
      zoneValues: {
        if (callId != null) 'callId': callId,
      },
      zoneSpecification: ZoneSpecification(
        print: (Zone self, ZoneDelegate parent, Zone zone, String line) {
          // Route print to stderr for VS Code Output pane
          stderr.writeln(line);
        },
      ),
    );
  }

  /// Handle a request from CLI (socket connection)
  /// Runs in a zone that redirects print() to the socket as log notifications
  /// 
  /// [client] The socket to send log messages to
  /// [sendLogToSocket] Callback to send log messages to the socket
  Future<Map<String, dynamic>?> handleCliRequest(
    String method,
    Map<String, dynamic> params,
    Object? id,
    void Function(String message) sendLogToSocket,
  ) async {
    final callId = id?.toString();
    return runZoned(
      () => _handleRequestInternalWithResult(method, params, id),
      zoneValues: {
        if (callId != null) 'callId': callId,
      },
      zoneSpecification: ZoneSpecification(
        print: (Zone self, ZoneDelegate parent, Zone zone, String line) {
          // Route print to socket for CLI visibility
          sendLogToSocket(line);
        },
      ),
    );
  }

  Future<void> _handleRequestInternal(
    String method,
    Map<String, dynamic> params,
    Object? id,
  ) async {
    final result = await _handleRequestInternalWithResult(method, params, id);
    // Response is sent inside for executeScript/executeFile/executeExpression, otherwise send here
    if (id != null && result != null && method != 'executeScript' && method != 'executeFile' && method != 'executeExpression') {
      _sendResponse(id, result);
    }
  }

  /// Internal request handler that returns the result instead of sending response
  /// Used by both VS Code and CLI request handlers
  Future<Map<String, dynamic>?> _handleRequestInternalWithResult(
    String method,
    Map<String, dynamic> params,
    Object? id,
  ) async {
    try {
      dynamic result;

      // Check if this is a Vce command that should be forwarded to VS Code
      if (method.endsWith('Vce')) {
        // Forward Vce commands directly to VS Code extension
        result = await sendRequest(method, params);
        if (result is Map<String, dynamic>) {
          return result;
        }
        return result != null ? {'result': result} : null;
      }

      switch (method) {
        case 'echo':
          result = {'message': params['message']};
          break;

        case 'startCliServer':
          result = await _startCliServer(params);
          break;

        case 'stopCliServer':
          result = await _stopCliServer();
          break;

        case 'getCliServerStatus':
          result = _getCliServerStatus();
          break;

        case 'getWorkspaceInfo':
          result = await _getWorkspaceInfo(params);
          break;

        case 'generateDocs':
          result = await _generateDocs(params);
          break;

        // Bridge D4rt execution commands (Vcb suffix)
        case 'executeFileVcb':
          result = await _executeFile(params, id);
          break;

        case 'executeScriptVcb':
          result = await _executeScript(params, id);
          break;

        case 'executeExpressionVcb':
          // Evaluate an expression and return its value
          // Uses D4rt's eval() method for direct expression evaluation
          final expression = params['expression'] as String?;
          if (expression == null) {
            throw Exception('expression parameter is required for executeExpressionVcb');
          }
          final evalParams = Map<String, dynamic>.from(params);
          evalParams['script'] = expression;
          result = await _executeScript(evalParams, id, useEval: true);
          break;

        case 'startProcessMonitor':
          result = await _startProcessMonitor(params);
          break;

        case 'setDebugLogging':
          result = _setDebugLogging(params);
          break;

        case 'getDebugLogging':
          result = _getDebugLogging();
          break;

        case 'printConfiguration':
          _logInterpreterConfigurationDetailed();
          result = {'success': true, 'message': 'Configuration printed to output'};
          break;

        default:
          throw Exception('Unknown method: $method');
      }

      if (result is Map<String, dynamic>) {
        return result;
      }
      return result != null ? {'result': result} : null;
    } catch (e, stackTrace) {
      if (id != null) {
        _sendErrorResponse(id, e.toString(), stackTrace);
      }
      rethrow;
    }
  }

  /// Send a request to VS Code and await response
  /// 
  /// This implements [VSCodeAdapter.sendRequest] for the VS Code API wrappers.
  @override
  Future<Map<String, dynamic>> sendRequest(
    String method,
    Map<String, dynamic> params, {
    String? scriptName,
    Duration timeout = const Duration(seconds: 30),
  }) {
    return sendRequestGeneric<Map<String, dynamic>>(
      method, params,
      scriptName: scriptName,
      timeout: timeout,
    );
  }

  /// Generic version of sendRequest for internal use
  /// 
  /// This allows returning different types from the request.
  Future<T> sendRequestGeneric<T>(String method, Map<String, dynamic> params,{String? scriptName, Duration timeout = const Duration(seconds: 30), String? callId}) {
    final id = 'dart-${_messageId++}';
    final effectiveCallId = callId ?? _currentCallId();
    final completer = Completer<T>();
    _pendingRequests[id] = completer;

    final timeoutMs = timeout.inMilliseconds;
    Timer? timer;
    if (!timeout.isNegative && timeoutMs > 0) {
      timer = Timer(timeout, () {
        final pending = _pendingRequests.remove(id);
        if (pending != null && !pending.isCompleted) {
          pending.completeError(TimeoutException('[B01] Request timed out: $method (id: $id, timeout: ${timeout.inSeconds}s)'));
          print('[B01] Request timeout: $method (id: $id, timeout: ${timeout.inSeconds}s)');
        }
      });
    }

    final message = {
      'jsonrpc': '2.0',
      'id': id,
      'method': method,
      'params': params,
      'scriptName': scriptName,
      'callId': effectiveCallId,
      'timeoutMs': timeoutMs,
    };
    if (BridgeLogging.debugLogging) {
      print('[REQ] → $method (id: $id, callId: ${effectiveCallId ?? 'NONE'}, timeoutMs: $timeoutMs)');
    }
    if (BridgeLogging.debugTraceLogging) {
      print('[REQPRM] Params: ${jsonEncode(params)}');
    }
    _outputController.add(jsonEncode(message));

    return completer.future.whenComplete(() {
      timer?.cancel();
      _pendingRequests.remove(id);
    });
  }

  /// Send a notification to VS Code (no response expected)
  void sendNotification(String method, Map<String, dynamic> params) {
    final callId = _currentCallId();
    final message = {
      'jsonrpc': '2.0',
      'method': method,
      'params': params,
      'callId': callId,
    };

    _outputController.add(jsonEncode(message));
  }

  /// Send a response to a VS Code request
  void _sendResponse(Object id, dynamic result) {
    if (BridgeLogging.debugLogging) {
      print('[SNDFULL] Sending response for id: $id with result: ${jsonEncode(result)}');
    } else if (BridgeLogging.debugTraceLogging) {
      print('[SND] ← id: $id (${_truncate(result?.toString() ?? '', 100)})');
    }
    final message = {
      'jsonrpc': '2.0',
      'id': id,
      'result': result,
    };

    _outputController.add(jsonEncode(message));
  }

  /// Send an error response
  void _sendErrorResponse(Object id, String error, StackTrace? stackTrace) {
    final message = {
      'jsonrpc': '2.0',
      'id': id,
      'error': {
        'message': error,
        'data': stackTrace?.toString(),
      },
    };

    _outputController.add(jsonEncode(message));
  }
  
  /// Truncate a string for compact logging
  String _truncate(String s, int maxLength) {
    if (s.length <= maxLength) return s;
    return '${s.substring(0, maxLength)}...';
  }

  /// Send an error notification to VS Code
  void _sendError(String message) {
    // Output to stderr for immediate visibility during development
    print('[BRGERR] $message');
  }

  // ===================================================================
  // Request Handlers
  // ===================================================================

  // -------------------------------------------------------------------
  // CLI Integration Server Management
  // -------------------------------------------------------------------

  /// Start the CLI integration server
  /// 
  /// Params:
  /// - port (optional): Port to listen on. If not provided, auto-selects
  ///   an available port in the range 19900-19909.
  Future<Map<String, dynamic>> _startCliServer(Map<String, dynamic> params) async {
    final requestedPort = params['port'] as int?;
    
    // Check if already running
    if (_cliServer?.isRunning == true) {
      final currentPort = _cliServer!.serverPort;
      if (requestedPort == null || currentPort == requestedPort) {
        return {
          'success': true,
          'message': 'CLI server already running on port $currentPort',
          'port': currentPort,
          'alreadyRunning': true,
        };
      } else {
        // Different port requested, stop the old server first
        await _cliServer!.stop();
      }
    }
    
    // If specific port requested, try only that port
    if (requestedPort != null) {
      return _tryStartCliServerOnPort(requestedPort, failOnPortInUse: true);
    }
    
    // Auto-select port: try 19900-19909
    for (var port = defaultCliServerPort; port <= maxCliServerPort; port++) {
      final result = await _tryStartCliServerOnPort(port, failOnPortInUse: false);
      if (result['success'] == true) {
        return result;
      }
      // Port in use, try next
      if (BridgeLogging.debugLogging) print('[CLITRY] Port $port in use, trying next...');
    }
    
    // No ports available
    return {
      'success': false,
      'message': 'No available ports in range $defaultCliServerPort-$maxCliServerPort',
      'error': 'NO_PORT_AVAILABLE',
    };
  }
  
  /// Try to start CLI server on a specific port
  Future<Map<String, dynamic>> _tryStartCliServerOnPort(int port, {required bool failOnPortInUse}) async {
    try {
      _cliServer = CliIntegrationServer(this, port: port);
      await _cliServer!.start();
      
      print('[CLIOK] CLI integration server started on port $port');
      
      return {
        'success': true,
        'message': 'CLI server started on port $port',
        'port': port,
        'alreadyRunning': false,
      };
    } on SocketException catch (e) {
      _cliServer = null;
      if (failOnPortInUse) {
        _sendError('Failed to start CLI server: ${e.message}');
        return {
          'success': false,
          'message': e.message,
          'port': port,
          'error': 'PORT_IN_USE',
        };
      }
      // Return failure without error logging (will try next port)
      return {
        'success': false,
        'port': port,
        'error': 'PORT_IN_USE',
      };
    } catch (e) {
      _cliServer = null;
      _sendError('Failed to start CLI server: $e');
      return {
        'success': false,
        'message': e.toString(),
        'port': port,
        'error': 'UNKNOWN',
      };
    }
  }
  
  /// Stop the CLI integration server
  Future<Map<String, dynamic>> _stopCliServer() async {
    if (_cliServer == null || !_cliServer!.isRunning) {
      return {
        'success': true,
        'message': 'CLI server was not running',
        'wasRunning': false,
      };
    }
    
    final port = _cliServer!.serverPort;
    await _cliServer!.stop();
    _cliServer = null;
    
    print('[CLISTP] CLI integration server stopped');
    
    return {
      'success': true,
      'message': 'CLI server stopped',
      'port': port,
      'wasRunning': true,
    };
  }
  
  /// Get CLI server status
  Map<String, dynamic> _getCliServerStatus() {
    final isRunning = _cliServer?.isRunning == true;
    return {
      'running': isRunning,
      'port': isRunning ? _cliServer!.serverPort : null,
    };
  }

  // -------------------------------------------------------------------
  // Debug Logging Control
  // -------------------------------------------------------------------

  /// Set debug logging on or off
  Map<String, dynamic> _setDebugLogging(Map<String, dynamic> params) {
    final enabled = params['enabled'] as bool? ?? false;
    BridgeLogging.setDebugLogging(enabled);
    print('[DBGSET] Debug logging ${enabled ? "enabled" : "disabled"}');
    return {
      'success': true,
      'debugLogging': BridgeLogging.debugLogging,
      'debugTraceLogging': BridgeLogging.debugTraceLogging,
    };
  }

  /// Get current debug logging status
  Map<String, dynamic> _getDebugLogging() {
    return {
      'debugLogging': BridgeLogging.debugLogging,
      'debugTraceLogging': BridgeLogging.debugTraceLogging,
    };
  }

  // -------------------------------------------------------------------
  // Process Monitor Operations
  // -------------------------------------------------------------------

  /// Start the Tom Process Monitor and verify all related processes are running.
  /// 
  /// The Process Monitor starts as a detached process at:
  /// `~/.tom/bin/darwin_arm64/Tom Process Monitor`
  /// 
  /// After starting, waits 3 seconds and checks if:
  /// - Process Monitor is alive
  /// - Watcher is alive  
  /// - Ledger Server is alive
  Future<Map<String, dynamic>> _startProcessMonitor(Map<String, dynamic> params) async {
    final home = Platform.environment['HOME'] ?? '/Users/${Platform.environment['USER']}';
    final processMonitorPath = '$home/.tom/bin/darwin_arm64/Tom Process Monitor';
    final defaultDirectory = '$home/.tom/process_monitor';

    // Check if Process Monitor binary exists
    if (!File(processMonitorPath).existsSync()) {
      return {
        'success': false,
        'message': 'Process Monitor binary not found at: $processMonitorPath',
        'error': 'BINARY_NOT_FOUND',
      };
    }

    // Ensure the default directory exists
    final dir = Directory(defaultDirectory);
    if (!dir.existsSync()) {
      dir.createSync(recursive: true);
    }

    try {
      // Start Process Monitor as a detached process
      if (BridgeLogging.debugLogging) {
        print('[PMSTRT] Starting Tom Process Monitor from: $processMonitorPath');
        print('[PMDIR] Directory parameter: $defaultDirectory');
      }

      await Process.start(
        processMonitorPath,
        ['--directory', defaultDirectory],
        mode: ProcessStartMode.detached,
      );

      if (BridgeLogging.debugLogging) print('[PMWAIT] Process Monitor started, waiting 3 seconds for processes to initialize...');
      
      // Wait 3 seconds for processes to start
      await Future<void>.delayed(const Duration(seconds: 3));

      // Check aliveness of all processes
      final processMonitorAlive = await _isProcessRunning('Tom Process Monitor');
      final watcherAlive = await _isProcessRunning('Tom Watcher') || await _isProcessRunning('monitor_watcher');
      final ledgerServerAlive = await _isProcessRunning('Tom Ledger Server');

      final allAlive = processMonitorAlive && watcherAlive && ledgerServerAlive;
      final status = StringBuffer();
      status.write('Process Monitor: ${processMonitorAlive ? "alive" : "not running"}, ');
      status.write('Watcher: ${watcherAlive ? "alive" : "not running"}, ');
      status.write('Ledger Server: ${ledgerServerAlive ? "alive" : "not running"}');

      if (BridgeLogging.debugLogging) print('[PMSTAT] Process status: $status');

      return {
        'success': allAlive,
        'message': allAlive 
            ? 'All processes started successfully'
            : 'Some processes failed to start: $status',
        'processMonitor': {'alive': processMonitorAlive},
        'watcher': {'alive': watcherAlive},
        'ledgerServer': {'alive': ledgerServerAlive},
      };
    } catch (e) {
      print('[PMERR] Error starting Process Monitor: $e');
      return {
        'success': false,
        'message': 'Failed to start Process Monitor: $e',
        'error': 'START_FAILED',
      };
    }
  }

  /// Check if a process with the given name is running using pgrep
  Future<bool> _isProcessRunning(String processName) async {
    try {
      final result = await Process.run('pgrep', ['-f', processName]);
      return result.exitCode == 0 && result.stdout.toString().trim().isNotEmpty;
    } catch (e) {
      if (BridgeLogging.debugLogging) print('[PCHKERR] Error checking process $processName: $e');
      return false;
    }
  }

  // -------------------------------------------------------------------
  // Workspace Operations
  // -------------------------------------------------------------------

  /// Get workspace information
  Future<Map<String, dynamic>> _getWorkspaceInfo(
    Map<String, dynamic> params,
  ) async {
    final workspaceRoot = params['workspaceRoot'] as String?;

    if (workspaceRoot == null) {
      throw Exception('workspaceRoot parameter is required');
    }

    final dir = Directory(workspaceRoot);
    if (!dir.existsSync()) {
      throw Exception('Workspace directory does not exist: $workspaceRoot');
    }

    // List top-level directories
    final projects = <String>[];
    await for (final entity in dir.list()) {
      if (entity is Directory) {
        projects.add(entity.path.split('/').last);
      }
    }

    return {
      'root': workspaceRoot,
      'projects': projects,
      'projectCount': projects.length,
    };
  }

  /// Generate documentation
  Future<Map<String, dynamic>> _generateDocs(
    Map<String, dynamic> params,
  ) async {
    final projectPath = params['projectPath'] as String?;
    final prompt = params['prompt'] as String?;

    if (projectPath == null || prompt == null) {
      throw Exception('projectPath and prompt parameters are required');
    }

    if (BridgeLogging.debugLogging) print('[DOCGEN] Generating documentation for: $projectPath');

    // Ask Copilot via VS Code (nested request to TypeScript)
    final copilotResponse = await sendRequestGeneric<String>('askCopilot', {
      'prompt': prompt,
    }, scriptName: '_generateDocs');

    // Write the documentation (nested request to TypeScript)
    final docsPath = '$projectPath/docs/generated.md';
    await sendRequest('writeFile', {
      'path': docsPath,
      'content': copilotResponse,
    }, scriptName: '_generateDocs');

    // Open the file (nested request to TypeScript)
    await sendRequest('openFile', {
      'path': docsPath,
    }, scriptName: '_generateDocs');

    return {
      'docsPath': docsPath,
      'success': true,
      'copilotResponse': copilotResponse,
    };
  }

  /// Execute a Dart file using D4rt interpreter
  /// Loads the file from disk and delegates to _executeScript
  Future<Map<String, dynamic>> _executeFile(
    Map<String, dynamic> params,
    Object? id,
  ) async {
    final filePath = params['filePath'] as String?;

    if (filePath == null) {
      throw Exception('filePath parameter is required');
    }

    // Load the file from disk
    final file = File(filePath);
    if (!file.existsSync()) {
      throw Exception('File does not exist: $filePath');
    }
    
    final script = await file.readAsString();
    
    if (BridgeLogging.debugLogging) print('[FLOAD] Loaded file $filePath (${script.length} chars) for execution');

    params['script'] = script;
    
    // Set basePath to the file's directory for relative imports
    // Only set if not already provided
    if (params['basePath'] == null) {
      params['basePath'] = file.parent.path;
    }

    // Delegate to _executeScript and return the result
    return await _executeScript(params, id);
  }

  /// Script has access to: params (request parameters) and context object
  /// Context includes: { bridge, sendRequest, sendNotification }
  /// final result = await context['sendRequest']('readFile', {'path': '/some/file'});
  /// return {'fileContent': result, 'params': params};
  /// ```
  Future<Map<String, dynamic>> _executeScript(
    Map<String, dynamic> params,
    Object? id, {
    bool useEval = false,
  }) async {
    final script = params['script'] as String?;
    final basePath = params['basePath'] as String?;
    final executeParams = params['params'] as Map<String, dynamic>? ?? {};

    if (script == null) {
      throw Exception('script parameter is required');
    }

    // Create execution context to capture logs and exceptions
    final executionContext = ExecutionContext();

    if (BridgeLogging.debugLogging) print('[SEXEC] Executing Dart script (${script.length} chars)${basePath != null ? " with basePath: $basePath" : ""}');

    // Build sources map by recursively resolving imports
    // This is a workaround for D4rt not implementing file system imports
    Map<String, String> sources = {};
    if (basePath != null) {
      final scriptUri = 'file://$basePath/__script__.dart';
      resolveImportsRecursively(script, scriptUri, sources, BridgeLogging.debugLogging ? print : null);
    }

    try {
      // Initialize the bridge context with params before running the script
      _vsCodeBridge.setExecutionContext(
        executeParams,
        {},
        bridgeServer: this,
      );

      // Use a Completer to handle the async result from the guarded zone
      final completer = Completer<Map<String, dynamic>>();
      
      // Use runZonedGuarded to catch uncaught async exceptions
      unawaited(runZonedGuarded(
        () async {
          if (BridgeLogging.debugLogging) print('[SEVAL] ${useEval ? "Evaluating expression" : "Executing script"}...');
          
          // Execute D4rt with try-catch to capture local exceptions
          Object? rawResult;
          try {
            if (useEval) {
              // Ensure an execution context exists before eval()
              _ensureExecutionContext();
              // Use eval() for direct expression evaluation
              rawResult = _interpreter.eval(script);
            } else if (basePath != null) {
              // When basePath is provided, use library + sources approach to enable relative imports
              // This works around D4rt's basePath not setting currentlibrary
              final libraryUri = 'file://$basePath/__script__.dart';
              // Add the main script to sources
              sources[libraryUri] = script;
              rawResult = _interpreter.execute(
                library: libraryUri,
                sources: sources,
                basePath: basePath,
                allowFileSystemImports: true,
              );
            } else {
              rawResult = _interpreter.execute(
                source: script,
                allowFileSystemImports: false,
              );
            }
          } catch (e, stackTrace) {
            print('[D4RTERR] D4rt execution error: $e');
            executionContext.recordException(e, stackTrace);
            // Return error response with logs
            final errorPayload = {
              'success': false,
              'error': e.toString(),
              'stackTrace': stackTrace.toString(),
              'logs': executionContext.logs,
            };
            if (id != null) {
              _sendResponse(id, errorPayload);
            }
            if (!completer.isCompleted) {
              completer.complete(errorPayload);
            }
            return;
          }
          
          if (BridgeLogging.debugLogging) print('[SDONE] Script executed, processing result... $rawResult');

          dynamic resolved = rawResult;
          try {
            if (rawResult is Future) {
              if (BridgeLogging.debugLogging) print('[SFUT] Resolving script future...');
              // Script execution can take a very long time for AI-assisted document processing
              // (e.g., askCopilotChat polling). Set to 48 hours to allow for long-running operations.
              resolved = await rawResult.timeout(
                const Duration(hours: 48),
                onTimeout: () {
                   print('[B02] Script execution timed out after 48 hours');
                  throw TimeoutException('[B02] Script execution timed out after 48 hours');
                },
              );
            }
          } catch (e, stackTrace) {
            print('[B03] Script future completed with error: $e');
            executionContext.recordException(e, stackTrace);
            final errorPayload = {
              'success': false,
              'error': e.toString(),
              'stackTrace': stackTrace.toString(),
              'logs': executionContext.logs,
            };
            if (id != null) {
              _sendResponse(id, errorPayload);
            }
            if (!completer.isCompleted) {
              completer.complete(errorPayload);
            }
            return;
          }

          // For eval(), resolved is the direct expression value
          // For execute(), the script may set a result in the zone's result map via context
          // Use zone result if explicitly set, otherwise use the resolved rawResult
          final zoneResultMap = Zone.current['result'] as Map<String, dynamic>?;
          final zoneResult = zoneResultMap?['result'];
          final Object? finalResult = zoneResult ?? resolved;
          if (BridgeLogging.debugLogging) print('[SRESULT] Final result: $finalResult (zone: $zoneResult, resolved: $resolved)');

          final responsePayload = {
            'success': true,
            'result': finalResult,
            'logs': executionContext.logs,
            // Include exception info if one was recorded but caught internally
            if (executionContext.hasException) 'exception': executionContext.exceptionMessage,
            if (executionContext.hasException) 'exceptionStackTrace': executionContext.exceptionStackTrace,
          };

          if (id != null) {
            _sendResponse(id, responsePayload);
          }

          if (!completer.isCompleted) {
            completer.complete(responsePayload);
          }
        },
        // Error handler for uncaught async exceptions
        (error, stackTrace) {
          print('[SASYNC] Uncaught async exception in script: $error');
          executionContext.recordException(error, stackTrace);
          final errorPayload = {
            'success': false,
            'error': error.toString(),
            'stackTrace': stackTrace.toString(),
            'logs': executionContext.logs,
          };
          if (id != null) {
            _sendResponse(id, errorPayload);
          }
          if (!completer.isCompleted) {
            completer.complete(errorPayload);
          }
        },
        zoneValues: {
          'bridgeServer': this,
          'executionContext': executionContext,
          'result': <String, dynamic>{},
          'params': executeParams,
          if (id != null) 'callId': id.toString(),
        },
        // Override print to capture script output and forward to parent zone
        zoneSpecification: ZoneSpecification(
          print: (Zone self, ZoneDelegate parent, Zone zone, String line) {
            // Capture in execution context for error response logs
            executionContext.log(line);
            // Forward to parent zone (which routes to stderr for VS Code or socket for CLI)
            parent.print(zone, line);
          },
        ),
      ));
      
      // Wait for the script to complete
      return await completer.future;
    } catch (e, stackTrace) {
      // Outer catch for any uncaught exceptions in the surrounding code
      print('[SUNHDL] Unhandled exception during script execution: $e');
      executionContext.recordException(e, stackTrace);
      final errorPayload = {
        'success': false,
        'error': e.toString(),
        'stackTrace': stackTrace.toString(),
        'logs': executionContext.logs,
      };
      if (id != null) {
        _sendResponse(id, errorPayload);
      }
      return errorPayload;
    }
  }
}
