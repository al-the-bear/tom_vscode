# Project Guide: tom_vscode_extension

## Purpose

`tom_vscode_extension` provides VS Code integration for Tom workflows:

- multi-transport AI prompt tooling (Anthropic direct SDK, Claude Agent SDK, VS Code Copilot, Local LLM, AI Conversation),
- bridge-based automation for Dart / shell / workspace operations,
- panel-based productivity UX (chat, workspace, sidebar notes, todos),
- YAML graph, quest todo, markdown browser, and trail viewer custom editors,
- prompt queue + timed requests for scripted dispatch,
- status / config / debug utilities.

## Primary entry points

- **Activation:** [src/extension.ts](../src/extension.ts)
- **Commands:** `package.json` `contributes.commands` + registration in `src/handlers/*`
- **Panels:** `@CHAT` (`tomAi.chatPanel`) and `@WS` (`tomAi.wsPanel`) plus `@TOM` sidebar views
- **Core AI handler:** [anthropic-handler.ts](../src/handlers/anthropic-handler.ts) + [agent-sdk-transport.ts](../src/handlers/agent-sdk-transport.ts)

## Development workflow

1. Implement in TypeScript under `src/`.
2. Typecheck: `npx tsc --noEmit`.
3. Reinstall + reload the extension host when needed — see [reinstall_extension.md](reinstall_extension.md).
4. Validate affected commands / webviews manually; check the Problems pane is clean.
5. Commit with scoped paths (no `git add -A`), push.

## Documentation map

User-facing (`doc/`):

- [doc/user_guide.md](../doc/user_guide.md) — end-to-end feature guide.
- [doc/quick_reference.md](../doc/quick_reference.md) — compact commands + shortcuts.
- [doc/anthropic_handler.md](../doc/anthropic_handler.md) — Anthropic handler deep-dive.
- [doc/copilot_chat_tools.md](../doc/copilot_chat_tools.md) — Copilot chat tooling reference.
- [doc/chat_log_custom_editor.md](../doc/chat_log_custom_editor.md) — Markdown Browser + live trail.
- [doc/file_and_prompt_placeholders.md](../doc/file_and_prompt_placeholders.md) — placeholder reference.

Maintainer (`_copilot_guidelines/`):

- [vscode_extension_overview.md](vscode_extension_overview.md) — canonical map.
- [architecture.md](architecture.md) — layering + data flow.
- [implementation.md](implementation.md) — code layout + patterns.
- [tom_ai_chat.md](tom_ai_chat.md), [tom_ai_bottom_panel.md](tom_ai_bottom_panel.md), [local_llm.md](local_llm.md), [bottom_panel_accordion.md](bottom_panel_accordion.md), [tab_navigation.md](tab_navigation.md) — chat + panel subsystems.
- [extension_bridge.md](extension_bridge.md), [bridge_scripting_guide.md](bridge_scripting_guide.md) — bridge subsystem.
- [keybindings_and_commands.md](keybindings_and_commands.md), [reinstall_extension.md](reinstall_extension.md) — operations.
- [tom_status_page.md](tom_status_page.md), [explorer_notes.md](explorer_notes.md) — status + sidebar.

## Current naming conventions

- Bottom panel titles: `@CHAT`, `@WS`. Sidebar: `@TOM`.
- Command namespace: `tomAi.*`.
- Chat variables: `${tomAi.quest}`, `${tomAi.role}`, `${tomAi.activeProjects}`, `${tomAi.todo}`, `${tomAi.workspaceName}`.
- Custom editor view types: `tomAi.yamlGraphEditor`, `tomAi.todoEditor`, `tomAi.markdownBrowser`, `tomAi.trailViewer`.
