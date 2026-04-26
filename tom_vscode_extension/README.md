# @Tom VS Code Extension

A VS Code extension for Copilot-driven workflows, prompt queue automation, timed requests, workspace tools, and bridge-based scripting.

## Overview

@Tom provides a unified AI workspace in VS Code with:

- Copilot and local LLM prompt workflows
- prompt queue orchestration with follow-ups, reminders, and repeat support
- timed request scheduling that enqueues prompts automatically
- markdown/guideline browsing and quest navigation
- bridge and CLI integration for workspace automation

## Key Features

- Copilot prompt send flows with template support
- @CHAT panel with repeat (R) and answer-wait (W) action-bar fields
- Prompt Queue editor with auto-send, auto-start, auto-pause, auto-continue, and restart controls
- RequestId-based answer detection with file watcher + polling fallback
- Timed Requests editor with interval/scheduled modes, sendMaximum, repeat affixes, and answer wait minutes
- Dedicated output channels: Tom Prompt Queue and Tom Timed Requests
- Markdown Browser with grouped document picker, quest filters, line anchors, and auto reload
- Window Status panel showing per-window subsystem state from window-state files
- Local LLM, AI Conversation, and Tom AI Chat integration
- D4rt/bridge/CLI runtime tooling

## Installation

Build and install from source:

```bash
npm install
npm run compile
bash install_extension.sh
```

Or install a VSIX package:

```bash
code --install-extension tom-ai-extension-0.1.0.vsix
```

## Main Commands

Open the command palette and type @T: to discover commands.

### Core AI Commands

- @T: Send to Copilot
- @T: Send to Copilot (Default Template)
- @T: Send to Copilot (Pick Template)
- @T: Send to Local LLM
- @T: Change Local LLM Model...
- @T: Start AI Conversation
- @T: Start Tom AI Chat

### Queue and Timer Commands

- @T: Open Prompt Queue
- @T: Open Timed Requests
- @T: Open Prompt Templates
- @T: Open Reusable Prompts

### Workspace and Runtime Commands

- @T: Open in Markdown Browser
- @T: Extension Status Page
- @T: Restart Bridge
- @T: Start Tom CLI Integration Server
- @T: Stop Tom CLI Integration Server
- @T: Start Process Monitor

## Keybindings

See full keybindings in [doc/quick_reference.md](doc/quick_reference.md).

High-use shortcuts:

- Ctrl+Shift+0: focus @CHAT
- Ctrl+Shift+9: focus @WS
- Ctrl+Shift+6: open Prompt Queue
- Ctrl+Shift+7: open Timed Requests
- Ctrl+Shift+5: open Raw Trail Viewer
- Ctrl+Shift+\: maximize toggle

## Queue and Timed Request Behavior

Prompt Queue highlights:

- one-file-per-entry YAML storage
- automation toggles for queue flow behavior
- repetition support with prefix/suffix placeholders
- answer-wait timeout for time-based auto-advance
- watchdog health checks to recover watcher issues

Timed Requests highlights:

- interval and scheduled firing modes
- sendMaximum with sentCount-based auto-pause
- reminder and repeat configuration
- global schedule slot filtering
- all fires enqueue through Prompt Queue (single dispatch path)

## Output Channels

- Tom Prompt Queue
- Tom Timed Requests
- Tom Debug
- Tom Tests
- Tom Dartbridge Log
- Tom Conversation Log
- Tom AI Chat Log
- Tom Tool Log
- Tom AI Chat Responses
- Tom AI Local LLM
- Tom AI Local Log

## Requirements

- VS Code 1.85.0+
- GitHub Copilot subscription for Copilot workflows
- Dart SDK 3.0+ for script/bridge features

## Development

Build:

```bash
npm run compile
```

Watch mode:

```bash
npm run watch
```

Run extension host for manual testing:

1. Open this project in VS Code.
2. Press F5.
3. Test commands in the Extension Development Host.

## Documentation

- [doc/user_guide.md](doc/user_guide.md): complete feature guide
- [doc/quick_reference.md](doc/quick_reference.md): shortcuts, panels, command map
- [doc/copilot_chat_tools.md](doc/copilot_chat_tools.md): Copilot/Tom AI Chat tooling
- [_copilot_guidelines/architecture.md](_copilot_guidelines/architecture.md): architecture and state model
- [_copilot_guidelines/keybindings_and_commands.md](_copilot_guidelines/keybindings_and_commands.md): command and keybinding details

## Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [Chat API](https://code.visualstudio.com/api/extension-guides/chat)
