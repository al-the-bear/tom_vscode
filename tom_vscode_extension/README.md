# @Tom VS Code Extension

A VS Code extension that enhances Dart/Flutter development with Copilot Chat integration, Dart script execution, and workspace automation tools.

## Overview

@Tom provides productivity features for VS Code including smart Copilot Chat integration with customizable templates, Dart script execution via the D4rt interpreter, and Tom CLI integration for workspace automation.

## Key Features

- 🤖 **Copilot Chat Integration**: Send text to Copilot with customizable prompt templates
- 🧠 **Local LLM (Ollama)**: Expand, rewrite, and process prompts using a local Ollama model — with configurable profiles and model switching. See the [User Guide](doc/user_guide.md#prompt-expander-ollama) for details.
- 💬 **Bot Conversation**: Orchestrate multi-turn conversations between a local Ollama model and GitHub Copilot, with halt/continue control, self-talk mode, and Telegram notifications. See the [User Guide](doc/user_guide.md#bot-conversation-ollama--copilot) for details.
- ⚡ **Dart Script Execution**: Execute Dart files directly or via D4rt interpreter
- 🔧 **Tom CLI Integration**: Control Tom CLI from VS Code with server communication
- 📊 **Process Monitor**: Background process monitoring with auto-restart
- � **Issue & Test Tracking**: GitHub issue management with configurable columns, statuses, labels, and split-panel detail view. See the [User Guide](doc/user_guide.md#tom-panel) for configuration.
- �🔄 **Window Reload**: Quick keyboard shortcut for window reload
- ❓ **Extension Help**: Built-in documentation access

## Installation

Build and install from source:

```bash
cd xternal/tom_module_vscode/tom_vscode_extension
npm install
npm run compile
bash reinstall_for_testing.sh
```

Or install from VSIX:

```bash
code --install-extension tom-ai-extension-0.1.0.vsix
```

## Commands

Open Command Palette (`Cmd+Shift+P` or `Ctrl+Shift+P`) and type "@T:" to see all commands:

### Copilot Chat Commands

| Command | Description |
|---------|-------------|
| **@T: Send to Copilot** | Send selected text to Copilot Chat |
| **@T: Send to Copilot (Default Template)** | Send with standard formatting |
| **@T: Send to Copilot (Pick Template)** | Choose from custom prompt templates |
| **@T: Reload Configuration** | Reload prompt template configuration |
| **@T: Show Chat Answer Values** | Display captured chat answer values |
| **@T: Clear Chat Answer Values** | Clear captured chat answer values |

### Send to Chat Submenu Templates

Right-click in the editor to access the "Send to Copilot..." submenu:

- **Send with Trail Reminder** - Include chat trail reminder
- **TODO Execution** - Execute TODO items
- **Code Review** - Request code review
- **Explain Code** - Get code explanation
- **Add to Todo** - Add selection to todo list
- **Fix Markdown here** - Fix markdown formatting

### Dart Execution Commands

| Command | Description |
|---------|-------------|
| **@T: Execute File** | Execute selected Dart file as subprocess |
| **@T: Execute as Script** | Execute Dart file via D4rt interpreter |

### Bridge & Server Commands

| Command | Description |
|---------|-------------|
| **@T: Restart Bridge** | Restart the Dart bridge process |
| **@T: Start Tom CLI Integration Server** | Start CLI server on default port |
| **@T: Start CLI Server (Custom Port)** | Start CLI server on custom port |
| **@T: Stop Tom CLI Integration Server** | Stop the running CLI server |
| **@T: Start Process Monitor** | Start background process monitor |
| **@T: Toggle Bridge Debug Logging** | Enable/disable detailed bridge logging |

### Local LLM Commands (Ollama)

| Command | Description |
|---------|-------------|
| **@T: Send to Local LLM** | Expand/process selected text using local Ollama model |
| **@T: Change Local LLM Model...** | Pick a different Ollama model |
| **@T: Send to Local LLM (Default)** | Send selected text to local LLM |
| **@T: Send to Local LLM (Default Template)** | Send with default profile |
| **@T: Send to Local LLM (Pick Template)** | Choose a profile template |

Right-click in the editor to access the "Send to Local LLM..." submenu with Expand, Rewrite, Detailed, and Annotated templates.

See the [User Guide](doc/user_guide.md#prompt-expander-ollama) for configuration and profile setup.

### Bot Conversation Commands

| Command | Description |
|---------|-------------|
| **@T: Start AI Conversation** | Start a multi-turn bot conversation |
| **@T: Stop AI Conversation** | Stop the active conversation |
| **@T: Halt AI Conversation** | Pause the conversation between turns |
| **@T: Continue AI Conversation** | Resume a halted conversation |
| **@T: Add to AI Conversation** | Inject additional context into the next turn |

See the [User Guide](doc/user_guide.md#bot-conversation-ollama--copilot) for profiles, self-talk mode, and Telegram integration.

### Tom AI Chat Commands

| Command | Description |
|---------|-------------|
| **@T: Start Tom AI Chat** | Initialize a .chat.md file for Tom AI chat |
| **@T: Send Tom AI Chat Prompt** | Send the current prompt in a .chat.md file |
| **@T: Interrupt Tom AI Chat** | Interrupt the active Tom AI chat session |

### Utility Commands

| Command | Description |
|---------|-------------|
| **@T: Reload Window** | Reload VS Code window (Command Palette only) |
| **@T: Run Tests** | Run extension tests |
| **@T: Show Extension Help** | Open extension documentation |
| **@T: Print Configuration** | Print D4rt interpreter configuration to output |
| **@T: Show VS Code API Info** | Show available language models, tools, and AI extensions |

## Context Menu Actions

### File Explorer (on .dart files)

- **@T: Execute File** - Run Dart file as subprocess
- **@T: Execute as Script** - Run via D4rt interpreter

### Editor Context Menu

- **Send to Copilot...** - Submenu with template options
- **@T: Send to Copilot (Default Template)** - Quick send
- **@T: Send to Copilot (Pick Template)** - Template picker
- **@T: Send to Copilot** - Send selection (when text selected)
- **@T: Execute as Script** - Run current Dart file

## Keyboard Shortcuts (Which-Key Menus)

Shortcuts use a **which-key menu** system — press a trigger key to open a popup, then press the indicated letter to execute instantly (no Enter needed). Works whether you release `Ctrl+Shift` first or keep it held.

| Trigger Key | Menu | Available Commands |
|-------------|------|--------------------|
| `Ctrl+Shift+C` | Conversation | **B**egin, **S**top, **H**alt, **C**ontinue, **A**dd info, **?** Help |
| `Ctrl+Shift+L` | Local LLM | E**x**pand, **C**hange model, **S**tandard, **T**emplate, **?** Help |
| `Ctrl+Shift+A` | Send to Chat | Send to **C**hat, **S**tandard, **T**emplate, **R**eload config, **?** Help |
| `Ctrl+Shift+T` | Tom AI Chat | **N**ew chat, **S**end prompt, **I**nterrupt, **?** Help |
| `Ctrl+Shift+E` | Execute | **E**xecute, **A**dd, **D**elete, **O**pen config, **?** Help |

## Custom Prompt Templates

Create a `tom_vscode_extension.json` file to define custom prompt templates:

**Default location**: `${workspaceFolder}/.tom/tom_vscode_extension.json`

Example configuration:

```json
{
  "templates": [
    {
      "id": "code-review",
      "name": "Code Review",
      "prompt": "Please review the following code:\n\n${selection}"
    },
    {
      "id": "explain",
      "name": "Explain Code",
      "prompt": "Explain what this code does:\n\n${selection}"
    }
  ]
}
```

Templates support these variables:
- `${selection}` - Currently selected text
- `${file}` - Current file path
- `${file.name}` - Current file name (without extension)

The configuration file is watched and auto-reloads when saved.

## Configuration

Access settings via **File > Preferences > Settings**, then search for "tomAi":

| Setting | Default | Description |
|---------|---------|-------------|
| `tomAi.contextApproach` | `accumulation` | Context persistence approach (`accumulation` or `persistent`) |
| `tomAi.maxContextSize` | `50000` | Maximum context size in tokens |
| `tomAi.autoRunOnSave` | `false` | Automatically run scripts on save |
| `tomAi.copilotModel` | `gpt-4o` | Preferred Copilot model |
| `tomAi.configPath` | `~/.tom_ai/vscode/tom_vscode_extension.json` | Path to extension config file |
| `tomAi.sendToChat.showNotifications` | `true` | Show notifications when sending to chat |
| `tomAi.sendToChat.chatAnswerFolder` | `_ai/chat_replies` | Folder for chat answer files |

## Tom CLI Integration

The extension can start a server that allows Tom CLI to communicate with VS Code:

1. **Start server**: Run "@T: Start Tom CLI Integration Server"
2. **Use Tom CLI**: CLI commands can now interact with VS Code
3. **Stop server**: Run "@T: Stop Tom CLI Integration Server"

The server enables:
- Sending prompts to Copilot Chat from CLI
- Reading chat responses
- Executing VS Code commands remotely

## Process Monitor

Start the Tom Process Monitor to watch and auto-restart background processes:

1. Run "@T: Start Process Monitor"
2. Monitor watches configured processes
3. Auto-restarts crashed processes
4. Logs status to output channel

## Architecture

```
┌──────────────────────────────────┐
│  @Tom Extension                  │
│  (VS Code Extension - TypeScript)│
│  - Commands & menus              │
│  - Copilot Chat integration      │
│  - CLI server                    │
└────────────┬─────────────────────┘
             │ JSON-RPC 2.0
             │ stdin/stdout
┌────────────▼─────────────────────┐
│  Dart Bridge (optional)          │
│  (Dart Process)                  │
│  - D4rt script execution         │
│  - Bridge server                 │
└──────────────────────────────────┘
```

## Requirements

- VS Code 1.85.0 or higher
- GitHub Copilot subscription (for chat features)
- Dart SDK 3.0+ (for script execution and bridge)

## Development

### Project Structure

```
tom_vscode_extension/
├── src/
│   ├── extension.ts           # Main extension activation
│   ├── vscode-bridge.ts       # DartBridgeClient (JSON-RPC)
│   ├── handlers/              # Command handlers (~30 files)
│   ├── managers/              # Todo persistence
│   └── tools/                 # Language Model Tool implementations
├── out/                       # Compiled JavaScript (generated)
├── doc/                       # Documentation (ARCHITECTURE, IMPLEMENTATION, USER_GUIDE)
├── _copilot_guidelines/       # Developer reference docs
├── package.json               # Extension manifest
├── tsconfig.json              # TypeScript configuration
└── README.md                  # This file
```

### Building

```bash
npm install
npm run compile
```

### Watching for Changes

```bash
npm run watch
```

### Testing in Development

1. Open this folder in VS Code
2. Press F5 to launch Extension Development Host
3. Test commands in the new window

### Reinstalling for Testing

```bash
bash reinstall_for_testing.sh
```

## License

Copyright (c) 2024-2026 Tom Framework. All rights reserved.

## Documentation

- [User Guide](doc/user_guide.md) - Complete guide to extension features
- [Quick Reference](doc/quick_reference.md) - Keyboard shortcuts and panel overview
- [Feature Overview](_copilot_guidelines/vscode_extension_overview.md) - All 15 feature areas with documentation index
- [Bridge Scripting Guide](_copilot_guidelines/bridge_scripting_guide.md) - Advanced JavaScript/Dart bridge scripting
- [Architecture](_copilot_guidelines/architecture.md) - System architecture details

## Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [Chat API](https://code.visualstudio.com/api/extension-guides/chat)
