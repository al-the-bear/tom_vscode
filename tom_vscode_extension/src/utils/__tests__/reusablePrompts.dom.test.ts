/**
 * The pages of the saved prompts, each in a JSDOM running its real script: the Reusable Prompt Editor
 * (media/reusablePromptEditor/) and the @CHAT action bar's reusable prompt controls (media/chatPanel/main.js).
 * Saved prompts are the active quest's only, so neither page has a scope to choose.
 *
 *   RD-1 the editor has no scope and no sub-scope selector; `data` draws the quest's files and names the quest in
 *        the headline; a click loads the file; no message carries a scope
 *   RD-2 the editor's buttons: add, rename, delete, Up / Down, preview and open post their message with the file
 *        only; rename, delete, Up / Down, preview and open are off without a selection; `files` selects and loads
 *        a new file, `fileRenamed` follows the new name, `fileDeleted` clears the editor, `filesReordered` redraws
 *        only the list (the text being edited stays)
 *   RD-3 the editor without a quest: the reason is shown, the list and editor are hidden, add is off, and a click
 *        posts nothing
 *   RD-4 the @CHAT action bar has no type dropdown and no scope dropdown; its file dropdown is filled from the
 *        host's list (labels as text, never as markup) and keeps the selection while the file is there
 *   RD-5 the @CHAT buttons address the selected prompt by its file name; saving posts the text without a selection;
 *        the copy button puts the loaded content before the tab's text; the file field asks the host for the list
 *        again before its picker opens
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const MEDIA = join(__dirname, '..', '..', '..', 'media');
const asset = (...parts: string[]): string => readFileSync(join(MEDIA, ...parts), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
type Posted = Array<Record<string, unknown>>;
type T = { after(fn: () => void): void };

const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const file = (name: string) => ({ id: name, label: name });

/** The Reusable Prompt Editor's page with a recording host. */
function editor(t: T): { w: Win; posted: Posted; states: Array<Record<string, unknown>>; $: (id: string) => Win; items: () => string[] } {
    const body = asset('reusablePromptEditor', 'index.html').split(/<body[^>]*>/)[1].split('<script')[0];
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Posted = [];
    const states: Array<Record<string, unknown>> = [];
    w.__INIT__ = {};
    w.confirm = () => true;
    w.acquireVsCodeApi = () => ({
        postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
        getState: () => undefined,
        setState: (s: Record<string, unknown>) => { states.push(JSON.parse(JSON.stringify(s))); },
    });
    w.eval(asset('reusablePromptEditor', 'main.js'));
    const $ = (id: string): Win => w.document.getElementById(id);
    const items = (): string[] => Array.from(w.document.querySelectorAll('#fileList .item') as Win[]).map((e: Win) => String(e.textContent));
    return { w, posted, states, $, items };
}

