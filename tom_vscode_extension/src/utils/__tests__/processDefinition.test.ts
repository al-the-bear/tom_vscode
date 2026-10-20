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
 *   PD-11 the role a move sets: the role the new step names; `default` when the process is cleared;
 *         nothing when the position did not change or the step names no role
 *   PD-12 the `prompt` field on phase, step, gate, post-gate and sub-step: accepted, written back,
 *         a process variable of its level
 *   PD-13 the moves offered at each position: proceed (runs this position: on to the next one, or —
 *         at a decision point — stays, marked as run), finish <level> where a repeat is possible,
 *         repeat sub-step / step / phase at their repeat points (capped by maxIterations), gate passed /
 *         failed, finish process at the end, skip, back; each with the state it leads to
 *   PD-18 the `ran` flag: written and read back, offered as "Run again", dropped by every move and
 *         every change of position, kept by a change that leaves the position
 *   PD-14 a finished process: the completed flag is written and read back, only "back" (reopen) is
 *         offered, and any other change clears it
 *   PD-15 a gate can always be run again: its iteration counts up although it is not marked repeatable
 *   PD-16 sessions: a phase, step or sub-step may name the Agent SDK session it runs in (a name, or
 *         name + basedOn + mode); the innermost one applies; validation, write-back, the `session`
 *         process variable and the context block
 *   PD-17 a session name may hold the iteration of its phase, step or sub-step (`${step-iteration}` …):
 *         resolved for the position, so every iteration gets its own session; other placeholders refused
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
    roleAfterMove,
    availableMoves,
    effectiveSession,
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
    prompt: Draft the document.
    steps:
      - id: write
        name: Write
        role: senior_developer
        description: Write it.
        prompt: Write the first version from the sources.
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
            prompt: Comment on what you read.
    gate:
      id: gate
      name: Draft gate
      role: code_reviewer
      description: Is the draft complete?
      prompt: Run the draft gate checklist.
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
        assert.deepEqual(s1, { process: 'review_flow', phase: 'draft', phaseIteration: 1, step: 'write', stepIteration: 1, substep: '', substepIteration: 1, completed: false });
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
        const stale = { process: 'review_flow', phase: 'gone', phaseIteration: 4, step: 'x', stepIteration: 2, substep: 'y', substepIteration: 3, completed: false };
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
            'phase-prompt': 'Draft the document.', 'step-prompt': '', 'substep-prompt': '', session: '',
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

    test('PD-11: the role a move sets', () => {
        const def = definition();
        const start = selectProcess(def);
        assert.equal(roleAfterMove(EMPTY_PROCESS_STATE, start, def), 'senior_developer', 'choosing the process: its first step\'s role');
        assert.equal(roleAfterMove(start, start, def), null, 'no move, no change');
        assert.equal(roleAfterMove(start, selectStep(start, def, 'tidy'), def), null, 'a step that names no role leaves the role');
        assert.equal(roleAfterMove(start, changeIteration(selectStep(start, def, 'review'), def, 'step', 1), def), 'code_reviewer');
        assert.equal(roleAfterMove(start, EMPTY_PROCESS_STATE, null), 'default', 'cleared: back to the default role');
        assert.equal(roleAfterMove(EMPTY_PROCESS_STATE, EMPTY_PROCESS_STATE, null), null, 'nothing set, nothing cleared');
    });
    test('PD-12: the prompt field', () => {
        const def = definition();
        assert.equal(def.phases[0].prompt, 'Draft the document.');
        assert.equal(def.phases[0].gate.prompt, 'Run the draft gate checklist.');
        assert.equal(def.phases[0].steps[1].substeps![1].prompt, 'Comment on what you read.');
        const text = stringifyProcessDefinition(def);
        assert.ok(text.indexOf('description: Write it.') < text.indexOf('prompt: Write the first version'), 'prompt after description');
        assert.deepEqual(parseProcessYaml(text).definition, def);
        assert.deepEqual(validateProcessDefinition({ id: 'x', phases: [{ id: 'a', prompt: 3, steps: [], gate: { id: 'g' } }] }).errors,
            [{ path: 'phases[0].prompt', message: 'text expected' }]);
        const s = selectSubstep(selectStep(selectProcess(def), def, 'review'), def, 'comment');
        const v = processVariableValues(def, s, '');
        assert.deepEqual([v['phase-prompt'], v['step-prompt'], v['substep-prompt']], ['Draft the document.', '', 'Comment on what you read.']);
    });

    test('PD-13: the moves at each position', () => {
        const def = definition();
        const kinds = (s: ReturnType<typeof selectProcess>): string[] => availableMoves(def, s).map((m) => m.level ? `${m.kind}:${m.level}` : m.kind);
        const at = (m: { target: { phase: string; step: string; substep: string; phaseIteration: number; stepIteration: number; substepIteration: number; ran?: boolean } }): string =>
            `${m.target.phase}#${m.target.phaseIteration}/${m.target.step}#${m.target.stepIteration}/${m.target.substep}#${m.target.substepIteration}${m.target.ran ? ' (ran)' : ''}`;
        const move = (s: ReturnType<typeof selectProcess>, kind: string, level?: string) =>
            availableMoves(def, s).find((m) => m.kind === kind && (level === undefined || m.level === level))!;

        const start = selectProcess(def);
        assert.deepEqual(kinds(start), ['proceed', 'skip'], 'the very first step: nowhere back to');
        assert.equal(move(start, 'proceed').label, 'Proceed');
        assert.equal(at(move(start, 'proceed')), 'draft#1/review#1/read#1', 'runs this step, then moves on');
        assert.deepEqual(move(start, 'skip').target, move(start, 'proceed').target, 'skip moves on without running');

        const read = selectStep(start, def, 'review');
        assert.deepEqual(kinds(read), ['proceed', 'skip', 'back'], 'inside a repeatable step: no decision yet');
        assert.equal(at(move(read, 'proceed')), 'draft#1/review#1/comment#1');
        assert.equal(at(move(read, 'back')), 'draft#1/write#1/#1');

        const comment = selectSubstep(read, def, 'comment');
        assert.deepEqual(kinds(comment), ['proceed', 'finish:step', 'repeat:substep', 'repeat:step', 'skip', 'back'],
            'the last sub-step of a repeatable step: a decision point');
        assert.equal(at(move(comment, 'proceed')), 'draft#1/review#1/comment#1 (ran)', 'a decision point: runs and stays');
        assert.equal(move(comment, 'finish').label, 'Finish step');
        assert.equal(at(move(comment, 'finish')), 'draft#1/gate#1/#1');
        assert.equal(at(move(comment, 'repeat', 'substep')), 'draft#1/review#1/comment#2');
        assert.equal(at(move(comment, 'repeat', 'step')), 'draft#1/review#2/read#1', 'a new step iteration starts at its first sub-step');
        assert.equal(at(move(comment, 'back')), 'draft#1/review#1/read#1');

        const gate = selectStep(start, def, 'gate');
        assert.deepEqual(kinds(gate), ['proceed', 'gate-passed', 'gate-failed', 'skip', 'back']);
        assert.equal(at(move(gate, 'proceed')), 'draft#1/gate#1/#1 (ran)', 'a gate: runs and stays for the verdict');
        assert.equal(at(move(gate, 'gate-passed')), 'draft#1/tidy#1/#1');
        assert.equal(at(move(gate, 'gate-failed')), 'draft#1/gate#2/#1');
        assert.equal(at(move(gate, 'back')), 'draft#1/review#1/comment#1', 'back into a step: its last sub-step');

        const tidy = selectStep(start, def, 'tidy');
        assert.deepEqual(kinds(tidy), ['proceed', 'finish:phase', 'repeat:phase', 'skip', 'back']);
        assert.equal(at(move(tidy, 'finish')), 'ship#1/release#1/#1');
        assert.equal(at(move(tidy, 'repeat', 'phase')), 'draft#2/write#1/#1', 'a new phase iteration starts at its first step');
        assert.deepEqual(kinds({ ...tidy, phaseIteration: 3 }), ['proceed', 'skip', 'back'], 'maxIterations reached: no decision left');
        assert.equal(at(move({ ...tidy, phaseIteration: 3 }, 'proceed')), 'ship#1/release#1/#1');

        const release = selectPhase(start, def, 'ship');
        assert.equal(at(move(release, 'back')), 'draft#1/tidy#1/#1', 'back across a phase boundary: the last step of the previous phase');
        const shipGate = selectStep(release, def, 'gate');
        assert.deepEqual(kinds(shipGate), ['proceed', 'finish-process', 'gate-failed', 'back'], 'the last gate: passing it finishes the process');
        assert.equal(at(move(shipGate, 'proceed')), 'ship#1/gate#1/#1 (ran)');
        const done = move(shipGate, 'finish-process').target;
        assert.equal(done.completed, true);
        assert.equal(at(move(shipGate, 'finish-process')), 'ship#1/gate#1/#1');
        assert.deepEqual(availableMoves(def, EMPTY_PROCESS_STATE), [], 'no process, no moves');
    });

    test('PD-18: the ran flag', () => {
        const def = definition();
        const defs = new Map([['review_flow', def]]);
        const gate = selectStep(selectProcess(def), def, 'gate');
        const ran = availableMoves(def, gate).find((m) => m.kind === 'proceed')!.target;
        assert.equal(ran.ran, true);
        assert.deepEqual(parseProcessState(stringifyProcessState(ran, 'x')), ran, 'written and read back');
        assert.doesNotMatch(stringifyProcessState(gate, 'x'), /ran/, 'only a run position writes the flag');
        const moves = availableMoves(def, ran);
        assert.equal(moves[0].kind, 'proceed');
        assert.equal(moves[0].label, 'Run again');
        assert.equal(moves[0].target.ran, true, 'running again stays');
        for (const m of moves.slice(1)) { assert.equal(m.target.ran, undefined, `${m.kind} leads to a position not run yet`); }
        const moved = applyProcessChange(ran, defs, { step: 'review' });
        assert.equal(moved.ok && moved.state.ran, undefined, 'a change of position drops it');
        const same = applyProcessChange(ran, defs, { completed: false });
        assert.equal(same.ok && same.state.ran, true, 'a change that leaves the position keeps it');
        const iterated = changeIteration(ran, def, 'step', 1);
        assert.equal(iterated.ran, undefined, 'a new iteration has not run');
    });

    test('PD-14: a finished process', () => {
        const def = definition();
        const defs = new Map([['review_flow', def]]);
        const last = selectStep(selectPhase(selectProcess(def), def, 'ship'), def, 'gate');
        const done = { ...last, completed: true };
        const moves = availableMoves(def, done);
        assert.deepEqual(moves.map((m) => [m.kind, m.label]), [['back', 'Reopen']]);
        assert.deepEqual(moves[0].target, last);
        assert.deepEqual(parseProcessState(stringifyProcessState(done, '2026-10-19T10:00:00Z')), done);
        assert.doesNotMatch(stringifyProcessState(last, 'x'), /completed/, 'only a finished state writes the flag');
        const r = applyProcessChange(done, defs, { step: 'release' });
        assert.equal(r.ok && r.state.completed, false, 'a change moves out of the finished state');
        const flagged = applyProcessChange(last, defs, { completed: true });
        assert.equal(flagged.ok && flagged.state.completed, true, 'the tool can finish a process');
    });

    test('PD-15: a gate can always be run again', () => {
        const def = definition();
        const gate = selectStep(selectProcess(def), def, 'gate');
        const again = changeIteration(gate, def, 'step', 1);
        assert.equal(again.stepIteration, 2);
        assert.equal(normalizeState(again, def).stepIteration, 2, 'the iteration of a gate survives normalisation');
        const defs = new Map([['review_flow', def]]);
        const r = applyProcessChange(gate, defs, { stepIteration: 3 });
        assert.equal(r.ok && r.state.stepIteration, 3);
    });
    test('PD-16: sessions', () => {
        const yaml = YAML
            .replace("    prompt: Draft the document.\n", "    prompt: Draft the document.\n    session: draft-work\n")
            .replace("            prompt: Comment on what you read.\n", "            prompt: Comment on what you read.\n            session:\n              name: per-comment\n              basedOn: draft-work\n              mode: fork-from-base\n");
        const parsed = parseProcessYaml(yaml);
        assert.deepEqual(parsed.errors, []);
        const def = parsed.definition!;
        const start = selectProcess(def);
        assert.deepEqual(effectiveSession(def, start), { name: 'draft-work' }, 'the phase\'s session, as a name');
        const comment = selectSubstep(selectStep(start, def, 'review'), def, 'comment');
        assert.deepEqual(effectiveSession(def, comment), { name: 'per-comment', basedOn: 'draft-work', mode: 'fork-from-base' }, 'the innermost wins');
        assert.equal(effectiveSession(def, selectPhase(start, def, 'ship')), null, 'none named');
        assert.equal(processVariableValues(def, comment, '').session, 'per-comment');
        assert.match(processContextBlock(def, comment, ''), /Session: `per-comment` \(re-created from `draft-work` for every prompt\)/);
        assert.deepEqual(parseProcessYaml(stringifyProcessDefinition(def)).definition, def, 'written back');
        const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'src', 'config', 'process.schema.json'), 'utf-8'));
        const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
        assert.equal(validate(parse(yaml)), true, JSON.stringify(validate.errors));
        assert.equal(validate({ id: 'x', phases: [{ id: 'a', session: { name: 'a', mode: 'fork-from-base' }, steps: [], gate: { id: 'g' } }] }), false,
            'the schema too: fork-from-base needs a base');
        const bad = (session: unknown): string[] => validateProcessDefinition({ id: 'x', phases: [{ id: 'a', session, steps: [], gate: { id: 'g' } }] })
            .errors.map((e) => `${e.path}: ${e.message}`);
        assert.deepEqual(bad('bad name'), ['phases[0].session: letters, digits, "_" and "-" only, starting with a letter or digit; ${phase-iteration}, ${step-iteration} and ${substep-iteration} are filled in']);
        assert.deepEqual(bad({ basedOn: 'x' }), ['phases[0].session.name: required']);
        assert.deepEqual(bad({ name: 'a', mode: 'often' }), ['phases[0].session.mode: "continue" or "fork-from-base"']);
        assert.deepEqual(bad({ name: 'a', mode: 'fork-from-base' }), ['phases[0].session.basedOn: a session re-created from its base for every prompt needs a base']);
        assert.deepEqual(bad({ name: 'a', other: 1 }), ['phases[0].session.other: unknown key']);
    });

    test('PD-17: iteration placeholders in session names', () => {
        const yaml = YAML
            .replace("    prompt: Draft the document.\n", "    prompt: Draft the document.\n    session: draft-p${phase-iteration}\n")
            .replace("            prompt: Comment on what you read.\n", "            prompt: Comment on what you read.\n            session:\n              name: comment-r${step-iteration}-${substep-iteration}\n              basedOn: prep-r${step-iteration}\n              mode: fork-from-base\n");
        const parsed = parseProcessYaml(yaml);
        assert.deepEqual(parsed.errors, []);
        const def = parsed.definition!;
        const start = selectProcess(def);
        assert.deepEqual(effectiveSession(def, start), { name: 'draft-p1' });
        const review = selectStep(start, def, 'review');
        const comment = { ...selectSubstep(review, def, 'comment'), stepIteration: 3 };
        assert.deepEqual(effectiveSession(def, comment), { name: 'comment-r3-1', basedOn: 'prep-r3', mode: 'fork-from-base' });
        assert.equal(processVariableValues(def, comment, '').session, 'comment-r3-1');
        assert.deepEqual(parseProcessYaml(stringifyProcessDefinition(def)).definition, def, 'written back unresolved');
        const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'src', 'config', 'process.schema.json'), 'utf-8'));
        const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
        assert.equal(validate(parse(yaml)), true, JSON.stringify(validate.errors));
        assert.equal(validate({ id: 'x', phases: [{ id: 'a', session: 'a-${quest}', steps: [], gate: { id: 'g' } }] }), false, 'the schema refuses other placeholders');
        const bad = (session: unknown): string[] => validateProcessDefinition({ id: 'x', phases: [{ id: 'a', session, steps: [], gate: { id: 'g' } }] })
            .errors.map((e) => `${e.path}: ${e.message}`);
        assert.equal(bad('a-${quest}').length, 1, 'only the three iteration placeholders');
        assert.equal(bad({ name: 'a', basedOn: 'b-${step}' }).length, 1);
        assert.deepEqual(bad('${step-iteration}-a'), [], 'a placeholder may start the name');
    });
});
