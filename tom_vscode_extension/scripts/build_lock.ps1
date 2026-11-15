# The checkout's build lock for the PowerShell install scripts (scripts/build-lock.cjs, qrfix5).
#
# A .ps1 run from an interactive terminal runs in that terminal's process, whose pid lives on after
# the script: a lock left behind there would never go stale. So each install script re-invokes itself
# inside Invoke-ScriptWithBuildLock, whose finally releases the lock however the script ends (an `exit`
# in a script called with the call operator ends only that script). Under another holder
# (TOM_BUILD_LOCK_HOLDER: an outer install script, `npm test`) it passes; another live holder stops it
# with the message naming it.

function Invoke-ScriptWithBuildLock {
    param([string]$Command, [string]$ScriptPath, [hashtable]$Bound, [object[]]$Rest)
    $lock = Join-Path $PSScriptRoot 'build-lock.cjs'
    & node $lock acquire --pid $PID --command $Command | Out-Host
    if ($LASTEXITCODE -ne 0) { return 1 }
    $owned = -not $env:TOM_BUILD_LOCK_HOLDER
    if ($owned) { $env:TOM_BUILD_LOCK_HOLDER = "$PID" }
    $outerInner = $env:TOM_BUILD_LOCK_INNER
    $env:TOM_BUILD_LOCK_INNER = $ScriptPath
    $code = 0
    try {
        $global:LASTEXITCODE = 0
        if ($null -eq $Rest) { $Rest = @() }
        & $ScriptPath @Bound @Rest | Out-Host
        if ($LASTEXITCODE) { $code = $LASTEXITCODE }
    } catch {
        Write-Host "$_"
        $code = 1
    } finally {
        if ($null -eq $outerInner) { Remove-Item Env:TOM_BUILD_LOCK_INNER -ErrorAction SilentlyContinue } else { $env:TOM_BUILD_LOCK_INNER = $outerInner }
        if ($owned) {
            & node $lock release --pid $PID | Out-Host
            Remove-Item Env:TOM_BUILD_LOCK_HOLDER -ErrorAction SilentlyContinue
        }
    }
    return $code
}
