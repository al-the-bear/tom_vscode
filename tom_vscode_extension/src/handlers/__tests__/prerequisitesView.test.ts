/**
 * @TOM VSC › PREREQUISITES (src/handlers/prerequisitesView-handler.ts, media/prerequisites/).
 *
 *   PV-1 the view is registered in @TOM VSC beside RESOURCES, wired at activation, its media ships
 *   PV-2 on open: the files grouped by repository, the projects without a file apart, not checked yet (no
 *        checks run); Check now runs every check once, stores the results with the time and duration in
 *        global storage, and a second provider on the same storage (another window, or after a reload) shows
 *        them without running a check
 *   PV-3 collapse state and the filter are kept in global storage per node and come back after a reload
 *   PV-4 Create writes a prerequisites.yaml that parses into a project without one, and it moves out of the
 *        without-file group; Open goes to the entry's line; a file the view does not know is not opened
 *   PV-5 the webview: Check now before the first check, Refresh and the time after it, the filters, two marks
 *        (VS Code and terminal) for env options and tools, Create in the without-file group
 */

/* eslint-disable @typescript-eslint/naming-convention -- env names and the stub's EventEmitter */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'prereq-view-'));
after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });
const WS = path.join(SANDBOX, 'ws');
for (const d of ['repo/.git', 'repo/app', 'repo/lib']) { fs.mkdirSync(path.join(WS, d), { recursive: true }); }
fs.writeFileSync(path.join(WS, 'repo', 'app', 'prerequisites.yaml'), `formatVersion: 1
sections:
  - id: main
    title: Main
    secrets:
      - id: key
        title: Key
        type: api_key
        options:
          - via: env
            name: PV_TEST_KEY
    tools:
      - id: node
        title: Node
        command: node
`);

const stubbed = installVscodeStub({ workspaceFolders: [WS] });
const stubWindow = stubbed.stub.window as Record<string, unknown>;
let registered: { resolveWebviewView: (view: unknown, ctx: unknown, token: unknown) => unknown } | undefined;
stubWindow.registerWebviewViewProvider = (_id: string, p: typeof registered) => { registered = p; return { dispose: () => undefined }; };

/* eslint-disable @typescript-eslint/no-require-imports */
const handler = require('../prerequisitesView-handler') as typeof import('../prerequisitesView-handler');
/* eslint-enable @typescript-eslint/no-require-imports */

const EXT = path.resolve(__dirname, '..', '..', '..');
/* eslint-disable @typescript-eslint/no-require-imports */
(require('../handler_shared') as typeof import('../handler_shared')).setExtensionPath(EXT);
/* eslint-enable @typescript-eslint/no-require-imports */

const memento = (): { get: (k: string, d?: unknown) => unknown; update: (k: string, v: unknown) => Promise<void> } => {
    const values = new Map<string, unknown>();
    return { get: (k, d) => (values.has(k) ? values.get(k) : d), update: async (k, v) => { values.set(k, v); } };
};
const globalState = memento();
let checkRuns = 0;
const deps: import('../prerequisitesView-handler').PrerequisitesViewDeps = {
    listProjects: async () => ({
        ok: true, source: 'buildkit', binary: 'buildkit', root: WS,
        projects: ['app', 'lib'].map((n) => ({ id: n, name: n, path: `repo/${n}`, absolutePath: path.join(WS, 'repo', n), language: 'dart', type: 'dart_package', natures: [] })),
    }),
    checkDeps: async () => {
        checkRuns++;
        return {
            platform: 'darwin', homedir: SANDBOX, env: { PV_TEST_KEY: 'x' },
            shellHasEnv: async () => 'missing', shellHasCommand: async () => 'set',
            stat: () => null, readText: () => null,
            run: async () => ({ exitCode: 0 }), runShell: async () => ({ exitCode: 0 }),
            vscodeSecretHas: async () => false, now: () => new Date('2026-11-17T12:00:00.000Z'),
        };
    },
};

