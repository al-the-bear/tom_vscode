/**
 * Custom chat variables survive a window reload (vscimpb38).
 *
 * The store's file was named per window *session* (`vscode.env.sessionId`, new on every reload) and deleted
 * when the window closed, so a reload — every extension install needs one — started with an empty `custom`
 * map: a process's run parameters (`design`, `design-mode`) and the reported `TODO` were gone at the next step.
 *
 *   CV-1 a reload (the old store disposed, a new session id, a new store) finds the custom variables, the
 *        quest and the role as they were; the file is the workspace's on this host,
 *        `<workspace>.<host>.chatvariable.yaml` (`_ai` is shared by the fleet)
 *   CV-2 a variable goes only when it is deleted (an empty value), and stays deleted after a reload; a bulk
 *        write (the response values writing `TODO`) keeps the others
 *   CV-3 a window without a file of its own starts from the newest file an older build wrote for the workspace
 *        (one per session) — not another host's file, not another workspace's; nothing is removed (`_ai`
 *        versions them); once it has its own file it reads only that
 *   CV-4 the file names: unsafe characters as `_`; a legacy file is `<workspace>.<sessionId>.chatvariable.yaml`
 *        of the same workspace, a session id being a UUID with digits or `window-<ms>`
 *   CV-5 a process run's own custom variables (vscimpb43) are in `<workspace>.<host>.<run>.chatvariable.yaml`, survive
 *        a reload (read back when the run is the window's again), are not the `default` run's, and are not taken
 *        for an older build's per-session file
 */

/* eslint-disable @typescript-eslint/naming-convention -- the keys are chat-variable names (`design-mode`, `TODO`) */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
import { hostSlugOf } from '../../utils/hostSlug.js';

const OWN = `q1.${hostSlugOf()}.chatvariable.yaml`;

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261110_vscimpb38_chatvars-'));
const WS = path.join(SANDBOX, 'ws');
fs.mkdirSync(path.join(WS, '_ai', 'quests', 'q1'), { recursive: true });
const stub = installVscodeStub({ workspaceFolders: [WS] });
const env = (stub.stub as unknown as { env: { sessionId: string } }).env;
(stub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, 'q1.code-workspace'), scheme: 'file' };

type StoreModule = typeof import('../../managers/chatVariablesStore');
let mod: StoreModule;
const subscriptions: Array<{ dispose(): void }> = [];

/** A window start: the store of a new window session. */
function open(sessionId: string): import('../../managers/chatVariablesStore').ChatVariablesStore {
    env.sessionId = sessionId;
    return mod.ChatVariablesStore.init({ subscriptions } as never);
}
/** A window reload: everything the old window registered is disposed, the singleton forgotten. */
function reload(): void {
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* gone */ } }
    mod.ChatVariablesStore.resetForTests();
}
const dir = (): string => path.join(WS, '_ai', 'chat_variables');

