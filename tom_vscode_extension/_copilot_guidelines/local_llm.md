# Local LLM Integration

The **Local LLM** subpanel in `@CHAT` sends prompts to an Ollama-compatible HTTP endpoint. Source: [localLlm-handler.ts](../src/handlers/localLlm-handler.ts).

## Commands

- `tomAi.sendToLocalLlm` — send current selection / editor content.
- `tomAi.sendToLocalLlm.standard` — default-template variant.
- `tomAi.sendToLocalLlm.template` — pick a template interactively.
- `tomAi.sendToLocalLlm.expand`, `tomAi.sendToLocalLlm.rewrite`, `tomAi.sendToLocalLlm.detailed`, `tomAi.sendToLocalLlm.annotated` — prompt-expansion shortcuts.
- `tomAi.localLlm.switchModel` — change the active model.

Chord menu: `Ctrl+Shift+L` opens the Local LLM menu.

## Runtime model

- Prompt is expanded via the active **template** (with full placeholder support — chat variables, memory, workspace context).
- History mode is Local-LLM-specific (`LocalLlmHistoryMode`); see [localLlm-handler.ts](../src/handlers/localLlm-handler.ts).
- Queue-compatible: prompts can be routed through the prompt queue with the same repeat / affix / answer-wait semantics as Copilot.

## Configuration expectations

- Profile + template definitions resolve from the extension config model ([sendToChatConfig.ts](../src/utils/sendToChatConfig.ts)).
- Model switching updates the active local model selection in `sendToChatConfig.localLlm.model`.
- Prompt expansion supports workspace / context placeholders (see [../doc/file_and_prompt_placeholders.md](../doc/file_and_prompt_placeholders.md)).

## Output channels

- **Tom AI Local LLM** — request / response content.
- **Tom AI Local Log** — debug output (connection, timing, retry).

## Guidance

- Keep profile schema backward-compatible — users have saved configurations on disk.
- Document new template fields in [../doc/file_and_prompt_placeholders.md](../doc/file_and_prompt_placeholders.md).
- Validate commands from both the palette and the editor context menu before shipping.
