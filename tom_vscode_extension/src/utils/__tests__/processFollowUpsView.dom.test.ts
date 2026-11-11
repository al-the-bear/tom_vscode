/**
 * Follow-up processes (vscimpb47) in the PROCESS view and the process editor, in a JSDOM running their real
 * scripts against a stand-in host.
 *
 *   FV-1 the PROCESS view: a state switched to by follow-ups shows the chain ("Continued from …", each origin with
 *        what it carried and its call context, the process now last); none without one; the decision banner lists
 *        the "Continue in …" option with where it leads
 *   FV-2 the process editor: Follow-up processes on the process, a phase and a step — add one, pick the process, then
 *        its phase (the process's phases offered) and step (that phase's steps), carry and the call context; Save
 *        holds {process, phase, step, carry, context}; another process clears the phase and step; the host sends
 *        each process's phases and steps
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { stringifyProcessDefinition, type ProcessDefinition, type ProcessState } from '../processDefinition.js';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (panel: string, file: string): string => readFileSync(join(ROOT, 'media', panel, file), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(panel: string): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset(panel, 'index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const w = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true }).window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => undefined });
    w.eval(asset(panel, 'main.js'));
    return { w, posted };
}
const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const text = (el: Win): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const SPECS: ProcessDefinition = {
    id: 'specs', name: 'Specs', phases: [{ id: 'p2', name: 'Phase 2', steps: [{ id: 'draft', name: 'Draft' }], gate: { id: 'g2' } }],
} as ProcessDefinition;
const IN_SPECS: ProcessState = { process: 'specs', phase: 'p2', phaseIteration: 1, step: 'draft', stepIteration: 1, substep: '', substepIteration: 1, completed: false };

function viewState(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: 'state', quest: 'q1',
        processes: [{ id: 'change', name: 'Spec Change', valid: true }, { id: 'specs', name: 'Specs', valid: true }],
        state: IN_SPECS, definition: SPECS, description: '', stepRole: '', chatRole: '', stepRun: null,
        moves: [{ kind: 'proceed', level: null, label: 'Proceed', to: 'Phase 2 › g2' }],
        levels: [], startable: 0,
        ...over,
    };
}

describe('follow-up processes: view and editor', () => {
    test('FV-1: the PROCESS view', () => {
        const { w } = setup('processPanel');
        try {
            send(w, viewState());
            assert.equal(w.document.querySelector('.origin-chain'), null, 'no chain without a follow-up');
            send(w, viewState({
                origins: [
                    { process: 'Spec Change', where: 'Intent', level: 'phase', at: '2026-11-11T12:00:00Z', carried: { change: 'CHG-7' }, context: { scope: 'CHG-7' } },
                ],
            }));
            const box = w.document.querySelector('.origin-chain');
            assert.ok(box, 'the chain is shown');
            assert.equal(text(box.querySelector('summary')), 'Continued from Spec Change');
            assert.deepEqual([...box.querySelectorAll('li')].map(text), [
                "Spec Change › Intent (the phase's follow-up)carried: change = CHG-7; context: scope = CHG-7",
                'Specs (now)',
            ]);
            // At a decision, the banner lists the Continue in … option.
            send(w, viewState({
                state: { ...IN_SPECS, step: 'g2', decision: true },
                moves: [
                    { kind: 'proceed', level: null, label: 'Decide…', to: '' },
                    { kind: 'gate-passed', level: null, label: 'Gate passed — Finish the process', to: '', branchOption: true },
                    { kind: 'follow-up', level: null, label: 'Gate passed — Continue in Spec Change › Close', to: 'change › Close › wrap', branchOption: true },
                ],
            }));
            const options = [...w.document.querySelectorAll('.bd-options li')];
            assert.deepEqual(options.map(text), ['Gate passed — Finish the process', 'Gate passed — Continue in Spec Change › Close']);
            assert.equal(options[1].getAttribute('title'), 'change › Close › wrap');
        } finally { w.close(); }
    });

    test('FV-2: the process editor', () => {
        const { w, posted } = setup('processEditor');
        try {
            send(w, { type: 'list', processes: [
                { id: 'change', name: 'Spec Change', valid: true, inputs: [], phases: [{ id: 'intent', name: 'Intent', steps: [{ id: 'capture', name: '' }, { id: 'gate1', name: '' }] }] },
                { id: 'specs', name: 'Specs', valid: true, inputs: [], phases: [{ id: 'p2', name: 'Phase 2', steps: [{ id: 'draft', name: 'Draft' }, { id: 'g2', name: '' }] }, { id: 'p3', name: '', steps: [{ id: 'build', name: '' }, { id: 'g3', name: '' }] }] },
            ], roles: [], currentProcess: '' });
            send(w, { type: 'load', id: 'change', definition: { id: 'change', phases: [{ id: 'intent', steps: [{ id: 'capture' }], gate: { id: 'gate1' } }] }, description: '', errors: [], files: { definition: 'change.process.yaml', description: 'change.md' } });
            const doc = w.document;
            const change = (sel: string, value: string, event = 'change'): void => {
                const el = doc.querySelector(sel);
                assert.ok(el, sel);
                el.value = value;
                el.dispatchEvent(new w.Event(event, { bubbles: true }));
            };
            // Offered on the process, the phase and every step (the gate too), not on a sub-step.
            for (const p of ['followUps', 'phases.0.followUps', 'phases.0.steps.0.followUps', 'phases.0.gate.followUps']) {
                assert.ok(doc.querySelector(`[data-op="add-entry"][data-path="${p}"]`), p);
            }
            doc.querySelector('[data-op="add-entry"][data-path="phases.0.followUps"]').click();
            assert.equal(doc.querySelector('[data-path="phases.0.followUps.0.phase"]').disabled, true, 'no process yet: no phase');
            change('[data-path="phases.0.followUps.0.process"]', 'specs');
            const phases = [...doc.querySelector('[data-path="phases.0.followUps.0.phase"]').options].map((o: Win) => o.value);
            assert.deepEqual(phases, ['', 'p2', 'p3'], 'the process\'s phases');
            change('[data-path="phases.0.followUps.0.phase"]', 'p2');
            assert.deepEqual([...doc.querySelector('[data-path="phases.0.followUps.0.step"]').options].map((o: Win) => o.value), ['', 'draft', 'g2'], 'that phase\'s steps');
            change('[data-path="phases.0.followUps.0.step"]', 'draft');
            change('[data-path="phases.0.followUps.0.carry"]', 'change, scope-note', 'input');
            change('[data-path="phases.0.followUps.0.context"]', 'scope: ${change}\nnote: from the impact evaluation', 'input');
            change('[data-path="phases.0.followUps.0.description"]', 'the change in the specification', 'input');
            doc.querySelector('[data-op="add-entry"][data-path="followUps"]').click();
            change('[data-path="followUps.0.process"]', 'specs');
            doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
            const saved = (posted.filter((m) => m.type === 'save').pop() as Win).definition;
            assert.deepEqual(saved.phases[0].followUps, [{
                process: 'specs', phase: 'p2', step: 'draft', carry: ['change', 'scope-note'],
                context: { scope: '${change}', note: 'from the impact evaluation' }, description: 'the change in the specification',
            }]);
            assert.deepEqual(saved.followUps, [{ process: 'specs' }]);
            assert.match(stringifyProcessDefinition(saved), /followUps:\n\s+- process: specs\n\s+phase: p2\n\s+step: draft\n\s+description: the change in the specification\n\s+carry:\n\s+- change\n\s+- scope-note\n\s+context:\n\s+scope: \$\{change\}/);
            // Another process: its phase and step go.
            change('[data-path="phases.0.followUps.0.process"]', 'change');
            doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
            const again = (posted.filter((m) => m.type === 'save').pop() as Win).definition.phases[0].followUps[0];
            assert.deepEqual([again.process, again.phase, again.step], ['change', undefined, undefined]);
        } finally { w.close(); }
        const host = readFileSync(join(ROOT, 'src', 'handlers', 'processEditor-handler.ts'), 'utf-8');
        assert.match(host, /phases: \(e\.definition\?\.phases \?\? \[\]\)\.map\(\(ph\) => \(\{/, 'the host sends each process\'s phases and steps');
        assert.match(host, /return validateProcessDefinition\(def, \{ profileIds, processOf \}\);/, 'the editor checks the targets');
    });
});
