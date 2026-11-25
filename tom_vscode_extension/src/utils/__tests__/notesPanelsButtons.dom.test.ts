/**
 * The NOTES panels' toolbars (media/sidebarNotes/{tomNotepad,workspace,questNotes}/).
 *
 *   NPB-1 every panel has Open in MD Browser and Open in MD Viewer, posting openInMdBrowser /
 *         openInMdViewer; Preview Markdown and Open in Editor stay (VS CODE NOTES also Copy and Clear)
 *   NPB-2 no panel has the template dropdown, Prompt Preview or Send to Copilot, and none posts
 *         selectTemplate, previewPrompt or sendToCopilot
 *   NPB-3 a state without templates renders: the file name (QUEST NOTES: the picker's choice) and the text show
 *   NPB-4 QUEST NOTES: the picker shows the quest's notes files in the host's order with the one shown selected;
 *         a change writes text still waiting to be saved and posts selectNotesFile; New notes file posts
 *         newNotesFile; a new state replaces the list
 *   NPB-5 WORKSPACE NOTES has no file-pick control and posts no changeFile / createNotesFile; without a
 *         workspace it shows only its message
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function media(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const PANELS = ['tomNotepad', 'workspace', 'questNotes'] as const;
type Panel = typeof PANELS[number];

const STATE: Record<Panel, Record<string, unknown>> = {
    tomNotepad: { type: 'state', content: 'hello', notesFilePath: '/h/.tom/notes/global_notes.md' },
    workspace: { type: 'state', content: 'hello', filePath: '/ws/_ai/workspaces/ws.notes.md', workspaceName: 'ws', hasWorkspace: true },
    questNotes: {
        type: 'state', content: 'hello', filePath: '/ws/_ai/quests/q/notes/quest-notes.md', hasWorkspaceFile: true,
        notesFiles: [{ name: 'quest-notes.md', isDefault: true }, { name: 'Alpha.md', isDefault: false }, { name: 'zeta.md', isDefault: false }],
        notesFile: 'quest-notes.md',
    },
};

function setup(t: { after(fn: () => void): void }, panel: Panel): { w: Win; posted: Array<Record<string, unknown>> } {
    const html = media('sidebarNotes', panel, 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => undefined });
    w.__INIT__ = { homeTomFolder: '.tom' };
    w.confirm = () => false;
    w.eval(media('sidebarNotes', panel, 'main.js'));
    w.dispatchEvent(new w.MessageEvent('message', { data: STATE[panel] }));
    return { w, posted };
}

function click(w: Win, id: string): void {
    const el = w.document.getElementById(id);
    assert.ok(el, `#${id} exists`);
    el.click();
}

describe('NOTES panels: toolbar buttons', () => {
    for (const panel of PANELS) {
        test(`NPB-1: ${panel} opens its file in the MD Browser and the MD Viewer`, (t) => {
            const { w, posted } = setup(t, panel);
            assert.equal(w.document.getElementById('openMdBrowserBtn').title, 'Open in MD Browser');
            assert.equal(w.document.getElementById('openMdViewerBtn').title, 'Open in MD Viewer');
            posted.length = 0;
            click(w, 'openMdBrowserBtn');
            click(w, 'openMdViewerBtn');
            click(w, 'previewMarkdownBtn');
            click(w, 'openBtn');
            assert.deepEqual(posted.map((m) => m.type), ['openInMdBrowser', 'openInMdViewer', 'previewMarkdown', 'openInEditor']);
            if (panel === 'tomNotepad') {
                posted.length = 0;
                click(w, 'copyBtn');
                assert.deepEqual(posted.map((m) => m.type), ['copy']);
                assert.ok(w.document.getElementById('clearBtn'));
            }
        });

        test(`NPB-2: ${panel} has no prompt features`, (t) => {
            const { w, posted } = setup(t, panel);
            for (const id of ['templateSelect', 'previewPromptBtn', 'sendBtn']) {
                assert.equal(w.document.getElementById(id), null, `no #${id}`);
            }
            // The only dropdown is QUEST NOTES' picker of notes files.
            assert.deepEqual([...w.document.querySelectorAll('select')].map((s: Win) => s.id), panel === 'questNotes' ? ['notesFileSelect'] : []);
            for (const btn of [...w.document.querySelectorAll('button')]) { btn.click(); }
            const types = posted.map((m) => m.type);
            for (const gone of ['selectTemplate', 'previewPrompt', 'sendToCopilot']) {
                assert.equal(types.includes(gone), false, `never posts ${gone}`);
            }
        });

        test(`NPB-3: ${panel} renders a state without templates`, (t) => {
            const { w } = setup(t, panel);
            assert.equal(w.document.getElementById('content').value, 'hello');
            if (panel === 'questNotes') {
                assert.equal(w.document.getElementById('notesFileSelect').value, 'quest-notes.md');
                assert.equal(w.document.getElementById('notesFileSelect').title, '/ws/_ai/quests/q/notes/quest-notes.md');
                return;
            }
            const nameId = panel === 'tomNotepad' ? 'notesFileName' : 'fileName';
            assert.match(w.document.getElementById(nameId).textContent, /\.md$/);
        });
    }

    test('NPB-4: QUEST NOTES picks and creates notes files', (t) => {
        const { w, posted } = setup(t, 'questNotes');
        const select = w.document.getElementById('notesFileSelect');
        const options = (): string[] => [...select.options].map((o: Win) => o.value);
        assert.deepEqual(options(), ['quest-notes.md', 'Alpha.md', 'zeta.md'], 'the host\'s order: the default first');
        assert.deepEqual([...select.options].map((o: Win) => o.textContent), ['quest-notes.md', 'Alpha.md', 'zeta.md']);
        assert.equal(select.value, 'quest-notes.md');

        posted.length = 0;
        select.value = 'zeta.md';
        select.dispatchEvent(new w.Event('change'));
        assert.deepEqual(posted, [{ type: 'selectNotesFile', name: 'zeta.md' }]);

        // Text still waiting for its pause is written to the file shown before the switch.
        posted.length = 0;
        const text = w.document.getElementById('content');
        text.value = 'hello, more';
        text.dispatchEvent(new w.Event('input'));
        assert.deepEqual(posted, [], 'not on every keystroke');
        select.value = 'Alpha.md';
        select.dispatchEvent(new w.Event('change'));
        assert.deepEqual(posted, [{ type: 'updateContent', content: 'hello, more' }, { type: 'selectNotesFile', name: 'Alpha.md' }]);

        posted.length = 0;
        assert.equal(w.document.getElementById('newNotesFileBtn').title, 'New notes file');
        click(w, 'newNotesFileBtn');
        assert.deepEqual(posted, [{ type: 'newNotesFile' }]);

        w.dispatchEvent(new w.MessageEvent('message', { data: { ...STATE.questNotes, content: '# New\n', filePath: '/ws/_ai/quests/q/notes/New.md', notesFiles: [{ name: 'quest-notes.md', isDefault: true }, { name: 'New.md', isDefault: false }], notesFile: 'New.md' } }));
        assert.deepEqual(options(), ['quest-notes.md', 'New.md']);
        assert.equal(select.value, 'New.md');
        assert.equal(text.value, '# New\n');
    });

    test('NPB-5: WORKSPACE NOTES has no file pick', (t) => {
        const { w, posted } = setup(t, 'workspace');
        for (const id of ['changeFileBtn', 'createFileBtn', 'selectFileBtn', 'noFile']) {
            assert.equal(w.document.getElementById(id), null, `no #${id}`);
        }
        assert.equal(w.document.getElementById('fileName').textContent, 'ws.notes.md');
        assert.equal(w.document.getElementById('wsHeader').textContent, 'Workspace Notes — ws');
        for (const btn of [...w.document.querySelectorAll('button')]) { btn.click(); }
        const types = posted.map((m) => m.type);
        for (const gone of ['changeFile', 'createNotesFile']) { assert.equal(types.includes(gone), false, `never posts ${gone}`); }
        assert.doesNotMatch(media('sidebarNotes', 'workspace', 'main.js'), /changeFile|createNotesFile|hasFile/);

        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', content: '', filePath: null, workspaceName: '', hasWorkspace: false } }));
        assert.equal(w.document.getElementById('noWorkspace').style.display, 'flex');
        assert.deepEqual(['headerBar', 'content', 'statusBar'].map((id) => w.document.getElementById(id).style.display), ['none', 'none', 'none']);
    });
});
