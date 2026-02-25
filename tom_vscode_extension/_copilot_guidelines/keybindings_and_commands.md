# Keybindings and Commands

## Panel focus and layout shortcuts

- `Ctrl+Shift+0` → `dartscript.focusTomAI`
- `Ctrl+Shift+9` → `dartscript.wsPanel.focus`
- `Ctrl+Shift+8` → `dartscript.showStatusPage`
- `Ctrl+Shift+\\` → `dartscript.combined.maximizeToggle`
- `Ctrl+Shift+2/3/4` → maximize explorer/editor/chat

## Chord menu shortcuts

- `Ctrl+Shift+C` conversation shortcuts
- `Ctrl+Shift+L` local LLM shortcuts
- `Ctrl+Shift+A` send-to-chat shortcuts
- `Ctrl+Shift+T` Tom AI chat shortcuts
- `Ctrl+Shift+E` execute shortcuts
- `Ctrl+Shift+X` favorites

## Core command groups

- Copilot send/template commands.
- Tom AI chat start/send/interrupt commands.
- Local LLM send/model commands.
- Bridge and runtime control commands.
- Notes/todos/status/config commands.

## Maintenance checklist

When adding/changing commands:

1. update `package.json` command title/category,
2. update bindings and chord menu entries if needed,
3. update `doc/quick_reference.md`.
