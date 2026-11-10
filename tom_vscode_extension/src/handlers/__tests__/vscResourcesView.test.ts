/**
 * @TOM VSC's host side (src/handlers/vscResourcesView-handler.ts, vscimpb30) with a fake process system and a
 * stand-in configuration, under the vscode stub.
 *
 *   VH-1 the status-bar item: the window's total (`$(server-process) … in N processes`), the largest groups in its
 *        tooltip, a click opens the view; hidden when the process list fails
 *   VH-2 the view: its state carries the snapshot, the settings and which profile commands exist; Pause posts
 *        SIGSTOP to the group's processes; Kill asks first and does nothing when the user declines
 *   VH-3 a setting written to the workspace settings (a glob into the object, off over an inherited on = false);
 *        a setting whose extension is missing answers a note; a profile command is run
 */

/* eslint-disable @typescript-eslint/naming-convention -- setting keys, globs and the stub's ConfigurationTarget / StatusBarAlignment names */
import test, { after, describe } from 'node:test';
import * as path from 'path';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub';
const stubbed = installVscodeStub({});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const win = stubbed.stub.window as Json;
const ws = stubbed.stub.workspace as Json;
const cmds = stubbed.stub.commands as Json;

// The status-bar item, the registered view provider, the configuration and the commands run.
const status: Json = { text: '', tooltip: '', command: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { /* */ } };
win.createStatusBarItem = () => status;
let provider: Json;
win.registerWebviewViewProvider = (_id: string, p: Json) => { provider = p; return { dispose() { /* */ } }; };
let warningAnswer: string | undefined;
win.showWarningMessage = async () => warningAnswer;
const config: Record<string, { defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown }> = {
    'search.exclude': { defaultValue: { '**/node_modules/**': true } },
    'git.autoRepositoryDetection': { defaultValue: true },
    'git.repositoryScanMaxDepth': { defaultValue: 1 },
    'git.openRepositoryInParentFolders': { defaultValue: 'prompt' },
    'files.watcherExclude': { defaultValue: {} },
};
const writes: Array<[string, unknown, unknown]> = [];
ws.getConfiguration = () => ({
    get: (key: string) => {
        const c = config[key];
        if (!c) { return undefined; }
        if (typeof c.defaultValue === 'object' && c.defaultValue !== null) { return { ...(c.defaultValue as object), ...(c.globalValue as object ?? {}), ...(c.workspaceValue as object ?? {}) }; }
        return c.workspaceValue ?? c.globalValue ?? c.defaultValue;
    },
    inspect: (key: string) => (config[key] ? { key, ...config[key] } : undefined),
    update: async (key: string, value: unknown, target: unknown) => {
        if (!config[key]) { throw new Error(`Unable to write to Workspace Settings because ${key} is not a registered configuration.`); }
        writes.push([key, value, target]);
        config[key].workspaceValue = value;
    },
});
ws.onDidChangeConfiguration = () => ({ dispose() { /* */ } });
(stubbed.stub as Json).ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
(stubbed.stub as Json).StatusBarAlignment = { Left: 1, Right: 2 };
const run: string[] = [];
cmds.getCommands = async () => ['workbench.profiles.actions.switchProfile', 'workbench.profiles.actions.manageProfiles'];
cmds.executeCommand = async (id: string) => { run.push(id); };

import { registerVscResourcesView } from '../vscResourcesView-handler';
import { setExtensionPath } from '../handler_shared';
import { ExtensionProcessService, type ProcessSystem } from '../../services/extensionProcessService';
import { parsePsOutput } from '../../utils/extensionProcesses';

const PS = [
    ' 100 1 S 600000 10.0 01:00 /Applications/VS Code/Code Helper (Plugin) --type=utility',
    ' 200 100 S 1048576 40.0 01:00 /sdk/bin/dart language-server --protocol=lsp',
    ' 201 200 S 524288 5.0 01:00 /sdk/bin/dartaotruntime /sdk/snapshots/analysis_server.dart.snapshot',
    ' 300 100 S 102400 0.0 01:00 /usr/bin/git status',
].join('\n');
let failing = false;
const signals: Array<[number, string]> = [];
const sys: ProcessSystem = {
    platform: 'darwin', rootPid: 100,
    listAll: async () => { if (failing) { throw new Error('ps failed'); } return parsePsOutput(PS); },
    signal: (pid, sig) => { signals.push([pid, sig]); },
};
const subscriptions: Array<{ dispose(): void }> = [];
const context = { subscriptions, extensionUri: { fsPath: '/ext', scheme: 'file' } } as never;
setExtensionPath(path.resolve(__dirname, '..', '..', '..'));
registerVscResourcesView(context, new ExtensionProcessService(sys));
after(() => {
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* */ } }
    stubbed.restore();
});

