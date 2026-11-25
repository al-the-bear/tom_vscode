/**
 * The QUEST NOTES side panel's page (media/questNotesPanel/, vscimpb101) in a JSDOM, with the MD Browser's
 * scripts it loads for the View tab (marked, blocks.js, teamReview.js, main.js).
 *
 *   MQP-1 Edit and View tabs: switching shows one pane; the choice is kept in the webview state (merged with
 *         what the renderer keeps there) and a new page opens on it; arrow keys switch
 *   MQP-2 Edit saves after a pause in typing and on blur, once per change
 *   MQP-3 View renders the file with the MD Browser's renderer: headings with fold buttons, folding, links
 *         posted to the host; the writing controls are not shown
 *   MQP-4 a change on disk reloads the text area; with unsaved edits it asks: Load the file / Keep my text
 *   MQP-5 no quest open: the page says so and shows no tabs
 *   MQP-6 the picker shows the quest's notes files with the one shown selected; a change saves unsaved text and
 *         posts selectNotesFile; New notes file posts newNotesFile; another file's text replaces the text shown
 *         without asking; while the conflict bar asks, the picker and the New button wait
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { transformMarkdown } from '../markdownHeadings.js';

const ROOT = join(__dirname, '..', '..', '..');
const media = (file: string): string => readFileSync(join(ROOT, 'media', file), 'utf-8');
const MARKED = readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = Record<string, any>;

interface Page { w: Win; posted: Msg[]; state: () => Msg; send(m: Msg): void; el(id: string): Win; of(type: string): Msg[] }

function setup(initialState?: Msg): Page {
    const html = media('questNotesPanel/index.html');
    const body = html.split(/<body[^>]*>/)[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const bodyClass = /<body class="([^"]*)"/.exec(html)![1];
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${media('questNotesPanel/style.css')}</style></head><body class="${bodyClass}">${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as Win;
    const posted: Msg[] = [];
    let state: Msg | undefined = initialState;
    let acquired = 0;
    w.acquireVsCodeApi = () => {
        acquired++;
        assert.equal(acquired, 1, 'the API is acquired once');
        return { postMessage: (m: Msg) => posted.push(m), getState: () => state, setState: (s: Msg) => { state = s; } };
    };
    // The page's script first (it publishes the API), then what it loads from __INIT__.scripts in the webview.
    w.eval(media('questNotesPanel/main.js'));
    w.eval(MARKED);
    for (const f of ['shared/mdOverlay.js', 'shared/mdQuestions.js', 'markdownBrowser/blocks.js', 'markdownBrowser/teamReview.js', 'markdownBrowser/main.js']) { w.eval(media(f)); }
    return {
        w, posted,
        state: () => state ?? {},
        send: (m) => w.dispatchEvent(new w.MessageEvent('message', { data: m })),
        el: (id) => w.document.getElementById(id),
        of: (type) => posted.filter((m) => m.type === type),
    };
}
const NOTES = '/ws/_ai/quests/q1/notes/quest-notes.md';
const FILES = [{ name: 'quest-notes.md', isDefault: true }, { name: 'Alpha.md', isDefault: false }, { name: 'zeta.md', isDefault: false }];
const notes = (p: Page, content: string, extra: Msg = {}): void => p.send({ type: 'notesState', hasQuest: true, questId: 'q1', filePath: NOTES, relativePath: '_ai/quests/q1/notes/quest-notes.md', content, notesFiles: FILES, notesFile: 'quest-notes.md', ...extra });
const view = (p: Page, content: string): void => p.send({ type: 'mdContent', content: transformMarkdown(content), filePath: NOTES, relativePath: '_ai/quests/q1/notes/quest-notes.md', fileName: 'quest-notes.md', crlf: false });
const type = (p: Page, value: string): void => { const t = p.el('notesText'); t.value = value; t.dispatchEvent(new p.w.Event('input')); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('QUEST NOTES side panel (page)', () => {
    test('MQP-1: tabs', () => {
        const p = setup();
        assert.deepEqual(p.of('ready').length, 1);
        notes(p, '# Notes\n');
        assert.deepEqual([p.el('editPane').hidden, p.el('viewPane').hidden], [false, true], 'Edit first');
        assert.equal(p.el('qnpFile').textContent, '_ai/quests/q1/notes/quest-notes.md');
        p.el('tabView').click();
        assert.deepEqual([p.el('editPane').hidden, p.el('viewPane').hidden], [true, false]);
        assert.equal(p.el('tabView').getAttribute('aria-selected'), 'true');
        assert.equal(p.state().qnpTab, 'view');
        view(p, '# Notes\n');
        assert.equal(p.state().qnpTab, 'view', 'the renderer\'s own state is merged in');
        assert.equal(p.state().filePath, NOTES);
        p.el('tabView').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
        assert.equal(p.state().qnpTab, 'edit');

        const again = setup({ qnpTab: 'view' });
        notes(again, '# Notes\n');
        assert.deepEqual([again.el('editPane').hidden, again.el('viewPane').hidden], [true, false], 'opens on the last tab used');
    });

    test('MQP-2: Edit saves', async () => {
        const p = setup();
        notes(p, 'a');
        type(p, 'ab');
        assert.equal(p.of('save').length, 0, 'not on every keystroke');
        assert.match(p.el('qnpStatus').textContent, /unsaved/);
        await sleep(650);
        assert.deepEqual(p.of('save').map((m) => m.content), ['ab']);
        assert.doesNotMatch(p.el('qnpStatus').textContent, /unsaved/);
        type(p, 'abc');
        p.el('notesText').dispatchEvent(new p.w.Event('blur'));
        assert.deepEqual(p.of('save').map((m) => m.content), ['ab', 'abc'], 'blur saves at once');
        await sleep(650);
        assert.equal(p.of('save').length, 2, 'once per change');
        p.el('openEditorBtn').click();
        assert.equal(p.of('openInEditor').length, 1, 'the editor button');
    });

    test('MQP-3: View renders with the MD Browser\'s renderer', () => {
        const p = setup();
        notes(p, '');
        p.el('tabView').click();
        view(p, '# Notes\n\nsee [the overview](overview.q1.md)\n\n## Today\n\ntoday text\n\n## Later\n\nlater text\n\n> **❓ Q-1 — scope:** which?\n> - (a) this\n>\n> **Answer:**\n');
        const area = p.el('contentArea');
        assert.ok([...area.querySelectorAll('h1, h2')].map((h: Win) => h.textContent.trim()).includes('Today'));
        assert.equal(area.querySelectorAll('.mdb-fold-btn').length, 3);
        [...area.querySelectorAll('h2')].find((h: Win) => h.textContent.trim() === 'Today').querySelector('.mdb-fold-btn').click();
        assert.ok(area.querySelector('.mdb-folded-away'), 'folding works');
        area.querySelector('a[href="overview.q1.md"]').click();
        assert.deepEqual(p.of('navigateLink').map((m) => m.href), ['overview.q1.md']);
        const answer = area.querySelector('.mdb-answer-btn');
        assert.ok(answer, 'the question is decorated');
        assert.equal(p.w.getComputedStyle(answer).display, 'none', 'no answer button: read-only');
        assert.equal(p.w.getComputedStyle(area.querySelector('.mdb-fold-btn')).display !== 'none', true);
    });

    test('MQP-4: a change on disk', () => {
        const p = setup();
        notes(p, 'one');
        notes(p, 'two', { external: true });
        assert.equal(p.el('notesText').value, 'two', 'no unsaved edits: reloaded');
        assert.equal(p.el('conflictBar').hidden, true);

        type(p, 'two, mine');
        notes(p, 'three', { external: true });
        assert.equal(p.el('notesText').value, 'two, mine', 'unsaved edits stay');
        assert.equal(p.el('conflictBar').hidden, false, 'it asks');
        p.el('loadDiskBtn').click();
        assert.equal(p.el('notesText').value, 'three');
        assert.equal(p.el('conflictBar').hidden, true);

        type(p, 'three, mine');
        notes(p, 'four', { external: true });
        assert.equal(p.of('save').length, 0, 'nothing saved while it asks');
        p.el('keepMineBtn').click();
        assert.deepEqual(p.of('save').map((m) => m.content), ['three, mine'], 'my text written over the file');
        assert.equal(p.el('conflictBar').hidden, true);
        notes(p, 'three, mine');
        assert.equal(p.el('notesText').value, 'three, mine');
    });

    test('MQP-5: no quest open', () => {
        const p = setup();
        p.send({ type: 'notesState', hasQuest: false, questId: '', filePath: '', relativePath: '', content: '' });
        assert.equal(p.el('qnpEmpty').hidden, false);
        assert.deepEqual([p.el('editPane').hidden, p.el('viewPane').hidden, p.w.document.querySelector('.qnp-bar').hidden], [true, true, true]);
    });

    test('MQP-6: the picker of notes files', () => {
        const p = setup();
        notes(p, 'default text');
        const select = p.el('notesFileSelect');
        const pick = (name: string): void => { select.value = name; select.dispatchEvent(new p.w.Event('change')); };
        // The page's messages as plain objects of this realm.
        const sent = (): Msg[] => JSON.parse(JSON.stringify(p.posted));
        assert.deepEqual([...select.options].map((o: Win) => o.value), ['quest-notes.md', 'Alpha.md', 'zeta.md']);
        assert.equal(select.value, 'quest-notes.md');
        assert.equal(select.closest('.qnp-bar') !== null, true, 'in the view\'s bar');

        p.posted.length = 0;
        pick('zeta.md');
        assert.deepEqual(sent(), [{ type: 'selectNotesFile', name: 'zeta.md' }], 'nothing to save: the switch alone');

        // The host answers with the other file: its text is shown, without asking.
        const ZETA = '/ws/_ai/quests/q1/notes/zeta.md';
        notes(p, 'zeta text', { filePath: ZETA, relativePath: '_ai/quests/q1/notes/zeta.md', notesFile: 'zeta.md' });
        assert.deepEqual([p.el('notesText').value, select.value, p.el('conflictBar').hidden, p.el('qnpFile').textContent], ['zeta text', 'zeta.md', true, '_ai/quests/q1/notes/zeta.md']);

        // Unsaved text is saved to the file shown before the switch is asked for.
        p.posted.length = 0;
        type(p, 'zeta text, mine');
        pick('Alpha.md');
        assert.deepEqual(sent(), [{ type: 'save', content: 'zeta text, mine' }, { type: 'selectNotesFile', name: 'Alpha.md' }]);
        notes(p, 'alpha text', { filePath: '/ws/_ai/quests/q1/notes/Alpha.md', notesFile: 'Alpha.md' });
        assert.equal(p.el('notesText').value, 'alpha text');

        p.posted.length = 0;
        assert.equal(p.el('newNotesFileBtn').title, 'New notes file');
        type(p, 'alpha text, mine');
        p.el('newNotesFileBtn').click();
        assert.deepEqual(sent(), [{ type: 'save', content: 'alpha text, mine' }, { type: 'newNotesFile' }]);
        notes(p, '# Fresh\n', { filePath: '/ws/_ai/quests/q1/notes/Fresh.md', notesFile: 'Fresh.md', notesFiles: [...FILES, { name: 'Fresh.md', isDefault: false }] });
        assert.deepEqual([[...select.options].map((o: Win) => o.value), select.value, p.el('notesText').value], [['quest-notes.md', 'Alpha.md', 'zeta.md', 'Fresh.md'], 'Fresh.md', '# Fresh\n']);

        // A change on disk of the file shown still asks; the picker and New wait for the answer.
        type(p, '# Fresh\n mine');
        notes(p, '# Fresh\n theirs', { filePath: '/ws/_ai/quests/q1/notes/Fresh.md', notesFile: 'Fresh.md', external: true });
        assert.deepEqual([p.el('conflictBar').hidden, select.disabled, p.el('newNotesFileBtn').disabled], [false, true, true]);
        p.el('loadDiskBtn').click();
        assert.deepEqual([p.el('conflictBar').hidden, select.disabled, p.el('newNotesFileBtn').disabled, p.el('notesText').value], [true, false, false, '# Fresh\n theirs']);
    });
});
