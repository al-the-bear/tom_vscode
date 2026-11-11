/**
 * The Prompt Queue editor and process runs (vscimpb45; media/queueEditor, media/shared/queueEntryRenderFunctions.js).
 *
 *   QR-1 every item shows the run it belongs to: `[run <run>]` (its own `run`, else its Proceed's, else `default`,
 *        muted); a chat send shows none
 *   QR-2 the run filter offers All runs and every run (the quest's and any an item names, `default` first, the
 *        window's marked); a run shows only its items (chat sends only under All runs); the choice is kept in the
 *        view state
 *   QR-3 Group by run puts the items under a heading per run (`default` first, by name, chat sends last), each
 *        with its count, in their order inside a group
 *   QR-4 the add form's run picker: the quest's runs, the window's chosen by default; Add sends the run picked;
 *        the host passes it to enqueue (an unknown one refused) and puts the runs and the window's run into the state
 *   QR-5 Queue per run (vscimpb46): the checkbox shows the setting and sends it; with it on, the lane strip has a
 *        row per lane — sending / pending, `held` — and Pause / Resume, which send the run's hold; off: no strip
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[], saved: Record<string, unknown> = {}, extraState: Record<string, unknown> = {}): { w: Win; posted: Win[]; state: () => Record<string, unknown> } {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    let viewState: Record<string, unknown> = { ...saved };
    w.acquireVsCodeApi = () => ({
        postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))),
        setState: (s: Record<string, unknown>) => { viewState = JSON.parse(JSON.stringify(s)); },
        getState: () => viewState,
    });
    w.__INIT__ = {
        state: { items, autoSend: false, processRuns: ['default', 'chg1', 'chg2'], currentRun: 'chg1', ...extraState },
        queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
        addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
    };
    w.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { w, posted, state: () => viewState };
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-11T10:00:00.000Z', status: 'pending' };
const ITEMS = [
    { ...base, id: 'a', originalText: 'a', expandedText: 'a', run: 'chg2' },
    { ...base, id: 'b', originalText: 'b', expandedText: 'b', run: 'default' },
    { ...base, id: 'c', originalText: 'c', expandedText: 'c', run: 'chg1' },
    { ...base, id: 'd', originalText: 'd', expandedText: 'd', processRun: { quest: 'q', state: {}, run: 'chg2' } },
    { ...base, id: 'e', originalText: 'e', expandedText: 'e' },
    { ...base, id: 'f', status: 'chat', originalText: 'chat', expandedText: 'chat', session: 'chat' },
];
/** What the select's / checkbox's inline handler calls (JSDOM's outside-only scripts run no inline handlers). */
const pick = (w: Win, id: string, value: string | boolean): void => {
    const el = w.document.getElementById(id);
    if (typeof value === 'boolean') { el.checked = value; w.setGroupByRun(el.checked); } else { el.value = value; w.setRunFilter(el.value); }
};

