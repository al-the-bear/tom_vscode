# DartScript Extension User Guide

## 1) What the extension provides

The extension combines VS Code automation, bridge-based scripting, Copilot workflows, Tom AI chat tools, local LLM integration, and YAML graph editing.

## 2) Panels and layout

Current bottom panel layout:

- `@CHAT` (`dartscript.chatPanel`): Session Todo, Workspace Todo, Local LLM, AI Conversation, Copilot, Tom AI Chat.
- `@WS` (`dartscript.wsPanel`): Guidelines, Documentation, Logs, Settings, Issues, Tests, Quest TODO.

Explorer adds note and todo views for session, quest, and workspace contexts.

## 3) Sending prompts

### Copilot

Use command palette or editor context menu:

- `DS: Send to Copilot Chat`
- `DS: Send to Copilot Chat (Standard)`
- `DS: Send to Copilot Chat (Template)...`

In `@CHAT`, Copilot supports templates, prompt slots, answer-file notifications, and response-value extraction.

### Tom AI Chat

Use:

- `Tom AI: Start Chat`
- `Tom AI: Send Chat Prompt`
- `Tom AI: Interrupt Chat`

Tom AI Chat tools are initialized during activation and support workspace operations, editing actions, diagnostics, and integrations.

### Local LLM (Ollama)

Use:

- `DS: Send to local LLM`
- `DS: Send to local LLM (Standard)`
- `DS: Send to local LLM (Template)...`

Switch model with `DS: Change local Ollama model...`.

## 4) Bridge operations

Bridge and automation commands:

- `DS: Restart Bridge`
- `DS: Switch Dartscript Bridge Profile...`
- `DS: Start Tom CLI Integration Server`
- `DS: Stop Tom CLI Integration Server`
- `DS: Start Tom Process Monitor`

## 5) Status, config, and diagnostics

Use:

- `DS: Extension Status Page`
- `DS: Open Extension Settings`
- `DS: Open Config File`
- `DS: Toggle Bridge Debug Logging`

## 6) YAML graph editing

Open `*.flow.yaml`, `*.state.yaml`, or `*.er.yaml` files.

The custom editor requires a numeric `meta.graph-version` and renders Mermaid output based on registered graph types.

## 7) Keyboard productivity

See `quick_reference.md` and `../_copilot_guidelines/keybindings_and_commands.md`.

## 8) Reinstall and reload

If extension changes do not appear:

1. reinstall the extension package in the target VS Code host,
2. reload window,
3. rerun the affected command.

Detailed flow: `../_copilot_guidelines/reinstall_extension.md`.
