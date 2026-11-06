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
| `Ctrl+Shift+L` | `tomAi.chordMenu.llm` | Send to LLM: `l` the selection, `s` with the default template, `t` with a picked template |
| `Ctrl+Shift+E` | `tomAi.chordMenu.execute` | Execute shortcuts |
| `Ctrl+Shift+X` | `tomAi.chordMenu.favorites` | Favorites |

## Command groups

- **Copilot** — send / template / slot / answer-file commands.
- **Send to LLM** — `tomAi.sendToLlm` (the selection), `tomAi.sendToLlm.standard` (the selection or the file, default template), `tomAi.sendToLlm.template` (picked template): the editor's text goes to the @CHAT Anthropic panel's current profile and session (`src/handlers/sendToLlm-handler.ts`), in the editor context menu and the `Ctrl+Shift+L` chord menu. Profile, session and model selection live on the subpanel action bar (a Local LLM is used through an Anthropic profile on a Local LLM configuration).
- **Markdown Browser** — `tomAi.openInMdBrowser`, `tomAi.openInMdBrowserLive` (live-mode follow-tail for the live trail).
- **Bridge + CLI + Telegram + Process Monitor** — lifecycle commands; fail-soft when subsystems aren't available.
- **Editors** — queue, timed requests, prompt templates, reusable prompts, context settings, chat variables, raw / summary trail viewer.
- **Layout** — reset / maximize / toggle / window state flow.
- **Notes + todos + status + config** — sidebar focus commands (`tomAi.tomSidebar.focus` opens @TOM, the quest's views; `tomAi.tomWsSidebar.focus` opens @TOM WS, the workspace's) and the status / settings pair.

## Maintenance checklist

When adding / changing commands:

1. Update `package.json` `contributes.commands` (title + category) and `contributes.keybindings` if bound.
2. Update chord menu registration in the relevant handler (`chordMenu-handler.ts`) if the command belongs in a chord menu.
3. Update [../doc/quick_reference.md](../doc/quick_reference.md).
4. Update subsystem guideline(s) in this folder if the command surface's meaning changed (e.g. [anthropic_chat.md](anthropic_chat.md), [extension_bridge.md](extension_bridge.md)).
5. If the change affects the schema or user config, update `config/tom_vscode_extension.schema.json` + `sendToChatConfig.ts`.