describe('Prompt Queue editor — process runs', () => {
    test('QR-1: the run badge', (t) => {
        const { w } = setup(t, ITEMS);
        const badges = [...w.document.querySelectorAll('#queueList .run-badge')].map((b: Win) => b.textContent);
        assert.deepEqual(badges.sort(), ['[run chg1]', '[run chg2]', '[run chg2]', '[run default]', '[run default]'], 'every item but the chat send');
        assert.ok([...w.document.querySelectorAll('#queueList .run-badge.default-run')].length === 2, 'default muted');
    });

    test('QR-2: the run filter', (t) => {
        const { w, state } = setup(t, ITEMS);
        const filter = w.document.getElementById('runFilter');
        assert.deepEqual([...filter.options].map((o: Win) => o.textContent), ['All runs', 'default', 'chg1 (this window\'s)', 'chg2']);
        const count = (): number => w.document.querySelectorAll('#queueList .run-badge').length;
        const chats = (): number => w.document.querySelectorAll('#queueList .chat-badge').length;
        assert.deepEqual([count(), chats()], [5, 1], 'all runs: every item and the chat send');
        assert.match(w.document.querySelector('[onchange="setRunFilter(this.value)"]').id, /runFilter/, 'the select calls it');
        pick(w, 'runFilter', 'chg2');
        assert.deepEqual([...w.document.querySelectorAll('#queueList .run-badge')].map((b: Win) => b.textContent), ['[run chg2]', '[run chg2]']);
        assert.equal(chats(), 0, 'a chat send is outside the runs');
        assert.equal(state().runFilter, 'chg2', 'kept in the view state');
        pick(w, 'runFilter', 'default');
        assert.equal(count(), 2, 'its own run and none');
    });

    test('QR-3: Group by run', (t) => {
        const { w, state } = setup(t, ITEMS);
        assert.equal(w.document.querySelector('[onchange="setGroupByRun(this.checked)"]').id, 'groupByRun', 'the checkbox calls it');
        pick(w, 'groupByRun', true);
        assert.equal(state().groupByRun, true);
        const heads = [...w.document.querySelectorAll('#queueList .run-group-head')].map((h: Win) => h.textContent.replace(/\s+/g, ' ').trim());
        assert.deepEqual(heads, ['Run default (2)', 'Run chg1 (this window\'s) (1)', 'Run chg2 (2)', 'Chat sends (1)']);
        const order = [...w.document.querySelectorAll('#queueList .run-group-head, #queueList .run-badge, #queueList .chat-badge')]
            .map((e: Win) => e.classList.contains('run-group-head') ? 'H' : e.textContent);
        assert.deepEqual(order, ['H', '[run default]', '[run default]', 'H', '[run chg1]', 'H', '[run chg2]', '[run chg2]', 'H', 'CHAT']);
    });

    test('QR-4: the add form\'s run, and the host', (t) => {
        const { w, posted } = setup(t, ITEMS);
        const sel = w.document.getElementById('addRun');
        assert.deepEqual([...sel.options].map((o: Win) => [o.value, o.selected]), [['default', false], ['chg1', true], ['chg2', false]], 'the window\'s run by default');
        w.document.getElementById('addText').value = 'new prompt';
        w.addPrompt();
        assert.equal(posted.filter((m) => m.type === 'addPrompt').at(-1).run, 'chg1');
        sel.value = 'chg2';
        sel.dispatchEvent(new w.Event('change'));
        w.document.getElementById('addText').value = 'another';
        w.addPrompt();
        assert.equal(posted.filter((m) => m.type === 'addPrompt').at(-1).run, 'chg2');
        const host = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(host, /\.\.\.\(typeof msg\.run === 'string' && msg\.run \? \{ run: addFormRun\(msg\.run\) \} : \{\}\)/);
        assert.match(host, /throw new Error\(`The quest has no run "\$\{run\}"/);
        assert.match(host, /\.\.\.queueRunState\(\),/);
    });

    test('QR-5: Queue per run — the checkbox and the lane strip', (t) => {
        const off = setup(t, ITEMS);
        assert.equal(off.w.document.getElementById('queuePerRun').checked, false);
        assert.equal(off.w.document.getElementById('laneStrip').style.display, 'none', 'off: no strip');
        off.w.setQueuePerRun(true);
        assert.deepEqual(off.posted.filter((m) => m.type === 'setQueuePerRun').at(-1), { type: 'setQueuePerRun', value: true });
        const lanes = [
            { run: 'default', sending: 0, pending: 2, held: false },
            { run: 'chg1', sending: 1, pending: 0, held: false },
            { run: 'chg2', sending: 0, pending: 2, held: true },
        ];
        const { w, posted } = setup(t, ITEMS, {}, { queuePerRun: true, heldRuns: ['chg2'], lanes });
        assert.equal(w.document.getElementById('queuePerRun').checked, true);
        const rows = [...w.document.querySelectorAll('#laneStrip .lane')];
        assert.deepEqual(rows.map((r: Win) => r.textContent.replace(/\s+/g, ' ').trim()), [
            'default · 0 sending · 2 pending Pause',
            'chg1 (this window\'s) · 1 sending · 0 pending Pause',
            'chg2 · 0 sending · 2 pending · held Resume',
        ]);
        assert.deepEqual(rows.map((r: Win) => r.className), ['lane lane-paused', 'lane lane-sending', 'lane lane-held']);
        rows[2].querySelector('button').click();
        assert.deepEqual(posted.filter((m) => m.type === 'setRunHeld').at(-1), { type: 'setRunHeld', run: 'chg2', held: false });
        rows[1].querySelector('button').click();
        assert.deepEqual(posted.filter((m) => m.type === 'setRunHeld').at(-1), { type: 'setRunHeld', run: 'chg1', held: true });
    });
});
