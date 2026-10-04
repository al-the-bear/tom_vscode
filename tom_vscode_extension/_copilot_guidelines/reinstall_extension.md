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

## Unattended runs on Windows (over SSH)

`compile_and_install.ps1` runs unattended: it sets `TOM_BRIDGE_FROM_SOURCE=1`,
which also auto-confirms the package prompt. Running it with its output sent to
a log works under Windows PowerShell 5.1 and PowerShell 7:

```powershell
& .\compile_and_install.ps1 *> C:\Code\al_the_bear\ztmp\install.log
```

`install_extension.ps1` keeps `$ErrorActionPreference = "Stop"`. Under PS 5.1
that preference turns any line a native program writes to stderr into a
terminating `NativeCommandError`, but only when output is redirected. For that
reason every native call (`npm`, `dart`, `node`, `nvm`, `vsce`, `code`) runs
through the script's `Invoke-Native { ... }`, which sets `Continue` for that
call alone, and is followed by a `$LASTEXITCODE` check. The extension test
`src/utils/__tests__/installScriptNativeCalls.test.ts` fails if a native call is
added without the wrapper. If you add a native call, wrap it and check its exit
code.

A build takes several minutes, so start it in a way that outlives the SSH
session:

- **Use a WMI-created process.** `Invoke-CimMethod -ClassName Win32_Process
  -MethodName Create` starts a process that is not a child of the SSH session,
  so it keeps running after the session closes. Do the redirection at the
  `cmd.exe` level, so that PowerShell's stream handling does not decide what
  reaches the log:

  ```powershell
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = 'cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Code\al_the_bear\tom_ai\vscode\tom_vscode_extension\compile_and_install.ps1 > C:\Code\al_the_bear\ztmp\install.log 2>&1'
    CurrentDirectory = 'C:\Code\al_the_bear\tom_ai\vscode\tom_vscode_extension'
  }
  ```

  Then follow the log (`Get-Content ...\install.log -Tail 20`). The run has
  succeeded when the log ends with `Installation complete!` and the
  `Finished at` line.
- **Do not use `Start-Process`** from an SSH session for this. Its process is a
  child of the session and is killed when the session ends, which leaves a
  half-built `bin/` and no error.
- `npm install` has no timeout. If the log stops moving for several minutes at
  `Installing npm dependencies...`, kill the process tree and start the run
  again.

## Pattern prompt

When the user issues `!!!reload finished` after a reload, the extension changes are in effect and you can resume the task. See [restart_debugging_flow.backup.md](restart_debugging_flow.backup.md) if the reload doesn't fix the issue.