/** The chat panel's page with a recording host. */
function chat(t: T): { w: Win; posted: Posted; $: (id: string) => Win; click: (action: string) => void } {
    const html = asset('chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Posted = [];
    w.acquireVsCodeApi = () => ({
        postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
        setState: () => undefined,
        getState: () => ({ expanded: ['anthropic'], pinned: [] }),
    });
    w.__INIT__ = {};
    w.eval(asset('chatPanel', 'main.js'));
    const $ = (id: string): Win => w.document.getElementById(id);
    const click = (action: string): void => w.document.querySelector(`[data-action="${action}"]`).click();
    return { w, posted, $, click };
}
const optionsOf = (sel: Win): Array<[string, string]> => Array.from(sel.options as Win[]).map((o: Win) => [String(o.value), String(o.textContent)]);
const noScope = (posted: Posted): void => {
    for (const m of posted) {
        assert.ok(!('scope' in m) && !('subScopeId' in m) && !('selection' in m), `no scope in ${JSON.stringify(m)}`);
    }
};

describe('saved prompts: the pages', () => {
    test('RD-1: the editor lists the quest\'s files, without a scope', (t) => {
        const { w, posted, states, $, items } = editor(t);
        assert.equal($('scopeSelect'), null);
        assert.equal($('subScopeSelect'), null);
        assert.equal(w.document.querySelectorAll('select').length, 0, 'no selector at all');
        assert.deepEqual(posted, [{ type: 'ready' }]);
        send(w, { type: 'data', quest: 'q1', noQuestMessage: '', files: [file('a.prompt.md'), file('b.prompt.md')], initialFileId: '' });
        assert.equal($('panelHeadline').textContent, 'q1 — Reusable Prompt Editor');
        assert.deepEqual(items(), ['a.prompt.md', 'b.prompt.md']);
        assert.equal($('noQuest').style.display, 'none');
        assert.equal($('mainArea').style.display, '');
        posted.length = 0;
        w.document.querySelectorAll('#fileList .item')[1].click();
        assert.deepEqual(posted, [{ type: 'loadFile', fileId: 'b.prompt.md' }]);
        assert.deepEqual(states.at(-1), { fileId: 'b.prompt.md' }, 'the restored state is the file alone');
        send(w, { type: 'fileContent', fileId: 'b.prompt.md', content: 'text <b>' });
        assert.equal($('contentEditor').value, 'text <b>');
        // A pre-selected file is loaded with the list.
        posted.length = 0;
        send(w, { type: 'data', quest: 'q1', files: [file('a.prompt.md'), file('b.prompt.md')], initialFileId: 'a.prompt.md' });
        assert.deepEqual(posted, [{ type: 'loadFile', fileId: 'a.prompt.md' }]);
        assert.equal(w.document.querySelector('#fileList .item.selected').textContent, 'a.prompt.md');
        // The host asks for a file: the page asks for the list with it.
        posted.length = 0;
        send(w, { type: 'selectFile', fileId: 'b.prompt.md', scope: 'global', subScopeId: 'global' });
        assert.deepEqual(posted, [{ type: 'requestData', fileId: 'b.prompt.md' }]);
        noScope(posted);
    });

    test('RD-2: the editor\'s buttons', (t) => {
        const { w, posted, $, items } = editor(t);
        const files = [file('a.prompt.md'), file('b.prompt.md'), file('c.prompt.md')];
        send(w, { type: 'data', quest: 'q1', files, initialFileId: '' });
        const off = (id: string): boolean => $(id).disabled === true;
        assert.deepEqual(['btnAdd', 'btnRename', 'btnDelete', 'btnMoveUp', 'btnMoveDown', 'btnPreview', 'btnOpen'].map(off), [false, true, true, true, true, true, true], 'no selection: only add');
        posted.length = 0;
        for (const id of ['btnRename', 'btnDelete', 'btnMoveUp', 'btnMoveDown', 'btnPreview', 'btnOpen']) { $(id).click(); }
        assert.deepEqual(posted, [], 'nothing without a selection');

        w.document.querySelectorAll('#fileList .item')[2].click();
        send(w, { type: 'fileContent', fileId: 'c.prompt.md', content: 'c text' });
        assert.deepEqual(['btnRename', 'btnDelete', 'btnMoveUp', 'btnMoveDown', 'btnPreview', 'btnOpen'].map(off), [false, false, false, true, false, false], 'the last entry: no down');
        posted.length = 0;
        for (const id of ['btnAdd', 'btnRename', 'btnDelete', 'btnMoveUp', 'btnPreview', 'btnOpen']) { $(id).click(); }
        $('contentEditor').value = 'edited';
        $('btnSave').click();
        assert.deepEqual(posted, [
            { type: 'add' },
            { type: 'rename', fileId: 'c.prompt.md' },
            { type: 'delete', fileId: 'c.prompt.md' },
            { type: 'move', fileId: 'c.prompt.md', direction: 'up' },
            { type: 'openInPreview', fileId: 'c.prompt.md' },
            { type: 'openInVsCode', fileId: 'c.prompt.md' },
            { type: 'save', fileId: 'c.prompt.md', content: 'edited' },
        ]);
        noScope(posted);

        // Reordered: only the list; the text stays.
        $('contentEditor').value = 'typed, not saved';
        send(w, { type: 'filesReordered', files: [files[0], files[2], files[1]] });
        assert.deepEqual(items(), ['a.prompt.md', 'c.prompt.md', 'b.prompt.md']);
        assert.equal($('contentEditor').value, 'typed, not saved');
        assert.ok(!off('btnMoveUp') && !off('btnMoveDown'), 'the buttons follow the new place');

        // Renamed: the selection follows the new name and is loaded.
        posted.length = 0;
        send(w, { type: 'fileRenamed', fileId: 'c.prompt.md', newFileId: 'z.prompt.md', files: [files[0], file('z.prompt.md'), files[1]] });
        assert.deepEqual(items(), ['a.prompt.md', 'z.prompt.md', 'b.prompt.md']);
        assert.equal(w.document.querySelector('#fileList .item.selected').textContent, 'z.prompt.md');
        assert.deepEqual(posted, [{ type: 'loadFile', fileId: 'z.prompt.md' }]);

        // Added: the new file is selected and loaded.
        posted.length = 0;
        send(w, { type: 'files', files: [files[0], file('z.prompt.md'), files[1], file('new.prompt.md')], selectFileId: 'new.prompt.md' });
        assert.equal(w.document.querySelector('#fileList .item.selected').textContent, 'new.prompt.md');
        assert.deepEqual(posted, [{ type: 'loadFile', fileId: 'new.prompt.md' }]);
        send(w, { type: 'fileContent', fileId: 'new.prompt.md', content: '# new' });
        assert.equal($('contentEditor').value, '# new');
        send(w, { type: 'fileContent', fileId: 'a.prompt.md', content: 'late answer for another file' });
        assert.equal($('contentEditor').value, '# new', 'a content for another file is not shown');

        // Deleted: the list, then the editor is cleared.
        send(w, { type: 'files', files: [files[0], file('z.prompt.md'), files[1]] });
        send(w, { type: 'fileDeleted', fileId: 'new.prompt.md' });
        assert.deepEqual(items(), ['a.prompt.md', 'z.prompt.md', 'b.prompt.md']);
        assert.equal($('contentEditor'), null);
        assert.match($('editorArea').textContent, /Select a prompt file/);
        assert.equal($('saveBar').style.display, 'none');
        assert.ok(off('btnRename') && off('btnDelete') && off('btnMoveUp'), 'no selection again');
    });

    test('RD-3: the editor without a quest', (t) => {
        const { w, posted, $, items } = editor(t);
        send(w, { type: 'data', quest: '', noQuestMessage: 'This window has no quest: saved prompts are a quest\'s.', files: [file('never.prompt.md')], initialFileId: 'never.prompt.md' });
        assert.equal($('panelHeadline').textContent, 'Reusable Prompt Editor');
        assert.equal($('noQuest').textContent, 'This window has no quest: saved prompts are a quest\'s.');
        assert.equal($('noQuest').style.display, '');
        assert.equal($('mainArea').style.display, 'none');
        assert.deepEqual(items(), [], 'files are not drawn without a quest');
        for (const id of ['btnAdd', 'btnRename', 'btnDelete', 'btnMoveUp', 'btnMoveDown', 'btnPreview', 'btnOpen']) {
            assert.equal($(id).disabled, true, id);
        }
        posted.length = 0;
        for (const id of ['btnAdd', 'btnRename', 'btnDelete', 'btnMoveUp', 'btnMoveDown', 'btnPreview', 'btnOpen', 'btnSave']) { $(id).click(); }
        assert.deepEqual(posted, []);
    });

    test('RD-4: the @CHAT action bar has only the file dropdown', (t) => {
        const { w, posted, $ } = chat(t);
        assert.equal($('anthropic-reusable-type'), null, 'no type dropdown');
        assert.equal($('anthropic-reusable-scope'), null, 'no scope dropdown');
        assert.equal($('anthropic-reusable-scope-label'), null);
        assert.equal(w.document.querySelectorAll('.reusable-prompt-type, .reusable-prompt-scope').length, 0);
        assert.doesNotMatch(asset('chatPanel', 'main.js'), /reusable-type|reusable-scope|preferredProjectId|preferredScanId|preferredQuestId/);
        assert.doesNotMatch(asset('chatPanel', 'style.css'), /reusable-prompt-(type|scope)/);
        const sel = $('anthropic-reusable-file');
        assert.ok(sel, 'the file dropdown');
        assert.deepEqual(optionsOf(sel), [['', '(File)']]);
        assert.ok(posted.some((m) => m.type === 'getReusablePrompts'), 'the page asks for the list');

        send(w, { type: 'reusablePrompts', quest: 'q1', files: [file('b.prompt.md'), { id: 'a.prompt.md', label: '<i>a</i>' }] });
        assert.deepEqual(optionsOf(sel), [['', '(File)'], ['b.prompt.md', 'b.prompt.md'], ['a.prompt.md', '<i>a</i>']], 'the host\'s list, in its order');
        assert.equal(sel.querySelector('i'), null, 'a label is text');
        assert.equal(sel.value, 'b.prompt.md', 'the first file is selected');
        assert.equal(sel.disabled, false);
        assert.equal($('anthropic-reusable-file-field').querySelector('.chat-field-label').textContent, 'Prompt file');

        // The selection is kept while the file is in the list, and falls back when it is gone.
        sel.value = 'a.prompt.md';
        sel.dispatchEvent(new w.Event('change'));
        send(w, { type: 'reusablePrompts', quest: 'q1', files: [file('c.prompt.md'), file('a.prompt.md')] });
        assert.equal(sel.value, 'a.prompt.md');
        send(w, { type: 'reusablePrompts', quest: 'q1', files: [file('c.prompt.md')] });
        assert.equal(sel.value, 'c.prompt.md');
        // A list in the shape of the scopes is no list.
        send(w, { type: 'reusablePrompts', model: { scopes: { quest: [{ id: 'q2', label: 'q2' }] }, files: { global: [file('g.prompt.md')], quest: { q2: [file('o.prompt.md')] } } }, preferredQuestId: 'q2' });
        assert.deepEqual(optionsOf(sel), [['', '(File)']]);
        assert.equal(sel.disabled, true, 'nothing to choose');
    });

    test('RD-5: the @CHAT buttons address the prompt by its file name', (t) => {
        const { w, posted, $, click } = chat(t);
        posted.splice(0);
        for (const action of ['sendReusablePrompt', 'copyReusablePrompt', 'openReusablePrompt', 'previewReusablePrompt', 'openReusablePromptExternal']) { click(action); }
        assert.deepEqual([...posted], [], 'nothing without a file');

        send(w, { type: 'reusablePrompts', quest: 'q1', files: [file('a.prompt.md'), file('b.prompt.md')] });
        const sel = $('anthropic-reusable-file');
        sel.value = 'b.prompt.md';
        sel.dispatchEvent(new w.Event('change'));
        $('anthropic-text').value = 'my text';
        posted.splice(0);
        for (const action of ['copyReusablePrompt', 'openReusablePrompt', 'previewReusablePrompt', 'openReusablePromptExternal', 'saveReusablePrompt']) { click(action); }
        assert.deepEqual([...posted], [
            { type: 'loadReusablePromptContent', reusableId: 'b.prompt.md' },
            { type: 'openReusablePromptInEditor', section: 'anthropic', reusableId: 'b.prompt.md' },
            { type: 'openReusablePromptInOverlay', reusableId: 'b.prompt.md' },
            { type: 'openReusablePromptInExternalApp', reusableId: 'b.prompt.md' },
            { type: 'saveReusablePrompt', section: 'anthropic', text: 'my text' },
        ]);
        posted.splice(0);
        click('sendReusablePrompt');
        const sent = posted.filter((m) => m.type === 'sendReusablePrompt');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].reusableId, 'b.prompt.md');
        assert.equal(sent[0].section, 'anthropic');

        // Copy: the loaded content goes before the tab's text.
        click('copyReusablePrompt');
        send(w, { type: 'reusablePromptContent', reusableId: 'b.prompt.md', content: 'saved prompt' });
        assert.equal($('anthropic-text').value, 'saved prompt\n\nmy text');

        // The file field: the list again first, then the picker over the fresh options.
        posted.splice(0);
        $('anthropic-reusable-file-field').querySelector('a').click();
        assert.equal(posted.length, 1);
        assert.equal(posted[0].type, 'refreshChoices');
        send(w, { type: 'reusablePrompts', quest: 'q1', files: [file('a.prompt.md'), file('b.prompt.md'), file('new.prompt.md')] });
        send(w, { type: 'choicesRefreshed', requestId: posted[0].requestId });
        const pick = posted.find((m) => m.type === 'pickFromSelect') as { items: Array<{ value: string }>; current: string };
        assert.deepEqual(pick.items.map((i) => i.value), ['', 'a.prompt.md', 'b.prompt.md', 'new.prompt.md']);
        assert.equal(pick.current, 'b.prompt.md');
    });
});
