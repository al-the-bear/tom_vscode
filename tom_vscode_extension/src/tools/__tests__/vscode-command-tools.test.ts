/**
 * Tool-impl tests for `vscode-command-tools.ts` — the four VS Code
 * command tools: `tomAi_runVscodeCommand`, `tomAi_runVscodeCommandTyped`,
 * `tomAi_listCommands`, `tomAi_openFile`.
 *
 * The impls take narrow `CommandRunner` / `FileOpener` dep interfaces,
 * so the tests pass plain-object fakes — no vscode stub required.
 *
 * Coverage entry #6 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; the
 *      runVscodeCommand vs runVscodeCommandTyped relationship and the
 *      "1-based line numbers, internally converted" promise are
 *      spelled out.
 *   b) Ambiguities — explicitly tested:
 *        - unknown command id (run + list)
 *        - commands that return undefined / null / object values
 *        - openFile path traversal rejection
 *        - openFile missing file
 *        - args=[] and args=undefined treated the same way
 *        - safe-list flagging
 *   c) Tests: known + unknown command, typed-args round-trip,
 *      openFile with missing file / line:column anchor / preview flag.
 *   d) Timing — typical call per tool wrapped in `withTiming`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    isSafeVscodeCommand,
    listCommandsImpl,
    openFileImpl,
    runVscodeCommandImpl,
    type CommandRunner,
    type FileOpener,
    type OpenFileShowOptions,
} from '../vscode-command-tools.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface CommandCall { commandId: string; args: unknown[] }

function makeFakeRunner(opts: {
    commands?: string[];
    onExecute?: (commandId: string, args: unknown[]) => unknown | Promise<unknown>;
    listError?: Error;
} = {}): CommandRunner & { calls: CommandCall[] } {
    const calls: CommandCall[] = [];
    return {
        calls,
        async executeCommand(commandId, args) {
            calls.push({ commandId, args });
            if (opts.onExecute) { return opts.onExecute(commandId, args); }
            return undefined;
        },
        async listCommands(filterInternal) {
            if (opts.listError) { throw opts.listError; }
            const all = opts.commands ?? [
                'editor.action.formatDocument',
                'editor.action.organizeImports',
                'workbench.action.files.save',
                'workbench.view.explorer',
                '_internal.thing',
                '_internal.another',
                'tomAi.something',
            ];
            return filterInternal ? all.filter((c) => !c.startsWith('_')) : all;
        },
    };
}

interface OpenCall { absPath: string; opts: OpenFileShowOptions }

function makeFakeOpener(opts: {
    wsRoot?: string;
    existing?: Set<string>;
    onOpen?: (abs: string, o: OpenFileShowOptions) => { ok: true; languageId: string; lineCount: number } | { ok: false; reason: string };
} = {}): FileOpener & { calls: OpenCall[] } {
    const calls: OpenCall[] = [];
    return {
        calls,
        wsRoot: opts.wsRoot ?? '/ws',
        exists(absPath) { return (opts.existing ?? new Set()).has(absPath); },
        async openInEditor(absPath, o) {
            calls.push({ absPath, opts: o });
            if (opts.onOpen) { return opts.onOpen(absPath, o); }
            return { ok: true, languageId: 'typescript', lineCount: 100 };
        },
    };
}

// ===========================================================================
// runVscodeCommand / runVscodeCommandTyped (shared impl)
// ===========================================================================

describe('runVscodeCommandImpl', () => {

    test('typical call: known command, returns result + safeListed flag', async () => {
        const runner = makeFakeRunner({
            onExecute: () => ({ formatted: true }),
        });
        const raw = await withTiming('tomAi_runVscodeCommand:typical', () =>
            runVscodeCommandImpl(runner, { command: 'editor.action.formatDocument' }));
        const r = JSON.parse(raw);
        assert.equal(r.success, true);
        assert.equal(r.command, 'editor.action.formatDocument');
        assert.equal(r.safeListed, true, 'editor.action.* should match the safe-list');
        assert.deepEqual(r.result, { formatted: true });
        assert.equal(runner.calls.length, 1);
        assert.deepEqual(runner.calls[0].args, []);
    });

    test('typical-typed: typed args round-trip through to the command', async () => {
        const runner = makeFakeRunner({
            onExecute: (_, args) => ({ receivedArgs: args }),
        });
        const raw = await withTiming('tomAi_runVscodeCommandTyped:typical', () =>
            runVscodeCommandImpl(runner, {
                command: 'editor.action.insertSnippet',
                args: [{ snippet: 'hello $1 world' }],
            }));
        const r = JSON.parse(raw);
        assert.deepEqual(r.result, { receivedArgs: [{ snippet: 'hello $1 world' }] });
        assert.deepEqual(runner.calls[0].args, [{ snippet: 'hello $1 world' }]);
    });

    test('undefined result is reported as null (not "undefined")', async () => {
        const runner = makeFakeRunner({ onExecute: () => undefined });
        const r = JSON.parse(await runVscodeCommandImpl(runner, { command: 'workbench.view.explorer' }));
        assert.equal(r.success, true);
        assert.equal(r.result, null);
    });

    test('missing command returns an instructive error', async () => {
        const runner = makeFakeRunner();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await runVscodeCommandImpl(runner, { command: '' as any }));
        assert.match(r.error, /`command` is required/);
        assert.equal(runner.calls.length, 0);
    });

    test('unknown command (executeCommand throws) is reported with detail, not swallowed', async () => {
        const runner = makeFakeRunner({
            onExecute: () => { throw new Error('command \'nope.does.not.exist\' not found'); },
        });
        const r = JSON.parse(await runVscodeCommandImpl(runner, { command: 'nope.does.not.exist' }));
        assert.match(r.error, /Command failed: command 'nope.does.not.exist' not found/);
        assert.equal(r.command, 'nope.does.not.exist');
    });

    test('non-safe command gets safeListed: false (informational hint)', async () => {
        const runner = makeFakeRunner({ onExecute: () => 'ok' });
        const r = JSON.parse(await runVscodeCommandImpl(runner, { command: 'tomAi.dangerous.thing' }));
        assert.equal(r.safeListed, false);
        // But it still executes — safeListed is a hint, not an enforcement.
        assert.equal(r.success, true);
    });

    test('args=[] and args=undefined are both forwarded as []', async () => {
        const runner = makeFakeRunner();
        await runVscodeCommandImpl(runner, { command: 'x', args: [] });
        await runVscodeCommandImpl(runner, { command: 'x' });
        assert.deepEqual(runner.calls[0].args, []);
        assert.deepEqual(runner.calls[1].args, []);
    });
});

describe('isSafeVscodeCommand', () => {
    test('recognises the documented safe prefixes', () => {
        assert.equal(isSafeVscodeCommand('editor.action.formatDocument'), true);
        assert.equal(isSafeVscodeCommand('workbench.view.explorer'), true);
        assert.equal(isSafeVscodeCommand('cursorMove'), true);
        assert.equal(isSafeVscodeCommand('revealLine'), true);
    });
    test('rejects everything else', () => {
        assert.equal(isSafeVscodeCommand('tomAi.run'), false);
        assert.equal(isSafeVscodeCommand('git.push'), false);
        assert.equal(isSafeVscodeCommand(''), false);
    });
});

// ===========================================================================
// listCommands
// ===========================================================================

describe('listCommandsImpl', () => {

    test('typical call: filtered + sorted + capped, with totals reported', async () => {
        const runner = makeFakeRunner();
        const raw = await withTiming('tomAi_listCommands:typical', () =>
            listCommandsImpl(runner, { filter: 'editor.action' }));
        const r = JSON.parse(raw);
        assert.equal(r.totalMatches, 2);
        assert.equal(r.returned, 2);
        assert.equal(r.truncated, false);
        // Sorted alphabetically:
        assert.deepEqual(r.commands, ['editor.action.formatDocument', 'editor.action.organizeImports']);
    });

    test('internal commands are hidden by default', async () => {
        const runner = makeFakeRunner();
        const r = JSON.parse(await listCommandsImpl(runner, {}));
        assert.ok(r.commands.every((c: string) => !c.startsWith('_')), 'no _-prefixed commands in default response');
    });

    test('includeInternal: true surfaces underscore commands', async () => {
        const runner = makeFakeRunner();
        const r = JSON.parse(await listCommandsImpl(runner, { includeInternal: true }));
        assert.ok(r.commands.some((c: string) => c.startsWith('_')), '_internal.* commands appear when requested');
    });

    test('maxResults clamps the output and sets truncated:true', async () => {
        const runner = makeFakeRunner({
            commands: Array.from({ length: 50 }, (_, i) => `cmd.${String(i).padStart(2, '0')}`),
        });
        const r = JSON.parse(await listCommandsImpl(runner, { maxResults: 5 }));
        assert.equal(r.returned, 5);
        assert.equal(r.totalMatches, 50);
        assert.equal(r.truncated, true);
        assert.deepEqual(r.commands, ['cmd.00', 'cmd.01', 'cmd.02', 'cmd.03', 'cmd.04']);
    });

    test('listCommands failure is wrapped as error JSON', async () => {
        const runner = makeFakeRunner({ listError: new Error('vscode unavailable') });
        const r = JSON.parse(await listCommandsImpl(runner, {}));
        assert.match(r.error, /List commands failed: vscode unavailable/);
    });
});

// ===========================================================================
// openFile
// ===========================================================================

describe('openFileImpl', () => {

    test('typical call: opens by relative path, returns languageId + lineCount', async () => {
        const opener = makeFakeOpener({
            existing: new Set(['/ws/src/extension.ts']),
        });
        const raw = await withTiming('tomAi_openFile:typical', () =>
            openFileImpl(opener, { filePath: 'src/extension.ts' }));
        const r = JSON.parse(raw);
        assert.equal(r.success, true);
        assert.equal(r.file, '/ws/src/extension.ts');
        assert.equal(r.language, 'typescript');
        assert.equal(r.lineCount, 100);
        assert.equal(opener.calls[0].absPath, '/ws/src/extension.ts');
    });

    test('line/column are 1-based and translated to 0-based for vscode', async () => {
        const opener = makeFakeOpener({ existing: new Set(['/ws/a.ts']) });
        await openFileImpl(opener, { filePath: 'a.ts', line: 5, column: 12 });
        assert.deepEqual(opener.calls[0].opts.selection, {
            startLine: 4, startCol: 11, endLine: 4, endCol: 11,
        });
    });

    test('selection range: endLine/endColumn flow through', async () => {
        const opener = makeFakeOpener({ existing: new Set(['/ws/a.ts']) });
        await openFileImpl(opener, { filePath: 'a.ts', line: 5, column: 12, endLine: 10, endColumn: 20 });
        assert.deepEqual(opener.calls[0].opts.selection, {
            startLine: 4, startCol: 11, endLine: 9, endCol: 19,
        });
    });

    test('preview flag flows through unchanged', async () => {
        const opener = makeFakeOpener({ existing: new Set(['/ws/a.ts']) });
        await openFileImpl(opener, { filePath: 'a.ts', preview: true });
        assert.equal(opener.calls[0].opts.preview, true);
    });

    test('missing file returns "File not found" error (no open)', async () => {
        const opener = makeFakeOpener({ existing: new Set() });
        const r = JSON.parse(await openFileImpl(opener, { filePath: 'nope.ts' }));
        assert.match(r.error, /File not found: \/ws\/nope\.ts/);
        assert.equal(opener.calls.length, 0);
    });

    test('path traversal outside the workspace is rejected', async () => {
        const opener = makeFakeOpener();
        const r = JSON.parse(await openFileImpl(opener, { filePath: '../../../etc/passwd' }));
        assert.match(r.error, /outside the workspace/);
        assert.equal(opener.calls.length, 0);
    });

    test('missing filePath returns instructive error', async () => {
        const opener = makeFakeOpener();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await openFileImpl(opener, {} as any));
        assert.match(r.error, /`filePath` is required/);
    });

    test('open failure (vscode threw) is surfaced as `Could not open` error', async () => {
        const opener = makeFakeOpener({
            existing: new Set(['/ws/a.ts']),
            onOpen: () => ({ ok: false, reason: 'document is binary' }),
        });
        const r = JSON.parse(await openFileImpl(opener, { filePath: 'a.ts' }));
        assert.match(r.error, /Could not open: document is binary/);
    });

    test('absolute path is honoured (no double-prefix)', async () => {
        const opener = makeFakeOpener({ existing: new Set(['/ws/sub/leaf.ts']) });
        const r = JSON.parse(await openFileImpl(opener, { filePath: '/ws/sub/leaf.ts' }));
        assert.equal(r.success, true);
        assert.equal(opener.calls[0].absPath, '/ws/sub/leaf.ts');
    });
});
