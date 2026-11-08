/**
 * The Agent SDK's native CLI on a platform the VSIX was not built for
 * (services/agentSdkCli.ts, handlers/agentSdkCliHelp-handler.ts, vsc_nodart-5).
 *
 *   AC-1 the lookup mirrors the SDK's: `<package>/claude[.exe]`, on Linux the glibc then the musl package;
 *        then the binary --all-platforms bundles as bin/<platform>/claude[.exe]; this checkout finds its host's
 *        CLI package
 *   AC-2 the transport without a CLI: runAgentSdkQuery fails before any query with what is missing and the
 *        page; the user gets the error with "What does this mean?" once per window session, the click opens
 *        the page; with a CLI (a fake SDK) nothing changes
 *   AC-3 the Dart-side pass-through: a terminal error chunk with the message, no query; a bundled CLI is
 *        passed as pathToClaudeCodeExecutable; a caller naming its own pathToClaudeCodeExecutable is not checked
 *   AC-4 the page: filled for the platform, says what keeps working and how to get the CLI (--all-platforms /
 *        -AllPlatforms); it ships (VSIX REQUIRED) and has its command
 *   AC-5 the build flag: --all-platforms / -AllPlatforms in all four install scripts; only the host's package
 *        stays in node_modules (vsce's npm list refuses another platform's); the fleet's other CLIs are fetched
 *        with npm pack and bundled as bin/<platform>/claude[.exe]; the VSIX check lists the CLI platforms
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub';

let clicked: string | undefined;
const errors: unknown[][] = [];
const stubbed = installVscodeStub({
    methodOverrides: {
        showErrorMessage: async (...args: unknown[]) => { errors.push(args); return clicked; },
    },
});

/* eslint-disable @typescript-eslint/no-require-imports */
const cli = require('../../services/agentSdkCli') as typeof import('../../services/agentSdkCli');
const help = require('../agentSdkCliHelp-handler') as typeof import('../agentSdkCliHelp-handler');
const transport = require('../agent-sdk-transport') as typeof import('../agent-sdk-transport');
const bridgeModule = require('../../services/agent-sdk-bridge') as typeof import('../../services/agent-sdk-bridge');
/* eslint-enable @typescript-eslint/no-require-imports */

const EXT = path.resolve(__dirname, '..', '..', '..');
const HOST = `${process.platform}-${process.arch}`;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const previews = (): unknown[][] => stubbed.spies.byMethod('commands.executeCommand').map((c) => c.args).filter((a) => a[0] === 'markdown.showPreview');

