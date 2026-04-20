# Keybindings and Commands

Reference for the shortcut surface. Canonical tables (with descriptions) live in [../doc/quick_reference.md](../doc/quick_reference.md); this page covers the conventions and the maintenance checklist.

## Panel focus and layout shortcuts

| Key | Command |
| --- | --- |
| `Ctrl+Shift+0` | `tomAi.focusChatPanel` |
| `Ctrl+Shift+9` | `tomAi.wsPanel.focus` |
| `Ctrl+Shift+8` | `tomAi.statusPage` |
| `Ctrl+Shift+7` | `tomAi.editor.timedRequests` |
| `Ctrl+Shift+6` | `tomAi.editor.promptQueue` |
| `Ctrl+Shift+5` | `tomAi.editor.rawTrailViewer` |
| `Ctrl+Shift+Y` | `tomAi.layout.windowStateFlow` |
| `Ctrl+Shift+N` | `tomAi.showSidebarNotes` |
| `Ctrl+Shift+\` | `tomAi.layout.maximizeToggle` |
| `Ctrl+Shift+2/3/4` | maximize explorer / editor / chat |

## Chord menu shortcuts

| Key | Command | Menu |
| --- | --- | --- |
| `Ctrl+Shift+C` | `tomAi.chordMenu.copilot` | Copilot shortcuts |
| `Ctrl+Shift+L` | `tomAi.chordMenu.localLlm` | Local LLM shortcuts |
| `Ctrl+Shift+A` | `tomAi.chordMenu.aiConversation` | AI Conversation shortcuts |
| `Ctrl+Shift+T` | `tomAi.chordMenu.tomAiChat` | Tom AI Chat shortcuts |
| `Ctrl+Shift+E` | `tomAi.chordMenu.execute` | Execute shortcuts |
| `Ctrl+Shift+X` | `tomAi.chordMenu.favorites` | Favorites |

## Command groups

- **Copilot** — send / template / slot / answer-file commands.
- **Tom AI Chat + Anthropic** — start / send / interrupt; profile + model selection live on the subpanel action bar.
- **AI Conversation** — start / stop / halt / continue / add / status.
- **Local LLM** — send / template / model switch / prompt-expansion variants.
- **Markdown Browser** — `tomAi.openInMdBrowser`, `tomAi.openInMdBrowserLive` (live-mode follow-tail for the live trail).
- **Bridge + CLI + Telegram + Process Monitor** — lifecycle commands; fail-soft when subsystems aren't available.
- **Editors** — queue, timed requests, prompt templates, reusable prompts, context settings, chat variables, raw / summary trail viewer.
- **Layout** — reset / maximize / toggle / window state flow.
- **Notes + todos + status + config** — sidebar focus commands and the status / settings pair.

## Maintenance checklist

When adding / changing commands:

1. Update `package.json` `contributes.commands` (title + category) and `contributes.keybindings` if bound.
2. Update chord menu registration in the relevant handler (`chordMenu-handler.ts`) if the command belongs in a chord menu.
3. Update [../doc/quick_reference.md](../doc/quick_reference.md).
4. Update subsystem guideline(s) in this folder if the command surface's meaning changed (e.g. [local_llm.md](local_llm.md), [tom_ai_chat.md](tom_ai_chat.md), [extension_bridge.md](extension_bridge.md)).
5. If the change affects the schema or user config, update `config/tom_vscode_extension.schema.json` + `sendToChatConfig.ts`.
