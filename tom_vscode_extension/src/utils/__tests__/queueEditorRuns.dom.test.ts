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
 *        with the tab; Position, Variables, the Chat Variables and Context & Settings buttons post the tab's run;
 *        the role of another run than the window's is its step's, shown, not picked
 *   QR-7 the Context & Settings view's run line names the run it was opened for
 *   QR-8 the run chip: `run <name>` in the todo chip's look beside it; on a staged or pending item it is clickable
 *        and posts `moveItemToRun` with the item; on a sending item or an item of a Proceed run it is not; the host
 *        picks among the quest's other runs and calls the manager's moveItemToRun
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
        w.openContextSettings();
        assert.deepEqual(posted, [
            { type: 'openRunStateFile', run: 'chg2' }, { type: 'openChatVariablesEditor', run: 'chg2' },
            { type: 'openChatVariablesEditor', run: 'chg2' }, { type: 'openContextSettings', run: 'chg2' },
        ]);
    });

    test('QR-7: the Context & Settings view names its run', () => {
        const html = readMedia('contextSettingsEditor', 'index.html');
        const body = html.split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
        const w = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only' }).window as Win;
        w.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
        w.eval(readMedia('contextSettingsEditor', 'main.js'));
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'contextData', quests: [], roles: [], projects: [], todoFiles: [], todos: [], activeProjects: [], reminderTemplates: [], run: 'chg2', windowRun: 'chg1' } }));
        const line = w.document.getElementById('run-line');
        assert.equal(line.dataset.run, 'chg2');
        assert.match(line.textContent, /^Run: chg2 — the quest, role, projects, todo and reminder settings here are the window's/);
        w.close();
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
});
