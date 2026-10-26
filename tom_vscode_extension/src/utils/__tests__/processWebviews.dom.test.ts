/**
 * The PROCESS sidebar view (media/processPanel/) and the process editor
 * (media/processEditor/), in a JSDOM running their real scripts and talking
 * to a stand-in host.
 *
 *   PW-1  PROCESS view: process, phase, step and sub-step dropdowns show the state; the post-gate
 *         todos and the role are shown; a non-repeatable level has no −/+
 *   PW-2  PROCESS view: choosing in a dropdown, −/+ and ? post the change / toggle the description
 *   PW-3  PROCESS view: without a quest it says so
 *   PW-4  editor: loading fills the form; typing marks it unsaved and asks the host to validate
 *   PW-5  editor: add / remove / move change the model; removing the last sub-step drops the list;
 *         Save sends the model and the description
 *   PW-6  editor: validation errors are listed and the field marked; choosing another process
 *         with unsaved changes hands them to the host
 *   PW-7  PROCESS view: the action bar shows the moves the host offers, Proceed first with a play
 *         icon, and posts the one clicked; the template button opens the template editor; at a decision a
 *         banner lists the options and the bar shows only Decide… (a fork icon) and Back; a finished
 *         process says so; a gate has −/+
 *   PW-14 editor: the gate card chooses where a failed gate goes — run it again (no onFail) or back to
 *         one of the phase's steps
 *   PW-8  editor: every phase, step and sub-step has a prompt field, edited into the model
 *   PW-11 editor: a session label on every node and on the process itself (`inherited` when unset, else
 *         `name based on X, per prompt, profile`); clicking it asks the host's session picker for that node,
 *         whose answer (a name, a spec, or null) is written into the definition at that node; the clear
 *         button removes it (inherited again); each level's write-back
 *   PW-12 PROCESS view: at a user action a banner says it is the user's turn, what to do (the description,
 *         in a box two lines taller than 30vh that scrolls with visible scrollbars) and that Proceed confirms it; the Proceed button shows a person; user actions are marked 👤 in the
 *         step and sub-step dropdowns
 *   PW-13 editor: a "user action" checkbox on steps without sub-steps, sub-steps and the post-gate step, not
 *         on a gate or a step with sub-steps
 *   PW-9  action page (Proceed): shows what runs, where the state goes and the session (Change… asks the
 *         host), previews as you type (custom instructions sent with it), confirms and cancels; an empty
 *         template moves without a prompt; a stale move says so
 *   PW-10 template editor: lists the kinds, inserts a variable at the cursor, marks unsaved kinds,
 *         resets to the default, saves all kinds at once
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (panel: string, file: string): string => readFileSync(join(ROOT, 'media', panel, file), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(panel: string): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset(panel, 'index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset(panel, 'style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) });
    w.eval(asset(panel, 'main.js'));
    return { w, posted };
}
const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const $ = (w: Win, sel: string): Win[] => [...w.document.querySelectorAll(sel)];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const DEF = {
    id: 'flow', name: 'Flow',
    phases: [
        {
            id: 'build', name: 'Build', repeatable: true, maxIterations: 3, description: 'Build it.',
            steps: [
                { id: 'code', name: 'Code', role: 'senior_developer' },
                { id: 'review', name: 'Review', repeatable: true, substeps: [{ id: 'read', name: 'Read' }, { id: 'note' }] },
            ],
            gate: { id: 'gate', name: 'Gate' },
            postGate: { id: 'wrap', name: 'Wrap up', todos: [{ title: 'Tag it', description: 'v1' }], todoPrefix: 'wraptodos' },
        },
        { id: 'ship', steps: [], gate: { id: 'gate' } },
    ],
};
const STATE = { process: 'flow', phase: 'build', phaseIteration: 2, step: 'review', stepIteration: 1, substep: 'read', substepIteration: 1, completed: false };
const MOVES = [
    { kind: 'proceed', level: null, label: 'Proceed', to: 'Build #2 › Review #1 › Read' },
    { kind: 'finish', level: 'step', label: 'Finish step', to: 'Build #2 › Gate #1' },
    { kind: 'repeat', level: 'step', label: 'Repeat step', to: 'Build #2 › Review #2 › Read' },
    { kind: 'skip', level: null, label: 'Skip', to: 'Build #2 › Gate #1' },
    { kind: 'back', level: null, label: 'Back', to: 'Build #2 › Code' },
];
const panelState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'state', quest: 'q1', processes: [{ id: 'flow', name: 'Flow', valid: true }, { id: 'bad', name: 'bad', valid: false }],
    state: STATE, definition: DEF, processInvalid: false, description: '# Flow', stepRole: '', chatRole: 'default', moves: MOVES, ...over,
});

describe('PROCESS view', () => {
    test('PW-1: showing the state', () => {
        const { w, posted } = setup('processPanel');
        assert.deepEqual(posted[0], { type: 'ready' });
        send(w, panelState());
        const value = (id: string): string => w.document.getElementById(id).value;
        assert.deepEqual([value('sel-process'), value('sel-phase'), value('sel-step'), value('sel-substep')], ['flow', 'build', 'review', 'read']);
        assert.deepEqual($(w, '#sel-step option').map((o) => o.textContent), ['1. Code (code)', '2. Review (review)', '3. Gate: Gate (gate)', '4. Post-gate: Wrap up (wrap)']);
        assert.equal($(w, '#sel-process option').find((o) => o.value === 'bad').disabled, true, 'an invalid process cannot be chosen');
        assert.equal(w.document.querySelector('[data-iter="phase"] + .iter-n').textContent, '2/3');
        assert.equal(w.document.querySelector('[data-iter="substep"][data-delta="1"]').disabled, true, 'sub-step "read" is not repeatable');
        assert.match(w.document.body.textContent, /none named — chat role: default/);
        send(w, panelState({ state: { ...STATE, step: 'wrap', substep: '' } }));
        assert.deepEqual($(w, '.todos li').map((li) => li.textContent), ['Tag it', 'quest todos wraptodos*']);
        assert.equal(w.document.getElementById('sel-substep'), null, 'no sub-steps, no dropdown');
    });

    test('PW-2: changing it', () => {
        const { w, posted } = setup('processPanel');
        send(w, panelState());
        const step = w.document.getElementById('sel-step');
        step.value = 'gate';
        step.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.deepEqual(posted.pop(), { type: 'change', change: { step: 'gate' } });
        w.document.querySelector('[data-iter="phase"][data-delta="1"]').click();
        assert.deepEqual(posted.pop(), { type: 'iteration', level: 'phase', delta: 1 });
        w.document.querySelector('[data-help="phase"]').click();
        assert.match(w.document.querySelector('.desc').textContent, /Build it\./);
        w.document.querySelector('[data-edit]').click();
        assert.deepEqual(posted.pop(), { type: 'openEditor', id: 'flow' });
    });

    test('PW-3: no quest', () => {
        const { w } = setup('processPanel');
        send(w, panelState({ quest: '' }));
        assert.match(w.document.body.textContent, /No quest is active/);
    });

    test('PW-7: the action bar', () => {
        const { w, posted } = setup('processPanel');
        send(w, panelState());
        const buttons = $(w, '.actions [data-move]');
        assert.deepEqual(buttons.map((b) => b.title), ['Proceed → Build #2 › Review #1 › Read', 'Finish step → Build #2 › Gate #1', 'Repeat step → Build #2 › Review #2 › Read', 'Skip → Build #2 › Gate #1', 'Back → Build #2 › Code']);
        assert.ok(buttons[0].querySelector('.codicon-play'), 'Proceed runs: a play icon');
        assert.ok(w.document.querySelector('.actions').compareDocumentPosition(w.document.getElementById('sel-process')) & 4, 'the bar is at the top');
        buttons[0].click();
        assert.deepEqual(posted.pop(), { type: 'action', kind: 'proceed' });
        buttons[2].click();
        assert.deepEqual(posted.pop(), { type: 'action', kind: 'repeat', level: 'step' });
        buttons[3].click();
        assert.deepEqual(posted.pop(), { type: 'action', kind: 'skip' });
        assert.equal(w.document.querySelector('.branch-decision'), null, 'not at a decision: no banner');
        send(w, panelState({
            state: { ...STATE, decision: true },
            moves: [
                { kind: 'proceed', level: null, label: 'Decide…', to: 'Build #2 › Review #1 › Read' },
                { kind: 'finish', level: null, label: 'Go on to Gate', to: 'Build #2 › Gate #1', branchOption: true },
                { kind: 'repeat', level: 'step', label: 'Repeat the step Review', to: 'Build #2 › Review #2 › Read', branchOption: true },
                { kind: 'back', level: null, label: 'Back', to: 'Build #2 › Review #1 › Read' },
            ],
        }));
        const banner = w.document.querySelector('.branch-decision');
        assert.match(banner.textContent, /Decision — how does the process go on\?/);
        assert.deepEqual($(w, '.bd-options li').map((li) => li.textContent), ['Go on to Gate', 'Repeat the step Review'], 'the options, listed');
        assert.deepEqual($(w, '.actions [data-move]').map((b) => b.dataset.move), ['proceed', 'back'], 'the options are chosen in the dialog, not in the bar');
        assert.ok(w.document.querySelector('[data-move="proceed"] .codicon-repo-forked'), 'Decide…: a fork icon');
        w.document.querySelector('[data-templates]').click();
        assert.deepEqual(posted.pop(), { type: 'openTemplates' });
        send(w, panelState({ state: { ...STATE, step: 'gate', substep: '' }, moves: [] }));
        assert.equal(w.document.querySelector('[data-iter="step"][data-delta="1"]').disabled, false, 'a gate can be run again');
        assert.match(w.document.querySelector('.actions').textContent, /No move from here/);
        send(w, panelState({ state: { ...STATE, completed: true }, moves: [{ kind: 'back', level: null, label: 'Reopen', to: 'Build #2 › Review #1 › Read' }] }));
        assert.match(w.document.body.textContent, /The process is finished/);
        assert.ok(w.document.querySelector('[data-move="back"] .codicon-debug-reverse-continue'));
        send(w, panelState({ state: { process: '', phase: '', phaseIteration: 1, step: '', stepIteration: 1, substep: '', substepIteration: 1, completed: false }, definition: null, moves: [] }));
        assert.equal(w.document.querySelector('.actions'), null, 'no process, no action bar');
    });
});

describe('PROCESS view — user actions', () => {
    test('PW-12: a user action', () => {
        const { w } = setup('processPanel');
        // The view loads marked itself (from node_modules); here it is evaluated directly.
        w.eval(readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8'));
        const def = JSON.parse(JSON.stringify(DEF));
        def.phases[0].steps[1].substeps[1] = { id: 'note', name: 'Answer', userAction: true, description: 'Answer the **questions**.' };
        def.phases[0].steps.splice(1, 0, { id: 'check', name: 'Check', userAction: true });
        send(w, panelState({ definition: def }));
        assert.equal(w.document.querySelector('.user-action'), null, 'an agent sub-step: no banner');
        assert.deepEqual($(w, '#sel-step option').map((o) => o.textContent).slice(0, 3), ['1. Code (code)', '2. 👤 Check (check)', '3. Review (review)']);
        assert.deepEqual($(w, '#sel-substep option').map((o) => o.textContent), ['1. Read (read)', '2. 👤 Answer (note)']);
        assert.ok(w.document.querySelector('[data-move="proceed"] .codicon-play'));

        send(w, panelState({ definition: def, state: { ...STATE, substep: 'note' }, moves: [{ kind: 'proceed', level: null, label: 'Confirm done', to: 'Build #2 › Gate #1' }] }));
        const banner = w.document.querySelector('.user-action');
        assert.ok(banner, 'a banner');
        assert.match(banner.textContent, /Your turn/);
        assert.match(banner.textContent, /Answer/);
        assert.equal(banner.querySelector('strong')?.textContent, 'questions', 'the description, rendered');
        assert.match(banner.textContent, /Proceed to confirm/);
        const desc = w.getComputedStyle(banner.querySelector('.ua-desc'));
        assert.match(desc.maxHeight, /^calc\((30vh \+ 2\.8em|2\.8em \+ 30vh)\)$/, 'two lines more than before (term order as the engine writes it)');
        assert.equal(desc.overflowY, 'auto', 'scrolls when longer');
        assert.ok(w.document.querySelector('.actions').compareDocumentPosition(banner) & 4, 'below the action bar');
        const proceed = w.document.querySelector('[data-move="proceed"]');
        assert.ok(proceed.querySelector('.codicon-person'), 'Proceed shows a person');
        assert.ok(proceed.classList.contains('act-user'));
    });
});

describe('process editor', () => {
    const load = (w: Win): void => {
        send(w, { type: 'list', processes: [{ id: 'flow', name: 'Flow', valid: true, errorCount: 0 }, { id: 'other', name: 'Other', valid: true, errorCount: 0 }], roles: ['code_reviewer', 'senior_developer'], currentProcess: 'flow', selected: 'flow' });
        send(w, { type: 'load', id: 'flow', definition: DEF, description: '# Flow', errors: [], files: { yaml: '/p/flow/flow.process.yaml', description: '/p/flow/flow.md' } });
    };
    const field = (w: Win, path: string): Win => w.document.querySelector(`[data-path="${path}"]`);

    test('PW-4: loading and typing', async () => {
        const { w, posted } = setup('processEditor');
        load(w);
        assert.equal(field(w, 'name').value, 'Flow');
        assert.equal(field(w, 'phases.0.steps.0.role').value, 'senior_developer');
        assert.equal(field(w, 'phases.0.repeatable').checked, true);
        assert.equal(field(w, 'phases.0.postGate.todos.0.title').value, 'Tag it');
        assert.equal(w.document.getElementById('process-description').value, '# Flow');
        assert.equal(w.document.querySelector('[data-op="save"]').disabled, true, 'nothing to save yet');
        const name = field(w, 'phases.0.steps.1.name');
        name.value = 'Peer review';
        name.dispatchEvent(new w.Event('input', { bubbles: true }));
        assert.match(w.document.querySelector('.head').textContent, /unsaved/);
        await sleep(350);
        const v = posted.filter((m) => m.type === 'validate').pop() as Win;
        assert.equal(v.definition.phases[0].steps[1].name, 'Peer review');
    });

    test('PW-5: structure and saving', () => {
        const { w, posted } = setup('processEditor');
        load(w);
        w.document.querySelector('[data-op="add-step"][data-path="phases.0"]').click();
        assert.equal(field(w, 'phases.0.steps.2.id').value, 'step3');
        w.document.querySelector('[data-op="up"][data-path="phases.0.steps.2"]').click();
        assert.equal(field(w, 'phases.0.steps.1.id').value, 'step3', 'moved up');
        // Remove both sub-steps of "review" (now steps.2): the list goes.
        w.document.querySelector('[data-op="remove"][data-path="phases.0.steps.2.substeps.1"]').click();
        w.document.querySelector('[data-op="remove"][data-path="phases.0.steps.2.substeps.0"]').click();
        w.document.querySelector('[data-op="remove-postgate"]').click();
        const desc = w.document.getElementById('process-description');
        desc.value = '# Flow\n\nMore.';
        desc.dispatchEvent(new w.Event('input', { bubbles: true }));
        const repeat = field(w, 'phases.0.repeatable');
        repeat.checked = false;
        repeat.dispatchEvent(new w.Event('change', { bubbles: true }));
        w.document.querySelector('[data-op="save"]').click();
        const saved = posted.filter((m) => m.type === 'save').pop() as Win;
        assert.deepEqual(saved.definition.phases[0].steps.map((s: Win) => s.id), ['code', 'step3', 'review']);
        assert.equal('substeps' in saved.definition.phases[0].steps[2], false);
        assert.equal('postGate' in saved.definition.phases[0], false);
        assert.equal('repeatable' in saved.definition.phases[0], false, 'false is left out');
        assert.equal(saved.description, '# Flow\n\nMore.');
        send(w, { type: 'saved', ok: true });
        assert.match(w.document.querySelector('.head').textContent, /Saved\./);
    });

    test('PW-6: errors and switching', () => {
        const { w, posted } = setup('processEditor');
        load(w);
        send(w, { type: 'validation', errors: [{ path: 'phases[0].steps[1].id', message: '"x" is used twice in phase "build"' }] });
        assert.match(w.document.getElementById('errors').textContent, /1 problem/);
        assert.ok(field(w, 'phases.0.steps.1.id').classList.contains('has-error'));
        const name = field(w, 'name');
        name.value = 'Flow 2';
        name.dispatchEvent(new w.Event('input', { bubbles: true }));
        w.document.querySelector('.item[data-id="other"]').click();
        const select = posted.filter((m) => m.type === 'select').pop() as Win;
        assert.deepEqual([select.id, select.dirty, select.definition.name], ['other', true, 'Flow 2']);
    });

    test('PW-13: the user-action checkbox', () => {
        const { w, posted } = setup('processEditor');
        load(w);
        assert.ok(field(w, 'phases.0.steps.0.userAction'), 'a step without sub-steps');
        assert.equal(field(w, 'phases.0.steps.1.userAction'), null, 'not a step with sub-steps');
        assert.ok(field(w, 'phases.0.steps.1.substeps.0.userAction'), 'a sub-step');
        assert.equal(field(w, 'phases.0.gate.userAction'), null, 'not a gate');
        assert.ok(field(w, 'phases.0.postGate.userAction'), 'the post-gate step');
        const box = field(w, 'phases.0.steps.1.substeps.1.userAction');
        box.checked = true;
        box.dispatchEvent(new w.Event('change', { bubbles: true }));
        w.document.querySelector('[data-op="save"]').click();
        const saved = [...posted].reverse().find((m) => m.type === 'save') as Record<string, Win>;
        assert.equal(saved.definition.phases[0].steps[1].substeps[1].userAction, true);
    });

    test('PW-14: where a failed gate goes', () => {
        const { w } = setup('processEditor');
        load(w);
        const pick = field(w, 'phases.0.gate.onFail');
        assert.deepEqual($(w, '[data-path="phases.0.gate.onFail"] option').map((o) => o.textContent), ['Run the gate again', 'Back to 1. Code', 'Back to 2. Review']);
        assert.equal(pick.value, '', 'run it again by default');
        pick.value = 'review';
        pick.dispatchEvent(new w.Event('change', { bubbles: true }));
        w.document.querySelector('[data-op="save"]').click();
        assert.equal(field(w, 'phases.0.gate.onFail').value, 'review');
        assert.equal(field(w, 'phases.0.steps.0.onFail'), null, 'only the gate has one');
    });

    test('PW-8: prompt fields', () => {
        const { w, posted } = setup('processEditor');
        load(w);
        for (const path of ['phases.0', 'phases.0.steps.0', 'phases.0.steps.1.substeps.0', 'phases.0.gate', 'phases.0.postGate']) {
            assert.ok(field(w, `${path}.prompt`), `${path} has a prompt field`);
        }
        const prompt = field(w, 'phases.0.gate.prompt');
        prompt.value = 'Run the gate checklist.';
        prompt.dispatchEvent(new w.Event('input', { bubbles: true }));
        w.document.querySelector('[data-op="save"]').click();
        const saved = posted.filter((m) => m.type === 'save').pop() as Win;
        assert.equal(saved.definition.phases[0].gate.prompt, 'Run the gate checklist.');
    });
});

describe('process editor sessions', () => {
    test('PW-11: session fields', () => {
        const { w, posted } = setup('processEditor');
        send(w, { type: 'list', processes: [{ id: 'flow', name: 'Flow', valid: true, errorCount: 0 }], roles: [], currentProcess: 'flow', selected: 'flow' });
        send(w, { type: 'load', id: 'flow', definition: { ...DEF, phases: [{ ...DEF.phases[0], session: 'build-work' }, DEF.phases[1]] }, description: '', errors: [], files: { yaml: 'y', description: 'd' } });
        const link = (path: string): Win => w.document.querySelector(`button.session-link[data-path="${path}"]`);
        const clear = (path: string): Win => w.document.querySelector(`button[data-op="clear-session"][data-path="${path}"]`);
        assert.equal(link('phases.0').textContent, 'build-work', 'a string spec reads as its name');
        assert.equal(link('').textContent, 'inherited', 'the process level, unset');
        for (const path of ['', 'phases.0', 'phases.0.steps.0', 'phases.0.steps.1.substeps.0', 'phases.0.gate', 'phases.0.postGate']) {
            assert.ok(link(path), `${path || 'the process'} has a session label`);
        }
        assert.equal(w.document.querySelector('input[data-path$=".session.name"]'), null, 'no free-text session fields any more');
        const lastSave = (): Win => {
            w.document.querySelector('[data-op="save"]').click();
            return posted.filter((m) => m.type === 'save').pop() as Win;
        };
        // Each level: click → the host is asked with the node's path → its answer lands there.
        const answers: Array<[string, unknown, string]> = [
            ['', { name: 'tomspecs', mode: 'per-prompt', profile: 'opus-5-5-agent-sdk-mm' }, 'tomspecs, per prompt, opus-5-5-agent-sdk-mm'],
            ['phases.0.steps.1', { name: 'per-review', basedOn: 'build-work', mode: 'per-iteration' }, 'per-review based on build-work, per iteration'],
            ['phases.0.steps.1.substeps.0', 'sub-work', 'sub-work'],
            ['phases.0.gate', 'gate-work', 'gate-work'],
            ['phases.0.postGate', 'tidy-work', 'tidy-work'],
        ];
        for (const [path, spec, label] of answers) {
            link(path).click();
            assert.deepEqual(posted.filter((m) => m.type === 'pickSession').pop(), { type: 'pickSession', path, current: '' });
            send(w, { type: 'sessionPicked', path, spec });
            assert.equal(link(path).textContent, label, path);
        }
        link('phases.0').click();
        assert.deepEqual(posted.filter((m) => m.type === 'pickSession').pop(), { type: 'pickSession', path: 'phases.0', current: 'build-work' });
        let saved = lastSave();
        assert.deepEqual(saved.definition.session, { name: 'tomspecs', mode: 'per-prompt', profile: 'opus-5-5-agent-sdk-mm' });
        assert.deepEqual(saved.definition.phases[0].steps[1].session, { name: 'per-review', basedOn: 'build-work', mode: 'per-iteration' });
        assert.equal(saved.definition.phases[0].steps[1].substeps[0].session, 'sub-work');
        assert.equal(saved.definition.phases[0].gate.session, 'gate-work');
        assert.equal(saved.definition.phases[0].postGate.session, 'tidy-work');
        send(w, { type: 'sessionPicked', path: 'phases.0', spec: null });
        assert.equal(link('phases.0').textContent, 'inherited', 'null from the picker: inherited');
        clear('').click();
        assert.equal(link('').textContent, 'inherited');
        assert.equal(clear('phases.0'), null, 'no clear button when inherited');
        saved = lastSave();
        assert.equal('session' in saved.definition, false, 'cleared at the process level');
        assert.equal('session' in saved.definition.phases[0], false, 'cleared at the phase');
    });
});

describe('process action page', () => {
    const MOVE = {
        type: 'move', kind: 'proceed', level: null, label: 'Proceed', title: 'Proceed — run the current phase, step or sub-step',
        quest: 'q1', process: 'Flow', from: 'Build #2 › Review #1 › Note', to: 'Build #2 › Review #2 › Read',
        startedPrompts: 'Review it.', custom: '', preview: '# Run: Build #2 › Review #1 › Note\n\nReview it.',
        session: { name: 'per-review', source: 'process', basedOn: 'build-work', mode: 'fork-from-base' },
    };

    test('PW-9: confirming a move', async () => {
        const { w, posted } = setup('processAction');
        assert.deepEqual(posted[0], { type: 'ready', custom: '' });
        send(w, MOVE);
        const text = (id: string): string => w.document.getElementById(id).textContent;
        assert.deepEqual([text('label'), text('from'), text('to'), text('started')], ['Proceed', 'Build #2 › Review #1 › Note', 'Build #2 › Review #2 › Read', 'Review it.']);
        assert.deepEqual([...w.document.querySelectorAll('table.move th')].map((th: Win) => th.textContent), ['Process', 'Runs', 'Then', 'Session']);
        assert.equal(text('confirm'), 'Add to queue');
        assert.match(text('preview'), /Review it\./);
        assert.equal(text('session'), 'per-review — from build-work for every prompt (from the process)', 'fork-from-base reads as per-prompt');
        w.document.getElementById('pick-session').click();
        assert.deepEqual(posted.pop(), { type: 'pickSession', custom: '' });
        send(w, { ...MOVE, session: { name: '', source: 'override' } });
        assert.equal(text('session'), 'the queue default (picked here)');
        send(w, MOVE);
        const custom = w.document.getElementById('custom');
        custom.value = 'Mind the glossary.';
        custom.dispatchEvent(new w.Event('input', { bubbles: true }));
        await sleep(350);
        assert.deepEqual(posted.pop(), { type: 'preview', custom: 'Mind the glossary.' });
        send(w, { type: 'preview', preview: '# Run\n\nMind the glossary.' });
        assert.match(text('preview'), /Mind the glossary/);
        send(w, { ...MOVE, preview: '# changed elsewhere' });
        assert.equal(custom.value, 'Mind the glossary.', 'a refresh of the same move keeps what is typed');
        w.document.getElementById('confirm').click();
        assert.deepEqual(posted.pop(), { type: 'confirm', custom: 'Mind the glossary.' });
        assert.equal(w.document.getElementById('confirm').disabled, true, 'no double confirm');
        w.document.getElementById('cancel').click();
        assert.deepEqual(posted.pop(), { type: 'cancel', custom: 'Mind the glossary.' });
        w.document.getElementById('template').click();
        assert.equal((posted.pop() as Win).type, 'editTemplate');
        send(w, { ...MOVE, label: 'Run again', to: 'stays here — you decide how the process goes on', preview: '' });
        assert.equal(text('confirm'), 'Move without a prompt', 'an empty template only moves');
        assert.equal(text('to'), 'stays here — you decide how the process goes on');
        send(w, { type: 'unavailable', kind: 'proceed', quest: 'q1' });
        assert.equal(w.document.getElementById('page').hidden, true);
        assert.match(text('unavailable'), /not possible at the current position/);
    });
});

describe('process template editor', () => {
    const LOAD = {
        type: 'load', selected: 'repeat',
        kinds: [
            { kind: 'next', title: 'Next', text: 'Next: ${step}', defaultText: 'Next: ${step}' },
            { kind: 'repeat', title: 'Repeat', text: 'Again: ${step}', defaultText: 'Again: ${step}' },
            { kind: 'skip', title: 'Skip', text: '', defaultText: '' },
        ],
        variables: [{ group: 'Action', items: [{ name: 'custom-instructions', description: 'typed' }] }, { group: 'Process', items: [{ name: 'step-prompt', description: '' }] }],
    };

    test('PW-10: editing templates', async () => {
        const { w, posted } = setup('processTemplateEditor');
        assert.deepEqual(posted[0], { type: 'ready' });
        send(w, LOAD);
        const text = w.document.getElementById('text');
        assert.equal(text.value, 'Again: ${step}', 'opens on the kind asked for');
        assert.equal(w.document.getElementById('save').disabled, true);
        text.selectionStart = text.selectionEnd = 7;
        w.document.querySelector('[data-var="custom-instructions"]').click();
        assert.equal(text.value, 'Again: ${custom-instructions}${step}');
        assert.match(w.document.querySelector('.item.selected').textContent, /repeat ●.*custom/);
        assert.equal(w.document.getElementById('save').disabled, false);
        await sleep(350);
        assert.deepEqual(posted.filter((m) => m.type === 'preview').pop(), { type: 'preview', kind: 'repeat', text: 'Again: ${custom-instructions}${step}' });
        send(w, { type: 'preview', kind: 'repeat', offered: false, label: '', preview: '' });
        assert.match(w.document.getElementById('preview-note').textContent, /not offered/);
        w.document.querySelector('.item[data-kind="next"]').click();
        assert.equal(text.value, 'Next: ${step}');
        text.value = '';
        text.dispatchEvent(new w.Event('input', { bubbles: true }));
        assert.match(w.document.querySelector('.item.selected').textContent, /empty/);
        w.document.getElementById('reset').click();
        assert.equal(text.value, 'Next: ${step}', 'back to the default');
        w.document.getElementById('save').click();
        assert.deepEqual(posted.filter((m) => m.type === 'save').pop(),
            { type: 'save', templates: { next: 'Next: ${step}', repeat: 'Again: ${custom-instructions}${step}', skip: '' } });
    });

});
