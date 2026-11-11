/**
 * The install scripts find VS Code's CLI when `code` is not on PATH (scripts/find_code_cli.sh / .ps1, used by
 * install_extension.* and reinstall_for_testing.*). An agent's shell often has no /usr/local/bin on PATH, so
 * `command -v code` alone built the VSIX and left it uninstalled.
 *
 *   FC-1 the bash helper, run: $TOM_CODE_CLI first, then `code` on PATH, then the first executable bundled
 *        candidate (a missing or non-executable one is passed); none found answers nothing with status 1
 *   FC-2 the bundled candidates in order: macOS /Applications then ~/Applications (Stable, then Insiders),
 *        Linux /usr/share/code then /snap/bin then Insiders, Windows %LOCALAPPDATA% then %ProgramFiles% —
 *        in both helpers
 *   FC-3 the four scripts source the helper, name the CLI they use and keep the warning when none is found;
 *        none of them looks for `code` on PATH alone any more or calls a bare `code`
 *   FC-4 the PowerShell helper, run (only where pwsh is installed): the same order as FC-1
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const SANDBOX = fs.mkdtempSync(path.join(ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261111_vscimpb39_codecli-'));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

/** An executable (or, with `executable: false`, a plain file) at `rel` in the sandbox. */
function fake(rel: string, executable = true): string {
    const file = path.join(SANDBOX, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, executable ? 0o755 : 0o644);
    return file;
}

/** Run tom_find_code_cli in a bash with only `pathDirs` on PATH. */
function findBash(env: Record<string, string>, pathDirs: string[] = []): { out: string; status: number | null } {
    const helper = path.join(ROOT, 'scripts', 'find_code_cli.sh');
    const r = spawnSync('/bin/bash', ['-c', `source "${helper}"; tom_find_code_cli`], {
        env: { PATH: [path.join(SANDBOX, 'empty'), ...pathDirs].join(':'), HOME: path.join(SANDBOX, 'home'), ...env },
        encoding: 'utf-8',
    });
    return { out: r.stdout.trim(), status: r.status };
}

