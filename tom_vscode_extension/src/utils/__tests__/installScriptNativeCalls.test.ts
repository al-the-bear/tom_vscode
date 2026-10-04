/**
 * `install_extension.ps1` must survive having its output redirected.
 *
 * The script sets `$ErrorActionPreference = "Stop"` so a failing cmdlet ends
 * the run. Under Windows PowerShell 5.1 that has a second effect: when the
 * script's streams are redirected (`*>`, `2>&1`, a log file — every
 * unattended run), ANY line a native program writes to stderr becomes a
 * terminating `NativeCommandError`. `dart pub get` prints its
 * "packages have newer versions" advice to stderr, so an unattended build
 * died right after it, with nothing in the log (legiondary01, 2026-09-28;
 * reproduced in isolation on PS 5.1.26100 on 2026-10-04).
 *
 * The fix is `Invoke-Native`: it runs a native command with the preference
 * set to `Continue` for its own scope, so stderr is logged rather than fatal,
 * and every call site already checks `$LASTEXITCODE` — the check the script
 * actually wants. This file holds that EVERY native call goes through it: a
 * single bare `dart pub get` re-creates the failure, and nothing else would
 * notice until the next unattended run on Windows.
 *
 * Source-scanning, because PowerShell cannot run under `node:test`. Guarded
 * against vacuity: it must find at least as many native call sites as the
 * script had when this was written, and must find a named one.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// out/utils/__tests__ -> project root is three levels up.
const SCRIPT = join(__dirname, '..', '..', '..', 'install_extension.ps1');

/** Native programs the script invokes. `Get-Command x` lines only probe. */
const NATIVE = /(^|[\s(=;{])(npm|npx|dart|node|nvm|vsce|code|cmd)(\s|$)/;
/** `& $Var ...` runs a native executable held in a variable. */
const CALL_OPERATOR_VAR = /&\s*\$[A-Za-z_][A-Za-z0-9_]*\s/;

interface Site { line: number; text: string }

function nativeCallSites(source: string): Site[] {
    const sites: Site[] = [];
    source.split(/\r?\n/).forEach((raw, i) => {
        const text = raw.trim();
        if (text === '' || text.startsWith('#')) { return; }
        if (/Get-Command\s/.test(text)) { return; }
        // Prose about a program inside a message string is not a call.
        if (/^(Write-(Host|Warning|Error|Output|Verbose)|throw)\b/.test(text)) { return; }
        if (/^"/.test(text)) { return; }
        if (/^function\s+Invoke-Native\b/.test(text)) { return; }
        if (NATIVE.test(text) || CALL_OPERATOR_VAR.test(text)) {
            sites.push({ line: i + 1, text });
        }
    });
    return sites;
}

describe('install_extension.ps1 — native calls survive redirected output', () => {
    const source = readFileSync(SCRIPT, 'utf-8');
    const sites = nativeCallSites(source);

    test('defines Invoke-Native with a scoped Continue preference', () => {
        const def = /function\s+Invoke-Native\b[\s\S]*?\{[\s\S]*?\$ErrorActionPreference\s*=\s*['"]Continue['"][\s\S]*?\}/;
        assert.match(source, def, 'Invoke-Native must set $ErrorActionPreference = "Continue" in its own scope');
    });

    test('finds the native call sites it is meant to guard (not vacuous)', () => {
        assert.ok(sites.length >= 18, `found only ${sites.length} native call sites — the detector is broken`);
        assert.ok(
            sites.some((s) => /dart pub get/.test(s.text)),
            'the known `dart pub get` site was not found',
        );
    });

    test('every native call runs inside Invoke-Native', () => {
        const bare = sites.filter((s) => !/Invoke-Native\s*\{/.test(s.text));
        assert.deepEqual(
            bare.map((s) => `${s.line}: ${s.text}`),
            [],
            'these native calls are not wrapped, so a stderr line from them ends an ' +
            'unattended (redirected) run on Windows PowerShell 5.1. Wrap each as ' +
            '`Invoke-Native { <command> }` and keep the $LASTEXITCODE check after it.',
        );
    });
});
