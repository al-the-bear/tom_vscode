/**
 * Processes: the definition (`<id>.process.yaml`), its validation, the state a
 * quest is in, the moves between states and what the system prompt is told
 * (src/utils/processDefinition.ts).
 *
 *   PD-1  a valid definition parses; gate and post-gate are steps of their phase, in that order
 *   PD-2  validation names every problem with its path: missing gate, duplicate ids,
 *         unknown keys, todos outside a post-gate, maxIterations without repeatable
 *   PD-3  choosing a process / phase / step starts at the first phase / step / sub-step, iteration 1
 *   PD-4  a new iteration of a repeatable phase or step restarts what is inside it; going back
 *         one iteration only corrects the number; a non-repeatable level stays at 1; maxIterations caps
 *   PD-5  the role of the current step: the sub-step's, else its step's
 *   PD-6  a state that no longer fits the definition is repaired to the nearest valid one
 *   PD-7  the chat-variable values and the system-prompt block; empty without a process
 *   PD-8  applying a change request (the tool's input): names checked, iterations set, errors reported
 *   PD-9  writing a definition and a state file reads back the same; a broken state file is the empty state
 *   PD-10 the JSON schema (src/config/process.schema.json) accepts what the validator accepts and
 *         rejects the shape errors it rejects
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import {
    EMPTY_PROCESS_STATE,
    applyProcessChange,
    changeIteration,
    currentRole,
    normalizeState,
    parseProcessYaml,
    phaseSteps,
    processContextBlock,
    processVariableValues,
    selectPhase,
    selectProcess,
    selectStep,
    selectSubstep,
    validateProcessDefinition,
    stringifyProcessDefinition,
    parseProcessState,
    stringifyProcessState,
    type ProcessDefinition,
} from '../processDefinition.js';

const YAML = `
id: review_flow
name: Review flow
summary: Write, review, ship.
phases:
  - id: draft
    name: Draft
    repeatable: true
    maxIterations: 3
    description: Write the first version.
    steps:
      - id: write
        name: Write
        role: senior_developer
        description: Write it.
      - id: review
        name: Review
        repeatable: true
        role: code_reviewer
        substeps:
          - id: read
            name: Read
          - id: comment
            name: Comment
            role: default
            repeatable: true
    gate:
      id: gate
      name: Draft gate
      role: code_reviewer
      description: Is the draft complete?
    postGate:
      id: tidy
      name: Tidy up
      todos:
        - title: Archive the review notes
          description: Move them to the quest folder.
      todoPrefix: phasetodosdraft
  - id: ship
    name: Ship
    steps:
      - id: release
        name: Release
    gate:
      id: gate
      name: Ship gate
`;

function definition(): ProcessDefinition {
    const parsed = parseProcessYaml(YAML);
    assert.deepEqual(parsed.errors, []);
    return parsed.definition!;
}

describe('process definitions', () => {
    test('PD-1: parsing', () => {
        const def = definition();
        assert.equal(def.id, 'review_flow');
        assert.deepEqual(def.phases.map((p) => p.id), ['draft', 'ship']);
        assert.deepEqual(phaseSteps(def.phases[0]).map((s) => `${s.kind}:${s.step.id}`),
            ['step:write', 'step:review', 'gate:gate', 'post-gate:tidy']);
        assert.deepEqual(phaseSteps(def.phases[1]).map((s) => s.kind), ['step', 'gate']);
        assert.equal(def.phases[0].postGate?.todos?.[0].title, 'Archive the review notes');
    });

    test('PD-2: validation', () => {
        const errors = (raw: unknown): string[] => validateProcessDefinition(raw).errors.map((e) => `${e.path}: ${e.message}`);
        assert.deepEqual(errors({ id: 'x', phases: [{ id: 'a', steps: [] }] }), ['phases[0].gate: a phase ends with a quality gate step']);
        assert.ok(errors({ id: 'x', phases: [{ id: 'a', steps: [{ id: 's' }, { id: 's' }], gate: { id: 'g' } }] })
            .includes('phases[0].steps[1].id: "s" is used twice in phase "a"'));
        assert.ok(errors({ id: 'x', phases: [{ id: 'a', steps: [{ id: 'g' }], gate: { id: 'g' } }] })
            .includes('phases[0].gate.id: "g" is used twice in phase "a"'), 'the gate shares the step namespace');
        assert.ok(errors({ id: 'x', phases: [{ id: 'a', steps: [{ id: 's', rol: 'x' }], gate: { id: 'g' } }] })
            .includes('phases[0].steps[0].rol: unknown key'));
        assert.ok(errors({ id: 'x', phases: [{ id: 'a', steps: [{ id: 's', todos: [] }], gate: { id: 'g' } }] })
            .includes('phases[0].steps[0].todos: unknown key'), 'todos only in a post-gate step');
        assert.ok(errors({ id: 'x', phases: [{ id: 'a', steps: [{ id: 's', maxIterations: 2 }], gate: { id: 'g' } }] })
            .includes('phases[0].steps[0].maxIterations: only a repeatable step has a maximum'));
        assert.ok(errors({ id: 'Bad Id!', phases: [] }).includes('id: letters, digits, "_" and "-" only, starting with a letter or digit'));
        assert.ok(errors({ id: 'x', phases: [] }).includes('phases: at least one phase'));
        assert.ok(errors({ id: 'x', phases: [{ id: 'a', steps: [{ id: 's', substeps: [] }], gate: { id: 'g' } }] })
            .includes('phases[0].steps[0].substeps: a step with sub-steps has at least one'));
        assert.ok(errors({ id: 'x', phases: [{ id: 'a', steps: [], gate: { id: 'g' }, postGate: { id: 'p', todos: [{ description: 'no title' }] } }] })
            .includes('phases[0].postGate.todos[0].title: required'));
        assert.deepEqual(parseProcessYaml('id: [unclosed').errors.map((e) => e.path), ['(yaml)']);
    });

    test('PD-3: choosing', () => {
        const def = definition();
        const s1 = selectProcess(def);
        assert.deepEqual(s1, { process: 'review_flow', phase: 'draft', phaseIteration: 1, step: 'write', stepIteration: 1, substep: '', substepIteration: 1 });
        const s2 = selectStep(s1, def, 'review');
        assert.deepEqual([s2.step, s2.substep, s2.substepIteration], ['review', 'read', 1], 'a step with sub-steps starts at its first');
        const s3 = selectSubstep(s2, def, 'comment');
        assert.equal(s3.substep, 'comment');
        const s4 = selectPhase(s3, def, 'ship');
        assert.deepEqual([s4.phase, s4.phaseIteration, s4.step, s4.substep], ['ship', 1, 'release', '']);
        assert.deepEqual(selectProcess(null), EMPTY_PROCESS_STATE);
        assert.throws(() => selectStep(s1, def, 'nope'), /no step "nope" in phase "draft"/);
    });

    test('PD-4: iterations', () => {
        const def = definition();
        let s = selectSubstep(selectStep(selectProcess(def), def, 'review'), def, 'comment');
        s = changeIteration(s, def, 'substep', 1);
        assert.equal(s.substepIteration, 2);
        s = changeIteration(s, def, 'step', 1);
        assert.deepEqual([s.stepIteration, s.substep, s.substepIteration], [2, 'read', 1], 'a new review round starts at its first sub-step');
        s = changeIteration(s, def, 'step', -1);
        assert.deepEqual([s.stepIteration, s.substep], [1, 'read'], 'going back only corrects the number');
        assert.throws(() => changeIteration(s, def, 'substep', 1), /sub-step "read" is not repeatable/);
        s = changeIteration(s, def, 'phase', 1);
        assert.deepEqual([s.phaseIteration, s.step, s.stepIteration], [2, 'write', 1], 'a new phase iteration restarts its steps');
        s = changeIteration(changeIteration(s, def, 'phase', 1), def, 'phase', 1);
        assert.equal(s.phaseIteration, 3, 'maxIterations 3 caps');
        s = changeIteration(changeIteration(s, def, 'phase', -1), def, 'phase', -1);
        assert.equal(changeIteration(s, def, 'phase', -1).phaseIteration, 1, 'never below 1');
    });

    test('PD-5: the current role', () => {
        const def = definition();
        const s = selectProcess(def);
        assert.equal(currentRole(def, s), 'senior_developer');
        const review = selectStep(s, def, 'review');
        assert.equal(currentRole(def, review), 'code_reviewer', 'a sub-step without a role takes its step\'s');
        assert.equal(currentRole(def, selectSubstep(review, def, 'comment')), 'default');
        assert.equal(currentRole(def, selectStep(s, def, 'tidy')), '', 'no role named');
    });

    test('PD-6: repairing a stale state', () => {
        const def = definition();
        const stale = { process: 'review_flow', phase: 'gone', phaseIteration: 4, step: 'x', stepIteration: 2, substep: 'y', substepIteration: 3 };
        assert.deepEqual(normalizeState(stale, def), selectProcess(def));
        const badStep = { ...selectProcess(def), step: 'gone', stepIteration: 3 };
        assert.deepEqual(normalizeState(badStep, def), selectProcess(def));
        const ok = selectSubstep(selectStep(selectProcess(def), def, 'review'), def, 'comment');
        assert.deepEqual(normalizeState(ok, def), ok);
        const tooMany = { ...selectProcess(def), phaseIteration: 9 };
        assert.equal(normalizeState(tooMany, def).phaseIteration, 3);
        const notRepeatable = { ...selectProcess(def), stepIteration: 2 };
        assert.equal(normalizeState(notRepeatable, def).stepIteration, 1);
    });

    test('PD-7: chat-variable values and the system-prompt block', () => {
        const def = definition();
        const s = selectStep(selectProcess(def), def, 'review');
        const v = processVariableValues(def, s, '# Review flow\n\nThe whole story.');
        /* eslint-disable @typescript-eslint/naming-convention -- the chat-variable names are hyphenated */
        assert.deepEqual(v, {
            process: 'review_flow', phase: 'draft', step: 'review', substep: 'read',
            'phase-iteration': '1', 'step-iteration': '1', 'substep-iteration': '1',
            'process-description': '# Review flow\n\nThe whole story.',
            'phase-description': 'Write the first version.',
            'step-description': '', 'substep-description': '',
        });
        /* eslint-enable @typescript-eslint/naming-convention */
        const block = processContextBlock(def, s, '# Review flow\n\nThe whole story.');
        assert.match(block, /Process: \*\*Review flow\*\* \(`review_flow`\)/);
        assert.match(block, /Phase: \*\*Draft\*\* \(`draft`, 1 of 2\), iteration 1 of at most 3/);
        assert.match(block, /Step: \*\*Review\*\* \(`review`, 2 of 4\), iteration 1 — role `code_reviewer`/);
        assert.match(block, /Sub-step: \*\*Read\*\* \(`read`, 1 of 2\), iteration 1/);
        assert.match(block, /Steps of this phase: `write` → \*\*`review`\*\* → `gate` \(gate\) → `tidy` \(post-gate\)/);
        assert.match(block, /tomAi_setProcessState/);
        const post = processContextBlock(def, selectStep(s, def, 'tidy'), '');
        assert.match(post, /- Archive the review notes — Move them to the quest folder\./);
        assert.match(post, /quest todos with the id prefix `phasetodosdraft`/);
        const none = processVariableValues(null, EMPTY_PROCESS_STATE, '');
        assert.ok(Object.values(none).every((x) => x === ''), 'no process: every value empty');
        assert.equal(processContextBlock(null, EMPTY_PROCESS_STATE, ''), '');
    });

    test('PD-8: applying a change request', () => {
        const def = definition();
        const defs = new Map([['review_flow', def]]);
        let r = applyProcessChange(EMPTY_PROCESS_STATE, defs, { process: 'review_flow', step: 'review', stepIteration: 2 });
        assert.equal(r.ok, true);
        assert.deepEqual(r.ok && [r.state.phase, r.state.step, r.state.stepIteration, r.state.substep], ['draft', 'review', 2, 'read']);
        r = applyProcessChange(r.ok ? r.state : EMPTY_PROCESS_STATE, defs, { phase: 'ship' });
        assert.deepEqual(r.ok && [r.state.phase, r.state.step], ['ship', 'release']);
        assert.deepEqual(applyProcessChange(EMPTY_PROCESS_STATE, defs, { process: 'nope' }),
            { ok: false, error: 'no process "nope"; known: review_flow' });
        assert.deepEqual(applyProcessChange(EMPTY_PROCESS_STATE, defs, { step: 'write' }),
            { ok: false, error: 'no process is set; pass `process` first' });
        const bad = applyProcessChange(selectProcess(def), defs, { stepIteration: 2 });
        assert.deepEqual(bad, { ok: false, error: 'step "write" is not repeatable' });
        const cleared = applyProcessChange(selectProcess(def), defs, { process: '' });
        assert.deepEqual(cleared, { ok: true, state: EMPTY_PROCESS_STATE });
    });

    test('PD-9: writing and reading back', () => {
        const def = definition();
        const text = stringifyProcessDefinition(def);
        const again = parseProcessYaml(text);
        assert.deepEqual(again.errors, []);
        assert.deepEqual(again.definition, def);
        assert.ok(text.indexOf('id: review_flow') < text.indexOf('phases:'), 'id first');
        const state = selectSubstep(selectStep(selectProcess(def), def, 'review'), def, 'comment');
        assert.deepEqual(parseProcessState(stringifyProcessState(state, '2026-10-19T10:00:00Z')), state);
        assert.deepEqual(parseProcessState(': not yaml ['), EMPTY_PROCESS_STATE);
        assert.deepEqual(parseProcessState('process: x\nphaseIteration: -2'), { ...EMPTY_PROCESS_STATE, process: 'x' });
    });

    test('PD-10: the JSON schema agrees', () => {
        const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'src', 'config', 'process.schema.json'), 'utf-8'));
        const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
        assert.equal(validate(parse(YAML)), true, JSON.stringify(validate.errors));
        const shapes: unknown[] = [
            { id: 'x', phases: [{ id: 'a', steps: [] }] },
            { id: 'x', phases: [{ id: 'a', steps: [{ id: 's', rol: 'x' }], gate: { id: 'g' } }] },
            { id: 'x', phases: [{ id: 'a', steps: [{ id: 's', todos: [] }], gate: { id: 'g' } }] },
            { id: 'Bad Id!', phases: [{ id: 'a', steps: [], gate: { id: 'g' } }] },
            { id: 'x', phases: [] },
            { id: 'x', phases: [{ id: 'a', steps: [{ id: 's', substeps: [] }], gate: { id: 'g' } }] },
            { id: 'x', phases: [{ id: 'a', steps: [], gate: { id: 'g' }, postGate: { id: 'p', todos: [{ description: 'no title' }] } }] },
        ];
        for (const raw of shapes) {
            assert.notEqual(validateProcessDefinition(raw).errors.length, 0);
            assert.equal(validate(raw), false, `the schema accepts ${JSON.stringify(raw)}`);
        }
    });
});
