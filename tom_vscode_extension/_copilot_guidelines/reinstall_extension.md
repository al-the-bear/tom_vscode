# Reinstall Extension Workflow

Use this workflow after changing extension code when runtime does not reflect expected behavior.

## Steps

1. Build/compile extension (`npx tsc -p ./`).
2. Reinstall extension in target VS Code host.
3. Reload VS Code window.
4. Re-run affected command or open affected view.

## When required

- changes to `package.json` contributions,
- activation-time wiring changes,
- webview resource/runtime mismatches,
- stale command metadata in host instance.

## Verification

- command appears with updated title/keybinding,
- panel/view naming and sections are updated (`@CHAT`, `@WS`),
- no compile/runtime errors in extension host logs.
