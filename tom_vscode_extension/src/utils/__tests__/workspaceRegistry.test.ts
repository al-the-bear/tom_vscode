/**
 * The quest's workspace folder recorded, the root's workspace folders, tomAi_getWorkspaceInfo's `include` parts
 * and `${workspaceQuests}` (02_wslayout-11; utils/workspaceRegistry.ts, services/aiWorkspaceLive.ts).
 *
 *   WR-1 the relative workspace folder: posix form below the root, `.` standalone
 *   WR-2 the scan: folders with an `_ai` entry and a `.tom` or CLAUDE.md, relative and sorted; ztmp, node_modules,
 *        build folders and hidden folders skipped, a workspace folder not searched further down; a standalone root
 *        answers `.`
 *   WR-3 the record: written when the window opens a quest (relative to the root), not again when unchanged,
 *        nothing for `default`; read back per quest; the quests of a workspace folder
 *   WR-4 tomAi_getWorkspaceInfo `include`: layout, workspaceFolderScan (refresh passed on), quests; an unknown part
 *        refused; without `include` the answer is as before
 *   WR-5 the workspace quests and `${workspaceQuests}`: the list when there is one, else the recorded quests of
 *        this window's workspace folder, else every quest; the workspace lists naming each quest
 */

import test, { after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261118_02_wslayout-11_reg-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function mk(...parts: string[]): string { const p = path.join(...parts); fs.mkdirSync(p, { recursive: true }); return p; }
function put(file: string, text: string): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

// The root: its .tom and _ai; two workspace folders (container: _ai link + .tom; web: _ai link + CLAUDE.md); folders the
// scan must not count.
const ROOT = mk(SANDBOX, 'root');
put(path.join(ROOT, '.tom', 'tom_root.yaml'), 'version: 1\n');
put(path.join(ROOT, '.tom', 'tom_vscode_extension.json'), '{}');
const QUESTS = mk(ROOT, '_ai', 'quests');
for (const q of ['qa', 'qb', 'qc']) { put(path.join(QUESTS, q, `overview.${q}.md`), `# ${q}\n`); }
put(path.join(QUESTS, 'qa', 'config', 'extension_config.qa.yaml'), 'workspaceFolder: inhouse/container\ntelegram:\n  pollIntervalMs: 5\n');
put(path.join(QUESTS, 'qb', 'config', 'extension_config.qb.yaml'), 'workspaceFolder: web\n');
const CONTAINER = mk(ROOT, 'inhouse', 'container');
mk(CONTAINER, '.tom');
fs.symlinkSync(path.join(ROOT, '_ai'), path.join(CONTAINER, '_ai'));
mk(CONTAINER, 'nested', '_ai'); mk(CONTAINER, 'nested', '.tom'); // inside a workspace folder: not searched
const WEB = mk(ROOT, 'web');
fs.symlinkSync(path.join(ROOT, '_ai'), path.join(WEB, '_ai')); put(path.join(WEB, 'CLAUDE.md'), '# web\n');
for (const skipped of ['ztmp/scratch', 'node_modules/pkg', 'build/out', '.hidden/ws']) {
    const d = mk(ROOT, ...skipped.split('/'));
    mk(d, '_ai'); mk(d, '.tom');
}
mk(ROOT, 'plain', 'deeper'); // neither

installVscodeStub({ workspaceFolders: [CONTAINER] });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const reg = require('../workspaceRegistry.js') as typeof import('../workspaceRegistry.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const layoutMod = require('../workspaceLayout.js') as typeof import('../workspaceLayout.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const live = require('../../services/aiWorkspaceLive.js') as typeof import('../../services/aiWorkspaceLive.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ai = require('../aiWorkspace.js') as typeof import('../aiWorkspace.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getWorkspaceInfoImpl } = require('../../tools/editor-context-tools.js') as typeof import('../../tools/editor-context-tools.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveVariables } = require('../variableResolver.js') as typeof import('../variableResolver.js');

function window(folder: string, quest: string): void {
    const handle = installVscodeStub({ workspaceFolders: [folder] });
    (handle.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(QUESTS, quest, `${quest}.code-workspace`), scheme: 'file' };
    layoutMod.resetLayoutForTests();
}

describe('workspace folders and recorded quests', () => {
    beforeEach(() => window(CONTAINER, 'qc'));

    test('WR-1: the relative workspace folder', () => {
        assert.equal(reg.relativeWorkspaceFolder(ROOT, CONTAINER), 'inhouse/container');
        assert.equal(reg.relativeWorkspaceFolder(ROOT, ROOT), '.');
    });

    test('WR-2: the scan', () => {
        assert.deepEqual(reg.scanWorkspaceFolders(ROOT), ['inhouse/container', 'web']);
        const alone = mk(SANDBOX, 'alone');
        mk(alone, '_ai'); mk(alone, '.tom');
        assert.deepEqual(reg.scanWorkspaceFolders(alone), ['.'], 'a standalone workspace');
        assert.deepEqual(reg.scanWorkspaceFolders(mk(SANDBOX, 'empty')), []);
    });

    test('WR-3: the record', () => {
        assert.equal(layoutMod.getLayout()?.root, ROOT);
        assert.equal(live.recordWindowQuestWorkspaceFolder(), true, 'written on open');
        assert.match(fs.readFileSync(path.join(QUESTS, 'qc', 'config', 'extension_config.qc.yaml'), 'utf8'), /workspaceFolder: inhouse\/container/);
        assert.equal(live.recordWindowQuestWorkspaceFolder(), false, 'unchanged: not written again');
        assert.equal(reg.readRecordedWorkspaceFolder(QUESTS, 'qa'), 'inhouse/container');
        assert.match(fs.readFileSync(path.join(QUESTS, 'qa', 'config', 'extension_config.qa.yaml'), 'utf8'), /pollIntervalMs: 5/, 'other sections kept');
        assert.deepEqual(reg.recordedQuestsOf(QUESTS, 'inhouse/container'), ['qa', 'qc']);
        assert.deepEqual(reg.questsWithWorkspaceFolders(QUESTS), [
            { quest: 'qa', workspaceFolder: 'inhouse/container' }, { quest: 'qb', workspaceFolder: 'web' }, { quest: 'qc', workspaceFolder: 'inhouse/container' },
        ]);
        const writes: unknown[] = [];
        const io = { read: () => undefined, write: (...a: unknown[]) => { writes.push(a); } };
        assert.equal(reg.recordQuestWorkspaceFolder(io, 'default', 'x'), false, 'no quest open');
        assert.equal(writes.length, 0);
        assert.equal(reg.recordQuestWorkspaceFolder(io, 'alone', '.'), true, 'standalone: `.`');
        assert.deepEqual(writes, [['workspaceFolder', '.', 'alone']]);
    });

    test('WR-4: tomAi_getWorkspaceInfo include', async () => {
        const snapshot = async () => ({ workspaceName: 'w', workspaceFile: null, workspaceFolders: [], questId: 'qc', projects: [], projectsSource: null, git: null }) as never;
        let refreshed: boolean | undefined;
        const extras = {
            layout: () => ({ root: ROOT }),
            workspaceFolders: (refresh: boolean) => { refreshed = refresh; return { root: ROOT, folders: reg.scanWorkspaceFolders(ROOT) }; },
            quests: () => reg.questsWithWorkspaceFolders(QUESTS),
            repos: () => null,
        };
        const plain = JSON.parse(await getWorkspaceInfoImpl({ source: { snapshot }, extras }, {}));
        assert.equal('layout' in plain || 'quests' in plain || 'workspaceFolderScan' in plain, false, 'no include: as before');
        const all = JSON.parse(await getWorkspaceInfoImpl({ source: { snapshot }, extras }, { include: ['layout', 'workspaceFolders', 'quests'], refresh: true }));
        assert.deepEqual(all.layout, { root: ROOT });
        assert.deepEqual(all.workspaceFolderScan, { root: ROOT, folders: ['inhouse/container', 'web'] });
        assert.equal(refreshed, true);
        assert.deepEqual(all.quests.map((q: { quest: string }) => q.quest), ['qa', 'qb', 'qc']);
        const bad = JSON.parse(await getWorkspaceInfoImpl({ source: { snapshot }, extras }, { include: ['nope'] }));
        assert.equal(bad.ok, false);
        assert.match(bad.error, /Unknown include part\(s\): nope/);
    });

    test('WR-5: the workspace quests and ${workspaceQuests}', () => {
        live.recordWindowQuestWorkspaceFolder();
        const recorded = live.windowWorkspaceQuests()!;
        assert.equal(recorded.source, 'recorded');
        assert.deepEqual(recorded.quests, ['qa', 'qc'], 'the quests recorded for this workspace folder');
        assert.equal(resolveVariables('${workspaceQuests}', { includeEditor: false }), 'qa, qc');
        // A list wins.
        ai.writeAiWorkspaceQuests(path.join(ROOT, '_ai'), 'container', ['qb']);
        assert.equal(resolveVariables('${workspaceQuests}', { includeEditor: false }), 'qb');
        assert.deepEqual(ai.workspacesListingQuests(path.join(ROOT, '_ai')).get('qb'), ['container']);
        fs.rmSync(path.join(ROOT, '_ai', 'workspaces'), { recursive: true, force: true });
        // Neither: every quest (the user's choice, as the quest choosers do).
        assert.deepEqual(ai.resolveWorkspaceQuests(path.join(ROOT, '_ai'), 'other', ['qa', 'qb', 'qc'], []).quests, ['qa', 'qb', 'qc']);
        window(WEB, 'qb');
        assert.equal(resolveVariables('${workspaceQuests}', { includeEditor: false }), 'qb', 'web: its recorded quest');
    });
});
