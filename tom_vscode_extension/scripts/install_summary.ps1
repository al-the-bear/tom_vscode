# Shared by install_extension.ps1 and compile_and_install.ps1 (dot-sourced):
# the closing lines of an install - where the VSIX is, and, when it was built
# without a Dart SDK, the warning about what it lacks.
#
#   Write-TomVsixPath <extension dir>
#   Write-TomNoDartWarning <reason> <from-source $true|$false>
#
# The last lines are owned by whichever script runs last (the wrapper when
# there is one, TOM_SKIP_FINISH_TS=1), so they are printed exactly once.

# The newest VSIX in the extension folder, as a full path ($null if none).
function Get-TomNewestVsix([string]$Dir) {
    $vsix = Get-ChildItem -Path $Dir -Filter '*.vsix' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($vsix) { return $vsix.FullName }
    return $null
}

function Write-TomVsixPath([string]$Dir) {
    $vsix = Get-TomNewestVsix $Dir
    if (-not $vsix) { return }
    Write-Host ""
    Write-Host "VSIX: $vsix"
    Write-Host "   On another machine: copy it there and run  code --install-extension <path-to>\$(Split-Path -Leaf $vsix)"
    # The workspace template the setup unpacks: inside the VSIX, and this copy beside it.
    $template = Join-Path $Dir 'workspace_template.zip'
    if (Test-Path $template) {
        Write-Host "Workspace template: $template (also inside the VSIX)"
    }
}

function Write-TomNoDartWarning([string]$Reason, [bool]$FromSource) {
    $platform = "$env:PROCESSOR_ARCHITECTURE"
    try {
        $ErrorActionPreference = 'Continue'
        $platform = (& node -p "process.platform + '-' + process.arch" 2>$null)
    } catch { }
    if ($FromSource) {
        $dartscript = "DartScript (tom_bs) is NOT in this VSIX for $platform."
    } else {
        $dartscript = "DartScript (tom_bs): only the prebuilt binaries bundled above."
    }
    $rule = '!' * 76
    $lines = @(
        '',
        "WARNING: BUILT WITHOUT A DART SDK ($Reason)",
        '',
        'CodeSpecs validation (validate_codespecs) is NOT in this VSIX.',
        $dartscript,
        '',
        'On its first start the extension shows a page explaining what is',
        'missing and how to add it.',
        '',
        'To get both: install the Dart SDK (https://dart.dev/get-dart)',
        'and run compile_and_install again.',
        ''
    )
    Write-Host ""
    Write-Host $rule -ForegroundColor Red
    foreach ($line in $lines) {
        Write-Host ('!! {0,-70} !!' -f $line) -ForegroundColor Red
    }
    Write-Host $rule -ForegroundColor Red
}
