# @Tom VS Code Extension Documentation

User-facing documentation for the `tom_vscode_extension` plugin. For implementation guidelines aimed at contributors, see [../\_copilot\_guidelines/](../_copilot_guidelines/).

## Start here

- [user_guide.md](user_guide.md) — end-to-end feature usage guide.
- [quick_reference.md](quick_reference.md) — compact command and shortcut reference.

## Subsystem deep-dives

- [anthropic_handler.md](anthropic_handler.md) — Anthropic direct SDK + Agent SDK handler, profiles, history modes, trails, approval gate.
- [copilot_chat_tools.md](copilot_chat_tools.md) — Copilot chat tooling reference.
- [llm_tools.md](llm_tools.md) — Local LLM toolchain.
- [chat_log_custom_editor.md](chat_log_custom_editor.md) — Markdown Browser + live-trail follow-tail behavior.
- [multi_transport_prompt_queue_revised.md](multi_transport_prompt_queue_revised.md) — prompt queue model across transports.

## Editors + visual tools

- [yaml_graph.md](yaml_graph.md) — YAML graph editor behavior and usage.
- [yaml_graph_architecture_design.md](yaml_graph_architecture_design.md) — graph editor implementation architecture.
- [diagram_editing.md](diagram_editing.md) — editing workflow and interaction model.
- [docspecs_linter_design.md](docspecs_linter_design.md) — DocSpecs linter design.

## Supporting references

- [file_and_prompt_placeholders.md](file_and_prompt_placeholders.md) — supported placeholders and variable expansion.
- [workspace_setup.md](workspace_setup.md) — workspace layout expected by the extension.
- [extension_analysis.md](extension_analysis.md) — activation + command audit.
- [information/vs_code_extension.md](information/vs_code_extension.md) — VS Code extension API notes.
- [information/mermaid_diagrams.md](information/mermaid_diagrams.md) — Mermaid rendering notes.

## Refactoring + analysis archive

- [refactoring/reusable_component_analysis.md](refactoring/reusable_component_analysis.md) — reusable webview/UI component inventory.
- [refactoring/duplication_analysis.md](refactoring/duplication_analysis.md), [refactoring/extension_discrepancies.md](refactoring/extension_discrepancies.md), [refactoring/hardcoded_constants_audit.md](refactoring/hardcoded_constants_audit.md), [refactoring/refactoring_plan.md](refactoring/refactoring_plan.md), [refactoring/refactoring_status.md](refactoring/refactoring_status.md).
- [review/](review/) — structural reviews (code, config, file storage, module graph, deprecation).

## Panel naming (current)

- Bottom panel **@CHAT** hosts the chat webview (`tomAi.chatPanel`) with five subpanels: Anthropic, Tom AI Chat, AI Conversation, Copilot, Local LLM.
- Bottom panel **@WS** hosts the workspace webview (`tomAi.wsPanel`).
- Sidebar **@TOM** hosts tree views for notes, todos, the todo log, and window status.
