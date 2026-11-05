/**
 * The NOTES panels' toolbars (media/sidebarNotes/{tomNotepad,workspace,questNotes}/).
 *
 *   NPB-1 every panel has Open in MD Browser and Open in MD Viewer, posting openInMdBrowser /
 *         openInMdViewer; Preview Markdown and Open in Editor stay (VS CODE NOTES also Copy and Clear)
 *   NPB-2 no panel has the template dropdown, Prompt Preview or Send to Copilot, and none posts
 *         selectTemplate, previewPrompt or sendToCopilot
 *   NPB-3 a state without templates renders: the file name and the text show
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
    workspace: { type: 'state', content: 'hello', filePath: '/ws/notes.md', workspaceName: 'ws', hasWorkspace: true, hasFile: true },
    questNotes: { type: 'state', content: 'hello', filePath: '/ws/_ai/quests/q/quest-notes.q.md', hasWorkspaceFile: true },
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
            assert.equal(w.document.querySelectorAll('select').length, 0);
            for (const btn of [...w.document.querySelectorAll('button')]) { btn.click(); }
            const types = posted.map((m) => m.type);
            for (const gone of ['selectTemplate', 'previewPrompt', 'sendToCopilot']) {
                assert.equal(types.includes(gone), false, `never posts ${gone}`);
            }
        });

        test(`NPB-3: ${panel} renders a state without templates`, (t) => {
            const { w } = setup(t, panel);
            assert.equal(w.document.getElementById('content').value, 'hello');
            const nameId = panel === 'tomNotepad' ? 'notesFileName' : 'fileName';
            assert.match(w.document.getElementById(nameId).textContent, /\.md$/);
        });
    }
});
