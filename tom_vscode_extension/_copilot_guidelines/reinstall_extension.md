# Reinstall Extension Workflow

Use this workflow after changing extension code when the runtime doesn't reflect expected behavior.

## Steps

1. Typecheck: `npx tsc --noEmit`. Fix all errors and Problems-pane warnings first.
2. Package or install the updated extension in the target VS Code host.
3. Reload the VS Code window (`Developer: Reload Window`).
4. Re-run the affected command or open the affected view.

## When required

- Changes to `package.json` contributions (commands, menus, keybindings, custom editors, activation events).
- Activation-time wiring changes (new handlers, new service singletons).
- Webview resource / runtime mismatches (changed HTML builders, new codicon / script references).
- Stale command metadata in host instance after renames.
- JSON Schema changes in `config/tom_vscode_extension.schema.json` (settings UI caches schemas).

## What doesn't need reinstall

- Pure logic changes inside handler methods — a reload window is usually enough.
- Markdown doc updates — no reload needed.
- Config file edits under `_ai/` — hot-reloaded by file watchers.

## Verification

- Command appears with updated title / keybinding in the palette.
- Panel / view naming and sections are updated (`@CHAT`, `@WS`, `@TOM`).
- No activation errors in "Extension Host" output or "Tom Debug" output channel.
- For chat changes: send a test prompt and confirm trails land in `_ai/trail/` / `_ai/quests/<quest>/live-trail.md`.

## Pattern prompt

When the user issues `!!!reload finished` after a reload, the extension changes are in effect and you can resume the task. See [restart_debugging_flow.backup.md](restart_debugging_flow.backup.md) if the reload doesn't fix the issue.
