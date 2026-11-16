/**
 * The QUEST NOTES side panel's host (src/handlers/questNotesPanel-handler.ts, vscimpb101), driven through the
 * vscode stub with a fake webview view.
 *
 *   QNP-1 no quest open: the page is told so, nothing is rendered, the title has no quest
 *   QNP-2 a quest: the notes file is created with its header, the page gets its content (Edit) and the
 *         MD Browser's mdContent (View), the title names the quest; the page loads the MD Browser's scripts
 *   QNP-3 save writes the file and the View follows; the MD Browser's writing messages change nothing
 *   QNP-4 a change on disk reaches the page (notesState, external) and the View
 *   QNP-5 links: an anchor scrolls the View; Open in Editor opens the notes file
 *   QNP-6 the @TOM INFO container and its view are contributed
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quest-notes-panel-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
fs.mkdirSync(path.join(WS, '_ai', 'quests', QUEST), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
const stubWorkspace = vscodeStub.stub.workspace as Record<string, unknown>;
const setQuest = (q: string | undefined): void => {
    stubWorkspace.workspaceFile = q ? { fsPath: path.join(WS, `${q}.code-workspace`), scheme: 'file' } : undefined;
};

import { setExtensionPath } from '../handler_shared.js';
import { QuestNotesPanelProvider, VIEW_SCRIPTS, QUEST_NOTES_PANEL_VIEW_ID } from '../questNotesPanel-handler.js';

setExtensionPath(EXT_ROOT);
after(() => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ } });

const context = { subscriptions: [] as Array<{ dispose(): void }>, extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file', path: EXT_ROOT } };
const NOTES = path.join(WS, '_ai', 'quests', QUEST, `quest-notes.${QUEST}.md`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = Record<string, any>;
const providers: QuestNotesPanelProvider[] = [];
after(() => { for (const p of providers) { p.dispose(); } });

function open(): { provider: QuestNotesPanelProvider; view: Msg; posted: Msg[]; send(m: Msg): Promise<void>; of(type: string): Msg[] } {
    const provider = new QuestNotesPanelProvider(context as never, 40);
    providers.push(provider);
    const posted: Msg[] = [];
    const view: Msg = {
        visible: true,
        title: '',
        onDidChangeVisibility: () => ({ dispose: () => undefined }),
        onDidDispose: () => ({ dispose: () => undefined }),
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-resource:',
            asWebviewUri: (u: { fsPath?: string; path?: string }) => ({ toString: () => `res:${u.fsPath ?? u.path}` }),
            onDidReceiveMessage: () => ({ dispose: () => undefined }),
            postMessage: async (m: Msg) => { posted.push(m); return true; },
        },
    };
    provider.resolveWebviewView(view as never);
    return { provider, view, posted, send: (m) => provider.handleMessage(m), of: (type) => posted.filter((m) => m.type === type) };
}

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) { throw new Error('timed out'); }
        await new Promise((r) => setTimeout(r, 20));
    }
};

describe('QUEST NOTES side panel (host)', () => {
    test('QNP-1: no quest open', async () => {
        setQuest(undefined);
        const p = open();
        await p.send({ type: 'ready' });
        assert.deepEqual(p.of('notesState').map((m) => [m.hasQuest, m.content]), [[false, '']]);
        assert.equal(p.of('mdContent').length, 0);
        assert.equal(p.view.title, 'QUEST NOTES');
    });

    test('QNP-2: the quest\'s notes, for both tabs', async () => {
        setQuest(QUEST);
        const p = open();
        const html = p.view.webview.html as string;
        assert.match(html, /<textarea id="notesText"/);
        for (const f of VIEW_SCRIPTS) { assert.ok(html.includes(`media/${f}`), `the page loads ${f}`); }
        assert.ok(html.includes('marked.umd.js'));
        await p.send({ type: 'ready' });
        assert.equal(fs.readFileSync(NOTES, 'utf8'), `# Quest Notes — ${QUEST}\n\n`, 'created with its header');
        const [state] = p.of('notesState');
        assert.deepEqual([state.hasQuest, state.questId, state.content, state.relativePath], [true, QUEST, `# Quest Notes — ${QUEST}\n\n`, path.join('_ai', 'quests', QUEST, `quest-notes.${QUEST}.md`)]);
        const [md] = p.of('mdContent');
        assert.equal(md.filePath, NOTES);
        assert.match(md.content, /Quest Notes/);
        assert.equal(md.crlf, false);
        assert.equal(p.view.title, `QUEST NOTES — ${QUEST}`);
        p.posted.length = 0;
        await p.send({ type: 'webviewReady' });
        assert.deepEqual(p.posted.map((m) => m.type), ['mdContent'], 'the renderer coming up gets the View only');
    });

    test('QNP-3: save, and the View follows; no writes from the View', async () => {
        setQuest(QUEST);
        const p = open();
        await p.send({ type: 'ready' });
        p.posted.length = 0;
        await p.send({ type: 'save', content: '# Notes\n\n## Today\n\nwrite tests\n' });
        assert.equal(fs.readFileSync(NOTES, 'utf8'), '# Notes\n\n## Today\n\nwrite tests\n');
        assert.match(p.of('mdContent')[0].content, /Today/);
        await p.send({ type: 'applyEdit', startLine: 0, endLine: 1, oldText: '# Notes', newText: '# Changed' });
        await p.send({ type: 'reviewMark', id: 'M-1', decision: 'accept' });
        assert.equal(fs.readFileSync(NOTES, 'utf8'), '# Notes\n\n## Today\n\nwrite tests\n', 'the View is read-only');
    });

    test('QNP-4: a change on disk', async () => {
        setQuest(QUEST);
        const p = open();
        await p.send({ type: 'ready' });
        p.posted.length = 0;
        fs.writeFileSync(NOTES, '# Notes\n\nfrom an agent\n');
        await waitFor(() => p.of('notesState').length > 0);
        const [state] = p.of('notesState');
        assert.deepEqual([state.external, state.content], [true, '# Notes\n\nfrom an agent\n']);
        await waitFor(() => p.of('mdContent').length > 0);
        assert.match(p.of('mdContent')[0].content, /from an agent/);
        // The panel's own save is not reported back as a change.
        p.posted.length = 0;
        await p.send({ type: 'save', content: '# Notes\n\nmine\n' });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(p.of('notesState').length, 0);
    });

    test('QNP-5: links and open buttons', async () => {
        setQuest(QUEST);
        const p = open();
        await p.send({ type: 'ready' });
        p.posted.length = 0;
        await p.send({ type: 'navigateLink', href: '#today' });
        assert.deepEqual(p.of('scrollToAnchor').map((m) => m.anchor), ['today']);
        vscodeStub.spies.clear();
        await p.send({ type: 'openInEditor' });
        const shown = vscodeStub.spies.calls.filter((c) => c.method === 'window.showTextDocument' || c.method === 'workspace.openTextDocument');
        assert.ok(shown.length > 0, 'the notes file is opened in an editor');
        assert.ok(JSON.stringify(shown).includes(`quest-notes.${QUEST}.md`), JSON.stringify(shown));
    });

    test('QNP-6: contributed as an activity-bar container of its own', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'));
        const container = pkg.contributes.viewsContainers.activitybar.find((c: Msg) => c.id === 'tomAi-info-sidebar');
        assert.ok(container, '@TOM INFO container');
        assert.ok(fs.existsSync(path.join(EXT_ROOT, container.icon)));
        assert.deepEqual(pkg.contributes.views['tomAi-info-sidebar'].map((v: Msg) => [v.type, v.id]), [['webview', QUEST_NOTES_PANEL_VIEW_ID], ['webview', 'tomAi.runsOverview'], ['webview', 'tomAi.notifications']]);
        assert.ok(pkg.contributes.views['tomAi-sidebar'].some((v: Msg) => v.id === 'tomAi.questNotes'), 'the @TOM QUEST NOTES view stays');
    });
});
