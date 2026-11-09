/**
 * The Agent SDK and its native CLI come from the installed Anthropic provider
 * (services/agentSdkCli.ts, handlers/agentSdkCliHelp-handler.ts,
 * services/providerRuntime.ts; the VSIX carries neither).
 *
 *   AC-1 the lookup mirrors the SDK's: `<package>/claude[.exe]`, on Linux the glibc then the musl package;
 *        the installed provider's first (source provider), else the development checkout's own package; an
 *        installed provider without this platform's CLI is no CLI; this checkout finds its host's CLI package
 *   AC-2 the transport without the SDK or the CLI: runAgentSdkQuery fails before any query with what is missing;
 *        the user gets the error with "Install provider SDKs" and "What does this mean?" once per window session —
 *        the first opens the Provider SDKs page, the second the help page; with the provider's CLI its path is
 *        given to the SDK, the dev checkout's package is found by the SDK itself
 *   AC-3 the Dart-side pass-through: a terminal error chunk with the message, no query; the provider's CLI is
 *        passed as pathToClaudeCodeExecutable; a caller naming its own pathToClaudeCodeExecutable is not checked
 *   AC-4 the page: filled for the platform, says how to install the Anthropic provider and what keeps working;
 *        it ships (VSIX REQUIRED) and has its command
 *   AC-5 no CLI bundling left: no --all-platforms / TOM_ALL_PLATFORMS in the install and VSIX scripts, no npm pack
 *        of the platform CLIs; the SDKs are devDependencies (vsce leaves them out); the VSIX check fails a VSIX
 *        carrying a provider SDK or a bundled claude binary
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
const runtime = require('../../services/providerRuntime') as typeof import('../../services/providerRuntime');
/* eslint-enable @typescript-eslint/no-require-imports */

const EXT = path.resolve(__dirname, '..', '..', '..');
const HOST = `${process.platform}-${process.arch}`;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const previews = (): unknown[][] => stubbed.spies.byMethod('commands.executeCommand').map((c) => c.args).filter((a) => a[0] === 'markdown.showPreview');