describe('the VS Code CLI when `code` is not on PATH', () => {
    test('FC-1: the bash helper', { skip: process.platform === 'win32' }, () => {
        fs.mkdirSync(path.join(SANDBOX, 'empty'), { recursive: true });
        const explicit = fake('explicit/code');
        const onPath = path.dirname(fake('onpath/code'));
        const notExec = fake('bundle1/code', false);
        const bundled = fake('bundle2/code');
        const candidates = [path.join(SANDBOX, 'missing/code'), notExec, bundled].join('\n');
        assert.deepEqual(findBash({ TOM_CODE_CLI: explicit, TOM_CODE_CLI_CANDIDATES: candidates }, [onPath]), { out: explicit, status: 0 }, 'an explicit choice first');
        assert.deepEqual(findBash({ TOM_CODE_CLI: path.join(SANDBOX, 'nope'), TOM_CODE_CLI_CANDIDATES: candidates }, [onPath]), { out: 'code', status: 0 }, 'then PATH');
        assert.deepEqual(findBash({ TOM_CODE_CLI_CANDIDATES: candidates }), { out: bundled, status: 0 }, 'then the first executable candidate');
        assert.deepEqual(findBash({ TOM_CODE_CLI_CANDIDATES: path.join(SANDBOX, 'missing/code') }), { out: '', status: 1 }, 'none: nothing, status 1');
    });

    test('FC-2: the order of the bundled candidates', () => {
        const order = (text: string, needles: string[]): void => {
            const at = needles.map((n) => text.indexOf(n));
            at.forEach((i, k) => assert.ok(i >= 0, `${needles[k]} is listed`));
            assert.deepEqual([...at].sort((a, b) => a - b), at, `in the order ${needles.join(' < ')}`);
        };
        const sh = read('scripts/find_code_cli.sh');
        order(sh, ['"$TOM_CODE_CLI"', 'command -v code', 'tom_code_cli_candidates)']);
        order(sh, ['"/Applications/Visual Studio Code.app/$app/code"', '"$HOME/Applications/Visual Studio Code.app/$app/code"',
            '"/Applications/Visual Studio Code - Insiders.app/$app/code-insiders"', '"$HOME/Applications/Visual Studio Code - Insiders.app/$app/code-insiders"']);
        order(sh, ['"/usr/share/code/bin/code"', '"/snap/bin/code"', '"/usr/share/code-insiders/bin/code-insiders"']);
        order(sh, ['"$LOCALAPPDATA/Programs/Microsoft VS Code/bin/code"', '"$PROGRAMFILES/Microsoft VS Code/bin/code"']);
        const ps = read('scripts/find_code_cli.ps1');
        order(ps, ['$env:TOM_CODE_CLI -and', 'Get-Command code', 'Get-TomCodeCliCandidates)']);
        order(ps, ["'Programs\\Microsoft VS Code\\bin\\code.cmd'", "'Microsoft VS Code\\bin\\code.cmd'", "'Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd'"]);
        order(ps, ['"/Applications/Visual Studio Code.app/$app/code"', '"$HOME/Applications/Visual Studio Code.app/$app/code"', 'Insiders.app/$app/code-insiders"']);
        order(ps, ["'/usr/share/code/bin/code'", "'/snap/bin/code'", "'/usr/share/code-insiders/bin/code-insiders'"]);
    });

    test('FC-3: the scripts use it', () => {
        for (const [file, source, found, warning] of [
            ['install_extension.sh', 'source "$SCRIPT_DIR/scripts/find_code_cli.sh"', 'elif CODE_CLI="$(tom_find_code_cli)"; then\n    echo "🧩 VS Code CLI: $CODE_CLI"', '⚠️  VS Code CLI \\`code\\` not found (not on PATH, not in the VS Code installation'],
            ['reinstall_for_testing.sh', 'source "$SCRIPT_DIR/scripts/find_code_cli.sh"', 'if CODE_CLI="$(tom_find_code_cli)"; then\n    echo "🧩 VS Code CLI: $CODE_CLI"', '⚠️  VS Code CLI not found (not on PATH'],
            ['install_extension.ps1', ". (Join-Path $PSScriptRoot 'scripts/find_code_cli.ps1')", '} elseif ($found = Find-TomCodeCli) {\n    $CodeCli = $found\n    Write-Host "VS Code CLI: $CodeCli"', "VS Code CLI 'code' not found (not on PATH, not in the VS Code installation"],
            ['reinstall_for_testing.ps1', ". (Join-Path $ScriptDir 'scripts/find_code_cli.ps1')", '$CodeCli = Find-TomCodeCli\nif ($CodeCli) {\n    Write-Host "🧩 VS Code CLI: $CodeCli"', '⚠️  VS Code CLI not found (not on PATH'],
        ]) {
            const text = read(file);
            assert.ok(text.includes(source), `${file} sources the helper`);
            assert.ok(text.includes(found), `${file} names the CLI it uses`);
            assert.ok(text.includes(warning), `${file} warns when none is found`);
            assert.doesNotMatch(text, /command -v code &>|Get-Command code /, `${file} does not look on PATH alone`);
            assert.doesNotMatch(text, /^\s*(?:&\s*)?code --/m, `${file} calls no bare \`code\``);
        }
    });

    // pwsh by its full path: the helper runs with a PATH that has no `code` on it.
    const pwsh = process.platform === 'win32' ? '' : spawnSync('/bin/sh', ['-c', 'command -v pwsh'], { encoding: 'utf-8' }).stdout.trim();
    test('FC-4: the PowerShell helper', { skip: !pwsh && 'pwsh is not installed here' }, () => {
        const helper = path.join(ROOT, 'scripts', 'find_code_cli.ps1');
        const bundled = fake('psbundle/code');
        fs.mkdirSync(path.join(SANDBOX, 'empty'), { recursive: true });
        const run = (env: Record<string, string>): string => spawnSync(pwsh, ['-NoProfile', '-Command', `. '${helper}'; $r = Find-TomCodeCli; if ($r) { $r } else { '(none)' }`], {
            env: { ...process.env, PATH: path.join(SANDBOX, 'empty'), ...env }, encoding: 'utf-8',
        }).stdout.trim();
        assert.equal(run({ TOM_CODE_CLI_CANDIDATES: [path.join(SANDBOX, 'missing'), bundled].join('\n') }), bundled);
        assert.equal(run({ TOM_CODE_CLI_CANDIDATES: path.join(SANDBOX, 'missing') }), '(none)');
    });
});
