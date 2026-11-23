/**
 * The Prompt Queue editor's Move items to another run overlay (media/queueEditor/main.js) and the "Run default"
 * entry of an item's template select (media/shared/queueEntryRenderFunctions.js).
 *
 *   QM-1 the toolbar button opens an overlay over the queue with the tab's items only, each with a peek of its
 *        prompt; staged and pending items have a checkbox, a sending item and an item of a Proceed run are greyed
 *        with the reason; the target select offers the quest's other runs
 *   QM-2 Select all checks every movable item (and is indeterminate on a partial pick); Move posts
 *        `moveItemsToRun` with the picked ids and the target run and closes the overlay; Move is disabled while
 *        nothing is picked; Escape and Cancel close it without posting
 *   QM-3 a click on a peek opens it; the host handles `moveItemsToRun` by calling the manager's moveItemsToRun
 *   QM-4 the template select starts with "Run default (<the run's template>)", selected for an item whose template
 *        is "(Run default)"
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function readFrom(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[]): { w: Win; posted: Win[] } {
    const html = readFrom('media', 'queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    let viewState: Record<string, unknown> = {};
    w.acquireVsCodeApi = () => ({
        postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))),
        setState: (s: Record<string, unknown>) => { viewState = JSON.parse(JSON.stringify(s)); },
        getState: () => viewState,
    });
    w.__INIT__ = {
        state: {
            items, autoSend: false, processRuns: ['default', 'chg1', 'chg2'], currentRun: 'chg1',
            runQueueSettings: { chg1: { defaultMessageTemplateId: 'execute-todo' } },
        },
        queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
        addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
    };
    w.eval([
        readFrom('media', 'shared', 'queueEntryUtils.js'),
        readFrom('media', 'shared', 'queueEntryRenderFunctions.js'),
        readFrom('media', 'shared', 'queueEntryMessageHandlers.js'),
        readFrom('media', 'queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { w, posted };
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-11T10:00:00.000Z', status: 'pending', run: 'chg1' };
const ITEMS = [
    { ...base, id: 'a', originalText: 'First prompt\nwith a second line', expandedText: 'First prompt', template: '(Run default)', status: 'staged' },
    { ...base, id: 'b', originalText: 'Second prompt', expandedText: 'Second prompt', status: 'staged' },
    { ...base, id: 'c', originalText: 'Running', expandedText: 'Running', status: 'sending' },
    { ...base, id: 'd', originalText: 'Proceed', expandedText: 'Proceed', processRun: { run: 'chg1' } },
    { ...base, id: 'e', originalText: 'Other run', expandedText: 'Other run', run: 'chg2' },
];

describe('queue editor: move items to another run', () => {
    test('QM-1: the overlay lists the tab\'s items', (t) => {
        const { w } = setup(t, ITEMS);
        const btn = w.document.getElementById('moveItemsBtn');
        assert.ok(btn, 'the toolbar button');
        assert.equal(btn.getAttribute('onclick'), 'openMoveItemsOverlay()', 'it opens the overlay (inline handlers do not run in this harness)');
        w.openMoveItemsOverlay();
        const overlay = w.document.getElementById('moveItemsOverlay');
        assert.ok(overlay, 'the overlay opens');
        const boxes = [...overlay.querySelectorAll('input[data-move-id]')] as Win[];
        assert.deepEqual(boxes.map((b) => b.getAttribute('data-move-id')), ['a', 'b', 'c', 'd'], 'the tab\'s items only');
        assert.deepEqual(boxes.map((b) => b.disabled), [false, false, true, true]);
        assert.match(overlay.textContent, /only staged and pending items move/);
        assert.match(overlay.textContent, /belongs to a Proceed run/);
        assert.ok(overlay.querySelector('.move-item-peek').textContent.includes('with a second line'), 'the peek holds the prompt');
        assert.deepEqual([...w.document.getElementById('moveItemsTarget').options].map((o: Win) => o.value), ['default', 'chg2']);
    });

    test('QM-2: Select all, Move, Cancel', (t) => {
        const { w, posted } = setup(t, ITEMS);
        w.openMoveItemsOverlay();
        const go = w.document.getElementById('moveItemsGo');
        assert.equal(go.disabled, true, 'nothing picked');
        const all = w.document.getElementById('moveItemsAll');
        const first = w.document.querySelector('input[data-move-id="a"]');
        first.checked = true;
        first.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.equal(all.indeterminate, true);
        all.checked = true;
        all.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.equal(w.document.querySelector('input[data-move-id="b"]').checked, true);
        assert.equal(w.document.querySelector('input[data-move-id="c"]').checked, false, 'a disabled item is never picked');
        w.document.getElementById('moveItemsTarget').value = 'chg2';
        go.click();
        assert.deepEqual(posted.filter((m) => m.type === 'moveItemsToRun'), [{ type: 'moveItemsToRun', ids: ['a', 'b'], run: 'chg2' }]);
        assert.equal(w.document.getElementById('moveItemsOverlay'), null, 'closed');

        w.openMoveItemsOverlay();
        w.document.getElementById('moveItemsCancel').click();
        assert.equal(w.document.getElementById('moveItemsOverlay'), null);
        w.openMoveItemsOverlay();
        w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
        assert.equal(w.document.getElementById('moveItemsOverlay'), null);
        assert.equal(posted.filter((m) => m.type === 'moveItemsToRun').length, 1);
    });

    test('QM-3: the peek opens; the host calls the manager', (t) => {
        const { w } = setup(t, ITEMS);
        w.openMoveItemsOverlay();
        const peek = w.document.querySelector('.move-item-peek');
        peek.click();
        assert.equal(peek.classList.contains('open'), true);
        const host = readFrom('src', 'handlers', 'queueEditor-handler.ts');
        assert.match(host, /case 'moveItemsToRun':[\s\S]*?qm\.moveItemsToRun\(ids, msg\.run\)/);
    });

    test('QM-4: Run default in the template select', (t) => {
        const { w } = setup(t, ITEMS);
                const options = [...w.document.querySelectorAll('option[value="__run_default__"]')] as Win[];
        assert.ok(options.length >= 1, 'the template select offers Run default');
        assert.ok(options.every((o) => o.textContent === 'Run default (execute-todo)'), 'named after the run\'s template');
        const sel = options.find((o) => o.hasAttribute('selected'));
        assert.ok(sel, 'selected for item a, whose template is (Run default)');
        assert.match(sel.parentElement.getAttribute('onchange'), /updateItemTemplate\('a'/);
    });
});
