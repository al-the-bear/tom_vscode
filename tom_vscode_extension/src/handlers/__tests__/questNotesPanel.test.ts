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
 *   QNP-7 the picker: the state lists the quest's notes files (the default first) and names the one shown;
 *         selectNotesFile shows another file, save writes that file, the open buttons open it; a second view
 *         follows the switch; a name that is not in the list changes nothing
 *   QNP-8 New notes file: the input box validates the name; the file is created in notes/ with its heading
 *         and shown; a dismissed box and a refused name create nothing
 *   QNP-9 the choice is kept per quest in the workspaceState: a new view opens on it; when its file is gone
 *         the default is shown; another quest has its own choice
 *   QNP-10 a quest whose notes are at the old place: the old file is shown and saved as quest-notes.md, and
 *         nothing is created in notes/; a new notes file goes into notes/ beside it
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

const stateValues = new Map<string, unknown>();
const workspaceState = { get: (k: string, d?: unknown) => stateValues.has(k) ? stateValues.get(k) : d, update: async (k: string, v: unknown) => { stateValues.set(k, v); }, keys: () => [...stateValues.keys()] };
const context = { subscriptions: [] as Array<{ dispose(): void }>, extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file', path: EXT_ROOT }, workspaceState };
const NOTES_DIR = path.join(WS, '_ai', 'quests', QUEST, 'notes');
const NOTES = path.join(NOTES_DIR, 'quest-notes.md');
const stubWindow = vscodeStub.stub.window as Record<string, unknown>;
const inputBoxes: Array<Record<string, unknown>> = [];
const inputAnswers: Array<string | undefined> = [];
stubWindow.showInputBox = async (options: Record<string, unknown>) => { inputBoxes.push(options); return inputAnswers.shift(); };
const warnings: string[] = [];
stubWindow.showWarningMessage = async (m: unknown) => { warnings.push(String(m)); return undefined; };

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
        assert.deepEqual([state.hasQuest, state.questId, state.content, state.relativePath], [true, QUEST, `# Quest Notes — ${QUEST}\n\n`, path.join('_ai', 'quests', QUEST, 'notes', 'quest-notes.md')]);
        assert.deepEqual([state.notesFiles, state.notesFile], [[{ name: 'quest-notes.md', isDefault: true }], 'quest-notes.md']);
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
        assert.ok(JSON.stringify(shown).includes(JSON.stringify(NOTES).slice(1, -1)), JSON.stringify(shown));
    });

    test('QNP-6: contributed as an activity-bar container of its own', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'));
        const container = pkg.contributes.viewsContainers.activitybar.find((c: Msg) => c.id === 'tomAi-info-sidebar');
        assert.ok(container, '@TOM INFO container');
        assert.ok(fs.existsSync(path.join(EXT_ROOT, container.icon)));
        assert.deepEqual(pkg.contributes.views['tomAi-info-sidebar'].map((v: Msg) => [v.type, v.id]), [['webview', QUEST_NOTES_PANEL_VIEW_ID], ['webview', 'tomAi.runsOverview'], ['webview', 'tomAi.userNotifications'], ['webview', 'tomAi.notifications']]);
        assert.ok(pkg.contributes.views['tomAi-sidebar'].some((v: Msg) => v.id === 'tomAi.questNotes'), 'the @TOM QUEST NOTES view stays');
    });

    test('QNP-7: the picker lists the notes files and switches', async () => {
        setQuest(QUEST);
        fs.writeFileSync(NOTES, '# Notes\n');
        fs.writeFileSync(path.join(NOTES_DIR, 'zeta.md'), '# zeta\n');
        fs.writeFileSync(path.join(NOTES_DIR, 'Alpha.md'), '# Alpha\n');
        fs.writeFileSync(path.join(NOTES_DIR, 'not-notes.txt'), 'x');
        const p = open();
        const other = open();
        await p.send({ type: 'ready' });
        await other.send({ type: 'ready' });
        const files = [{ name: 'quest-notes.md', isDefault: true }, { name: 'Alpha.md', isDefault: false }, { name: 'zeta.md', isDefault: false }];
        assert.deepEqual([p.of('notesState')[0].notesFiles, p.of('notesState')[0].notesFile], [files, 'quest-notes.md']);

        p.posted.length = 0;
        other.posted.length = 0;
        await p.send({ type: 'selectNotesFile', name: 'zeta.md' });
        const state = p.of('notesState').pop()!;
        assert.deepEqual([state.notesFile, state.content, state.filePath, state.notesFiles], ['zeta.md', '# zeta\n', path.join(NOTES_DIR, 'zeta.md'), files]);
        assert.equal(p.of('mdContent').pop()!.fileName, 'zeta.md', 'the View follows');
        assert.deepEqual([other.of('notesState').pop()!.notesFile, other.of('notesState').pop()!.content], ['zeta.md', '# zeta\n'], 'the other view follows');

        await p.send({ type: 'save', content: '# zeta\n\nmore\n' });
        assert.equal(fs.readFileSync(path.join(NOTES_DIR, 'zeta.md'), 'utf8'), '# zeta\n\nmore\n');
        assert.equal(fs.readFileSync(NOTES, 'utf8'), '# Notes\n', 'the default is not written');
        await waitFor(() => other.of('notesState').some((m) => m.external && m.content === '# zeta\n\nmore\n'));

        vscodeStub.spies.clear();
        await p.send({ type: 'openInEditor' });
        const shown = vscodeStub.spies.calls.filter((c) => c.method === 'window.showTextDocument' || c.method === 'workspace.openTextDocument');
        assert.ok(JSON.stringify(shown).includes('zeta.md'), `the buttons act on the file shown: ${JSON.stringify(shown)}`);

        p.posted.length = 0;
        await p.send({ type: 'selectNotesFile', name: '../overview.q1.md' });
        await p.send({ type: 'selectNotesFile', name: 'not-notes.txt' });
        assert.deepEqual(p.of('notesState').map((m) => m.notesFile), ['zeta.md', 'zeta.md'], 'only a file of the list is shown');

        await p.send({ type: 'selectNotesFile', name: 'quest-notes.md' });
        assert.equal(p.of('notesState').pop()!.content, '# Notes\n');
    });

    test('QNP-8: New notes file', async () => {
        setQuest(QUEST);
        const p = open();
        await p.send({ type: 'ready' });
        await p.send({ type: 'selectNotesFile', name: 'quest-notes.md' });
        p.posted.length = 0;
        inputBoxes.length = 0;
        inputAnswers.push('Meeting');
        await p.send({ type: 'newNotesFile' });
        assert.equal(inputBoxes.length, 1);
        assert.equal(inputBoxes[0].title, 'New notes file');
        const validate = inputBoxes[0].validateInput as (v: string) => string | undefined;
        assert.equal(validate('fine'), undefined);
        assert.match(String(validate('')), /Enter a name/);
        assert.match(String(validate('a/b')), /path separator/);
        assert.match(String(validate('..')), /"\.\."/);
        assert.match(String(validate('ALPHA')), /Alpha\.md exists already/);
        assert.equal(fs.readFileSync(path.join(NOTES_DIR, 'Meeting.md'), 'utf8'), '# Meeting\n\n');
        const state = p.of('notesState').pop()!;
        assert.deepEqual([state.notesFile, state.content], ['Meeting.md', '# Meeting\n\n'], 'the new file is shown');
        assert.deepEqual(state.notesFiles.map((f: Msg) => f.name), ['quest-notes.md', 'Alpha.md', 'Meeting.md', 'zeta.md']);

        // Dismissed, and a name the box would have refused: nothing is created, the file shown stays.
        const before = fs.readdirSync(NOTES_DIR).sort();
        warnings.length = 0;
        inputAnswers.push(undefined, 'meeting.md', '../escape');
        await p.send({ type: 'newNotesFile' });
        await p.send({ type: 'newNotesFile' });
        await p.send({ type: 'newNotesFile' });
        assert.deepEqual(fs.readdirSync(NOTES_DIR).sort(), before);
        assert.equal(fs.existsSync(path.join(WS, '_ai', 'quests', QUEST, 'escape.md')), false);
        assert.equal(warnings.length, 2);
        assert.match(warnings[0], /Meeting\.md exists already/);
        assert.match(warnings[1], /path separator/);
        assert.equal(fs.readFileSync(path.join(NOTES_DIR, 'Meeting.md'), 'utf8'), '# Meeting\n\n', 'an existing file is not overwritten');
    });

    test('QNP-9: the kept choice and its fallback', async () => {
        setQuest(QUEST);
        const first = open();
        await first.send({ type: 'ready' });
        await first.send({ type: 'selectNotesFile', name: 'Alpha.md' });
        assert.deepEqual(stateValues.get('tomAi.notes.questNotesFile'), { [QUEST]: 'Alpha.md' });

        const again = open();
        await again.send({ type: 'ready' });
        assert.deepEqual([again.of('notesState')[0].notesFile, again.of('notesState')[0].content], ['Alpha.md', '# Alpha\n'], 'a new view opens on the choice');

        // Another quest has its own choice (none: its default).
        fs.mkdirSync(path.join(WS, '_ai', 'quests', 'q2', 'notes'), { recursive: true });
        fs.writeFileSync(path.join(WS, '_ai', 'quests', 'q2', 'notes', 'Alpha.md'), '# q2 Alpha\n');
        setQuest('q2');
        const q2 = open();
        await q2.send({ type: 'ready' });
        assert.deepEqual([q2.of('notesState')[0].questId, q2.of('notesState')[0].notesFile], ['q2', 'quest-notes.md']);
        setQuest(QUEST);

        fs.rmSync(path.join(NOTES_DIR, 'Alpha.md'));
        const after = open();
        await after.send({ type: 'ready' });
        const state = after.of('notesState')[0];
        assert.deepEqual([state.notesFile, state.content, state.notesFiles.map((f: Msg) => f.name)], ['quest-notes.md', '# Notes\n', ['quest-notes.md', 'Meeting.md', 'zeta.md']], 'the file is gone: the default');
        assert.equal(fs.existsSync(path.join(NOTES_DIR, 'Alpha.md')), false, 'the gone file is not created again');
    });

    test('QNP-10: notes at the old place', async () => {
        const old = 'q_old';
        const folder = path.join(WS, '_ai', 'quests', old);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, `quest-notes.${old}.md`), '# Old notes\n');
        setQuest(old);
        const p = open();
        await p.send({ type: 'ready' });
        const state = p.of('notesState')[0];
        assert.deepEqual([state.notesFiles, state.notesFile, state.content, state.filePath],
            [[{ name: 'quest-notes.md', isDefault: true }], 'quest-notes.md', '# Old notes\n', path.join(folder, `quest-notes.${old}.md`)]);
        assert.equal(fs.existsSync(path.join(folder, 'notes')), false, 'nothing is created, copied or moved');
        await p.send({ type: 'save', content: '# Old notes\n\nmore\n' });
        assert.equal(fs.readFileSync(path.join(folder, `quest-notes.${old}.md`), 'utf8'), '# Old notes\n\nmore\n', 'saved into the old file');
        assert.equal(fs.existsSync(path.join(folder, 'notes')), false);

        inputAnswers.push('quest-notes', 'ideas');
        warnings.length = 0;
        await p.send({ type: 'newNotesFile' });
        assert.match(warnings[0], /quest-notes\.md exists already/);
        await p.send({ type: 'newNotesFile' });
        assert.equal(fs.readFileSync(path.join(folder, 'notes', 'ideas.md'), 'utf8'), '# ideas\n\n');
        assert.equal(fs.existsSync(path.join(folder, 'notes', 'quest-notes.md')), false);
        await p.send({ type: 'selectNotesFile', name: 'quest-notes.md' });
        const back = p.of('notesState').pop()!;
        assert.deepEqual([back.notesFiles.map((f: Msg) => f.name), back.content], [['quest-notes.md', 'ideas.md'], '# Old notes\n\nmore\n'], 'the old file stays the default');

        // Once notes/quest-notes.md exists it wins; the old file is not read.
        fs.writeFileSync(path.join(folder, 'notes', 'quest-notes.md'), '# New place\n');
        const next = open();
        await next.send({ type: 'ready' });
        assert.deepEqual([next.of('notesState')[0].content, next.of('notesState')[0].filePath], ['# New place\n', path.join(folder, 'notes', 'quest-notes.md')]);
        setQuest(QUEST);
    });
});