function makeView(): { view: Record<string, unknown>; posted: Array<Record<string, unknown>>; send: (m: unknown) => Promise<void> } {
    const E = (stubbed.stub as { EventEmitter: new () => { event: unknown; fire: (v: unknown) => void } }).EventEmitter;
    const received = new E();
    const posted: Array<Record<string, unknown>> = [];
    let listener: ((m: unknown) => unknown) | undefined;
    const view = {
        visible: true,
        webview: {
            html: '', options: {}, cspSource: 'vscode-resource:',
            onDidReceiveMessage: (fn: (m: unknown) => unknown) => { listener = fn; return { dispose: () => undefined }; },
            postMessage: async (m: Record<string, unknown>) => { posted.push(m); return true; },
            asWebviewUri: (u: unknown) => u,
        },
        onDidChangeVisibility: new E().event,
        onDidDispose: new E().event,
    };
    void received;
    // The host handles a message without awaiting it (`void this.handle(msg)`): let it finish.
    return { view, posted, send: async (m) => { await listener?.(m); await new Promise((r) => setTimeout(r, 40)); } };
}

function context(): Record<string, unknown> {
    return {
        subscriptions: [], extensionPath: EXT, extensionUri: { fsPath: EXT, scheme: 'file', path: EXT },
        globalState, workspaceState: memento(), secrets: { get: async () => undefined },
    };
}

const lastState = (posted: Array<Record<string, unknown>>): Record<string, unknown> => [...posted].reverse().find((m) => m.type === 'state')!;
type Tree = import('../../utils/prerequisitesTree').PrerequisitesTree;

