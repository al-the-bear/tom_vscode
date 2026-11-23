/**
 * The guideline picker (gsel5; media/shared/aspectPicker.js) and the places
 * that show it: the Prompt Queue editor (window, all windows, run info line,
 * items) and the todo panel (the todo editor's button, the row indicator).
 *
 *   AP-1 the resolver agrees with utils/aspectGuidelines.ts resolveAspects on every level up to the one edited
 *        (lowest wins, an unknown option skipped, Remove, the section default, nothing)
 *   AP-2 the view: per section the effective choice, its origin and this level's own entry; `own` when it chose
 *   AP-3 the summary and hover text (`Answer: brief · Night: on`, run choices starred); the button's dot only
 *        when its level chose; the list indicator only then, its details on hover
 *   AP-4 the popup: the title, one row per section with its effective choice and origin (✓ here / from window /
 *        default / nothing chosen); hovering a section opens its options with Don't add and Remove, this
 *        level's choice marked; Edit sections… at the bottom; without sections a hint
 *   AP-5 the popup's choices: an option, Don't add ('') and Remove ('remove') call onChoose and close it;
 *        Edit sections calls onEditSections; Escape and a click outside close it
 *   AP-6 the queue editor's toolbar: the window button (dot when the window chose), the all-windows button
 *        (broadcast, no dot), Set as / Clear quest default (Clear disabled without a quest default); the
 *        window and all-windows pickers post aspectChoose with their level; the quest buttons aspectQuestDefault
 *   AP-7 the run info line: the run's effective selection, the run's own starred; a click opens the run's picker
 *        and a choice posts level run with the tab's run
 *   AP-8 queue items: the list row shows only the indicator (an item with choices); the item's details hold the
 *        item-level button (disabled unless staged or pending) and the choices; its picker posts level item
 *   AP-9 the todo panel: the row indicator for a todo with choices; the detail form's button with the todo's
 *        own choices as text; its picker posts level todo with the todo's quest and id; a role change redraws it
 *   AP-10 the hosts: the queue editor's state carries `aspects` and routes the picker's messages; the todo panel
 *        answers qtGetAspects and writes a todo's choice; both pages load the component's script and style
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { resolveAspects, type AspectLevelChoices, type AspectSection } from '../aspectGuidelines.js';
import { aspectCatalogueOf } from '../aspectChoices.js';

const ROOT = join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const SECTIONS: AspectSection[] = [
    { id: 'answer', name: 'Answer mode', label: 'Answer', placement: 'system', defaultOption: 'brief', options: [{ name: 'brief', text: 'b' }, { name: 'full', text: 'f' }] },
    { id: 'night', name: 'Night mode', label: 'Night', placement: 'user', options: [{ name: 'on', text: 'on' }, { name: 'off', text: 'off' }] },
];
const CATALOGUE = aspectCatalogueOf(SECTIONS);

function component(t: { after(fn: () => void): void }): Win {
    const dom = new JSDOM('<body><button id="anchor">a</button></body>', { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    w.eval(read('media', 'shared', 'aspectPicker.js'));
    return w;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('guideline picker: the component', () => {
    test('AP-1: the resolver agrees with resolveAspects', (t) => {
        const w = component(t);
        const cases: AspectLevelChoices[] = [
            {},
            { questDefault: { night: 'on' } },
            { questDefault: { night: 'on' }, window: { answer: 'full' }, run: { night: 'remove' } },
            { window: { answer: 'full' }, item: { answer: 'nonsense' } },
            { role: { answer: 'remove' }, todo: { answer: 'brief', night: 'off' } },
            { roleType: { night: 'off' }, role: { night: 'on' } },
        ];
        for (const levels of cases) {
            const ts = resolveAspects(SECTIONS, levels).sections;
            for (const s of CATALOGUE.sections) {
                const js = w.TomAspectPicker.resolveSection(s, levels, 'todo');
                const want = ts.find((x) => x.section === s.id)!;
                assert.deepEqual({ option: js.option, removed: js.removed, from: js.from },
                    { option: want.option, removed: want.removed, from: want.from }, `${s.id} over ${JSON.stringify(levels)}`);
            }
        }
        // Only the levels up to the one edited count.
        const levels = { window: { answer: 'full' }, item: { answer: 'brief' } };
        assert.equal(w.TomAspectPicker.resolveSection(CATALOGUE.sections[0], levels, 'run').from, 'window');
        assert.equal(w.TomAspectPicker.resolveSection(CATALOGUE.sections[0], levels, 'item').from, 'item');
    });

    test('AP-2: the view', (t) => {
        const w = component(t);
        const v = w.TomAspectPicker.view(CATALOGUE, { questDefault: { night: 'on' }, window: { answer: 'full' }, run: { night: 'remove' } }, 'run');
        assert.equal(v.level, 'run');
        assert.equal(v.own, true);
        assert.deepEqual(JSON.parse(JSON.stringify(v.sections.map((s: Win) => ({ id: s.id, option: s.option, removed: s.removed, from: s.from, here: s.here })))), [
            { id: 'answer', option: 'full', removed: false, from: 'window' },
            { id: 'night', removed: true, from: 'run', here: 'remove' },
        ]);
        const win = w.TomAspectPicker.view(CATALOGUE, { questDefault: { night: 'on' } }, 'window');
        assert.equal(win.own, false);
        assert.deepEqual([win.sections[0].from, win.sections[1].from], ['sectionDefault', 'questDefault']);
        assert.deepEqual(JSON.parse(JSON.stringify(w.TomAspectPicker.view(null, {}, 'window'))), { level: 'window', sections: [], own: false });
    });

    test('AP-3: summary, hover text, button and indicator', (t) => {
        const w = component(t);
        const P = w.TomAspectPicker;
        const base = P.view(CATALOGUE, { questDefault: { night: 'on' } }, 'window');
        assert.equal(P.summary(base), 'Answer: brief \u00b7 Night: on');
        const run = P.view(CATALOGUE, { questDefault: { night: 'on' }, run: { answer: 'full' } }, 'run');
        assert.equal(P.summary(run, { star: true }), 'Answer: full* \u00b7 Night: on');
        assert.equal(P.summary(P.view({ sections: [CATALOGUE.sections[1]] }, {}, 'window')), 'nothing chosen');
        assert.equal(P.hoverText(run, 'Guidelines'), 'Guidelines: Answer: full \u00b7 Night: on\nChosen here: Answer: full\nWhere from: Answer: full (here) \u00b7 Night: on (quest)', 'each choice with where it comes from (gsel20)');

        const host = w.document.createElement('div');
        host.innerHTML = P.buttonHtml(run, { title: 'Guidelines of run x', attrs: Object.fromEntries([['data-aspect-open', 'run']]) });
        const btn = host.firstElementChild;
        assert.ok(btn.classList.contains('own'));
        assert.ok(btn.querySelector('.tom-aspect-dot'), 'a dot: the level chose');
        assert.equal(btn.getAttribute('data-aspect-open'), 'run');
        assert.match(btn.title, /^Guidelines of run x: Answer: full · Night: on/);
        host.innerHTML = P.buttonHtml(base, { title: 'Guidelines', icon: 'codicon-broadcast' });
        assert.equal(host.querySelector('.tom-aspect-dot'), null, 'no dot: nothing chosen here');
        assert.ok(host.querySelector('.codicon-broadcast'));

        assert.equal(P.indicatorHtml(base, 'Guidelines of this item'), '', 'no indicator without own choices');
        host.innerHTML = P.indicatorHtml(P.view(CATALOGUE, { item: { night: 'off' } }, 'item'), 'Guidelines of this item');
        assert.match(host.firstElementChild.title, /Guidelines of this item: Answer: brief · Night: off\nChosen here: Night: off/);
    });

    test('AP-4: the popup', (t) => {
        const w = component(t);
        const P = w.TomAspectPicker;
        const anchor = w.document.getElementById('anchor');
        const v = P.view(CATALOGUE, { questDefault: { night: 'on' }, window: { answer: 'full' }, run: { night: 'remove' } }, 'run');
        const popup = P.open(anchor, v, { title: 'Guidelines — run r1', onChoose: () => undefined });
        assert.equal(w.document.getElementById('tomAspectPopup'), popup);
        assert.equal(popup.querySelector('.tom-aspect-popup-title').textContent, 'Guidelines — run r1');
        const rows = [...popup.querySelectorAll('.tom-aspect-section')];
        assert.deepEqual(rows.map((r: Win) => r.querySelector('.tom-aspect-section-label').textContent), ['Answer', 'Night']);
        assert.deepEqual(rows.map((r: Win) => r.querySelector('.tom-aspect-section-value').textContent), ['full', 'removed']);
        assert.deepEqual(rows.map((r: Win) => r.querySelector('.tom-aspect-origin').textContent), ['from window', '\u2713 here']);
        assert.ok(rows[1].querySelector('.tom-aspect-origin').classList.contains('here'));
        assert.equal(rows[0].classList.contains('open'), false);
        rows[0].dispatchEvent(new w.MouseEvent('mouseenter'));
        assert.ok(rows[0].classList.contains('open'), 'hovering a section opens its options');
        const opts = [...rows[0].querySelectorAll('.tom-aspect-option')];
        assert.deepEqual(opts.map((o: Win) => o.querySelector('.tom-aspect-option-text').textContent), ['Don\'t add', 'brief', 'full', 'Remove']);
        assert.deepEqual(opts.map((o: Win) => o.getAttribute('data-value') ?? `choice:${o.getAttribute('data-choice')}`), ['', 'choice:brief', 'choice:full', 'remove']);
        assert.equal(opts[1].getAttribute('role'), 'menuitemcheckbox', 'the choices are checkboxes (gsel20)');
        assert.deepEqual(opts.map((o: Win) => o.classList.contains('mine')), [true, false, false, false], 'the run chose nothing for Answer: Don\'t add is marked');
        assert.ok(opts[2].classList.contains('effective'));
        rows[1].dispatchEvent(new w.MouseEvent('mouseenter'));
        assert.equal(rows[0].classList.contains('open'), false, 'one submenu at a time');
        const night = [...rows[1].querySelectorAll('.tom-aspect-option')];
        assert.deepEqual(night.map((o: Win) => o.classList.contains('mine')), [false, false, false, true], 'Remove is this level\'s choice');
        assert.equal(night[3].getAttribute('aria-checked'), 'true');
        assert.equal(popup.querySelector('.tom-aspect-edit').textContent, 'Edit aspects\u2026');
        assert.equal(popup.lastElementChild.className, 'tom-aspect-edit', 'Edit aspects sits at the bottom');

        const empty = P.open(anchor, P.view({ sections: [] }, {}, 'window'), { title: 'x', onChoose: () => undefined });
        assert.match(empty.querySelector('.tom-aspect-empty').textContent, /No guideline aspects/);
        assert.equal(w.document.querySelectorAll('.tom-aspect-popup').length, 1, 'opening one closes the other');
    });

    test('AP-5: the popup\'s choices', async (t) => {
        const w = component(t);
        const P = w.TomAspectPicker;
        const anchor = w.document.getElementById('anchor');
        const v = P.view(CATALOGUE, { window: { answer: 'full' } }, 'window');
        const chosen: Array<[string, string | string[]]> = [];
        let edits = 0;
        const open = (view: Win = v): Win => P.open(anchor, view, { title: 'w', onChoose: (s: string, val: string | string[]) => chosen.push([s, JSON.parse(JSON.stringify(val))]), onEditSections: () => { edits++; } });
        const choice = (popup: Win, section: string, name: string): Win => popup.querySelector(`.tom-aspect-option[data-section="${section}"][data-choice="${name}"]`);
        const radio = (popup: Win, section: string, value: string): Win => popup.querySelector(`.tom-aspect-option[data-section="${section}"][data-value="${value}"]`);
        // Choices are checkboxes (gsel20): a click writes this level's list and keeps the popup open.
        let popup = open();
        choice(popup, 'night', 'off').click();
        assert.ok(w.document.getElementById('tomAspectPopup'), 'a choice keeps it open');
        assert.equal(choice(popup, 'night', 'off').getAttribute('aria-checked'), 'true', 'redrawn checked');
        choice(popup, 'answer', 'brief').click();
        assert.deepEqual(chosen.splice(0), [['night', 'off'], ['answer', ['brief', 'full']]], 'several choices, in the aspect\'s order');
        choice(popup, 'answer', 'full').click();
        choice(popup, 'answer', 'brief').click();
        assert.deepEqual(chosen.splice(0), [['answer', 'brief'], ['answer', '']], 'unchecking the last: Don\'t add');
        // The replace / add switch: with choices on this level it rewrites them as added ones.
        choice(popup, 'answer', 'full').click();
        popup.querySelector('.tom-aspect-mode[data-section="answer"][data-mode="add"]').click();
        assert.deepEqual(chosen.splice(0), [['answer', 'full'], ['answer', ['+full']]]);
        assert.equal(popup.querySelector('.tom-aspect-mode[data-section="answer"][data-mode="add"]').classList.contains('active'), true);
        choice(popup, 'answer', 'brief').click();
        assert.deepEqual(chosen.splice(0), [['answer', ['+brief', '+full']]], 'a choice checked while adding is added');
        // Don't add and Remove close it.
        radio(popup, 'answer', '').click();
        assert.equal(w.document.getElementById('tomAspectPopup'), null, 'Don\'t add closes it');
        radio(open(), 'answer', 'remove').click();
        assert.deepEqual(chosen.splice(0), [['answer', ''], ['answer', 'remove']]);
        // An adding entry is shown with the switch on Add.
        popup = open(P.view(CATALOGUE, { window: { answer: ['+brief'] } }, 'window'));
        assert.equal(popup.querySelector('.tom-aspect-mode[data-section="answer"][data-mode="add"]').classList.contains('active'), true);
        P.close();
        open().querySelector('.tom-aspect-edit').click();
        assert.equal(edits, 1);
        assert.equal(w.document.getElementById('tomAspectPopup'), null);

        open();
        await flush();
        w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
        assert.equal(w.document.getElementById('tomAspectPopup'), null, 'Escape closes it');
        popup = open();
        await flush();
        popup.querySelector('.tom-aspect-section').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
        assert.ok(w.document.getElementById('tomAspectPopup'), 'a click inside keeps it');
        anchor.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
        assert.equal(w.document.getElementById('tomAspectPopup'), null, 'a click outside closes it');
    });
});

/* ---- The Prompt Queue editor ---------------------------------------------------- */

