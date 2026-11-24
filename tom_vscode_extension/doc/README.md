# @Tom VS Code Extension Documentation

User-facing documentation for the `tom_vscode_extension` plugin. Implementation guidelines for contributors are kept apart from it, in the extension's `_agent_guidelines/` folder in the source tree.

## Start here

- [user_guide.md](user_guide.md) — end-to-end feature usage guide.
- [quick_reference.md](quick_reference.md) — compact command and shortcut reference.

## Subsystem deep-dives

- [anthropic_handler.md](anthropic_handler.md) — Anthropic direct SDK + Agent SDK handler, profiles, history modes, trails, approval gate.
- [mcp_server.md](mcp_server.md) — standalone MCP server: config, auth + read-only floor, lifecycle, security, observability.
- [agent_sdk_scripting_mirror.md](agent_sdk_scripting_mirror.md) — Agent SDK 1:1 Dart mirror for scripting: type surface, `query()` streaming, reverse-RPC tools + `canUseTool`, workspace discovery, security boundary.
- [copilot_chat_tools.md](copilot_chat_tools.md) — Copilot chat tooling reference.
- [llm_tools.md](llm_tools.md) — the LLM tool surface, per transport.
- [chat_log_custom_editor.md](chat_log_custom_editor.md) — Markdown Browser + live-trail follow-tail behavior.
- [md_browser_page_protocol.md](md_browser_page_protocol.md) — the Markdown Browser page's message protocol as a versioned contract: the version, the capabilities a host declares, every message with its fields and answer, and the decisions that are the host's.
- [anthropic_sdk_integration.md](anthropic_sdk_integration.md) — the Anthropic SDK integration in full: profiles, configurations, memory, compaction, trails.
- [llm_configuration.md](llm_configuration.md) — Local LLM, Anthropic and history-compaction settings: per-configuration overrides, tool-trail retention, the placeholders, the aspect guidelines.
- [chat_enhancements.md](chat_enhancements.md) — chat panel feature design notes.
- [telegram_integration.md](telegram_integration.md) — Telegram remote control and notifications: commands, per-quest configuration, the live-conversation forwarder, one receiver per bot token.
- [tomspecs_agent_workflow.md](tomspecs_agent_workflow.md) — for agents: editing a TomSpecs specification with the spec tools and taking it through Phase 4 (CodeSpecs).
- [multi_transport_prompt_queue_revised.md](multi_transport_prompt_queue_revised.md) — prompt queue model across transports.

## Editors + visual tools

- [marktext_integration.md](marktext_integration.md) — MarkText editor integration notes.
- [docspecs_linter_design.md](docspecs_linter_design.md) — DocSpecs linter design.

## Supporting references

- [placeholder_engine.md](placeholder_engine.md) — the placeholder engine, for maintainers.
- [reading_notation_sample.md](reading_notation_sample.md) — a sample of the reading notation (provenance notes, citations) as the MD Browser renders it.
- [file_and_prompt_placeholders.md](file_and_prompt_placeholders.md) — supported placeholders and variable expansion.
- [workspace_setup.md](workspace_setup.md) — workspace layout expected by the extension.
- [extension_analysis.md](extension_analysis.md) — activation + command audit.
- [information/vs_code_extension.md](information/vs_code_extension.md) — VS Code extension API notes.

## Panel naming (current)

- Bottom panel **@CHAT** hosts the chat webview (`tomAi.chatPanel`) with two subpanels: Anthropic and Copilot.
- Bottom panel **@WS** hosts the workspace webview (`tomAi.wsPanel`).
- Sidebar **@TOM** hosts the quest's views (process, quest notes, quest and session todos); sidebar **@TOM WS** the workspace's (VS Code and workspace notes, workspace todos, the todo log, window status).
