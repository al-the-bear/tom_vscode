/// VS Code Bridge Library
/// 
/// Provides JSON-RPC bridge between Dart and TypeScript (VS Code Extension)
/// and comprehensive Dart wrappers for the VS Code API.
/// 
/// The VS Code API wrappers are in the `tom_vscode_scripting_api` package.
library;

// Core bridge
export 'bridge_server.dart';

// Script execution API
export 'script_api.dart';

// Re-export VS Code API from tom_vscode_scripting_api
export 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';