function editor(t: { after(fn: () => void): void }, state: Record<string, unknown>): { window: Win; posted: Array<Record<string, unknown>> } {
    const html = read('media', 'queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window as Win;
    t.after(() => window.close());
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push({ ...m }), setState: () => undefined, getState: () => undefined });
    window.__INIT__ = { state: { items: [], autoSend: false, context: { quest: 'q', role: '', activeProjects: [] }, ...state } };
    window.eval([read('media', 'shared', 'aspectPicker.js'), read('media', 'shared', 'queueEntryUtils.js'), read('media', 'shared', 'queueEntryRenderFunctions.js'),
        read('media', 'shared', 'queueEntryMessageHandlers.js'), read('media', 'queueEditor', 'main.js')].join('\n;\n'));
    return { window, posted };
}

const ASPECTS = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...CATALOGUE, questDefault: { night: 'on' }, roles: { reviewer: { role: { answer: 'full' } } }, ...extra,
});
const chosen = (posted: Array<Record<string, unknown>>): Array<Record<string, unknown>> => posted.filter((m) => m.type === 'aspectChoose' || m.type === 'aspectQuestDefault' || m.type === 'aspectWorkspaceDefault' || m.type === 'aspectEditSections');

describe('guideline picker: the Prompt Queue editor', () => {
    test('AP-6: the toolbar', (t) => {
        const { window, posted } = editor(t, { aspects: ASPECTS({ window: { answer: 'full' } }) });
        const doc = window.document;
        const slot = doc.getElementById('aspectToolbar');
        assert.ok(slot.parentElement.id === 'compactionPickers', 'right of the model dropdowns');
        const win = doc.getElementById('aspectWindowBtn');
        const all = doc.getElementById('aspectAllWindowsBtn');
        assert.ok(win.querySelector('.tom-aspect-dot'), 'the window chose: a dot');
        assert.match(win.title, /^Guidelines of this window: Answer: full · Night: on/);
        assert.ok(all.querySelector('.codicon-broadcast'));
        assert.equal(all.querySelector('.tom-aspect-dot'), null);
        // Composed icon buttons (gsel22): the quest's compass and the workspace's root folder with save, close and book.
        const icons = (id: string): string[] => [...doc.getElementById(id).querySelectorAll('.codicon')].map((e: Win) => e.className.replace('codicon codicon-', ''));
        assert.deepEqual(['aspectSetQuestDefault', 'aspectClearQuestDefault', 'aspectEditQuestDefault', 'aspectSetWorkspaceDefault', 'aspectClearWorkspaceDefault', 'aspectEditWorkspace'].map(icons),
            [['compass', 'save'], ['compass', 'close'], ['compass', 'book'], ['root-folder', 'save'], ['root-folder', 'close'], ['root-folder', 'book']]);
        assert.match(doc.getElementById('aspectSetQuestDefault').title, /^Set as quest default: /);
        assert.match(doc.getElementById('aspectSetWorkspaceDefault').title, /^Set as workspace default: .*workspace_aspects\.md/);
        assert.equal(doc.getElementById('aspectSetQuestDefault').textContent, '', 'no text: icons and hover help');
        assert.equal(doc.getElementById('aspectClearQuestDefault').disabled, false);
        assert.equal(doc.getElementById('aspectClearWorkspaceDefault').disabled, true, 'no workspace entries: nothing to clear');

        win.click();
        const popup = doc.getElementById('tomAspectPopup');
        assert.equal(popup.getAttribute('data-level'), 'window');
        assert.deepEqual([...popup.querySelectorAll('.tom-aspect-section > .tom-aspect-origin')].map((e: Win) => e.textContent), ['\u2713 here', 'from quest']);
        popup.querySelector('.tom-aspect-option[data-section="night"][data-choice="off"]').click();
        all.click();
        assert.match(doc.getElementById('tomAspectPopup').querySelector('.tom-aspect-popup-note').textContent, /every window/);
        doc.getElementById('tomAspectPopup').querySelector('.tom-aspect-option[data-section="answer"][data-value=""]').click();
        doc.getElementById('aspectSetQuestDefault').click();
        doc.getElementById('aspectClearQuestDefault').click();
        doc.getElementById('aspectSetWorkspaceDefault').click();
        // The quest default's own picker: its choice is the level's own, over the workspace level.
        doc.getElementById('aspectEditQuestDefault').click();
        const q = doc.getElementById('tomAspectPopup');
        assert.equal(q.getAttribute('data-level'), 'questDefault');
        assert.match(q.querySelector('.tom-aspect-popup-title').textContent, /the quest default/);
        q.querySelector('.tom-aspect-option[data-section="answer"][data-choice="brief"]').click();
        q.querySelector('.tom-aspect-option[data-section="night"][data-value="remove"]').click();
        // The workspace folder's own picker.
        doc.getElementById('aspectEditWorkspace').click();
        const w = doc.getElementById('tomAspectPopup');
        assert.equal(w.getAttribute('data-level'), 'workspace');
        w.querySelector('.tom-aspect-option[data-section="answer"][data-choice="full"]').click();
        win.click();
        doc.getElementById('tomAspectPopup').querySelector('.tom-aspect-edit').click();
        assert.deepEqual(chosen(posted), [
            { type: 'aspectChoose', level: 'window', section: 'night', value: 'off' },
            { type: 'aspectChoose', level: 'allWindows', section: 'answer', value: '' },
            { type: 'aspectQuestDefault', action: 'set' },
            { type: 'aspectQuestDefault', action: 'clear' },
            { type: 'aspectWorkspaceDefault', action: 'set' },
            { type: 'aspectChoose', level: 'questDefault', section: 'answer', value: 'brief' },
            { type: 'aspectChoose', level: 'questDefault', section: 'night', value: 'remove' },
            { type: 'aspectChoose', level: 'workspace', section: 'answer', value: 'full' },
            { type: 'aspectEditSections' },
        ]);

        window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', items: [], context: { quest: 'q', role: '', activeProjects: [] }, aspects: { ...CATALOGUE, roles: {} } } }));
        assert.equal(doc.getElementById('aspectClearQuestDefault').disabled, true, 'no quest default: nothing to clear');
        assert.equal(doc.getElementById('aspectWindowBtn').querySelector('.tom-aspect-dot'), null, 'a new state moves the dot');
    });

    test('AP-7: the run info line', (t) => {
        const { window, posted } = editor(t, { aspects: ASPECTS(), runQueueSettings: { default: { guidelines: { answer: 'full' } } } });
        const doc = window.document;
        const link = doc.getElementById('runAspectLink');
        assert.ok(link, 'the run info line shows the run\'s selection');
        assert.equal(link.textContent, 'Answer: full* \u00b7 Night: on');
        assert.match(link.title, /\* chosen by the run/);
        link.click();
        const popup = doc.getElementById('tomAspectPopup');
        assert.equal(popup.getAttribute('data-level'), 'run');
        assert.deepEqual([...popup.querySelectorAll('.tom-aspect-section > .tom-aspect-origin')].map((e: Win) => e.textContent), ['\u2713 here', 'from quest']);
        popup.querySelector('.tom-aspect-option[data-section="night"][data-value="remove"]').click();
        assert.deepEqual(chosen(posted), [{ type: 'aspectChoose', level: 'run', run: 'default', section: 'night', value: 'remove' }]);
        assert.equal(posted.some((m) => m.type === 'pickQueueDefaultSession'), false, 'the info line\'s other pick handler leaves it');
    });

    test('AP-8: queue items', (t) => {
        const items = [
            { id: 'i1', status: 'staged', originalText: 'one', role: 'reviewer', guidelines: { night: 'off' }, createdAt: '2026-11-21T10:00:00Z' },
            { id: 'i2', status: 'pending', originalText: 'two', createdAt: '2026-11-21T10:01:00Z' },
            { id: 'i3', status: 'sent', originalText: 'three', guidelines: { answer: 'brief' }, createdAt: '2026-11-21T10:02:00Z' },
        ];
        const { window, posted } = editor(t, { items, aspects: ASPECTS() });
        const doc = window.document;
        const ind = doc.querySelectorAll('#queueList .tom-aspect-ind');
        assert.equal(ind.length, 2, 'an indicator on the items with choices of their own');
        assert.match(ind[0].title, /Guidelines of this item: Answer: full · Night: off\nChosen here: Night: off/, 'its role\'s choice counts');
        const b1 = doc.querySelector('[data-aspect-item="i1"]');
        const b3 = doc.querySelector('[data-aspect-item="i3"]');
        assert.ok(b1 && b3, 'the item editor has the button');
        assert.equal(b1.disabled, false);
        assert.equal(doc.querySelector('[data-aspect-item="i2"]').disabled, false);
        assert.equal(b3.disabled, true, 'a sent item cannot change its choices');
        assert.ok(b1.querySelector('.tom-aspect-dot'));
        assert.equal(doc.querySelector('[data-aspect-item="i2"]').querySelector('.tom-aspect-dot'), null);
        assert.match(b1.closest('.qe-aspect-row').querySelector('.tom-aspect-text').textContent, /^Answer: full · Night: off\*$/);
        b1.click();
        const popup = doc.getElementById('tomAspectPopup');
        assert.equal(popup.getAttribute('data-level'), 'item');
        assert.deepEqual([...popup.querySelectorAll('.tom-aspect-section > .tom-aspect-origin')].map((e: Win) => e.textContent), ['from role', '\u2713 here']);
        popup.querySelector('.tom-aspect-option[data-section="answer"][data-choice="brief"]').click();
        assert.deepEqual(chosen(posted), [{ type: 'aspectChoose', level: 'item', itemId: 'i1', section: 'answer', value: 'brief' }]);
    });
});

