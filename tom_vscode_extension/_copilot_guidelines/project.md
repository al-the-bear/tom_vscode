# Project Guide: tom_vscode_extension

## Purpose

`tom_vscode_extension` provides VS Code integration for Tom workflows:

- bridge-based automation,
- AI prompt tooling,
- panel-based productivity UX,
- YAML graph and quest todo custom editors,
- status/config/debug utilities.

## Primary entry points

- activation: `src/extension.ts`
- commands: `package.json` contributes + `src/handlers`
- panels: Unified Notepad (`@CHAT`) and T3 (`@WS`)

## Development workflow

1. Implement in TypeScript under `src/`.
2. Compile (`npx tsc -p ./`).
3. Reinstall/reload extension when required.
4. Validate affected commands/webviews manually.

## Documentation map

User docs:

- `doc/user_guide.md`
- `doc/quick_reference.md`
- `doc/copilot_chat_tools.md`

Maintainer docs:

- `vscode_extension_overview.md`
- `architecture.md`
- `implementation.md`
- `dartscript_extension_bridge.md`

## Current naming conventions

- Bottom panel titles: `@CHAT`, `@WS`.
- Keep command IDs under `dartscript.*` namespace.
