/**
 * Optional and conditional phases and steps (src/utils/processDefinition.ts):
 * `optional: true` and `when:` — a variable test the extension decides, or a
 * `judge:` text the agent decides at Proceed.
 *
 *   PC-1  a definition with an optional and a conditional phase, and one with two alternative first steps chosen
 *         by a run parameter, validate (validator and JSON schema) and are written back unchanged
 *   PC-2  validation: `optional` / `when` refused on a gate, a test that is not exactly one, a bad variable name,
 *         an empty judge text, a non-boolean optional; the schema rejects the same shapes
 *   PC-3  conditions decided: equals / notEquals / in / set; a variable not set decides nothing (except `set`);
 *         no lookup decides nothing; `judge` is always the agent's; the lookup reads custom names, `custom.`
 *         and the level's inputs; the condition as text
 *   PC-4  alternative first steps: the start passes the step the run parameter excludes; Proceed from the
 *         decision step leads to the alternative chosen, and from it past the other one into Phase 2; each
 *         left-out step is recorded (by its condition, with the reason); without variables nothing is passed
 *   PC-5  a conditional phase whose test fails is passed by (recorded); after a gate the decision's go-on leads
 *         past it; at the end of the process, everything after excluded, the option finishes the process
 *   PC-6  optional: Leave out is offered for the phase at its start and for the step, not for a gate; it is
 *         recorded as the user's, leads past the phase / step and on past what conditions exclude
 *   PC-7  judge: the agent's condition at the phase's start and at the step (also a variable not set);
 *         the context block tells the agent to judge it and how to leave it out; a `leaveOut` on the state
 *         makes Leave out the agent's with its reason
 *   PC-8  the state file writes and reads `skipped` and `leaveOut`; the context block lists what was left
 *         out and marks optional / conditional / left-out steps
 *   PC-9  the PROCESS view's notes (processPanel-handler conditionNotes): the phase's and each step's optional
 *         flag, condition as plain text and how it stands now; none for a gate or a plain step
 */

/* eslint-disable @typescript-eslint/naming-convention -- the keys are chat-variable names (`spec-mode`, `custom.spec-mode`) */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import {
    EMPTY_PROCESS_STATE,
    availableMoves,
    conditionLookup,
    conditionText,
    decisionAt,
    evaluateCondition,
    judgedLevelAt,
    parseProcessState,
    parseProcessYaml,
    passExcluded,
    processContextBlock,
    selectProcess,
    stringifyProcessDefinition,
    stringifyProcessState,
    validateProcessDefinition,
    type ConditionOptions,
    type ProcessDefinition,
    type ProcessMove,
    type ProcessState,
} from '../processDefinition.js';

/** The optional and the conditional phase. */
const PHASES = `id: phased
phases:
  - id: plan
    steps:
      - id: write
    gate:
      id: gate
  - id: research
    optional: true
    steps:
      - id: read
    gate:
      id: gate
  - id: migrate
    when:
      var: needs-migration
      equals: "yes"
    steps:
      - id: move
    gate:
      id: gate
  - id: ship
    steps:
      - id: release
        optional: true
      - id: announce
        when:
          judge: the release changes the public API
    gate:
      id: gate
`;

/** Alternative first steps chosen by a run parameter (tom_specs: initial specification or change). */
const ALTERNATIVES = `id: specs
phases:
  - id: intent
    steps:
      - id: decide
        userAction: true
        description: Set spec-mode to initial or change.
      - id: idea-rounds
        name: Project Idea question rounds
        when:
          var: spec-mode
          equals: initial
      - id: change-intent
        name: Change intent and impact
        when:
          var: spec-mode
          equals: change
    gate:
      id: gate
  - id: blueprint
    steps:
      - id: draft
    gate:
      id: gate
`;

const NOW = '2026-11-10T12:00:00.000Z';

function def(yaml: string): ProcessDefinition {
    const parsed = parseProcessYaml(yaml);
    assert.deepEqual(parsed.errors, []);
    return parsed.definition!;
}