/* ---- The todo panel --------------------------------------------------------------- */

function panel(t: { after(fn: () => void): void }): { w: Win; posted: Array<Record<string, unknown>> } {
    const dom = new JSDOM(`<body>${read('media', 'questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.vscode = { postMessage: (m: Record<string, unknown>) => posted.push({ ...m }), getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + read('media', 'shared', 'aspectPicker.js') + read('media', 'questTodoPanel', 'grouping.js') + read('media', 'questTodoPanel', 'main.js'));
    w.eval(`qtAspects = ${JSON.stringify(ASPECTS())}; qtAspectRun = { answer: 'full' }; qtCurrentQuestId = 'q1';`);
    return { w, posted };
}

describe('guideline picker: the todo panel', () => {
    test('AP-9: rows and the todo editor', (t) => {
        const { w, posted } = panel(t);
        assert.equal(posted.some((m) => m.type === 'qtGetAspects'), true, 'the panel asks for the sections');
        const mine = w.qtRenderTodoRow({ id: 'a1', title: 'A', status: 'not-started', guidelines: { night: 'off' } });
        const plain = w.qtRenderTodoRow({ id: 'a2', title: 'B', status: 'not-started' });
        assert.match(mine, /class="tom-aspect-ind" title="Guidelines of this todo: Answer: full · Night: off\nChosen here: Night: off\nWhere from: /);
        assert.doesNotMatch(plain, /tom-aspect-ind/);

        const todo = { id: 'a1', title: 'A', status: 'not-started', role: '', guidelines: { night: 'remove' }, _resolvedQuestId: 'q2' };
        w.qtRenderDetail(todo);
        const btn = w.document.getElementById('qt-d-aspect-btn');
        assert.ok(btn, 'the todo editor has the button');
        assert.ok(btn.querySelector('.tom-aspect-dot'));
        assert.equal(w.document.getElementById('qt-d-aspect-text').textContent, 'Night: Remove', 'its choices as text beside it');
        btn.click();
        const popup = w.document.getElementById('tomAspectPopup');
        assert.equal(popup.getAttribute('data-level'), 'todo');
        assert.deepEqual([...popup.querySelectorAll('.tom-aspect-section > .tom-aspect-origin')].map((e: Win) => e.textContent), ['from run', '\u2713 here']);
        popup.querySelector('.tom-aspect-option[data-section="answer"][data-choice="brief"]').click();
        assert.deepEqual(posted.filter((m) => m.type === 'aspectChoose'), [{ type: 'aspectChoose', level: 'todo', questId: 'q2', todoId: 'a1', section: 'answer', value: 'brief' }]);

        // The host's answer redraws the row; a role change does too (the role's choices count).
        w.qtHandleMessage({ type: 'qtAspectChanged', todoId: 'a1', guidelines: { answer: 'brief' } });
        assert.equal(w.document.getElementById('qt-d-aspect-text').textContent, 'Answer: brief');
        w.qtHandleMessage({ type: 'qtAspectChanged', todoId: 'a1', guidelines: null });
        assert.equal(w.document.getElementById('qt-d-aspect-text').textContent, 'none of its own');
        assert.equal(w.document.getElementById('qt-d-aspect-btn').querySelector('.tom-aspect-dot'), null);
        const role = w.document.getElementById('qt-d-role');
        role.innerHTML = '<option value=""></option><option value="reviewer">reviewer</option>';
        role.value = 'reviewer';
        role.dispatchEvent(new w.Event('change'));
        assert.match(w.document.getElementById('qt-d-aspect-btn').title, /Answer: full/);
    });

    test('AP-9b: session and workspace-file views have no picker', (t) => {
        const { w } = panel(t);
        w.eval("qtViewConfig.mode = 'session';");
        w.qtRenderDetail({ id: 's1', title: 'S', status: 'not-started' });
        assert.equal(w.document.getElementById('qt-d-aspect-btn'), null);
        assert.equal(w.qtTodoAspectIndicator({ id: 's1', guidelines: { night: 'on' } }), '');
    });

    test('AP-10: the hosts', () => {
        const queue = read('src', 'handlers', 'queueEditor-handler.ts');
        assert.match(queue, /const aspect = await handleAspectPickerMessage\(msg\);\s*if \(aspect\.handled\) \{ return; \}/);
        assert.match(queue, /aspects: \(\(\) => \{\s*try \{ return aspectPickerState\(\); \}/);
        const html = read('media', 'queueEditor', 'index.html');
        assert.match(html, /\{\{sharedUri\}\}\/aspectPicker\.css/);
        assert.match(html, /<script src="\{\{sharedUri\}\}\/aspectPicker\.js"><\/script>[\s\S]*main\.js/);
        const todo = read('src', 'handlers', 'questTodoPanel-handler.ts');
        assert.match(todo, /case 'qtGetAspects': \{[\s\S]*?_aspectViews\.add\(webview\);\s*post\(_todoAspectMessage\(\)\);/);
        assert.match(todo, /msg\.level === 'todo'[\s\S]*?applyAspectChoice\(\{ level: 'todo'[\s\S]*?post\(\{ type: 'qtAspectChanged'/);
        assert.match(todo, /readMediaText\('shared', 'aspectPicker\.js'\)/);
        assert.match(read('src', 'handlers', 'questTodo', 'questTodoAssets.ts'), /readMediaText\('shared', 'aspectPicker\.css'\)/);
    });
});
