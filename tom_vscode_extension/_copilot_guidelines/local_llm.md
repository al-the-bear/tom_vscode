# Local LLM Integration

## Commands

- `dartscript.sendToLocalLlm`
- `dartscript.sendToLocalLlmStandard`
- `dartscript.sendToLocalLlmAdvanced`
- `dartscript.switchLocalModel`
- prompt-expansion shortcut commands under `dartscript.sendToLocalLlm.*`

## Runtime model

Local LLM workflows are profile/template driven and integrated with Unified Notepad and command palette/context menus.

## Configuration expectations

- profile and template definitions resolve from extension config model,
- model switching command updates active local model selection,
- prompt expansion can include workspace/context placeholders.

## Guidance

- Keep profile schema backward-compatible.
- Ensure new template fields are documented in placeholder docs.
- Validate commands from both palette and context menus.