const vars = (values: Record<string, string>, state?: ProcessState): ConditionOptions => ({ lookup: conditionLookup(values, state), now: NOW });
const move = (moves: ProcessMove[], kind: string, level?: string): ProcessMove => {
    const m = moves.find((x) => x.kind === kind && (level === undefined || x.level === level));
    assert.ok(m, `no move ${kind}${level ? ` ${level}` : ''} among ${moves.map((x) => `${x.kind}/${x.level ?? ''}`).join(', ')}`);
    return m;
};
const at = (s: ProcessState): string => `${s.phase}/${s.step}${s.decision ? ' (decision)' : ''}${s.completed ? ' (completed)' : ''}`;
const schema = (): (data: unknown) => boolean => {
    const raw = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'src', 'config', 'process.schema.json'), 'utf-8'));
    return new Ajv2020({ allErrors: true, strict: false }).compile(raw);
};

describe('optional and conditional phases and steps', () => {
    test('PC-1: the definitions validate and are written back', () => {
        const validate = schema();
        for (const yaml of [PHASES, ALTERNATIVES]) {
            const d = def(yaml);
            assert.equal(validate(parse(yaml)), true, JSON.stringify((validate as unknown as { errors: unknown }).errors));
            const again = def(stringifyProcessDefinition(d));
            assert.deepEqual(again, d);
        }
        const d = def(PHASES);
        assert.equal(d.phases[1].optional, true);
        assert.deepEqual(d.phases[2].when, { var: 'needs-migration', equals: 'yes' });
        assert.deepEqual(d.phases[3].steps[1].when, { judge: 'the release changes the public API' });
    });

    test('PC-2: validation', () => {
        const validate = schema();
        const base = (over: Record<string, unknown>, where: 'phase' | 'step' | 'gate' = 'step'): unknown => ({
            id: 'x',
            phases: [{
                id: 'a',
                ...(where === 'phase' ? over : {}),
                steps: [{ id: 's', ...(where === 'step' ? over : {}) }],
                gate: { id: 'g', ...(where === 'gate' ? over : {}) },
            }],
        });
        const cases: Array<[unknown, RegExp]> = [
            [base({ optional: true }, 'gate'), /gate\.optional: every phase that runs ends with its gate/],
            [base({ when: { judge: 'x' } }, 'gate'), /gate\.when: every phase that runs ends with its gate/],
            [base({ when: { var: 'm', equals: 'a', notEquals: 'b' } }), /exactly one of equals, notEquals, in, set/],
            [base({ when: { var: 'm' } }), /exactly one of/],
            [base({ when: { var: 'bad name', equals: 'a' } }), /when\.var: a chat variable name/],
            [base({ when: { judge: '  ' } }), /when\.judge: the condition, as text/],
            [base({ when: { var: 'm', in: [] } }), /when\.in: a list of texts/],
            [base({ when: { var: 'm', set: 'yes' } }), /when\.set: true or false/],
            [base({ when: 'mode is change' }), /\{judge: text\}/],
            [base({ optional: 'yes' }, 'phase'), /phases\[0\]\.optional: true or false/],
            [base({ when: { var: 'm', equals: 'a', also: 1 } }), /when\.also: unknown key/],
        ];
        for (const [raw, message] of cases) {
            const errors = validateProcessDefinition(raw).errors.map((e) => `${e.path}: ${e.message}`).join('\n');
            assert.match(errors, message, JSON.stringify(raw));
        }
        // The schema rejects the shape errors (a gate's fields are refused by the validator, as onFail on a step is).
        for (const [raw] of cases.slice(2)) {
            assert.equal(validate(raw), false, `the schema accepts ${JSON.stringify(raw)}`);
        }
    });

    test('PC-3: deciding a condition', () => {
        const look = conditionLookup({ 'custom.spec-mode': 'change', role: 'architect', empty: '' }, { ...EMPTY_PROCESS_STATE, inputs: { folder: 'docs' } });
        assert.equal(look('spec-mode'), 'change', 'a custom variable by its name');
        assert.equal(look('custom.spec-mode'), 'change');
        assert.equal(look('role'), 'architect', 'a built-in');
        assert.equal(look('input.folder'), 'docs', "the level's input");
        assert.equal(look('empty'), undefined, 'empty is not set');
        assert.equal(evaluateCondition({ var: 'spec-mode', equals: 'change' }, look), 'holds');
        assert.equal(evaluateCondition({ var: 'spec-mode', equals: 'initial' }, look), 'fails');
        assert.equal(evaluateCondition({ var: 'spec-mode', notEquals: 'initial' }, look), 'holds');
        assert.equal(evaluateCondition({ var: 'spec-mode', in: ['initial', 'change'] }, look), 'holds');
        assert.equal(evaluateCondition({ var: 'input.folder', in: ['src'] }, look), 'fails');
        assert.equal(evaluateCondition({ var: 'missing', equals: 'x' }, look), 'judge', 'a variable not set decides nothing');
        assert.equal(evaluateCondition({ var: 'missing', set: false }, look), 'holds');
        assert.equal(evaluateCondition({ var: 'spec-mode', set: true }, look), 'holds');
        assert.equal(evaluateCondition({ var: 'spec-mode', set: false }, look), 'fails');
        assert.equal(evaluateCondition({ var: 'spec-mode', equals: 'change' }), 'judge', 'no lookup');
        assert.equal(evaluateCondition({ judge: 'the API changes' }, look), 'judge');
        assert.equal(conditionText({ var: 'spec-mode', equals: 'change' }), '`spec-mode` is `change`');
        assert.equal(conditionText({ var: 'm', notEquals: 'a' }), '`m` is not `a`');
        assert.equal(conditionText({ var: 'm', in: ['a', 'b'] }), '`m` is one of `a`, `b`');
        assert.equal(conditionText({ var: 'm', set: false }), '`m` is not set');
        assert.equal(conditionText({ judge: ' the API changes ' }), 'the API changes');
    });

    test('PC-4: alternative first steps chosen by a run parameter', () => {
        const d = def(ALTERNATIVES);
        // The decision step comes first: nothing to pass at the start.
        const start = passExcluded(d, EMPTY_PROCESS_STATE, selectProcess(d), vars({ 'custom.spec-mode': 'change' }));
        assert.equal(at(start), 'intent/decide');
        for (const [mode, ran, left] of [['change', 'change-intent', 'idea-rounds'], ['initial', 'idea-rounds', 'change-intent']]) {
            const o = vars({ 'custom.spec-mode': mode });
            const toAlternative = move(availableMoves(d, start, o), 'proceed').target;
            assert.equal(at(toAlternative), `intent/${ran}`, mode);
            const toGate = move(availableMoves(d, toAlternative, o), 'proceed').target;
            assert.equal(at(toGate), 'intent/gate', `${mode}: past the other alternative`);
            const leftOut = toGate.skipped ?? [];
            assert.deepEqual(leftOut.map((r) => [r.phase, r.step, r.by, r.reason, r.at]),
                [['intent', left, 'condition', `runs only when \`spec-mode\` is \`${mode === 'change' ? 'initial' : 'change'}\``, NOW]]);
            // From Phase 2 on both alternatives run the same steps.
            const decision = move(availableMoves(d, toGate, o), 'proceed').target;
            assert.equal(at(move(availableMoves(d, decision, o), 'gate-passed').target), 'blueprint/draft');
        }
        // A step the alternative skipped is told apart in the decision's label too.
        const changeIntent = move(availableMoves(d, start, vars({ 'custom.spec-mode': 'change' })), 'proceed');
        assert.equal(changeIntent.target.skipped?.[0].step, 'idea-rounds');
        // Without variables nothing is decided: the steps run in order.
        assert.equal(at(move(availableMoves(d, start), 'proceed').target), 'intent/idea-rounds');
        // Skip (by hand) goes where Proceed goes.
        assert.equal(at(move(availableMoves(d, start, vars({ 'spec-mode': 'change' })), 'skip').target), 'intent/change-intent');
    });

    test('PC-5: a conditional phase', () => {
        const d = def(PHASES);
        const researchDone: ProcessState = { ...selectProcess(d), phase: 'research', step: 'gate', decision: true };
        const no = vars({ 'needs-migration': 'no' });
        const past = move(decisionAt(d, researchDone, no)!.options, 'gate-passed');
        assert.equal(at(past.target), 'ship/release', 'the migrate phase is passed by');
        assert.match(past.label, /Ship › Release|ship › release/i);
        assert.deepEqual(past.target.skipped?.map((r) => [r.phase, r.step ?? '', r.by]), [['migrate', '', 'condition']]);
        const yes = vars({ 'needs-migration': 'yes' });
        assert.equal(at(move(decisionAt(d, researchDone, yes)!.options, 'gate-passed').target), 'migrate/move');
        assert.equal(at(move(decisionAt(d, researchDone)!.options, 'gate-passed').target), 'migrate/move', 'not set: entered');
        // The last phase excluded: the decision before it finishes the process.
        const last = def(PHASES.replace(/  - id: ship[\s\S]*$/, ''));
        const finish = move(decisionAt(last, researchDone, no)!.options, 'finish-process');
        assert.equal(finish.target.completed, true);
        assert.equal(finish.target.skipped?.[0].phase, 'migrate');
        // A phase repeated enters it again: its condition is decided again.
        const conditional = def(PHASES.replace('  - id: migrate\n', '  - id: migrate\n    repeatable: true\n'));
        const migrateDone: ProcessState = { ...selectProcess(conditional), phase: 'migrate', step: 'gate', decision: true };
        const repeat = move(decisionAt(conditional, migrateDone, no)!.options, 'repeat', 'phase');
        assert.equal(at(repeat.target), 'ship/release');
    });

    test('PC-6: optional — Leave out', () => {
        const d = def(PHASES);
        const research: ProcessState = { ...selectProcess(d), phase: 'research', step: 'read' };
        const o = vars({ 'needs-migration': 'no' });
        const phase = move(availableMoves(d, research, o), 'leave-out', 'phase');
        assert.equal(phase.label, 'Leave out the phase research');
        assert.equal(at(phase.target), 'ship/release', 'past the phase, and past migrate by its condition');
        assert.deepEqual(phase.target.skipped?.map((r) => [r.phase, r.by, r.reason]), [
            ['research', 'user', 'left out by the user (optional)'],
            ['migrate', 'condition', 'runs only when `needs-migration` is `yes`'],
        ]);
        // Not at the gate, and no step Leave out on a step that is neither optional nor conditional.
        const atGate = availableMoves(d, { ...research, step: 'gate' }, o);
        assert.equal(atGate.some((m) => m.kind === 'leave-out'), false);
        const ship: ProcessState = { ...selectProcess(d), phase: 'ship', step: 'release' };
        const step = move(availableMoves(d, ship, o), 'leave-out', 'step');
        assert.equal(at(step.target), 'ship/announce');
        assert.deepEqual(step.target.skipped?.map((r) => [r.step, r.by]), [['release', 'user']]);
        assert.equal(availableMoves(d, ship, o).some((m) => m.kind === 'leave-out' && m.level === 'phase'), false, 'ship is not optional');
        // A conditional step can be left out by hand too; the record names its condition.
        const announce = move(availableMoves(d, { ...ship, step: 'announce' }, o), 'leave-out', 'step');
        assert.equal(at(announce.target), 'ship/gate');
        assert.match(announce.target.skipped![0].reason, /left out by the user \(runs only when the release changes the public API\)/);
    });

    test('PC-7: the agent judges', () => {
        const d = def(PHASES);
        const ship: ProcessState = { ...selectProcess(d), phase: 'ship', step: 'announce' };
        const judged = judgedLevelAt(d, ship);
        assert.equal(judged?.level, 'step');
        assert.equal(judgedLevelAt(d, { ...ship, step: 'release' }), null, 'optional only: the user leaves it out');
        // A variable test whose variable is not set is the agent's too, at the phase's start only.
        const migrate: ProcessState = { ...selectProcess(d), phase: 'migrate', step: 'move' };
        assert.equal(judgedLevelAt(d, migrate, conditionLookup({}))?.level, 'phase');
        assert.equal(judgedLevelAt(d, { ...migrate, step: 'gate' }, conditionLookup({})), null);
        assert.equal(judgedLevelAt(d, migrate, conditionLookup({ 'needs-migration': 'yes' })), null, 'decided');
        const block = processContextBlock(d, ship, '', true, vars({}));
        assert.match(block, /\*\*Condition\*\* — this step runs only when: the release changes the public API\./);
        assert.match(block, /tomAi_setProcessState \{leaveOut: "<why>"\}/);
        assert.match(block, /`leaveOut` is the exception/);
        assert.match(processContextBlock(d, migrate, '', false, { lookup: conditionLookup({}) }), /this phase runs only when: `needs-migration` is `yes` \(the variable is not set/);
        // The agent's leaveOut makes Leave out its own, with its reason.
        const marked: ProcessState = { ...ship, leaveOut: { level: 'step', reason: 'no public API change' } };
        const out = move(availableMoves(d, marked, vars({})), 'leave-out', 'step');
        assert.deepEqual(out.target.skipped?.map((r) => [r.step, r.by, r.reason]), [['announce', 'agent', 'no public API change']]);
        assert.equal(out.target.leaveOut, undefined, 'dropped with the move');
        assert.equal(at(out.target), 'ship/gate');
    });

    test('PC-8: the state file and the context block', () => {
        const d = def(ALTERNATIVES);
        const o = vars({ 'spec-mode': 'change' });
        const start = selectProcess(d);
        const there = move(availableMoves(d, move(availableMoves(d, start, o), 'proceed').target, o), 'proceed').target;
        const withFlag: ProcessState = { ...there, leaveOut: { level: 'step', reason: 'why' } };
        const read = parseProcessState(stringifyProcessState(withFlag, NOW));
        assert.deepEqual(read.skipped, there.skipped);
        assert.deepEqual(read.leaveOut, { level: 'step', reason: 'why' });
        const block = processContextBlock(d, there, '', false, o);
        assert.match(block, /`idea-rounds` \(when `spec-mode` is `initial`, left out\)/);
        assert.match(block, /`change-intent` \(when `spec-mode` is `change`\)/);
        assert.match(block, /Left out so far: step `idea-rounds` of phase `intent` — runs only when `spec-mode` is `initial`/);
        const phased = def(PHASES);
        assert.match(processContextBlock(phased, { ...selectProcess(phased), phase: 'research', step: 'read' }, ''), /This phase is optional\./);
    });

    test('PC-9: the PROCESS view\'s notes', () => {
        // The handler needs `vscode`: loaded under the stub.
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { installVscodeStub } = require('../../tools/__tests__/_vscode-stub.js') as typeof import('../../tools/__tests__/_vscode-stub');
        const stub = installVscodeStub({});
        try {
            const { conditionNotes } = require('../../handlers/processPanel-handler.js') as typeof import('../../handlers/processPanel-handler');
            const d = def(PHASES);
            const ship = conditionNotes(d, { ...selectProcess(d), phase: 'ship', step: 'release' }, conditionLookup({}));
            assert.equal(ship.phase, null);
            assert.deepEqual(ship.steps, {
                release: { optional: true, when: '', verdict: '' },
                announce: { optional: false, when: 'the release changes the public API', verdict: 'the agent judges it at Proceed' },
            });
            const migrate = conditionNotes(d, { ...selectProcess(d), phase: 'migrate', step: 'move' }, conditionLookup({ 'needs-migration': 'no' }));
            assert.deepEqual(migrate.phase, { optional: false, when: 'needs-migration is yes', verdict: 'does not hold now' });
            assert.deepEqual(migrate.steps, {});
        } finally {
            stub.restore();
        }
        /* eslint-enable @typescript-eslint/no-require-imports */
    });
});