describe('the Agent SDK CLI per platform', () => {
    test('AC-1: the lookup', () => {
        assert.deepEqual(cli.agentSdkCliCandidates('darwin', 'arm64'), ['@anthropic-ai/claude-agent-sdk-darwin-arm64/claude']);
        assert.deepEqual(cli.agentSdkCliCandidates('win32', 'x64'), ['@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe']);
        assert.deepEqual(cli.agentSdkCliCandidates('linux', 'x64'), ['@anthropic-ai/claude-agent-sdk-linux-x64/claude', '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude']);
        const only = (id: string) => (x: string): string => { if (x !== id) { throw new Error('not installed'); } return `/nm/${x}`; };
        assert.equal(cli.findAgentSdkCli(only('@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude'), () => true, 'linux', 'x64'), '/nm/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude');
        assert.equal(cli.findAgentSdkCli(only('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'), () => true, 'win32', 'x64'), null, 'another platform\'s CLI does not count');
        assert.equal(cli.findAgentSdkCli(() => '/nm/x', () => false, 'darwin', 'arm64'), null, 'resolved but no file');
        const here = cli.findAgentSdkCli();
        assert.ok(here && fs.existsSync(here), 'this checkout has its host\'s CLI');
        const root = '/ext';
        const bundled = path.join(root, 'bin', 'win32-x64', 'claude.exe');
        assert.equal(cli.bundledAgentSdkCliPath(root, 'win32', 'x64'), bundled);
        const none = (): string => { throw new Error('not installed'); };
        assert.deepEqual(cli.locateAgentSdkCli(root, none, (f) => f === bundled, 'win32', 'x64'), { path: bundled, source: 'bundled' });
        assert.equal(cli.locateAgentSdkCli(root, none, () => false, 'win32', 'x64'), null);
        assert.deepEqual(cli.locateAgentSdkCli(root, only('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'), () => true, 'darwin', 'arm64'),
            { path: '/nm/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude', source: 'package' }, 'the package first');
    });

    test('AC-2: the transport without a CLI', async () => {
        let queried = 0;
        transport.__setAgentSdkForTests({ query: () => { queried++; return (async function* () { /* nothing */ })(); } });
        transport.__setAgentSdkCliFinderForTests(() => null);
        help.resetAgentSdkCliNotice();
        const before = errors.length;
        for (let i = 0; i < 2; i++) {
            await assert.rejects(transport.runAgentSdkQuery({} as never), (e: unknown) => {
                assert.ok(e instanceof cli.AgentSdkCliMissing);
                const m = (e as Error).message;
                for (const part of [`@anthropic-ai/claude-agent-sdk-${HOST}`, `does not carry for ${HOST}`, '--all-platforms', 'missing_agent_sdk_cli.md', 'tomAi.showAgentSdkCliHelp']) {
                    assert.ok(m.includes(part), `the message names ${part}`);
                }
                return true;
            });
        }
        await tick();
        assert.equal(queried, 0, 'no query');
        assert.equal(errors.length, before + 1, 'told once per window session');
        assert.equal(errors[before][1], 'What does this mean?');
        const opened = previews().length;
        clicked = 'What does this mean?';
        help.resetAgentSdkCliNotice();
        await assert.rejects(transport.runAgentSdkQuery({} as never));
        await tick(); await tick();
        assert.equal(previews().length, opened + 1, 'the button opens the page');
        assert.match((previews().at(-1)![1] as { fsPath: string }).fsPath, /missing_agent_sdk_cli\.md$/);
        clicked = undefined;
        transport.__setAgentSdkCliFinderForTests(() => ({ path: '/nm/claude', source: 'package' }));
        assert.equal(transport.requireAgentSdkCli(), undefined, 'the package: the SDK finds it itself');
        transport.__setAgentSdkCliFinderForTests(() => ({ path: '/ext/bin/win32-x64/claude.exe', source: 'bundled' }));
        assert.equal(transport.requireAgentSdkCli(), '/ext/bin/win32-x64/claude.exe', 'the bundled binary: given to the SDK');
    });

    test('AC-3: the Dart-side pass-through', async () => {
        const run = async (options: Record<string, unknown>, requireCli: () => string | undefined): Promise<{ queried: Array<Record<string, unknown>>; chunks: Array<Record<string, unknown>> }> => {
            const queried: Array<Record<string, unknown>> = [];
            const chunks: Array<Record<string, unknown>> = [];
            const bridge = new bridgeModule.AgentSdkBridge({
                loadSdk: async () => ({ query: (q: { options: Record<string, unknown> }) => { queried.push(q.options); return (async function* () { /* nothing */ })(); } }) as never,
                requireCli,
                sendNotification: (_m, p) => { chunks.push(p); },
            });
            await bridge.startQuery({ streamId: 's1', prompt: 'hi', options } as never);
            await tick();
            return { queried, chunks };
        };
        const missing = (): string | undefined => { throw new cli.AgentSdkCliMissing('win32-x64'); };
        const blocked = await run({}, missing);
        assert.equal(blocked.queried.length, 0);
        assert.match(String(blocked.chunks[0]?.error), /does not carry for win32-x64/);
        const bundled = await run({}, () => '/ext/bin/win32-x64/claude.exe');
        assert.equal(bundled.queried[0].pathToClaudeCodeExecutable, '/ext/bin/win32-x64/claude.exe', 'the bundled CLI given to the SDK');
        const own = await run({ pathToClaudeCodeExecutable: '/opt/claude' }, missing);
        assert.equal(own.queried.length, 1, 'a caller with its own CLI is not checked');
        assert.equal(own.queried[0].pathToClaudeCodeExecutable, '/opt/claude');
    });

    test('AC-4: the page', () => {
        const template = fs.readFileSync(path.join(EXT, cli.AGENT_SDK_CLI_HELP_PAGE), 'utf8');
        const page = cli.fillAgentSdkCliPage(template, 'win32-x64');
        assert.ok(!page.includes('{{'));
        assert.match(page, /Platform: \*\*win32-x64\*\*\. This extension does not carry `@anthropic-ai\/claude-agent-sdk-win32-x64`/);
        for (const part of ['direct Anthropic API', 'Copilot', 'local models', './compile_and_install.sh --all-platforms', '.\\compile_and_install.ps1 -AllPlatforms', 'darwin-arm64,\nlinux-x64, win32-x64']) {
            assert.ok(page.includes(part), part);
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/naming-convention
        const { REQUIRED } = require(path.join(EXT, 'scripts', 'check-vsix-contents.cjs')) as { REQUIRED: string[] };
        assert.ok(REQUIRED.includes('extension/resources/agent_sdk/missing_agent_sdk_cli.md'));
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === cli.AGENT_SDK_CLI_HELP_COMMAND));
    });

    test('AC-5: the build flag', () => {
        const read = (f: string): string => fs.readFileSync(path.join(EXT, f), 'utf8');
        const sh = read('install_extension.sh');
        assert.match(sh, /--all-platforms\) export TOM_ALL_PLATFORMS=1 ;;/);
        assert.match(sh, /for PLAT in darwin-arm64 linux-x64 win32-x64; do\n\s+\[ "\$PLAT" = "\$HOST_PLAT" \] && continue/);
        assert.match(sh, /npm pack "\$PKG" --silent/);
        assert.match(sh, /cp "\$UNPACK\/package\/claude\$EXE" "\$SCRIPT_DIR\/bin\/\$PLAT\/claude\$EXE"/);
        assert.match(sh, /if \[ "\$PLAT" != "\$HOST_PLAT" \]; then\n\s+rm -rf "\$DIR"/);
        assert.doesNotMatch(sh, /--force/, 'no other platform\'s package in node_modules');
        assert.match(read('compile_and_install.sh'), /--all-platforms\) export TOM_ALL_PLATFORMS=1 ;;/);
        const ps1 = read('install_extension.ps1');
        assert.match(ps1, /param\(\[switch\]\$NoDart, \[switch\]\$AllPlatforms, \[switch\]\$PackageOnly\)/);
        assert.match(ps1, /elseif \(\$Arg -eq '--all-platforms'\) \{ \$AllPlatforms = \$true \}/);
        assert.match(ps1, /foreach \(\$plat in @\('darwin-arm64', 'linux-x64', 'win32-x64'\)\) \{\s+if \(\$plat -eq \$HostPlat\) \{ continue \}/);
        assert.match(ps1, /Invoke-Native \{ npm pack \$pkg --silent \}/);
        assert.match(ps1, /Invoke-Native \{ tar -xzf \$tgz -C \$unpack \}/);
        assert.match(ps1, /if \(\$plat -ne \$HostPlat\) \{\s+Remove-Item -Recurse -Force \$dir\.FullName/);
        assert.doesNotMatch(ps1, /--force @/, 'no other platform\'s package in node_modules');
        assert.match(read('compile_and_install.ps1'), /if \(\$AllPlatforms\) \{ \$env:TOM_ALL_PLATFORMS = '1' \}/);
        assert.deepEqual([...cli.FLEET_CLI_PLATFORMS], ['darwin-arm64', 'linux-x64', 'win32-x64']);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { agentSdkCliPlatforms } = require(path.join(EXT, 'scripts', 'check-vsix-contents.cjs')) as { agentSdkCliPlatforms(n: Set<string>): string[] };
        assert.deepEqual(agentSdkCliPlatforms(new Set([
            'extension/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
            'extension/bin/win32-x64/claude.exe',
            'extension/bin/linux-x64/claude',
            'extension/bin/linux-x64/tom_bs',
            'extension/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
        ])), ['darwin-arm64', 'linux-x64', 'win32-x64']);
    });
});
