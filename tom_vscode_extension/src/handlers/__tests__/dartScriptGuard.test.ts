/**
 * DartScript without tom_bs (handlers/dartScriptGuard.ts, vsc_nodart-3), with
 * the vscode stub and a fake extension root that has no tom_bs for this
 * platform.
 *
 *   DG-1 activation's restartBridgeHandler(context, false): no bridge process is spawned, no message is shown
 *        (no 'Bridge binary not found'); it answers dartScriptUnavailable
 *   DG-2 every bridge command stops first with `<feature> needs DartScript, which is not available on
 *        <platform>: the tom_bs binary is missing.` and the "What does this mean?" button, spawns nothing and
 *        returns the tool answer; the button opens the Dart binaries page
 *   DG-3 tomAi_runVscodeCommand on a bridge command answers {ok: false, code: 'dartScriptUnavailable', error, help}
 *   DG-4 Telegram /bridge restart, /bridge mode and /cli-integration start reply with the sentence
 *   DG-5 the guard reads the binaries again: tom_bs copied in later passes it, without a reload; with tom_bs
 *        present no guard stops anything
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub';

let clicked: string | undefined;
const errors: unknown[][] = [];
const stubbed = installVscodeStub({
    methodOverrides: {
        showErrorMessage: async (...args: unknown[]) => { errors.push(args); return clicked; },
        showWarningMessage: async (...args: unknown[]) => { errors.push(args); return undefined; },
    },
});

// Count bridge spawns: vscode-bridge.ts calls child_process.spawn at start time.
const spawned: unknown[][] = [];
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require('child_process') as { spawn: (...a: unknown[]) => unknown };
const realSpawn = cp.spawn;
cp.spawn = (...args: unknown[]) => { spawned.push(args); return realSpawn(...args); };

/* eslint-disable @typescript-eslint/no-require-imports */
const status = require('../../services/dartBinariesStatus') as typeof import('../../services/dartBinariesStatus');
const guard = require('../dartScriptGuard') as typeof import('../dartScriptGuard');
const restart = require('../restartBridge-handler') as typeof import('../restartBridge-handler');
const cli = require('../cliServer-handler') as typeof import('../cliServer-handler');
const execFile = require('../executeInTomAiBuild-handler') as typeof import('../executeInTomAiBuild-handler');
const execScript = require('../executeAsScript-handler') as typeof import('../executeAsScript-handler');
const debugLogging = require('../debugLogging-handler') as typeof import('../debugLogging-handler');
const processMonitor = require('../processMonitor-handler') as typeof import('../processMonitor-handler');
const printConfig = require('../printConfiguration-handler') as typeof import('../printConfiguration-handler');
const runTests = require('../runTests-handler') as typeof import('../runTests-handler');
const commandTools = require('../../tools/vscode-command-tools') as typeof import('../../tools/vscode-command-tools');
const telegram = require('../telegram-cmd-handlers') as typeof import('../telegram-cmd-handlers');
/* eslint-enable @typescript-eslint/no-require-imports */