describe('the PREREQUISITES view', () => {
    test('PV-1: registration', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        const views = pkg.contributes.views['tomAi-vsc-sidebar'].map((v: { id: string }) => v.id);
        assert.deepEqual(views, ['tomAi.vscResources', 'tomAi.prerequisites']);
        assert.equal(pkg.contributes.views['tomAi-vsc-sidebar'][1].name, 'PREREQUISITES');
        const ext = fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8');
        assert.match(ext, /registerVscResourcesView\(context\);\n\s+registerPrerequisitesView\(context\);/);
        for (const f of ['index.html', 'main.js', 'style.css']) { assert.ok(fs.existsSync(path.join(EXT, 'media', 'prerequisites', f)), f); }
    });

    test('PV-2: listing, Check now, results for every window', async () => {
        const provider = handler.registerPrerequisitesView(context() as never, deps);
        assert.ok(registered);
        const { view, posted, send } = makeView();
        await registered!.resolveWebviewView(view, {}, {});
        await send({ type: 'ready' });
        let state = lastState(posted);
        const tree = state.tree as Tree;
        assert.deepEqual(tree.repositories.map((r) => [r.name, r.files.map((f) => f.name)]), [['repo', ['app']]]);
        assert.deepEqual(tree.withoutFile.map((p) => p.name), ['lib']);
        assert.equal(state.checkedAt, null, 'not checked yet');
        assert.equal(checkRuns, 0, 'opening runs no check');

        await send({ type: 'check' });
        state = lastState(posted);
        assert.equal(checkRuns, 1);
        assert.equal(state.checking, null);
        assert.equal(typeof state.checkedAt, 'string');
        assert.equal(typeof state.durationMs, 'number');
        const stored = globalState.get(handler.PREREQUISITES_RESULTS_KEY) as { checkedAt: string; results: Record<string, { status: string; host?: string; shell?: string }> };
        assert.equal(stored.checkedAt, state.checkedAt);
        const item = (state.tree as Tree).repositories[0].files[0].sections[0].items;
        assert.deepEqual(item.map((i) => [i.id, i.status]), [['key', 'set'], ['node', 'set']]);
        assert.deepEqual([item[0].options[0].result?.host, item[0].options[0].result?.shell], ['set', 'missing'], 'two marks for env');
        void provider;

        // Another window (or after a reload): the same storage, a new provider; no check runs.
        handler.registerPrerequisitesView(context() as never, deps);
        const other = makeView();
        await registered!.resolveWebviewView(other.view, {}, {});
        await other.send({ type: 'ready' });
        const otherState = lastState(other.posted);
        assert.equal(otherState.checkedAt, stored.checkedAt, 'the last check and its time at once');
        assert.equal((otherState.tree as Tree).repositories[0].files[0].sections[0].items[0].status, 'set');
        assert.equal(checkRuns, 1, 'no second check');
    });

    test('PV-3: collapse state and filter survive a reload', async () => {
        handler.registerPrerequisitesView(context() as never, deps);
        const a = makeView();
        await registered!.resolveWebviewView(a.view, {}, {});
        await a.send({ type: 'ready' });
        const file = path.join(WS, 'repo', 'app', 'prerequisites.yaml');
        await a.send({ type: 'toggle', node: file, expanded: true });
        await a.send({ type: 'toggle', node: `${file}#main/key`, expanded: true });
        await a.send({ type: 'filter', filter: { missingOnly: true, requiredOnly: false } });
        handler.registerPrerequisitesView(context() as never, deps);
        const b = makeView();
        await registered!.resolveWebviewView(b.view, {}, {});
        await b.send({ type: 'ready' });
        const state = lastState(b.posted);
        assert.deepEqual(state.expanded, { [file]: true, [`${file}#main/key`]: true });
        assert.deepEqual(state.filter, { missingOnly: true, requiredOnly: false });
    });

    test('PV-4: Create and Open', async () => {
        handler.registerPrerequisitesView(context() as never, deps);
        const v = makeView();
        await registered!.resolveWebviewView(v.view, {}, {});
        await v.send({ type: 'ready' });
        const lib = path.join(WS, 'repo', 'lib');
        await v.send({ type: 'create', dir: lib });
        const created = path.join(lib, 'prerequisites.yaml');
        assert.ok(fs.existsSync(created));
        const state = lastState(v.posted);
        const files = (state.tree as Tree).repositories[0].files;
        assert.deepEqual(files.map((f) => [f.name, f.error, f.problems.length]), [['app', undefined, 0], ['lib', undefined, 0]]);
        assert.deepEqual((state.tree as Tree).withoutFile, []);
        const opened = stubbed.spies.byMethod('window.showTextDocument').length;
        assert.ok(opened > 0, 'the new file is opened');

        const before = stubbed.spies.byMethod('window.showTextDocument').length;
        await v.send({ type: 'open', file: path.join(WS, 'elsewhere.yaml') });
        assert.equal(stubbed.spies.byMethod('window.showTextDocument').length, before, 'an unknown file is not opened');
        const shown: unknown[][] = [];
        const original = stubWindow.showTextDocument as (...a: unknown[]) => unknown;
        stubWindow.showTextDocument = (...args: unknown[]) => { shown.push(args); return original(...args); };
        try {
            await v.send({ type: 'open', file: path.join(WS, 'repo', 'app', 'prerequisites.yaml'), nodeId: 'main/node' });
        } finally {
            stubWindow.showTextDocument = original;
        }
        const selection = (shown.at(-1)?.[1] as { selection?: { start?: { line: number } } })?.selection;
        assert.equal(selection?.start?.line, 12, 'the tool\'s id line');
    });

    test('PV-5: the webview', () => {
        const js = fs.readFileSync(path.join(EXT, 'media', 'prerequisites', 'main.js'), 'utf8');
        assert.match(js, /Check now/);
        assert.match(js, /btn\('refresh', 'Check again'/);
        assert.match(js, /Last checked /);
        assert.match(js, /data-filter="missingOnly"/);
        assert.match(js, /data-filter="requiredOnly"/);
        assert.match(js, /mark\(r\.host, 'VS Code'\).*mark\(r\.shell, 'login shell \(a terminal\)'\)/);
        assert.match(js, /Projects without prerequisites\.yaml/);
        assert.match(js, /btn\('new-file', 'Create prerequisites\.yaml in '/);
        assert.match(js, /vscode\.postMessage\(\{ type: 'toggle', node: key, expanded: now \}\)/);
    });
});