before(async () => { mod = await import('../../managers/chatVariablesStore.js'); });
after(() => { reload(); stub.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

describe('custom chat variables survive a reload', () => {
    it('CV-1: reload', () => {
        const first = open('session-a');
        first.set('design', 'process_design', 'anthropic');
        first.set('design-mode', 'revise', 'anthropic');
        assert.equal(first.quest, 'q1');
        reload();
        const second = open('session-b');
        assert.deepEqual(second.custom, { 'design': 'process_design', 'design-mode': 'revise' });
        assert.equal(second.getRaw('design-mode'), 'revise');
        assert.equal(second.quest, 'q1');
        assert.deepEqual(fs.readdirSync(dir()), [OWN], 'one file, the workspace\'s on this host, kept on close');
    });

    it('CV-2: deleted only when deleted; a bulk write keeps the rest', () => {
        const store = mod.ChatVariablesStore.instance;
        store.setCustomBulk({ TODO: '_ai/quests/q1/todos.q1.todo.yaml/a1_x' }, 'anthropic');
        assert.equal(store.getRaw('design'), 'process_design', 'the response values add, they do not replace');
        store.remove('design-mode', 'anthropic');
        reload();
        const again = open('session-c');
        assert.deepEqual(again.custom, { 'design': 'process_design', 'TODO': '_ai/quests/q1/todos.q1.todo.yaml/a1_x' });
    });

    it('CV-3: starting from an older build\'s files', () => {
        reload();
        fs.rmSync(dir(), { recursive: true, force: true });
        fs.mkdirSync(dir(), { recursive: true });
        const legacy = (name: string, custom: Record<string, string>, ageS: number): string => {
            const file = path.join(dir(), name);
            fs.writeFileSync(file, `quest: q1\nrole: default\nactiveProjects: []\ntodo: ""\ntodoFile: all\ncustom: ${JSON.stringify(custom)}\nchangeLog: []\n`);
            const t = new Date(Date.now() - ageS * 1000);
            fs.utimesSync(file, t, t);
            return name;
        };
        const files = [
            legacy('q1.1c6cbbe1-057f-4786-b05c-313b60a9f87b1788606536910.chatvariable.yaml', { stale: 'yes' }, 600),
            legacy('q1.f1ccbb4f-e37a-4965-8daf-dbfbbfc7c6931794337981249.chatvariable.yaml', { 'design-mode': 'revise' }, 10),
            legacy('q1.bomber.chatvariable.yaml', { host: 'bomber' }, 1),
            legacy('q1x.0012f69c-410b-45b5-9985-ab7c4c7381891781247760022.chatvariable.yaml', { other: 'workspace' }, 5),
        ];
        const store = open('session-d');
        assert.deepEqual(store.custom, { 'design-mode': 'revise' }, 'the newest session file of this workspace');
        assert.deepEqual(fs.readdirSync(dir()).sort(), [...files, OWN].sort(), 'nothing removed; its own file written');
        store.set('fresh', '1', 'user');
        reload();
        fs.utimesSync(path.join(dir(), files[0]), new Date(), new Date());
        assert.deepEqual(open('session-e').custom, { 'design-mode': 'revise', 'fresh': '1' }, 'its own file from now on');
    });

    it('CV-4: the file names', () => {
        assert.equal(mod.chatVariablesFileName('my ws.v2', 'mac.book'), 'my_ws_v2.mac_book.chatvariable.yaml');
        const uuid = 'f1ccbb4f-e37a-4965-8daf-dbfbbfc7c6931794337981249';
        assert.deepEqual(mod.legacyChatVariableFiles([
            `q1.${uuid}.chatvariable.yaml`, 'q1.window-1794337981249.chatvariable.yaml', 'q1.alexiss-macbook-pro.chatvariable.yaml',
            `q1x.${uuid}.chatvariable.yaml`, `q1.${uuid}.yaml`, `${uuid}.chatvariable.yaml`,
        ], 'q1'), [`q1.${uuid}.chatvariable.yaml`, 'q1.window-1794337981249.chatvariable.yaml']);
    });

    it('CV-5: a run\'s own variables survive a reload', () => {
        reload();
        const store = open('session-r1');
        store.set('design', 'default-value', 'user');
        store.setWindowRun('chg1');
        assert.deepEqual(store.custom, {}, 'a run starts with its own, empty set');
        store.set('design', 'run-value', 'user');
        const runFile = path.join(dir(), `q1.${hostSlugOf()}.chg1.chatvariable.yaml`);
        assert.equal(store.runFilePath('chg1'), runFile);
        assert.match(fs.readFileSync(runFile, 'utf8'), /design: run-value/);
        reload();
        const again = open('session-r2');
        assert.equal(again.getRaw('design'), 'default-value', 'the window starts on default');
        again.setWindowRun('chg1');
        assert.equal(again.getRaw('design'), 'run-value', 'read back from its file');
        assert.deepEqual(mod.legacyChatVariableFiles([path.basename(runFile)], 'q1'), [], 'not an older build\'s file');
        again.deleteRunSet('chg1');
        assert.equal(fs.existsSync(runFile), false);
        assert.equal(again.windowRun, 'default', 'a deleted window run leaves default');
    });
});
