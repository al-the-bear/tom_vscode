/**
 * Process actions: the Proceed template and the values it is resolved with
 * (src/utils/processActionPrompt.ts). Proceed runs the CURRENT position; every
 * other move only moves the state and has no template.
 *
 *   PA-1 a configured template wins, an empty one included (it queues nothing); otherwise the default
 *   PA-2 the values describe the position being run: its process variables, the role it names, the
 *        custom instructions, the label, where the state goes after queuing, and what the prompt is told
 *        about that (moved on / stays for the user's decision)
 *   PA-3 `action-prompt` holds the prompt fields of what runs here — at a phase's first step the phase,
 *        step and first sub-step prompts, at a step's first sub-step the step and sub-step, else the
 *        sub-step's own; `action-note` names a repeated run (another iteration, a gate run again)
 *   PA-5 a position for people: names (else ids) joined by ›, iterations where a level repeats
 *   PA-6 the session: picked on the page, else the process's for the position being run, else the
 *        queue default
 *   PA-4 the default template names only variables an action provides
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    PROCESS_VARIABLE_KEYS,
    availableMoves,
    parseProcessYaml,
    selectPhase,
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
    actionSession,
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
        assert.equal(processActionTemplate('proceed'), DEFAULT_PROCESS_ACTION_TEMPLATES.proceed);
        assert.equal(processActionTemplate('proceed', { proceed: 'Go on: ${step}' }), 'Go on: ${step}');
        assert.equal(processActionTemplate('proceed', { proceed: '' }), '', 'an empty template is a choice: nothing is queued');
    });

    test('PA-2: the values of a run', () => {
        const d = def();
        const start = selectProcess(d);
        const proceed = move(d, start, 'proceed');
        const v = processActionValues(d, start, proceed, '  Mind the glossary.  ', 'The process.');
        assert.equal(v.step, 'a', 'the position being run, not the one the state moves to');
        assert.equal(v.substep, '');
        assert.equal(v['step-prompt'], 'Do A.');
        assert.equal(v['custom-instructions'], 'Mind the glossary.');
        assert.equal(v['process-description'], 'The process.');
        assert.equal(v.action, 'proceed');
        assert.equal(v['action-label'], 'Proceed');
        assert.equal(v['action-position'], 'one #1 › a');
        assert.equal(v['action-target'], 'one / b / b1', 'where the state goes after queuing');
        assert.match(v['action-after'], /moved on to one #1 › b #1 › b1; that runs only when the user proceeds again/);
        assert.equal(v.role, 'author', 'the role of the step being run');
        const b2 = selectSubstep(selectStep(start, d, 'b'), d, 'b2');
        const decide = processActionValues(d, b2, move(d, b2, 'proceed'), '', '');
        assert.equal(decide.role, 'checker');
        assert.match(decide['action-after'], /stays at this position until the user decides/, 'a decision point: the state stays');
        const again = move(d, move(d, b2, 'proceed').target, 'proceed');
        assert.equal(processActionValues(d, again.target, again, '', '')['action-label'], 'Run again');
    });

    test('PA-3: what runs here', () => {
        const d = def();
        const start = selectProcess(d);
        const prompt = (s: ProcessState): string => processActionValues(d, s, move(d, s, 'proceed'), '', '')['action-prompt'];
        const note = (s: ProcessState): string => processActionValues(d, s, move(d, s, 'proceed'), '', '')['action-note'];
        assert.equal(prompt(start), 'Phase one.\n\nDo A.', 'the first step of a phase: the phase and the step');
        const b1 = selectStep(start, d, 'b');
        assert.equal(prompt(b1), 'Do B.\n\nDo B1.', 'the first sub-step: the step and the sub-step');
        const b2 = selectSubstep(b1, d, 'b2');
        assert.equal(prompt(b2), 'Do B2.', 'a later sub-step: its own');
        assert.equal(prompt(selectStep(start, d, 'g')), 'Check the gate.');
        assert.equal(prompt(selectPhase(start, d, 'two')), 'Phase two.\n\nDo C.');
        assert.equal(note(start), '', 'a first run: no note');
        assert.match(note({ ...b1, stepIteration: 2 }), /Iteration 2 of the step starts here/);
        assert.equal(note({ ...b2, stepIteration: 2 }), '', 'inside the iteration, past its start: no note');
        assert.match(note({ ...selectStep(start, d, 'g'), stepIteration: 3 }), /run 3 of the gate: the previous run did not pass/);
        assert.match(note({ ...start, phaseIteration: 2 }), /Iteration 2 of the phase starts here/);
    });

    test('PA-4: the default template', () => {
        const known = new Set<string>([...PROCESS_VARIABLE_KEYS, ...PROCESS_ACTION_VARIABLES.map((v) => v.name)]);
        for (const [kind, template] of Object.entries(DEFAULT_PROCESS_ACTION_TEMPLATES)) {
            for (const m of template.replace(/\$\{\{[\s\S]*?\}\}/g, '').matchAll(/\$\{([^{}]+)\}/g)) {
                assert.ok(known.has(m[1]), `${kind}: \${${m[1]}} is not provided`);
            }
            for (const m of template.matchAll(/vars(?:\.(\w+)|\["([^"]+)"\])/g)) {
                assert.ok(known.has(m[1] ?? m[2]), `${kind}: vars ${m[1] ?? m[2]} is not provided`);
            }
        }
        assert.deepEqual(Object.keys(DEFAULT_PROCESS_ACTION_TEMPLATES), ['proceed'], 'only Proceed runs anything');
    });
    test('PA-5: a position for people', () => {
        const d = def();
        const b2 = selectSubstep(selectStep(selectProcess(d), d, 'b'), d, 'b2');
        assert.equal(positionText(d, { ...b2, stepIteration: 2 }), 'one #1 › b #2 › b2');
        assert.equal(positionText(d, selectStep(selectProcess(d), d, 'g')), 'one #1 › g #1', 'a gate counts its runs');
        assert.equal(positionText(d, { ...selectProcess(d), completed: true }), 'one #1 › a (finished)');
    });
    test('PA-6: the session of a run', () => {
        const d = parseProcessYaml(YAML.replace('    prompt: Phase one.\n', '    prompt: Phase one.\n    session: one-work\n')
            .replace('            prompt: Do B2.\n', '            prompt: Do B2.\n            session: { name: per-b2, basedOn: one-work, mode: fork-from-base }\n')).definition!;
        const start = selectProcess(d);
        assert.deepEqual(actionSession(d, start), { name: 'one-work', source: 'process', spec: { name: 'one-work' } });
        const b2 = selectSubstep(selectStep(start, d, 'b'), d, 'b2');
        assert.deepEqual(actionSession(d, b2),
            { name: 'per-b2', source: 'process', spec: { name: 'per-b2', basedOn: 'one-work', mode: 'fork-from-base' } }, 'of the position being run');
        assert.deepEqual(actionSession(d, start, 'mine'), { name: 'mine', source: 'override' });
        assert.deepEqual(actionSession(d, start, ''), { name: '', source: 'queue-default' }, 'picked: the queue default');
        assert.deepEqual(actionSession(d, selectPhase(start, d, 'two')), { name: '', source: 'queue-default' }, 'phase two names none');
    });
});