const HOST = status.dartBinariesStatus(fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'))).platform;
const EXE = process.platform === 'win32' ? '.exe' : '';
const BUTTON = 'What does this mean?';
const sentence = (feature: string): string => `${feature} needs DartScript, which is not available on ${HOST}: the tom_bs binary is missing.`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-guard-ext-'));
status.setDartBinariesExtensionRoot(root);
status.setDartBinariesConfigSource(() => ({}));
const ctx = { extensionPath: root, subscriptions: [], globalState: { get: () => undefined, update: async () => undefined } } as never;

const previews = (): number => stubbed.spies.byMethod('commands.executeCommand').filter((c) => c.args[0] === 'markdown.showPreview').length;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('DartScript without tom_bs', () => {
    test('DG-1: activation starts nothing and shows nothing', async () => {
        const before = errors.length;
        const answer = await restart.restartBridgeHandler(ctx, false);
        await tick();
        assert.equal(spawned.length, 0, 'no bridge process');
        assert.equal(errors.length, before, 'no message at activation');
        assert.equal((answer as { code?: string })?.code, 'dartScriptUnavailable');
    });

    test('DG-2: every bridge command', async () => {
        const commands: Array<[string, () => Promise<unknown>]> = [
            ['Restart Bridge', () => restart.restartBridgeHandler(ctx, true)],
            ['Switch Bridge Profile', () => restart.switchBridgeProfileHandler(ctx)],
            ['Execute File', () => execFile.executeInTomAiBuildHandler(undefined, ctx)],
            ['Execute as Script', () => execScript.executeAsScriptHandler(undefined, ctx)],
            ['The CLI integration server', () => cli.startCliServerHandler()],
            ['The CLI integration server', () => cli.startCliServerCustomPortHandler()],
            ['Bridge debug logging', () => debugLogging.toggleBridgeDebugLoggingHandler()],
            ['The process monitor', () => processMonitor.startProcessMonitorHandler()],
            ['Print Configuration', () => printConfig.printConfigurationHandler()],
            ['Run Tests', () => runTests.runTestsHandler(ctx)],
        ];
        for (const [feature, run] of commands) {
            const before = errors.length;
            const answer = await run() as { ok: boolean; code: string; error: string; help: string; page: string };
            await tick();
            assert.deepEqual(errors.slice(before), [[sentence(feature), BUTTON]], feature);
            assert.equal(answer.ok, false);
            assert.equal(answer.code, 'dartScriptUnavailable');
            assert.equal(answer.error, sentence(feature));
            assert.equal(answer.help, 'Run command tomAi.showDartBinariesHelp');
            assert.match(answer.page, /missing_dart_binaries\.md$/);
        }
        assert.equal(spawned.length, 0, 'nothing spawned');
        const opened = previews();
        clicked = BUTTON;
        guard.guardDartScript('Restart Bridge');
        await tick(); await tick();
        assert.equal(previews(), opened + 1, 'the button opens the page');
        clicked = undefined;
    });

    test('DG-3: a tool gets the answer', async () => {
        const out = JSON.parse(await commandTools.runVscodeCommandImpl(
            { executeCommand: async () => restart.restartBridgeHandler(ctx, true), listCommands: async () => [] },
            { command: 'tomAi.bridge.restart' },
        ));
        assert.equal(out.result.ok, false);
        assert.equal(out.result.code, 'dartScriptUnavailable');
        assert.equal(out.result.error, sentence('Restart Bridge'));
        assert.equal(out.result.help, 'Run command tomAi.showDartBinariesHelp');
    });

    test('DG-4: Telegram replies with the sentence', async () => {
        const registry = telegram.createCommandRegistry(() => undefined);
        const run = (text: string): Promise<{ text: string }> => {
            const parsed = registry.parse(text, 1, 1, 'u')!;
            return registry.get(parsed.command)!.handler(parsed) as Promise<{ text: string }>;
        };
        const executed = stubbed.spies.byMethod('commands.executeCommand').length;
        assert.equal((await run('/bridge restart')).text, `❌ ${sentence('Restart Bridge')}`);
        assert.equal((await run('/bridge mode prod')).text, `❌ ${sentence('Switch Bridge Profile')}`);
        assert.equal((await run('/cli-integration start')).text, `❌ ${sentence('The CLI integration server')}`);
        assert.equal(stubbed.spies.byMethod('commands.executeCommand').length, executed, 'no command run');
    });

    test('DG-5: read again; with tom_bs nothing stops', async () => {
        assert.equal(guard.isDartScriptAvailable(), false);
        assert.throws(() => guard.requireDartScript('Restart Bridge'), (e: unknown) => e instanceof guard.DartScriptUnavailable);
        fs.mkdirSync(path.join(root, 'bin', HOST), { recursive: true });
        fs.writeFileSync(path.join(root, 'bin', HOST, `tom_bs${EXE}`), '');
        try {
            assert.equal(guard.isDartScriptAvailable(), true, 'copied in: available without a reload');
            assert.doesNotThrow(() => guard.requireDartScript('Restart Bridge'));
            const before = errors.length;
            assert.equal(guard.guardDartScript('Run Tests'), undefined);
            assert.equal(guard.dartScriptUnavailableText('Restart Bridge'), undefined);
            await tick();
            assert.equal(errors.length, before);
        } finally {
            fs.rmSync(path.join(root, 'bin'), { recursive: true, force: true });
        }
        assert.equal(guard.isDartScriptAvailable(), false);
    });
});
