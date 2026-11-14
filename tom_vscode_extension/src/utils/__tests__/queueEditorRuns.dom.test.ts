/**
 * The Prompt Queue editor: one tab per process run, each its run's queue (vscimpb45, vscimpb60b; media/queueEditor,
 * media/shared/queueEntryRenderFunctions.js).
 *
 *   QR-1 the tabs: below the shared compaction row, one tab per run — the quest's runs and any run with items,
 *        `default` first, the window's marked and selected first; each says whether its run sends, waits or is paused
 *        and how many open items it has; a tab shows its run's items only, a chat send in the tab of the run it ran in,
 *        else the default run's; every item keeps its run chip
 *   QR-2 a tab switch: the list, the toolbar's counts and settings follow; the host is told the run
 *        (`setSettingsRun`); the tab is kept in the view state over a reload, a tab that is gone falls back to the
 *        window's run
 *   QR-3 the tab's toolbar posts its run: Add, auto-send, Auto-Start / -Pause / -Continue, Restart, Stop, Interrupt,
 *        Send all staged, Retry / Delete errors, Clear sent / all, the Copilot timeout and reminder, the default
 *        session picker; Collapse / Expand act on the tab's items
 *   QR-4 gone: the run filter, Group by run, the Queue per run checkbox, the lane strip, the add form's run picker;
 *        the add form names the tab's run; the Copilot defaults row shows only while the run's default transport is
 *        Copilot
 *   QR-5 the host: every toolbar action passes the message's run to the manager (handler source)
 *   QR-6 the context bar shows the tab's run (vscimpb60c): its name, position, role and chat variables, which change
 *        with the tab; Position, Variables and the Chat Variables button post the tab's run; the bell posts
 *        `openReminderSettings` (the Status Page's reminder settings); the role of another run than the window's is
 *        its step's, shown, not picked
 *   QR-8 the run chip: `run <name>` in the todo chip's look beside it; on a staged or pending item it is clickable
 *        and posts `moveItemToRun` with the item; on a sending item or an item of a Proceed run it is not; the host
 *        picks among the quest's other runs and calls the manager's moveItemToRun
 *   QR-9 Make default (vscimpb60g): a codicon button in the tab's toolbar; enabled only while the tab's run differs
 *        from the start values (the state's `startQueueSettings`; unset equals ""), its tooltip naming what differs;
 *        a click posts `makeRunSettingsDefault` with the tab's run; the host calls the manager's
 *        setDefaultQueueSettings and confirms in the status bar
 *   QR-10 a deleted run's tab (vscimpb86): a run that is no longer among the quest's runs and still has items keeps
 *        its tab, muted and marked `(deleted run)` in its label and tooltip, with a remove button beside it (codicon
 *        trash, "Remove this deleted run's queue: delete its items"); live runs and `default` never have it; a click
 *        posts `removeRunQueue` with the run and does not switch the tab; the run created again under the same name
 *        (it is back in `processRuns`) makes the tab live again, its items in it, without the button; once the host
 *        has removed the items the tab is gone and the selection falls back to the window's run
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
    { ...base, id: 'g', status: 'chat-sent', originalText: 'chat2', expandedText: 'chat2', session: 'chat@chg2', run: 'chg2' },
];
const tabs = (w: Win): string[] => [...w.document.querySelectorAll('#runTabs .run-tab')].map((b: Win) => b.textContent.replace(/\s+/g, ' ').trim());
const listedText = (w: Win): string => w.document.getElementById('queueList').textContent;
const runChips = (w: Win): string[] => [...w.document.querySelectorAll('#queueList .queue-run-chip')].map((c: Win) => c.dataset.run);
const clickTab = (w: Win, run: string): void => { w.document.querySelector(`#runTabs .run-tab[data-run="${run}"]`).click(); };
const SETTINGS = {
    default: { autoSend: true, autoStart: false, autoPause: true, autoContinue: false, responseTimeoutMinutes: 60, defaultTransport: 'copilot' },
    chg1: { autoSend: true, autoStart: false, autoPause: true, autoContinue: false, responseTimeoutMinutes: 30, defaultTransport: 'anthropic' },
    chg2: { autoSend: false, autoStart: true, autoPause: false, autoContinue: true, responseTimeoutMinutes: 120, defaultTransport: 'copilot' },
};

describe('Prompt Queue editor — one tab per run', () => {
    test('QR-1: the tabs', (t) => {
        const items = [...ITEMS, { ...base, id: 'h', status: 'sending', originalText: 'h', expandedText: 'h', run: 'default' }];
        const { w } = setup(t, items, {}, { runQueueSettings: SETTINGS });
        const row = w.document.getElementById('runTabs');
        const shared = w.document.getElementById('compactionPickers');
        assert.ok(shared.compareDocumentPosition(row) & w.Node.DOCUMENT_POSITION_FOLLOWING, 'the shared models above the tabs');
        assert.ok(w.document.querySelector('h2').compareDocumentPosition(shared) & w.Node.DOCUMENT_POSITION_FOLLOWING);
        assert.ok(row.compareDocumentPosition(w.document.querySelector('.toolbar')) & w.Node.DOCUMENT_POSITION_FOLLOWING, 'the toolbar is the tab\'s');
        assert.ok(row.compareDocumentPosition(w.document.getElementById('queueDefaultPickerSlot')) & w.Node.DOCUMENT_POSITION_FOLLOWING, 'so is the defaults row');
        assert.deepEqual(tabs(w), ['default 4', 'chg1 (this window) 1', 'chg2 2'], 'default first, the window\'s marked, open items counted (a running chat send too)');
        const states = [...row.querySelectorAll('.run-tab')].map((b: Win) => [b.dataset.run, b.dataset.state, b.classList.contains('active')]);
        assert.deepEqual(states, [['default', 'sending', false], ['chg1', 'waiting', true], ['chg2', 'paused', false]], 'the window\'s run selected first');
        assert.match(row.querySelector('[data-run="chg2"]').title, /paused/);
        assert.deepEqual(runChips(w), ['chg1']);
        clickTab(w, 'default');
        assert.match(listedText(w), /CHAT/, 'a chat send without a run: the default run\'s tab');
        assert.deepEqual(runChips(w), ['default', 'default', 'default'], 'b, e and the sending h');
        clickTab(w, 'chg2');
        assert.match(listedText(w), /CHAT SENT/, 'a chat send in the tab of the run it ran in');
        assert.deepEqual(runChips(w), ['chg2', 'chg2']);
    });

    test('QR-2: a tab switch', (t) => {
        const { w, posted, state } = setup(t, ITEMS, {}, { runQueueSettings: SETTINGS });
        assert.deepEqual(posted.filter((m) => m.type === 'setSettingsRun').at(-1), { type: 'setSettingsRun', run: 'chg1' });
        assert.match(w.document.getElementById('autoSendBtn').title, /ON/);
        assert.match(w.document.getElementById('countLabel').textContent, /Pending: 1 /);
        clickTab(w, 'chg2');
        assert.equal(w.document.querySelector('#runTabs .run-tab.active').dataset.run, 'chg2');
        assert.deepEqual(posted.filter((m) => m.type === 'setSettingsRun').at(-1), { type: 'setSettingsRun', run: 'chg2' });
        assert.equal(state().queueTab, 'chg2', 'kept in the view state');
        assert.match(w.document.getElementById('autoSendBtn').title, /OFF/, 'the run\'s own settings');
        assert.match(w.document.getElementById('autoStartBtn').title, /ON/);
        assert.equal(w.document.getElementById('responseTimeout').value, '120');
        assert.match(w.document.getElementById('countLabel').textContent, /Pending: 2 /);
        // A reload: the kept tab is selected again.
        const again = setup(t, ITEMS, state(), { runQueueSettings: SETTINGS });
        assert.equal(again.w.document.querySelector('#runTabs .run-tab.active').dataset.run, 'chg2');
        // A tab that is gone: the window's run.
        const gone = setup(t, ITEMS, { queueTab: 'removed' }, { runQueueSettings: SETTINGS });
        assert.equal(gone.w.document.querySelector('#runTabs .run-tab.active').dataset.run, 'chg1');
    });

    test('QR-3: the tab\'s toolbar posts its run', (t) => {
        const { w, posted } = setup(t, ITEMS, {}, { runQueueSettings: SETTINGS });
        clickTab(w, 'chg2');
        posted.length = 0;
        for (const fn of ['toggleAutoSend', 'toggleAutoStart', 'toggleAutoPause', 'toggleAutoContinue', 'restartQueue', 'stopActiveItem',
            'interruptActiveForContinuation', 'sendAllStaged', 'retryAllErrors', 'clearErrors', 'clearSent', 'clearAll']) { w[fn](); }
        w.setResponseTimeout('30');
        assert.deepEqual(posted.map((m) => [m.type, m.run]), [
            ['toggleAutoSend', 'chg2'], ['toggleAutoStart', 'chg2'], ['toggleAutoPause', 'chg2'], ['toggleAutoContinue', 'chg2'],
            ['restartQueue', 'chg2'], ['stopActiveItem', 'chg2'], ['interruptActiveForContinuation', 'chg2'], ['sendAllStaged', 'chg2'],
            ['retryAllErrors', 'chg2'], ['clearErrors', 'chg2'], ['clearSent', 'chg2'], ['clearAll', 'chg2'], ['setResponseTimeout', 'chg2'],
        ]);
        posted.length = 0;
        w.document.getElementById('addText').value = 'new prompt';
        w.addPrompt();
        assert.equal(posted.find((m) => m.type === 'addPrompt').run, 'chg2', 'Add adds to the tab\'s run');
        posted.length = 0;
        w.collapseAll();
        assert.deepEqual(posted.find((m) => m.type === 'setAllDetailsExpanded').ids.sort(), ['a', 'd', 'g'], 'Collapse acts on the tab\'s items');
        // The context bar's Session link picks the tab's run's default session.
        const sessionLink = w.document.querySelector('#contextSummary [data-pick="session"]');
        assert.ok(sessionLink, 'the Session link');
        posted.length = 0;
        sessionLink.click();
        assert.deepEqual(posted.at(-1), { type: 'pickQueueDefaultSession', run: 'chg2' });
    });

    test('QR-4: what is gone, and the add form', (t) => {
        const { w } = setup(t, ITEMS, {}, { runQueueSettings: SETTINGS });
        for (const id of ['runFilter', 'groupByRun', 'queuePerRun', 'laneStrip', 'addRun', 'settingsRunLabel']) {
            assert.equal(w.document.getElementById(id), null, `no #${id}`);
        }
        assert.equal(w.document.querySelectorAll('.run-group-head').length, 0);
        assert.equal(w.document.getElementById('addRunLabel').textContent, 'Run: chg1 (this window\'s)');
        assert.equal(w.document.getElementById('copilotDefaultsRow').style.display, 'none', 'chg1 sends on Anthropic: no Copilot defaults');
        clickTab(w, 'chg2');
        assert.equal(w.document.getElementById('addRunLabel').textContent, 'Run: chg2');
        assert.equal(w.document.getElementById('copilotDefaultsRow').style.display, '', 'chg2 on Copilot: its answer timeout and reminder');
    });

    test('QR-5: the host passes the run of every toolbar action', () => {
        const host = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        for (const call of [
            /qm\.clearByStatus\('sent', tabRunOf\(msg\)\)/, /qm\.clearByStatus\('error', tabRunOf\(msg\)\)/, /qm\.clearAll\(tabRunOf\(msg\)\)/,
            /qm\.sendAllStaged\(tabRunOf\(msg\)\)/, /qm\.retryAllErrors\(tabRunOf\(msg\)\)/, /qm\.restartQueue\(tabRunOf\(msg\)\)/,
            /qm\.stopActiveItem\(typeof msg\.id === 'string' && msg\.id \? msg\.id : undefined, tabRunOf\(msg\)\)/,
            /qm\.interruptActiveItemForContinuation\(msg\.type === 'interruptForContinuation' \? msg\.id : undefined, tabRunOf\(msg\)\)/,
            /qm\.setRunQueueSettings\(run, \{ \[key\]: !qm\.runQueueSettings\(run\)\[key\] \}\)/,
            /qm\.setRunQueueSettings\(settingsRunOf\(msg\), \{ responseTimeoutMinutes:/,
            /qm\.setRunQueueSettings\(settingsRunOf\(msg\), \{ defaultReminderTemplateId:/,
            /\.\.\.\(typeof msg\.run === 'string' && msg\.run \? \{ run: addFormRun\(msg\.run\) \} : \{\}\)/,
        ]) { assert.match(host, call); }
    });
    test('QR-6: the context bar shows the tab\'s run', (t) => {
        const runContexts = {
            default: { run: 'default', process: 'design', position: 'Phase One › Plan', role: 'planner', variables: { mode: 'fast' }, stateFile: '/ws/ps.yaml' },
            chg1: { run: 'chg1', process: 'design', position: 'Phase One › Build', role: 'builder', variables: { mode: 'careful', limit: '7' }, stateFile: '/ws/ps.chg1.yaml' },
            chg2: { run: 'chg2', process: '', position: '', role: '', variables: {}, stateFile: '/ws/ps.chg2.yaml' },
        };
        const { w, posted } = setup(t, ITEMS, {}, { runQueueSettings: SETTINGS, runContexts, context: { quest: 'q1', role: 'builder', activeProjects: [] } });
        const bar = (): string => w.document.getElementById('contextSummary').textContent.replace(/\s+/g, ' ');
        const linkOf = (pick: string): Win => w.document.querySelector(`#contextSummary [data-pick="${pick}"]`);
        assert.match(bar(), /Run: chg1 \(this window's\) \| Position: Phase One › Build \| Role: builder \|/);
        assert.equal(linkOf('variables').textContent, '2');
        assert.match(linkOf('variables').title, /mode=careful, limit=7/);
        assert.ok(linkOf('role'), 'the window\'s run: the role is picked');
        clickTab(w, 'default');
        assert.match(bar(), /Run: default \| Position: Phase One › Plan \| Role: planner \|/, 'the links follow the tab');
        assert.equal(linkOf('role'), null, 'another run\'s role is its step\'s: shown, not picked');
        assert.equal(linkOf('variables').textContent, '1');
        clickTab(w, 'chg2');
        assert.match(bar(), /Position: \(no process\)/);
        posted.length = 0;
        linkOf('position').click();
        linkOf('variables').click();
        w.openChatVariables();
        w.openReminderSettings();
        assert.deepEqual(posted, [
            { type: 'openRunStateFile', run: 'chg2' }, { type: 'openChatVariablesEditor', run: 'chg2' },
            { type: 'openChatVariablesEditor', run: 'chg2' }, { type: 'openReminderSettings' },
        ]);
    });


    test('QR-8: the run chip', (t) => {
        const items = [
            { ...base, id: 'p', originalText: 'p', expandedText: 'p', run: 'chg1' },
            { ...base, id: 's', status: 'staged', originalText: 's', expandedText: 's', run: 'chg1' },
            { ...base, id: 'x', status: 'sending', originalText: 'x', expandedText: 'x', run: 'chg1' },
            { ...base, id: 'q', originalText: 'q', expandedText: 'q', processRun: { quest: 'q', state: {}, run: 'chg1' } },
        ];
        const { w, posted } = setup(t, items);
        const chip = (id: string): Win => w.document.querySelector(`#queueList .queue-run-chip[data-qid="${id}"]`);
        for (const id of ['p', 's', 'x', 'q']) {
            const c = chip(id);
            assert.ok(c.classList.contains('queue-from-chip'), 'the todo chip\'s look');
            assert.match(c.textContent, /^run chg1$/);
        }
        assert.deepEqual(['p', 's', 'x', 'q'].map((id) => chip(id).classList.contains('movable')), [true, true, false, false]);
        assert.match(chip('q').title, /Proceed run/);
        assert.match(chip('p').getAttribute('onclick'), /moveItemToRun\('p'\)/);
        assert.equal(chip('x').getAttribute('onclick'), null, 'a sending item: no click');
        w.moveItemToRun('p');
        assert.deepEqual(posted.filter((m) => m.type === 'moveItemToRun'), [{ type: 'moveItemToRun', id: 'p' }]);
        const host = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        const handler = host.slice(host.indexOf("case 'moveItemToRun':"), host.indexOf("case 'letNextGoFirst':"));
        assert.match(handler, /queueRunState\(\)/, 'the quest\'s runs');
        assert.match(handler, /filter\(\(r\) => r !== current\)/, 'not its own');
        assert.match(handler, /qm\.moveItemToRun\(id, picked\.label\)/);
    });

    test('QR-9: Make default', (t) => {
        const start = { ...SETTINGS.default, defaultMessageTemplateId: '' };
        const { w, posted } = setup(t, ITEMS, { queueTab: 'default' }, { runQueueSettings: SETTINGS, startQueueSettings: start });
        const btn = w.document.getElementById('makeDefaultBtn');
        assert.ok(btn, 'the button');
        assert.ok(btn.querySelector('.codicon'), 'a codicon');
        assert.equal(btn.disabled, true, 'default equals the start values (unset equals "")');
        assert.match(btn.title, /Make these settings the default for new runs/);
        posted.length = 0;
        w.makeRunSettingsDefault();
        assert.equal(posted.filter((m) => m.type === 'makeRunSettingsDefault').length, 0, 'nothing to write, nothing posted');
        clickTab(w, 'chg2');
        assert.equal(btn.disabled, false, 'chg2 differs');
        assert.match(btn.title, /autoSend, autoStart, autoPause, autoContinue, responseTimeoutMinutes/);
        assert.match(btn.getAttribute('onclick'), /^makeRunSettingsDefault\(\)$/);
        posted.length = 0;
        w.makeRunSettingsDefault();
        assert.deepEqual(posted.filter((m) => m.type === 'makeRunSettingsDefault'), [{ type: 'makeRunSettingsDefault', run: 'chg2' }]);
        // The host's answer: chg2's settings are the start values now.
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', items: ITEMS, autoSend: false, processRuns: ['default', 'chg1', 'chg2'], currentRun: 'chg1', runQueueSettings: SETTINGS, startQueueSettings: SETTINGS.chg2 } }));
        assert.equal(w.document.getElementById('makeDefaultBtn').disabled, true, 'disabled once nothing differs');
        const host = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(host, /case 'makeRunSettingsDefault': \{\s*const run = settingsRunOf\(msg\) \?\? qm\.windowRun;\s*const changed = qm\.setDefaultQueueSettings\(run\);/);
        assert.match(host, /setStatusBarMessage\(/);
        assert.match(host, /startQueueSettings: \{ \.\.\.qm\.startQueueSettings\(\) \}/);
    });
    test('QR-10: a deleted run\'s tab', (t) => {
        // chg2 was deleted: the quest's runs are default and chg1, chg2 still has items a, d, g.
        const { w, posted } = setup(t, ITEMS, { queueTab: 'chg2' }, { runQueueSettings: SETTINGS, processRuns: ['default', 'chg1'] });
        const row = w.document.getElementById('runTabs');
        assert.deepEqual(tabs(w), ['default 3', 'chg1 (this window) 1', 'chg2 (deleted run) 2'], 'the deleted run keeps its tab, marked');
        const orphan = row.querySelector('.run-tab[data-run="chg2"]');
        assert.ok(orphan.classList.contains('run-tab-orphaned'), 'muted');
        assert.equal(orphan.dataset.orphaned, 'true');
        assert.match(orphan.title, /^Run chg2 \(deleted run: its items are kept until you remove its queue\)/);
        const removes = [...row.querySelectorAll('.run-tab-remove')].map((b: Win) => b.dataset.run);
        assert.deepEqual(removes, ['chg2'], 'the button only on the deleted run\'s tab');
        const btn = row.querySelector('.run-tab-remove');
        assert.ok(btn.querySelector('.codicon-trash'));
        assert.equal(btn.title, 'Remove this deleted run\'s queue: delete its items');
        for (const live of ['default', 'chg1']) {
            assert.ok(!row.querySelector(`.run-tab[data-run="${live}"]`).classList.contains('run-tab-orphaned'), `${live} is live`);
        }
        clickTab(w, 'chg1');
        posted.length = 0;
        btn.click();
        assert.deepEqual(posted.filter((m) => m.type === 'removeRunQueue'), [{ type: 'removeRunQueue', run: 'chg2' }]);
        assert.equal(row.querySelector('.run-tab.active').dataset.run, 'chg1', 'the click does not switch the tab');
        assert.equal(posted.filter((m) => m.type === 'setSettingsRun').length, 0);

        // The run is created again under the same name: the tab is live, its items in it, no button.
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', items: ITEMS, autoSend: false, processRuns: ['default', 'chg1', 'chg2'], currentRun: 'chg1', runQueueSettings: SETTINGS } }));
        assert.deepEqual(tabs(w), ['default 3', 'chg1 (this window) 1', 'chg2 2']);
        assert.equal(w.document.querySelectorAll('#runTabs .run-tab-remove').length, 0, 'no button once the run is back');
        assert.ok(!w.document.querySelector('#runTabs .run-tab[data-run="chg2"]').classList.contains('run-tab-orphaned'));
        clickTab(w, 'chg2');
        assert.deepEqual(runChips(w), ['chg2', 'chg2'], 'its old items are back in it');

        // Deleted again, then its items removed by the host: the tab goes, the selection falls back to the window's run.
        const rest = ITEMS.filter((i) => !['a', 'd', 'g'].includes(i.id));
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', items: rest, autoSend: false, processRuns: ['default', 'chg1'], currentRun: 'chg1', runQueueSettings: SETTINGS } }));
        assert.deepEqual(tabs(w), ['default 3', 'chg1 (this window) 1']);
        assert.equal(w.document.querySelector('#runTabs .run-tab.active').dataset.run, 'chg1');
        assert.equal(w.document.querySelectorAll('#runTabs .run-tab-remove').length, 0);

        // The host confirms and removes (handler source): refused for default and live runs, the manager removes.
        const host = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(host, /case 'removeRunQueue': \{[\s\S]*runQueueRemovalRefused\(run, queueRunState\(\)\.processRuns\)[\s\S]*showWarningMessage\(dialog\.message, \{ modal: true, detail: dialog\.detail \}[\s\S]*qm\.removeRunQueue\(run, choice\.mode\)/);
    });
});