/** A webview view whose posted messages are recorded; `handle` is what the view posts to the host. */
function resolveView(): { posted: Json[]; handle: (m: Json) => Promise<void> } {
    const posted: Json[] = [];
    let handler: (m: Json) => Promise<void> = async () => undefined;
    const view: Json = {
        visible: false,
        webview: {
            options: {}, html: '', cspSource: 'csp',
            asWebviewUri: (u: Json) => u,
            postMessage: async (m: Json) => { posted.push(JSON.parse(JSON.stringify(m))); return true; },
            onDidReceiveMessage: (fn: (m: Json) => Promise<void>) => { handler = fn; return { dispose() { /* */ } }; },
        },
        onDidChangeVisibility: () => ({ dispose() { /* */ } }),
        onDidDispose: () => ({ dispose() { /* */ } }),
    };
    provider.resolveWebviewView(view);
    return { posted, handle: async (m) => { await handler(m); await new Promise((r) => setTimeout(r, 10)); } };
}

describe('@TOM VSC host', () => {
    test('VH-1: the status-bar item', async () => {
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(status.text, '$(server-process) 1.6 GB in 3 processes');
        assert.match(status.tooltip, /extension host itself: 586 MB/);
        assert.match(status.tooltip, /dart-code\.dart-code: 1\.5 GB/);
        assert.equal(status.command, 'tomAi.vscResources.focus');
        assert.equal(status.visible, true);
    });

    test('VH-2: the view and the process actions', async () => {
        const { posted, handle } = resolveView();
        await handle({ type: 'ready' });
        const state = posted.pop();
        assert.equal(state.type, 'state');
        assert.equal(state.snapshot.processes.length, 3);
        assert.equal(state.snapshot.totalText, '1.6 GB');
        assert.deepEqual(state.profiles.map((p: Json) => [p.id, p.available]), [
            ['workbench.profiles.actions.switchProfile', true],
            ['workbench.profiles.actions.createFromCurrentProfile', false],
            ['workbench.profiles.actions.manageProfiles', true],
        ]);
        assert.ok(state.settings.some((s: Json) => s.id === 'dart.onlyAnalyzeProjectsWithOpenFiles' && s.available === false), 'Dart not installed');
        await handle({ type: 'act', action: 'pause', extensionId: 'dart-code.dart-code', label: 'Dart' });
        assert.deepEqual(signals.sort((a, b) => a[0] - b[0]), [[200, 'SIGSTOP'], [201, 'SIGSTOP']]);
        assert.match(posted.pop().note.text, /Paused 2 processes\. Their editor features wait until you resume them\./);
        signals.length = 0;
        warningAnswer = undefined;
        await handle({ type: 'act', action: 'kill', pids: [300], label: 'git' });
        assert.deepEqual(signals, [], 'declined: nothing killed');
        warningAnswer = 'Kill';
        await handle({ type: 'act', action: 'kill', pids: [300], label: 'git' });
        assert.deepEqual(signals, [[300, 'SIGTERM']]);
    });

    test('VH-3: settings and profiles', async () => {
        const { posted, handle } = resolveView();
        await handle({ type: 'setting', id: 'search.exclude:**/ztmp/**', value: true });
        assert.deepEqual(writes.pop(), ['search.exclude', { '**/ztmp/**': true }, 2]);
        await handle({ type: 'setting', id: 'search.exclude:**/node_modules/**', value: false });
        assert.deepEqual(writes.pop(), ['search.exclude', { '**/ztmp/**': true, '**/node_modules/**': false }, 2], 'on by default: written false');
        await handle({ type: 'setting', id: 'git.autoRepositoryDetection', value: 'openEditors' });
        assert.deepEqual(writes.pop(), ['git.autoRepositoryDetection', 'openEditors', 2]);
        await handle({ type: 'setting', id: 'dart.onlyAnalyzeProjectsWithOpenFiles', value: true });
        assert.match(posted.pop().note.text, /could not be written: Unable to write/);
        await handle({ type: 'profile', command: 'workbench.profiles.actions.switchProfile' });
        await handle({ type: 'profile', command: 'workbench.action.quit' });
        assert.deepEqual(run, ['workbench.profiles.actions.switchProfile'], 'only the profile commands');
        failing = true;
        await handle({ type: 'refresh' });
        assert.equal(status.visible, false, 'a failed list hides the status item');
        failing = false;
    });
});
