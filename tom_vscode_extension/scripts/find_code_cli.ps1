# Shared by install_extension.ps1 and reinstall_for_testing.ps1 (dot-sourced):
# the VS Code CLI that installs the VSIX.
#
#   Find-TomCodeCli   the CLI's path (or 'code' from PATH); $null when none is found
#
# An agent's shell often has no VS Code `bin` folder on PATH; the CLI is still
# in the installation. Looked for, in order:
#   1. $env:TOM_CODE_CLI, when it names an existing file (an explicit choice)
#   2. `code` on PATH
#   3. the bundled CLI: Windows %LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd,
#      %ProgramFiles%\Microsoft VS Code\bin\code.cmd, then Insiders' code-insiders.cmd;
#      macOS /Applications and ~/Applications (Stable, then Insiders);
#      Linux /usr/share/code/bin/code, /snap/bin/code, Insiders
# $env:TOM_CODE_CLI_CANDIDATES (one path per line) replaces the list of step 3
# (the tests use it).

function Get-TomCodeCliCandidates {
    if ($env:TOM_CODE_CLI_CANDIDATES) {
        return @($env:TOM_CODE_CLI_CANDIDATES -split "`r?`n" | Where-Object { $_ })
    }
    if ($IsMacOS) {
        $app = 'Contents/Resources/app/bin'
        return @(
            "/Applications/Visual Studio Code.app/$app/code",
            "$HOME/Applications/Visual Studio Code.app/$app/code",
            "/Applications/Visual Studio Code - Insiders.app/$app/code-insiders",
            "$HOME/Applications/Visual Studio Code - Insiders.app/$app/code-insiders"
        )
    }
    if ($IsLinux) {
        return @('/usr/share/code/bin/code', '/snap/bin/code', '/usr/share/code-insiders/bin/code-insiders')
    }
    # Windows (Windows PowerShell has no $IsWindows; it only runs there).
    $list = @()
    if ($env:LOCALAPPDATA) { $list += (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd') }
    if ($env:ProgramFiles) { $list += (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd') }
    if ($env:LOCALAPPDATA) { $list += (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd') }
    return $list
}

function Find-TomCodeCli {
    if ($env:TOM_CODE_CLI -and (Test-Path -LiteralPath $env:TOM_CODE_CLI -PathType Leaf)) { return $env:TOM_CODE_CLI }
    if (Get-Command code -ErrorAction SilentlyContinue) { return 'code' }
    foreach ($candidate in (Get-TomCodeCliCandidates)) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    return $null
}
