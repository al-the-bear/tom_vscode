/**
 * The quest overview shown once per quest and machine when a quest window
 * opens (handlers/questOverviewOnOpen-handler.ts, vsc_setup-6), through the
 * vscode stub with the MD Browser's open replaced by a recorder.
 *
 *   QO-1 a quest window opens the overview the first time, in the MD Browser without taking the focus, and
 *        remembers the quest in globalState (`tomAi.questOverview.shown`); not the second time
 *   QO-2 not for `default`, not for a quest without an overview
 *   QO-3 a second quest is opened the first time again; the list keeps both
 *   QO-4 not when it is open already in a restored tab (by path, or by title for a tab whose file was not
 *        remembered) or a running panel — it still counts as shown
 *   QO-5 beside a restored editor, in the active group when there is none; afterwards reachable as
 *        @WS › Documentation › Quest Overview; called at activation after the MD Browser registered its tabs
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quest-overview-')));
const WS = path.join(SANDBOX, 'ws');
for (const q of ['alpha', 'beta', 'bare']) { fs.mkdirSync(path.join(WS, '_ai', 'quests', q), { recursive: true }); }
for (const q of ['alpha', 'beta']) { fs.writeFileSync(path.join(WS, '_ai', 'quests', q, `overview.${q}.md`), `# ${q}`); }
const EXT = path.resolve(__dirname, '..', '..', '..');

const opened: Array<{ file: string; show: { viewColumn?: number; preserveFocus?: boolean } | undefined }> = [];
const stubbed = installVscodeStub({
    workspaceFolders: [WS],
    moduleOverrides: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- a module path
        './markdownBrowser-handler': {
            openMarkdownBrowser: (_c: unknown, file: string, options?: { show?: { viewColumn?: number; preserveFocus?: boolean } }) => { opened.push({ file, show: options?.show }); return 'mdb-x'; },
        },
    },
});
const stubWindow = stubbed.stub.window as Record<string, unknown>;
const stubWorkspace = stubbed.stub.workspace as Record<string, unknown>;

import { openQuestOverviewOnce } from '../questOverviewOnOpen-handler.js';
import { mdBrowserRegistry } from '../../utils/mdBrowserRegistry.js';
import { QUEST_OVERVIEW_SHOWN_KEY, isOpenInMdBrowser, planQuestOverview } from '../../utils/questOverviewOnOpen.js';
import { QUEST_LOG_TABS } from '../../utils/questLogFiles.js';

after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

const overview = (q: string): string => path.join(WS, '_ai', 'quests', q, `overview.${q}.md`);
function machine(): { context: never; state: Map<string, unknown> } {
    const state = new Map<string, unknown>();
    const context = { globalState: { get: (k: string, d?: unknown) => state.has(k) ? state.get(k) : d, update: async (k: string, v: unknown) => { state.set(k, v); } } };
    return { context: context as never, state };
}
function questWindow(q: string | undefined): void {
    stubWorkspace.workspaceFile = q ? { fsPath: path.join(WS, '_ai', 'quests', q, `${q}.code-workspace`), scheme: 'file' } : undefined;
}
const ACTIVE = (): number => ((stubbed.stub as Record<string, unknown>).ViewColumn as Record<string, number>).Active;
const BESIDE = (): number => ((stubbed.stub as Record<string, unknown>).ViewColumn as Record<string, number>).Beside;
stubWindow.visibleTextEditors = [];

describe('the quest overview on opening a quest window', () => {
    test('QO-1: the first time, not the second', async () => {
        const { context, state } = machine();
        questWindow('alpha');
        opened.length = 0;
        assert.equal(await openQuestOverviewOnce(context), 'opened');
        assert.deepEqual(opened, [{ file: overview('alpha'), show: { viewColumn: ACTIVE(), preserveFocus: true } }]);
        assert.deepEqual(state.get(QUEST_OVERVIEW_SHOWN_KEY), ['alpha']);
        assert.equal(await openQuestOverviewOnce(context), 'skipped');
        assert.equal(opened.length, 1, 'not again for that quest');
    });

    test('QO-2: not for default, not without an overview', async () => {
        const { context, state } = machine();
        opened.length = 0;
        questWindow(undefined);
        assert.equal(await openQuestOverviewOnce(context), 'skipped');
        questWindow('default');
        assert.equal(await openQuestOverviewOnce(context), 'skipped');
        questWindow('bare');
        assert.equal(await openQuestOverviewOnce(context), 'skipped');
        assert.equal(opened.length, 0);
        assert.equal(state.get(QUEST_OVERVIEW_SHOWN_KEY), undefined, 'nothing remembered');
    });

    test('QO-3: a second quest the first time again', async () => {
        const { context, state } = machine();
        opened.length = 0;
        questWindow('alpha');
        await openQuestOverviewOnce(context);
        questWindow('beta');
        assert.equal(await openQuestOverviewOnce(context), 'opened');
        assert.deepEqual(opened.map((o) => o.file), [overview('alpha'), overview('beta')]);
        assert.deepEqual(state.get(QUEST_OVERVIEW_SHOWN_KEY), ['alpha', 'beta']);
        questWindow('alpha');
        assert.equal(await openQuestOverviewOnce(context), 'skipped');
    });

    test('QO-4: not when it is open already', async () => {
        opened.length = 0;
        // A restored tab with its file remembered.
        let { context, state } = machine();
        questWindow('alpha');
        const dormant = mdBrowserRegistry.registerDormant({ label: 'MD: overview.alpha.md', viewColumn: 1, filePath: overview('alpha'), liveMode: false });
        assert.equal(await openQuestOverviewOnce(context), 'alreadyOpen');
        assert.equal(opened.length, 0);
        assert.deepEqual(state.get(QUEST_OVERVIEW_SHOWN_KEY), ['alpha'], 'it still counts as shown');
        mdBrowserRegistry.unregister(dormant);
        // A restored tab known only by its title.
        ({ context, state } = machine());
        const unknown = mdBrowserRegistry.registerDormant({ label: 'MD: overview.alpha.md', viewColumn: 1, liveMode: false });
        assert.equal(await openQuestOverviewOnce(context), 'alreadyOpen');
        mdBrowserRegistry.unregister(unknown);
        // A running panel.
        ({ context, state } = machine());
        const running = mdBrowserRegistry.register({ filePath: overview('alpha'), liveMode: false, viewColumn: 1 });
        assert.equal(await openQuestOverviewOnce(context), 'alreadyOpen');
        mdBrowserRegistry.unregister(running);
        assert.equal(opened.length, 0);
        // Another file of another quest with the same base name does not count.
        assert.equal(isOpenInMdBrowser(overview('alpha'), [{ filePath: path.join(SANDBOX, 'elsewhere', 'overview.alpha.md') }]), false);
        assert.deepEqual(planQuestOverview({ questId: 'alpha', overviewExists: true, shown: [], alreadyOpen: true }), { open: false, remember: ['alpha'] });
    });

    test('QO-5: where it opens; reachable afterwards; wired at activation', async () => {
        const { context } = machine();
        opened.length = 0;
        questWindow('beta');
        stubWindow.visibleTextEditors = [{ document: { uri: { fsPath: path.join(WS, 'a.dart') } } }];
        await openQuestOverviewOnce(context);
        stubWindow.visibleTextEditors = [];
        assert.deepEqual(opened[0].show, { viewColumn: BESIDE(), preserveFocus: true }, 'beside the restored editor, focus kept');
        assert.ok(QUEST_LOG_TABS.some((t) => t.id === 'overview' && t.section === 'docs' && t.label === 'Quest Overview'));
        const ext = fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8');
        assert.match(ext, /registerMarkdownBrowser\(context\);\n[^\n]*\n\s+void openQuestOverviewOnce\(context\)/);
    });
});
