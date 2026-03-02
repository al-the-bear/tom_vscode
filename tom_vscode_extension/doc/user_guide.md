# @Tom Extension User Guide

## 1) What the extension provides

The extension combines VS Code automation, bridge-based scripting, Copilot workflows, Tom AI chat tools, local LLM integration, and YAML graph editing.

## 2) Panels and layout

Current bottom panel layout:

- `@CHAT` (`tomAi.chatPanel`): Session Todo, Workspace Todo, Local LLM, AI Conversation, Copilot, Tom AI Chat.
- `@WS` (`tomAi.wsPanel`): Guidelines, Documentation, Logs, Settings, Issues, Tests, Quest TODO.

Explorer adds note and todo views for session, quest, and workspace contexts.

## 3) Sending prompts

### Copilot

Use command palette or editor context menu:

- `@T: Send to Copilot`
- `@T: Send to Copilot (Default Template)`
- `@T: Send to Copilot (Pick Template)`

In `@CHAT`, Copilot supports templates, prompt slots, answer-file notifications, and response-value extraction.

### Tom AI Chat

Use:

- `@T: Start Tom AI Chat`
- `@T: Send Tom AI Chat Prompt`
- `@T: Interrupt Tom AI Chat`

Tom AI Chat tools are initialized during activation and support workspace operations, editing actions, diagnostics, and integrations.

### Local LLM (Ollama)

Use:

- `@T: Send to Local LLM`
- `@T: Send to Local LLM (Default Template)`
- `@T: Send to Local LLM (Pick Template)`

Switch model with `@T: Change Local LLM Model...`.

## 4) Bridge operations

Bridge and automation commands:

- `@T: Restart Bridge`
- `@T: Switch Bridge Profile...`
- `@T: Start Tom CLI Integration Server`
- `@T: Stop Tom CLI Integration Server`
- `@T: Start Process Monitor`

## 5) Status, config, and diagnostics

Use:

- `@T: Extension Status Page`
- `@T: Open Extension Settings`
- `@T: Open Config File`
- `@T: Toggle Bridge Debug Logging`

## 6) YAML graph editing

Open `*.flow.yaml`, `*.state.yaml`, or `*.er.yaml` files.

The custom editor requires a numeric `meta.graph-version` and renders Mermaid output based on registered graph types.

## 7) Keyboard productivity

See [quick_reference.md](quick_reference.md) and [../_copilot_guidelines/keybindings_and_commands.md](../_copilot_guidelines/keybindings_and_commands.md).

## 8) Reinstall and reload

If extension changes do not appear:

1. reinstall the extension package in the target VS Code host,
2. reload window,
3. rerun the affected command.

Detailed flow: [../_copilot_guidelines/reinstall_extension.md](../_copilot_guidelines/reinstall_extension.md).
