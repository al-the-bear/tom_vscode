/**
 * Process actions: the template per move kind and the values it is resolved
 * with (src/utils/processActionPrompt.ts).
 *
 *   PA-1 a configured template wins, an empty one included (it queues nothing); otherwise the default
 *   PA-2 the values describe where the move leads: process variables of the target, the role it names,
 *        the custom instructions, the label / level / iteration of the move, where it came from
 *   PA-3 `action-prompt` holds the prompt fields of what the move starts — a new phase its phase, step
 *        and sub-step prompts, a new step its step and sub-step, a sub-step its own; nothing on finish
 *   PA-5 a position for people: names (else ids) joined by ›, iterations where a level repeats
 *   PA-4 the default templates name only variables an action provides, and skip / back queue nothing
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    PROCESS_VARIABLE_KEYS,
    availableMoves,
    parseProcessYaml,
    selectProcess,
    selectStep,
    selectSubstep,
    type ProcessDefinition,
    type ProcessMoveKind,
    type ProcessState,
} from '../processDefinition.js';
import {
    DEFAULT_PROCESS_ACTION_TEMPLATES,
    PROCESS_ACTION_VARIABLES,
    processActionTemplate,
    processActionValues,
    positionText,
} from '../processActionPrompt.js';

const YAML = `
id: flow
phases:
  - id: one
    prompt: Phase one.
    repeatable: true
    steps:
      - id: a
        role: author
        prompt: Do A.
      - id: b
        repeatable: true
        prompt: Do B.
        substeps:
          - id: b1
            prompt: Do B1.
          - id: b2
            role: checker
            prompt: Do B2.
    gate:
      id: g
      prompt: Check the gate.
  - id: two
    prompt: Phase two.
    steps:
      - id: c
        prompt: Do C.
    gate:
      id: g
`;

function def(): ProcessDefinition {
    const parsed = parseProcessYaml(YAML);
    assert.deepEqual(parsed.errors, []);
    return parsed.definition!;
}

function move(d: ProcessDefinition, s: ProcessState, kind: ProcessMoveKind, level?: string) {
    const m = availableMoves(d, s).find((x) => x.kind === kind && (level === undefined || x.level === level));
    assert.ok(m, `${kind} offered`);
    return m!;
}

describe('process action prompts', () => {
    test('PA-1: which template', () => {
        assert.equal(processActionTemplate('next'), DEFAULT_PROCESS_ACTION_TEMPLATES.next);
        assert.equal(processActionTemplate('next', { next: 'Go on: ${step}' }), 'Go on: ${step}');
        assert.equal(processActionTemplate('next', { next: '' }), '', 'an empty template is a choice: nothing is queued');
        assert.equal(processActionTemplate('repeat', { next: 'x' }), DEFAULT_PROCESS_ACTION_TEMPLATES.repeat);
    });

    test('PA-2: the values of a move', () => {
        const d = def();
        const start = selectProcess(d);
        const next = move(d, start, 'next');
        const v = processActionValues(d, start, next, '  Mind the glossary.  ', 'The process.');
        assert.equal(v.step, 'b');
        assert.equal(v.substep, 'b1');
        assert.equal(v['step-prompt'], 'Do B.');
        assert.equal(v['custom-instructions'], 'Mind the glossary.');
        assert.equal(v['process-description'], 'The process.');
        assert.equal(v.action, 'next');
        assert.equal(v['action-label'], 'Next');
        assert.equal(v['action-target'], 'one / b / b1');
        assert.deepEqual([v['from-phase'], v['from-step'], v['from-substep']], ['one', 'a', '']);
        assert.equal(v.role, undefined, 'the target names no role: the chat role stays');
        const b2 = selectSubstep(selectStep(start, d, 'b'), d, 'b2');
        const rep = move(d, b2, 'repeat', 'step');
        const rv = processActionValues(d, b2, rep, '', '');
        assert.deepEqual([rv['action-label'], rv['action-level'], rv['action-iteration']], ['Repeat step', 'step', '2']);
        assert.equal(processActionValues(d, start, move(d, selectSubstep(selectStep(start, d, 'b'), d, 'b1'), 'next'), '', '').role, 'checker');
    });

    test('PA-3: what the move starts', () => {
        const d = def();
        const start = selectProcess(d);
        const prompt = (s: ProcessState, kind: ProcessMoveKind, level?: string): string =>
            processActionValues(d, s, move(d, s, kind, level), '', '')['action-prompt'];
        assert.equal(prompt(start, 'next'), 'Do B.\n\nDo B1.', 'a new step: its prompt and its first sub-step\'s');
        const b1 = selectStep(start, d, 'b');
        assert.equal(prompt(b1, 'next'), 'Do B2.', 'a sub-step: its own');
        const b2 = selectSubstep(b1, d, 'b2');
        assert.equal(prompt(b2, 'repeat', 'step'), 'Do B.\n\nDo B1.', 'a new step iteration starts the step again');
        assert.equal(prompt(b2, 'finish'), 'Check the gate.');
        const gate = selectStep(start, d, 'g');
        assert.equal(prompt(gate, 'gate-passed'), 'Phase two.\n\nDo C.', 'a new phase: the phase and its first step');
        assert.equal(prompt(gate, 'repeat', 'phase'), 'Phase one.\n\nDo A.');
        assert.equal(prompt(gate, 'gate-failed'), 'Check the gate.');
        const last = selectStep(selectStep({ ...start, phase: 'two', step: 'c' }, d, 'c'), d, 'g');
        assert.equal(prompt(last, 'finish-process'), '', 'finishing starts nothing');
    });

    test('PA-4: the default templates', () => {
        const known = new Set<string>([...PROCESS_VARIABLE_KEYS, ...PROCESS_ACTION_VARIABLES.map((v) => v.name)]);
        for (const [kind, template] of Object.entries(DEFAULT_PROCESS_ACTION_TEMPLATES)) {
            for (const m of template.replace(/\$\{\{[\s\S]*?\}\}/g, '').matchAll(/\$\{([^{}]+)\}/g)) {
                assert.ok(known.has(m[1]), `${kind}: \${${m[1]}} is not provided`);
            }
            for (const m of template.matchAll(/vars(?:\.(\w+)|\["([^"]+)"\])/g)) {
                assert.ok(known.has(m[1] ?? m[2]), `${kind}: vars ${m[1] ?? m[2]} is not provided`);
            }
        }
        assert.equal(DEFAULT_PROCESS_ACTION_TEMPLATES.skip, '');
        assert.equal(DEFAULT_PROCESS_ACTION_TEMPLATES.back, '');
    });
    test('PA-5: a position for people', () => {
        const d = def();
        const b2 = selectSubstep(selectStep(selectProcess(d), d, 'b'), d, 'b2');
        assert.equal(positionText(d, { ...b2, stepIteration: 2 }), 'one #1 › b #2 › b2');
        assert.equal(positionText(d, selectStep(selectProcess(d), d, 'g')), 'one #1 › g #1', 'a gate counts its runs');
        assert.equal(positionText(d, { ...selectProcess(d), completed: true }), 'one #1 › a (finished)');
    });
});
