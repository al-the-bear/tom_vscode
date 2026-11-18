/**
 * Quest data under the `_ai` root and `_ai` paths compared by their real paths (02_wslayout-3; utils/pathCompare.ts).
 *
 *   AP-1 the helper: a file through the workspace folder's `_ai` link and through the root is the same file, inside
 *        the root's `_ai`, with the same path below it (names kept); a file not there yet too; a sibling with the
 *        same prefix is not inside
 *   AP-2 Windows path casing: compared without case on win32 (the names below kept as written), with case elsewhere
 *   AP-3 quest detection: a todo file through the link and through the root is in the same quest
 *   AP-4 the MD Browser: a document opened through the root and then through the link reuses the panel; closing
 *        under the root's quest folder closes the panel opened through the link
 *   AP-5 the quest todo watcher: one watcher at the real `_ai` root (the same from the container and from a
 *        workspace folder without its own `_ai`); a change refreshes once
 *   AP-6 `_ai` only at the root: the quests, the todo id schema, a configured `_ai/...` path and the file tools'
 *        workspace check all reach the root's `_ai`; other configured paths stay in the workspace folder
 *   AP-7 no `getWorkspaceRoot` left in the sources
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { installVscodeStub, stubFileWatchers } from '../../tools/__tests__/_vscode-stub.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261118_02_wslayout-3_paths-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function mk(...parts: string[]): string { const p = path.join(...parts); fs.mkdirSync(p, { recursive: true }); return p; }
function put(file: string, text: string): string { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }

// The root with the one `_ai`; the container links to it; `bare` is a workspace folder without an `_ai` of its own.
const ROOT = mk(SANDBOX, 'root');
put(path.join(ROOT, '.tom', 'tom_root.yaml'), 'version: 1\n');
const ROOT_AI = mk(ROOT, '_ai');
put(path.join(ROOT_AI, 'quests', 'qa', 'overview.qa.md'), '# qa\n');
put(path.join(ROOT_AI, 'quests', 'qa', 'todos.qa.todo.yaml'), 'todos: []\n');
put(path.join(ROOT_AI, 'quests', 'qa', 'idea.qa.md'), '# idea\n');
put(path.join(ROOT_AI, 'schemas', 'yaml', 'todo.schema.json'), JSON.stringify({ $defs: { todo: { properties: { id: { type: 'string', pattern: '^[a-z]+[0-9]*$', description: 'An id (letters, then digits).' } } } } }));
const CONTAINER = mk(ROOT, 'inhouse', 'container');
mk(CONTAINER, '.tom');
fs.symlinkSync(ROOT_AI, path.join(CONTAINER, '_ai'));
const BARE = mk(ROOT, 'bare');
mk(BARE, '.tom');
const SIBLING = mk(ROOT, '_ai2', 'quests', 'qa');

const VIA_LINK = path.join(CONTAINER, '_ai', 'quests', 'qa', 'idea.qa.md');
const VIA_ROOT = path.join(ROOT_AI, 'quests', 'qa', 'idea.qa.md');

installVscodeStub({ workspaceFolders: [CONTAINER] });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pc = require('../../utils/pathCompare.js') as typeof import('../../utils/pathCompare.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const layoutMod = require('../../utils/workspaceLayout.js') as typeof import('../../utils/workspaceLayout.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WsPaths } = require('../../utils/workspacePaths.js') as typeof import('../../utils/workspacePaths.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { todoScopeOf } = require('../../utils/todoBlocking.js') as typeof import('../../utils/todoBlocking.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MdBrowserRegistry } = require('../../utils/mdBrowserRegistry.js') as typeof import('../../utils/mdBrowserRegistry.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mdTools = require('../../tools/md-browser-tools.js') as typeof import('../../tools/md-browser-tools.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const prims = require('../../tools/file-primitives.js') as typeof import('../../tools/file-primitives.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../tools/tool-executors.js'); // installs the extra-roots provider (the window's other roots and the `_ai` root)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const qtm = require('../../managers/questTodoManager.js') as typeof import('../../managers/questTodoManager.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupQuestTodoWatcher } = require('../questTodoPanel-handler.js') as typeof import('../questTodoPanel-handler.js');

function window(folder: string): void {
    const handle = installVscodeStub({ workspaceFolders: [folder] });
    (handle.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(ROOT_AI, 'quests', 'qa', 'qa.code-workspace'), scheme: 'file' };
    layoutMod.resetLayoutForTests();
}

describe('_ai paths by their real paths', () => {
    test('AP-1: the helper', () => {
        assert.equal(pc.samePath(VIA_LINK, VIA_ROOT), true);
        assert.equal(pc.isInside(VIA_LINK, ROOT_AI), true);
        assert.equal(pc.isInside(VIA_ROOT, path.join(CONTAINER, '_ai')), true);
        assert.deepEqual(pc.relativeInside(VIA_LINK, ROOT_AI), ['quests', 'qa', 'idea.qa.md']);
        assert.deepEqual(pc.relativeInside(path.join(CONTAINER, '_ai'), ROOT_AI), [], 'the same folder');
        const notYet = path.join(CONTAINER, '_ai', 'quests', 'qa', 'new', 'later.md');
        assert.equal(pc.samePath(notYet, path.join(ROOT_AI, 'quests', 'qa', 'new', 'later.md')), true, 'a file not there yet');
        assert.equal(pc.isInside(path.join(SIBLING, 'x.md'), ROOT_AI), false, 'a sibling with the same prefix');
        assert.equal(pc.isInside(path.join(CONTAINER, 'x.md'), ROOT_AI), false);
        assert.equal(pc.samePath('', VIA_ROOT), false);
    });

    test('AP-2: Windows path casing', () => {
        assert.equal(pc.samePath('C:\\Code\\_ai\\Quests\\QA\\f.md', 'c:\\code\\_AI\\quests\\qa\\F.MD', 'win32'), true);
        assert.equal(pc.samePath('C:\\Code\\_ai\\Quests\\QA\\f.md', 'c:\\code\\_AI\\quests\\qa\\F.MD', 'linux'), false);
        assert.deepEqual(pc.relativeInside('C:\\Code\\_ai\\quests\\QaQuest\\f.md', 'c:\\code\\_AI', 'win32'), ['quests', 'QaQuest', 'f.md'], 'names kept');
        assert.equal(pc.relativeInside('C:\\Code\\_ai\\quests\\q\\f.md', 'c:\\code\\_AI', 'darwin'), undefined);
    });

    test('AP-3: quest detection agrees through the link and through the root', () => {
        const viaLink = path.join(CONTAINER, '_ai', 'quests', 'qa', 'todos.qa.todo.yaml');
        const viaRoot = path.join(ROOT_AI, 'quests', 'qa', 'todos.qa.todo.yaml');
        const linkQuests = path.join(CONTAINER, '_ai', 'quests');
        const rootQuests = path.join(ROOT_AI, 'quests');
        for (const [file, quests] of [[viaLink, rootQuests], [viaRoot, linkQuests], [viaLink, linkQuests], [viaRoot, rootQuests]]) {
            assert.deepEqual(todoScopeOf(file, quests), { scopeKey: 'quest:qa', quest: 'qa' }, `${file} in ${quests}`);
        }
    });

    test('AP-4: the MD Browser recognises the same quest file', async () => {
        window(CONTAINER);
        const registry = new MdBrowserRegistry();
        const calls: string[] = [];
        const c = {
            registry, workspaceRoot: CONTAINER,
            exists: (p: string) => fs.existsSync(p),
            open(absPath: string, opts: { live: boolean }) { calls.push(`open ${absPath}`); return registry.register({ filePath: absPath, liveMode: opts.live, viewColumn: 1 }); },
            reveal(panelId: string) { calls.push(`reveal ${panelId}`); return true; },
            close(ids: string[]) { for (const id of ids) { calls.push(`close ${id}`); registry.unregister(id); } },
        };
        const first = JSON.parse(await mdTools.openInMdBrowserImpl(c, { filePath: VIA_ROOT }));
        assert.equal(first.ok, true, JSON.stringify(first));
        const again = JSON.parse(await mdTools.openInMdBrowserImpl(c, { filePath: VIA_LINK }));
        assert.deepEqual([again.panelId, again.reused], [first.panelId, true], 'the same panel');
        const closed = JSON.parse(await mdTools.closeMdBrowserImpl(c, { under: path.join(ROOT_AI, 'quests', 'qa') }));
        assert.deepEqual(closed.closed.map((x: { panelId: string }) => x.panelId), [first.panelId]);
        assert.deepEqual(calls, [`open ${VIA_ROOT}`, `reveal ${first.panelId}`, `close ${first.panelId}`]);
    });

    test('AP-5: one quest todo watcher at the real _ai root', () => {
        for (const folder of [CONTAINER, BARE]) {
            window(folder);
            let refreshed = 0;
            const before = stubFileWatchers().length;
            const w = setupQuestTodoWatcher(() => { refreshed += 1; });
            assert.ok(w, folder);
            const made = stubFileWatchers().slice(before);
            assert.equal(made.length, 1, 'one watcher');
            const pattern = made[0].pattern as { base: unknown; pattern: string };
            assert.equal(pattern.base, fs.realpathSync(ROOT_AI), `${folder}: the real _ai root`);
            assert.equal(pattern.pattern, 'quests/**/*.todo.yaml');
            made[0].fireChange({ fsPath: VIA_ROOT });
            assert.equal(refreshed, 1, 'a change refreshes once');
            w!.dispose();
        }
    });

    test('AP-6: _ai only at the root', () => {
        window(BARE);
        assert.equal(fs.existsSync(path.join(BARE, '_ai')), false);
        assert.equal(WsPaths.aiRoot, ROOT_AI);
        assert.deepEqual(qtm.listQuestIds(), ['qa']);
        assert.match(qtm.todoIdRefusal('12ab') ?? '', /is no todo id: the todo schema \(_ai\/schemas\/yaml\/todo\.schema\.json\) requires letters, then digits/);
        assert.equal(qtm.todoIdRefusal('ab12'), undefined);
        assert.equal(WsPaths.resolveWorkspaceRelative('_ai/copilot'), path.join(ROOT_AI, 'copilot'));
        assert.equal(WsPaths.resolveWorkspaceRelative('_ai'), ROOT_AI);
        assert.equal(WsPaths.resolveWorkspaceRelative('notes/x.md'), path.join(BARE, 'notes', 'x.md'));
        assert.equal(WsPaths.resolveWorkspaceRelative('/abs/x'), '/abs/x');
        assert.equal(prims.isInsideWorkspace(VIA_ROOT, BARE), true, 'the root\'s _ai counts as inside');
        assert.equal(prims.isInsideWorkspace(path.join(ROOT, 'elsewhere.md'), BARE), false);
        window(CONTAINER);
        assert.equal(prims.isInsideWorkspace(VIA_ROOT, CONTAINER), true, 'through the root while the container links to it');
    });

    test('AP-7: no getWorkspaceRoot left in the sources', () => {
        const hits: string[] = [];
        const walk = (dir: string): void => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { if (e.name !== '__tests__') { walk(p); } continue; }
                if (e.name.endsWith('.ts') && /\bgetWorkspaceRoot\b/.test(fs.readFileSync(p, 'utf8'))) { hits.push(path.relative(EXT, p)); }
            }
        };
        walk(path.join(EXT, 'src'));
        assert.deepEqual(hits, []);
    });
});
