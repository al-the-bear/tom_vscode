/**
 * The PROCESS view, the process branching editor and the process editor for nested processes
 * (ccparity_e_process-7), in a JSDOM running their real scripts against a stand-in host.
 *
 *   NV-1  the branching cards: both lists (closed — only listed processes), a card's summary, where it starts,
 *         the inputs the step fills, an undefined process that cannot start; an agent's suggestion first with
 *         its reason and recommended follow-up, a suggestion of an unlisted process dropped
 *   NV-2  PROCESS view with one level: as before — the Process dropdown in its row, no level sections
 *   NV-3  PROCESS view with a stack: every lower level an accordion section (collapsed; kind, name,
 *         position, waiting, its follow-up / inputs / handed-back outputs), the quest's own process dropdown
 *         only in the bottom section (an arbitrary process is reached only there); the running level open
 *         with its kind (a branch labelled as a branch), Abort (posts abortNested), its inputs and outputs, and
 *         its process shown, not switchable; an opened lower section stays open on the next state
 *   NV-4  the Your turn box at a user-action step: "Start a subprocess or branch…" when the step lists any
 *         (posts openBranching), none when it lists none
 *   NV-5  the branching page: one card per process with its follow-up choice (the recommendation selected and
 *         marked), Start posts the card's kind, process and the chosen follow-up, a card that cannot start has
 *         Start disabled, Dismiss posts dismiss
 *   NV-6  the process editor: a step's Subprocesses and Branches lists — add an entry, pick a process, the
 *         process's declared inputs appear to be filled, Save holds {process, inputs}; another process empties
 *         the mapping; the writer folds an entry with nothing but its process back to the bare id
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { branchingCards } from '../processBranchingPlan.js';
import { positionText } from '../processActionPrompt.js';
import { stringifyProcessDefinition, type ProcessDefinition, type ProcessState } from '../processDefinition.js';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (panel: string, file: string): string => readFileSync(join(ROOT, 'media', panel, file), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(panel: string, init?: Record<string, unknown>): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset(panel, 'index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const w = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true }).window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => undefined });
    if (init) { w.__INIT__ = init; }
    w.eval(asset(panel, 'main.js'));
    return { w, posted };
}
const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const $ = (w: Win, sel: string): Win[] => [...w.document.querySelectorAll(sel)];

const MAIN: ProcessDefinition = {
    id: 'main', name: 'Main', phases: [{
        id: 'p1', steps: [
            { id: 'review', name: 'Review', userAction: true, subprocesses: ['team', { process: 'gone' }], branches: [{ process: 'side', description: 'explore an alternative' }] },
            { id: 'build', name: 'Build' },
        ], gate: { id: 'g' },
    }],
} as ProcessDefinition;
const TEAM: ProcessDefinition = {
    id: 'team', name: 'Team review', summary: 'Several reviewers, one merged copy',
    inputs: [{ name: 'documents', kind: 'documents', required: true }, { name: 'folder', kind: 'folder' }],
    phases: [{ id: 'prep', name: 'Prepare', steps: [{ id: 'dist', name: 'Distribute' }], gate: { id: 'g' } }],
} as ProcessDefinition;
const SIDE: ProcessDefinition = { id: 'side', name: 'Side', phases: [{ id: 'a', steps: [{ id: 'b' }], gate: { id: 'g' } }] } as ProcessDefinition;
(MAIN.phases[0].steps[0].subprocesses as unknown[])[0] = { process: 'team', inputs: { documents: '${step-folder}/*.md' } };
const AT_REVIEW: ProcessState = { process: 'main', phase: 'p1', phaseIteration: 1, step: 'review', stepIteration: 1, substep: '', substepIteration: 1, completed: false };
const DEFS = new Map([['main', MAIN], ['team', TEAM], ['side', SIDE]]);

function viewState(levels: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: 'state', quest: 'q1',
        processes: [{ id: 'main', name: 'Main', valid: true }, { id: 'team', name: 'Team review', valid: true }, { id: 'side', name: 'Side', valid: true }],
        state: AT_REVIEW, definition: MAIN, description: '', stepRole: '', chatRole: '', stepRun: null,
        moves: [{ kind: 'proceed', level: null, label: 'Confirm done', to: 'Build' }],
        levels, startable: 3,
        ...over,
    };
}
const level = (index: number, process: string, kind: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    index, process, name: process === 'main' ? 'Main' : process, kind, position: 'P1 › Review', followUp: kind === 'process' ? '' : 'Go on past the step',
    startedAt: '', inputs: {}, outputs: {}, subOutputs: {}, running: false, ...over,
});

describe('nested processes: view, branching editor, process editor', () => {
    test('NV-1: the branching cards', () => {
        const cards = branchingCards(MAIN, AT_REVIEW, DEFS, positionText, [
            { kind: 'branch', process: 'side', reason: 'the review found two ways', followUp: 'run-again' },
            { kind: 'subprocess', process: 'other', reason: 'not listed' },
        ]);
        assert.deepEqual(cards.map((c) => [c.kind, c.process]), [['branch', 'side'], ['subprocess', 'team'], ['subprocess', 'gone']], 'the suggestion first; the unlisted one dropped');
        assert.deepEqual([cards[0].reason, cards[0].followUp, cards[0].recommended, cards[0].description], ['the review found two ways', 'run-again', true, 'explore an alternative']);
        const team = cards[1];
        assert.deepEqual([team.name, team.summary, team.valid, team.followUp, team.recommended, team.reason], ['Team review', 'Several reviewers, one merged copy', true, 'ask', false, undefined]);
        assert.match(team.startsAt, /Prepare.*Distribute/);
        assert.deepEqual(team.inputs, [{ name: 'documents', kind: 'documents', required: true, from: '${step-folder}/*.md' }, { name: 'folder', kind: 'folder', required: false, from: '' }]);
        assert.deepEqual([cards[2].valid, cards[2].startsAt], [false, ''], 'an undefined process cannot start');
        assert.deepEqual(branchingCards(MAIN, { ...AT_REVIEW, step: 'build' }, DEFS, positionText), [], 'a step without lists offers nothing');
    });

    test('NV-2: one level', () => {
        const { w } = setup('processPanel');
        try {
            send(w, viewState([level(0, 'main', 'process', { running: true })]));
            assert.equal($(w, 'details.level').length, 0);
            assert.equal($(w, '#sel-process').length, 1);
            assert.equal($(w, '[data-abort]').length, 0);
        } finally { w.close(); }
    });

    test('NV-3: a stack of levels', () => {
        const { w, posted } = setup('processPanel');
        try {
            const levels = [
                level(0, 'main', 'process'),
                level(1, 'team', 'subprocess', { position: 'Prepare › Distribute', inputs: { documents: 'a.md' }, subOutputs: { side: { result: 'r.md' } } }),
                level(2, 'side', 'branch', { running: true, position: 'A › B', followUp: 'Ask me at the end (Go on / Run the step again)', inputs: { x: '1' }, outputs: { y: '2' } }),
            ];
            send(w, viewState(levels, { state: { process: 'side', phase: 'a', phaseIteration: 1, step: 'b', stepIteration: 1, substep: '', substepIteration: 1, completed: false }, definition: SIDE, startable: 0 }));
            const sections = $(w, 'details.level');
            assert.equal(sections.length, 2, 'one section per lower level');
            assert.deepEqual(sections.map((d: Win) => d.open), [false, false], 'collapsed');
            assert.match(sections[0].querySelector('summary').textContent, /Quest process\s+Main — P1 › Review · waiting/);
            assert.match(sections[1].querySelector('summary').textContent, /Subprocess\s+team — Prepare › Distribute · waiting/);
            assert.match(sections[1].textContent, /When it ends Go on past the step/);
            assert.match(sections[1].textContent, /Inputs documents = a\.md/);
            assert.match(sections[1].textContent, /Handed back \$\{sub\.side\.result\} = r\.md/);
            assert.equal($(w, '#sel-process').length, 1);
            assert.ok(sections[0].querySelector('#sel-process'), 'the quest\'s own process is switched only in the bottom section');
            assert.equal(w.document.getElementById('sel-process').value, 'main');
            const head = w.document.querySelector('.level-head.running');
            assert.match(head.textContent, /Branch\s+side/, 'a branch labelled as a branch');
            assert.match(w.document.querySelector('.running-level').textContent, /When it ends the step below: Ask me at the end[\s\S]*Inputs x = 1[\s\S]*Outputs set y = 2/);
            assert.match(w.document.querySelector('.running-level').textContent, /Process\s*side/, 'the running process shown, not a dropdown');
            head.querySelector('[data-abort]').click();
            assert.equal(posted.pop()?.type, 'abortNested');
            sections[1].open = true;
            sections[1].dispatchEvent(new w.Event('toggle'));
            send(w, viewState(levels, { state: { process: 'side', phase: 'a', phaseIteration: 1, step: 'b', stepIteration: 1, substep: '', substepIteration: 1, completed: false }, definition: SIDE, startable: 0 }));
            assert.deepEqual($(w, 'details.level').map((d: Win) => d.open), [false, true], 'kept open');
        } finally { w.close(); }
    });

    test('NV-4: the Your turn box', () => {
        const { w, posted } = setup('processPanel');
        try {
            send(w, viewState([level(0, 'main', 'process', { running: true })]));
            const btn = w.document.querySelector('.user-action [data-branching]');
            assert.ok(btn, 'at a user-action step that lists processes');
            assert.match(btn.textContent, /Start a subprocess or branch…/);
            btn.click();
            assert.equal(posted.pop()?.type, 'openBranching');
            send(w, viewState([level(0, 'main', 'process', { running: true })], { startable: 0 }));
            assert.equal(w.document.querySelector('.user-action [data-branching]'), null, 'none when the step lists none');
        } finally { w.close(); }
    });

    test('NV-5: the branching page', () => {
        const cards = branchingCards(MAIN, AT_REVIEW, DEFS, positionText, [{ kind: 'branch', process: 'side', reason: 'two ways', followUp: 'run-again' }]);
        const followUps = [{ value: 'ask', label: 'Ask me at the end' }, { value: 'go-on', label: 'Go on past the step' }, { value: 'run-again', label: 'Run the step again' }];
        const { w, posted } = setup('processBranching', { step: 'P1 › Review', process: 'Main', cards, followUps });
        try {
            const els = $(w, '.card');
            assert.equal(els.length, 3);
            assert.match(w.document.getElementById('title').textContent, /Start from P1 › Review \(Main\)/);
            assert.match(els[0].textContent, /Branch\s*Side[\s\S]*Suggested: two ways/);
            const sel = els[0].querySelector('select.follow-up');
            assert.equal(sel.value, 'run-again');
            assert.match(sel.selectedOptions[0].textContent, /\(recommended\)/);
            assert.match(els[1].textContent, /Subprocess\s*Team review[\s\S]*Starts at[\s\S]*Inputs[\s\S]*documents[\s\S]*\$\{step-folder\}\/\*\.md[\s\S]*folder[\s\S]*not filled/);
            els[1].querySelector('select.follow-up').value = 'go-on';
            els[1].querySelector('button.start').click();
            assert.deepEqual(posted.pop(), { type: 'start', kind: 'subprocess', process: 'team', followUp: 'go-on' });
            assert.equal(els[2].querySelector('button.start').disabled, true, 'an undefined process cannot start');
            w.document.getElementById('btnDismiss').click();
            assert.deepEqual(posted.pop(), { type: 'dismiss' });
        } finally { w.close(); }
    });

    test('NV-6: the editor\'s lists', () => {
        const { w, posted } = setup('processEditor');
        try {
            send(w, { type: 'list', processes: [{ id: 'main', name: 'Main', valid: true, inputs: [] }, { id: 'team', name: 'Team review', valid: true, inputs: [{ name: 'documents', kind: 'documents', required: true, description: 'what to review' }] }, { id: 'side', name: 'Side', valid: true, inputs: [] }], roles: [], currentProcess: '' });
            send(w, { type: 'load', id: 'main', definition: { id: 'main', phases: [{ id: 'p1', steps: [{ id: 'review', branches: ['side'] }], gate: { id: 'g' } }] }, description: '', errors: [], files: { definition: 'main.process.yaml', description: 'main.md' } });
            const doc = w.document;
            assert.equal(doc.querySelector('[data-path="phases.0.steps.0.branches.0.process"]').value, 'side', 'a bare id is shown as its entry');
            doc.querySelector('[data-op="add-entry"][data-path="phases.0.steps.0.subprocesses"]').click();
            const pick = doc.querySelector('[data-path="phases.0.steps.0.subprocesses.0.process"]');
            pick.value = 'team';
            pick.dispatchEvent(new w.Event('change', { bubbles: true }));
            const map = doc.querySelector('[data-path="phases.0.steps.0.subprocesses.0.inputs.documents"]');
            assert.ok(map, 'the process\'s declared inputs to fill');
            map.value = '${step-folder}/*.md';
            map.dispatchEvent(new w.Event('input', { bubbles: true }));
            doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
            const saved = posted.filter((m) => m.type === 'save').pop() as Win;
            const step = saved.definition.phases[0].steps[0];
            assert.deepEqual(step.subprocesses, [{ process: 'team', inputs: { documents: '${step-folder}/*.md' } }]);
            assert.deepEqual(step.branches, [{ process: 'side' }]);
            assert.match(stringifyProcessDefinition(saved.definition), /branches:\n\s+- side\n/, 'the writer folds it back to the id');
            assert.match(stringifyProcessDefinition(saved.definition), /subprocesses:\n\s+- process: team\n\s+inputs:\n\s+documents: \$\{step-folder\}\/\*\.md/);
            const again = doc.querySelector('[data-path="phases.0.steps.0.subprocesses.0.process"]');
            again.value = 'side';
            again.dispatchEvent(new w.Event('change', { bubbles: true }));
            assert.equal(doc.querySelector('[data-path="phases.0.steps.0.subprocesses.0.inputs.documents"]'), null, 'another process: the mapping goes');
            doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
            assert.deepEqual((posted.filter((m) => m.type === 'save').pop() as Win).definition.phases[0].steps[0].subprocesses, [{ process: 'side' }]);
        } finally { w.close(); }
    });
});
