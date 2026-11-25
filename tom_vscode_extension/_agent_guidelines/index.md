# Tom VS Code Extension Project Guidelines

Project: `tom_vscode_extension`  
Type: TypeScript extension

## Global references

- [Documentation Guidelines](../../../../../../../../_agent_guidelines/documentation_guidelines.md)
- [Dart Coding Guidelines](../../../../_agent_guidelines/dart/coding_guidelines.md)
- [Dart Unit Tests](../../../../_agent_guidelines/dart/unit_tests.md)

## Project-specific guidelines

- [vscode_extension_overview.md](vscode_extension_overview.md)
- [architecture.md](architecture.md)
- [panels_and_views.md](panels_and_views.md) — the bottom panels, the sidebars and their views with the handler or service of each; roles, role types and aspect guidelines in the UI; a folder without a quest
- [configuration_files.md](configuration_files.md) — the configuration files (the schema and `sendToChatConfig.ts`, the root's `.tom/tom_vscode_extension.json`, the two per-quest `extension_config` files) and the code that owns them
- [implementation.md](implementation.md)
- [project.md](project.md)
- [copilot_guidelines.md](copilot_guidelines.md)
- [extension_bridge.md](extension_bridge.md)
- [bridge_scripting_guide.md](bridge_scripting_guide.md)
- [keybindings_and_commands.md](keybindings_and_commands.md)
- [tom_ai_bottom_panel.md](tom_ai_bottom_panel.md)
- [tom_status_page.md](tom_status_page.md)
- [anthropic_chat.md](anthropic_chat.md)
- [prompt_queue_timed_templates.md](prompt_queue_timed_templates.md)
- [local_llm.md](local_llm.md)
- [explorer_notes.md](explorer_notes.md)
- [bottom_panel_accordion.md](bottom_panel_accordion.md)
- [tab_navigation.md](tab_navigation.md)
- [media_webview_migration.md](media_webview_migration.md)
- [reinstall_extension.md](reinstall_extension.md)
- [restart_debugging_flow.backup.md](restart_debugging_flow.backup.md)
- [tool_testing.md](tool_testing.md) — testing the tools: the vscode stub, timing report, coverage audit, and the all-tools MCP suite (every tool over the MCP server, in a sandbox)
- [todo_files_and_panel.md](todo_files_and_panel.md) — TRA todo mechanics: -archived/-deleted sibling rule, panel move buttons, per-host session todo file, archive/delete LLM tools

## User-facing docs

- [doc/README.md](../doc/README.md)
- [doc/user_guide.md](../doc/user_guide.md)
- [doc/quick_reference.md](../doc/quick_reference.md)
- [doc/mcp_server.md](../doc/mcp_server.md)
- [doc/agent_sdk_scripting_mirror.md](../doc/agent_sdk_scripting_mirror.md)
