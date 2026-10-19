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
const STATE = { process: 'flow', phase: 'build', phaseIteration: 2, step: 'review', stepIteration: 1, substep: 'read', substepIteration: 1 };
const panelState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'state', quest: 'q1', processes: [{ id: 'flow', name: 'Flow', valid: true }, { id: 'bad', name: 'bad', valid: false }],
    state: STATE, definition: DEF, processInvalid: false, description: '# Flow', stepRole: '', chatRole: 'default', ...over,
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
});