describe('the Agent SDK from the installed provider', () => {
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
        const none = (): string => { throw new Error('not installed'); };
        assert.deepEqual(cli.locateAgentSdkCli(only('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'), none, () => true, 'darwin', 'arm64'),
            { path: '/nm/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude', source: 'provider' }, 'the installed provider first');
        assert.equal(cli.locateAgentSdkCli(none, only('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'), () => true, 'darwin', 'arm64'), null,
            'an installed provider without this platform\'s CLI: none (the dev package does not stand in)');
        assert.deepEqual(cli.locateAgentSdkCli(undefined, only('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'), () => true, 'darwin', 'arm64'),
            { path: '/nm/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude', source: 'package' }, 'no provider: the checkout\'s own package');
        assert.equal(cli.locateAgentSdkCli(undefined, none, () => true, 'darwin', 'arm64'), null);
        process.env.TOM_PROVIDER_SDKS_NO_DEV_FALLBACK = '1';
        try {
            assert.equal(cli.locateAgentSdkCli(undefined, only('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'), () => true, 'darwin', 'arm64'), null, 'as in a VSIX');
        } finally {
            delete process.env.TOM_PROVIDER_SDKS_NO_DEV_FALLBACK;
        }
    });

    test('AC-2: the transport without the SDK or the CLI', async () => {
        let queried = 0;
        transport.__setAgentSdkForTests({ query: () => { queried++; return (async function* () { /* nothing */ })(); } });
        // The provider is not installed.
        transport.__setAgentSdkFinderForTests(() => { throw new runtime.ProviderSdkMissing('anthropic', '@anthropic-ai/claude-agent-sdk'); });
        help.resetAgentSdkCliNotice();
        const before = errors.length;
        for (let i = 0; i < 2; i++) {
            await assert.rejects(transport.runAgentSdkQuery({} as never), (e: unknown) => {
                assert.ok(e instanceof runtime.ProviderSdkMissing);
                const m = (e as Error).message;
                for (const part of ['@anthropic-ai/claude-agent-sdk SDK is not installed', 'Anthropic provider', 'Provider SDKs', 'tomAi.providerSdks']) {
                    assert.ok(m.includes(part), `the message names ${part}`);
                }
                return true;
            });
        }
        await tick();
        assert.equal(queried, 0, 'no query');
        assert.equal(errors.length, before + 1, 'told once per window session');
        assert.deepEqual(errors[before].slice(1), ['Install provider SDKs', 'What does this mean?']);
        // "Install provider SDKs" opens the Provider SDKs page.
        const providerRuns = (): number => stubbed.spies.byMethod('commands.executeCommand').filter((c) => c.args[0] === 'tomAi.providerSdks').length;
        const pages = providerRuns();
        clicked = 'Install provider SDKs';
        help.resetAgentSdkCliNotice();
        await assert.rejects(transport.runAgentSdkQuery({} as never));
        await tick(); await tick();
        assert.equal(providerRuns(), pages + 1, 'the install button opens the Provider SDKs page');
        // The SDK is there, the CLI for this platform is not: the help page.
        transport.__setAgentSdkFinderForTests(() => undefined);
        transport.__setAgentSdkCliFinderForTests(() => null);
        const opened = previews().length;
        clicked = 'What does this mean?';
        help.resetAgentSdkCliNotice();
        await assert.rejects(transport.runAgentSdkQuery({} as never), (e: unknown) => {
            assert.ok(e instanceof cli.AgentSdkCliMissing);
            assert.match((e as Error).message, new RegExp(`claude-agent-sdk-${HOST}\\), which the installed Anthropic provider does not have for ${HOST}`));
            return true;
        });
        await tick(); await tick();
        assert.equal(previews().length, opened + 1, 'the help button opens the page');
        assert.match((previews().at(-1)![1] as { fsPath: string }).fsPath, /missing_agent_sdk_cli\.md$/);
        clicked = undefined;
        transport.__setAgentSdkCliFinderForTests(() => ({ path: '/nm/claude', source: 'package' }));
        assert.equal(transport.requireAgentSdkCli(), undefined, 'the checkout\'s package: the SDK finds it itself');
        transport.__setAgentSdkCliFinderForTests(() => ({ path: '/gs/providers/anthropic/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude', source: 'provider' }));
        assert.equal(transport.requireAgentSdkCli(), '/gs/providers/anthropic/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude', 'the provider\'s CLI: given to the SDK');
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
        assert.match(String(blocked.chunks[0]?.error), /does not have for win32-x64/);
        const provided = await run({}, () => '/gs/providers/anthropic/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe');
        assert.equal(provided.queried[0].pathToClaudeCodeExecutable, '/gs/providers/anthropic/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', 'the provider\'s CLI given to the SDK');
        const own = await run({ pathToClaudeCodeExecutable: '/opt/claude' }, missing);
        assert.equal(own.queried.length, 1, 'a caller with its own CLI is not checked');
        assert.equal(own.queried[0].pathToClaudeCodeExecutable, '/opt/claude');
    });

    test('AC-4: the page', () => {
        const template = fs.readFileSync(path.join(EXT, cli.AGENT_SDK_CLI_HELP_PAGE), 'utf8');
        const page = cli.fillAgentSdkCliPage(template, 'win32-x64');
        assert.ok(!page.includes('{{'));
        assert.match(page, /Platform: \*\*win32-x64\*\*\. The Agent SDK needs `@anthropic-ai\/claude-agent-sdk-win32-x64` for it\./);
        for (const part of ['does not carry these SDKs', '**Anthropic provider**', 'Provider SDKs', '@T: Provider SDKs', 'Install / Uninstall', 'Check for updates', 'Copilot', 'local models']) {
            assert.ok(page.includes(part), part);
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/naming-convention
        const { REQUIRED } = require(path.join(EXT, 'scripts', 'check-vsix-contents.cjs')) as { REQUIRED: string[] };
        assert.ok(REQUIRED.includes('extension/resources/agent_sdk/missing_agent_sdk_cli.md'));
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === cli.AGENT_SDK_CLI_HELP_COMMAND));
    });

    test('AC-5: no CLI bundling left', () => {
        const read = (f: string): string => fs.readFileSync(path.join(EXT, f), 'utf8');
        for (const f of ['install_extension.sh', 'install_extension.ps1', 'compile_and_install.sh', 'compile_and_install.ps1', 'create_vsix.sh', 'create_vsix.ps1',
            'create_vsix_nodart.sh', 'create_vsix_nodart.ps1', 'create_currentbinaries_vsix.sh', 'create_currentbinaries_vsix.ps1', 'create_fleetcompiled_vsix.sh',
            'create_fleetcompiled_vsix.ps1', 'reinstall_for_testing.sh', 'reinstall_for_testing.ps1']) {
            const text = read(f);
            for (const gone of ['--all-platforms', 'TOM_ALL_PLATFORMS', 'AllPlatforms', 'npm pack', 'claude-agent-sdk']) {
                assert.ok(!text.includes(gone), `${f}: no ${gone}`);
            }
        }
        const pkg = JSON.parse(read('package.json'));
        for (const name of ['@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk']) {
            assert.equal(pkg.dependencies[name], undefined, `${name}: not a dependency (vsce would package it)`);
            assert.ok(pkg.devDependencies[name], `${name}: a devDependency (types, tests)`);
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { providerSdkEntries } = require(path.join(EXT, 'scripts', 'check-vsix-contents.cjs')) as { providerSdkEntries(n: Set<string>): string[] };
        assert.deepEqual(providerSdkEntries(new Set([
            'extension/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
            'extension/node_modules/@anthropic-ai/sdk/index.js',
            'extension/bin/win32-x64/claude.exe',
            'extension/bin/linux-x64/tom_bs',
            'extension/node_modules/zod/index.js',
        ])), ['extension/bin/win32-x64/claude.exe', 'extension/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude', 'extension/node_modules/@anthropic-ai/sdk/index.js']);
    });
});
