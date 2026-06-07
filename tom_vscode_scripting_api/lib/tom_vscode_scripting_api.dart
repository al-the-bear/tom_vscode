/// VS Code Scripting API
///
/// Provides Dart abstractions for VS Code extension APIs.
/// This package allows you to interact with VS Code through a bridge adapter.
library;

// Core adapter interface
export 'src/vscode_adapter.dart';

// Bridge client for socket-based communication
export 'src/vscode_bridge_client.dart';

// Bridge adapter implementation
export 'src/vscode_bridge_adapter.dart';

// Main VS Code API
export 'src/vscode.dart';

// API namespaces
export 'src/vscode_commands.dart';
export 'src/vscode_extensions.dart';
export 'src/vscode_lm.dart';
export 'src/vscode_window.dart';
export 'src/vscode_workspace.dart';
export 'src/vscode_chat.dart';
export 'src/vscode_helper.dart';

// Types
export 'src/vscode_types.dart';

// Agent SDK 1:1 mirror — type surface (todo #2): messages/blocks (raw-
// preserving), Options + sealed configs, permission and MCP value types.
export 'src/agent_sdk_messages.dart';
export 'src/agent_sdk_permissions.dart';
export 'src/agent_sdk_mcp.dart';
export 'src/agent_sdk_options.dart';

// Agent SDK 1:1 mirror — streaming query() core (todo #3): typed message
// stream, the transport seam, and the bridge-backed transport.
export 'src/agent_sdk_query.dart';

// Bidirectional RPC primitive (todo #4): client half that routes incoming
// server→client requests to registered handlers and replies over the socket.
export 'src/bridge_request_dispatcher.dart';

// AI APIs (local LLM prompt processing & bot conversation)
export 'src/ai_prompt_api.dart';
export 'src/ai_conversation_api.dart';

// Tom APIs (workspace, todos, queue, timed requests, documents)
export 'src/tom_todo_api.dart';
export 'src/tom_queue_api.dart';
export 'src/tom_timed_api.dart';
export 'src/tom_document_api.dart';
export 'src/tom_workspace_api.dart';
export 'src/tom_tools_api.dart';
export 'src/tom_chat_api.dart';

// Script globals (vscode, window, workspace, commands, extensions, lm, chat)
export 'script_globals.dart';
