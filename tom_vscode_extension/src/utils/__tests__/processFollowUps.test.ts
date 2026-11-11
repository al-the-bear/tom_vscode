/**
 * Follow-up processes (vscimpb47, src/utils/processDefinition.ts): a process, a phase or a step names where the
 * quest may continue when it ends — another process at a named phase and step — offered at the decision there.
 *
 *   PF-1 a definition with follow-ups on the process, a phase and a step validates (validator and JSON schema)
 *        and is written back unchanged
 *   PF-2 validation: the shape (a process id required, phase / step ids, step only with phase, carry names,
 *        context texts, unknown keys, twice the same target), and with the other processes known: the target
 *        process, its phase and the step in that phase must exist (the own process counts); the schema
 *        rejects the same shapes
 *   PF-3 the decision offers them: the phase's at its end (after its gate, "Gate passed — Continue in …"), the
 *        step's at the step's end (a step with follow-ups ends at a decision), the process's at the end of its
 *        last phase — each beside going on; the target is the named phase and step (default: the first ones),
 *        past what its conditions leave out; not offered in a subprocess / branch, without the other
 *        processes, or when the target is gone
 *   PF-4 the switch: the origin records where it came from (the chain grows, at most 20); the call context is
 *        resolved and the carried variables' values recorded; `${process-origin}` and `${origin.<name>}`; the
 *        chain as text; the state file writes and reads it; the context block says where it came from
 *   PF-5 the decisions-journal entry of a switch: from, to, run, carried, call context
 */

/* eslint-disable @typescript-eslint/naming-convention -- chat-variable names */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import {
    EMPTY_PROCESS_STATE,
    MAX_ORIGIN_RECORDS,
    completeFollowUpSwitch,
    conditionLookup,
    decisionAt,
    followUpJournalEntry,
    originChainText,
    originVariables,
    parseProcessState,
    parseProcessYaml,
    processContextBlock,
    stringifyProcessDefinition,
    stringifyProcessState,
    validateProcessDefinition,
    type ProcessDefinition,
    type ProcessMove,
    type ProcessState,
} from '../processDefinition.js';

const CHANGE = `id: change
name: Spec Change
followUps:
  - process: specs
    phase: p3
    description: implement the change
phases:
  - id: intent
    name: Intent
    followUps:
      - process: specs
        phase: p2
        step: draft
        description: the change in the specification
        carry:
          - change
        context:
          scope: \${change}
          note: from the impact evaluation
    steps:
      - id: capture
        name: Capture
      - id: impact
        name: Impact
        followUps:
          - process: specs
    gate:
      id: gate1
  - id: close
    steps:
      - id: wrap
    gate:
      id: gate2
`;

const SPECS = `id: specs
name: Specs
phases:
  - id: p1
    steps:
      - id: s1
    gate:
      id: g1
  - id: p2
    name: Phase 2
    steps:
      - id: prep
        when:
          var: mode
          equals: full
      - id: draft
        name: Draft
    gate:
      id: g2
  - id: p3
    steps:
      - id: build
    gate:
      id: g3
`;

const def = (text: string): ProcessDefinition => {
    const v = parseProcessYaml(text);
    assert.deepEqual(v.errors, []);
    return v.definition!;
};
const change = def(CHANGE);
const specs = def(SPECS);
const processOf = (id: string): ProcessDefinition | undefined => ({ change, specs } as Record<string, ProcessDefinition>)[id];
const schema = (): ((data: unknown) => boolean) & { errors?: unknown } => {
    const raw = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'src', 'config', 'process.schema.json'), 'utf-8'));
    return new Ajv2020({ allErrors: true, strict: false }).compile(raw);
};
const at = (phase: string, step: string, extra: Partial<ProcessState> = {}): ProcessState => ({ ...EMPTY_PROCESS_STATE, process: 'change', phase, step, ...extra });
const options = (vars: Record<string, string> = {}) => ({ lookup: conditionLookup(vars), processOf, now: '2026-11-11T12:00:00.000Z' });
const followUps = (state: ProcessState, vars: Record<string, string> = {}): ProcessMove[] =>
    (decisionAt(change, state, options(vars))?.options ?? []).filter((o) => o.kind === 'follow-up');

describe('follow-up processes', () => {
    test('PF-1: valid, written back unchanged', () => {
        assert.deepEqual(validateProcessDefinition(parse(CHANGE), { processOf }).errors, []);
        const validate = schema();
        assert.equal(validate(parse(CHANGE)), true, JSON.stringify(validate.errors));
        assert.deepEqual(parse(stringifyProcessDefinition(change)), parse(CHANGE));
    });

    test('PF-2: validation', () => {
        const errorsOf = (followUpsYaml: unknown, withProcesses = true): string[] =>
            validateProcessDefinition({ ...parse(CHANGE), followUps: followUpsYaml }, withProcesses ? { processOf } : {}).errors.map((e) => `${e.path}: ${e.message}`);
        assert.match(errorsOf([{ phase: 'p2' }]).join('\n'), /followUps\[0\]\.process: required/);
        assert.match(errorsOf([{ process: 'specs', step: 'draft' }]).join('\n'), /followUps\[0\]\.step: a step is named within its phase/);
        assert.match(errorsOf([{ process: 'specs', carry: ['bad name'] }]).join('\n'), /carry: a list of chat variable names/);
        assert.match(errorsOf([{ process: 'specs', context: { file: 3 } }]).join('\n'), /context\.file: text expected/);
        assert.match(errorsOf([{ process: 'specs', extra: 1 }]).join('\n'), /followUps\[0\]\.extra: unknown key/);
        assert.match(errorsOf([{ process: 'specs' }, { process: 'specs' }]).join('\n'), /the follow-up specs is listed twice/);
        assert.match(errorsOf('specs').join('\n'), /followUps: a list of/);
        // The target must exist — checked when the other processes are known.
        assert.match(errorsOf([{ process: 'nope' }]).join('\n'), /followUps\[0\]\.process: no process "nope"/);
        assert.match(errorsOf([{ process: 'specs', phase: 'p9' }]).join('\n'), /phase: the process "specs" has no phase "p9" \(its phases: p1, p2, p3\)/);
        assert.match(errorsOf([{ process: 'specs', phase: 'p2', step: 'zz' }]).join('\n'), /step: the phase "p2" of "specs" has no step "zz" \(its steps: prep, draft, g2\)/);
        assert.deepEqual(errorsOf([{ process: 'change', phase: 'close' }]), [], 'its own process counts');
        assert.deepEqual(errorsOf([{ process: 'nope' }], false), [], 'without the other processes: not checked');
        // A follow-up on a sub-step is unknown (only the process, phases and steps offer them).
        const sub = parse(CHANGE);
        sub.phases[1].steps[0].substeps = [{ id: 'a', followUps: [{ process: 'specs' }] }];
        assert.match(validateProcessDefinition(sub).errors.map((e) => e.path).join('\n'), /substeps\[0\]\.followUps/);
        const validate = schema();
        assert.equal(validate({ ...parse(CHANGE), followUps: [{ phase: 'p2' }] }), false, 'the schema: process required');
        assert.equal(validate({ ...parse(CHANGE), followUps: [{ process: 'specs', context: { a: 1 } }] }), false, 'the schema: context texts');
    });

    test('PF-3: the decision offers them', () => {
        // The phase's, at the decision after its gate: beside Gate passed / failed.
        const gate = decisionAt(change, at('intent', 'gate1', { decision: true }), options())!.options;
        assert.deepEqual(gate.map((o) => o.kind), ['gate-passed', 'gate-failed', 'follow-up']);
        const toDraft = gate[2];
        assert.equal(toDraft.label, 'Gate passed — Continue in Specs › Phase 2 › Draft (the change in the specification)');
        assert.deepEqual([toDraft.target.process, toDraft.target.phase, toDraft.target.step, toDraft.target.phaseIteration, toDraft.target.stepIteration], ['specs', 'p2', 'draft', 1, 1]);
        assert.equal(toDraft.target.decision, undefined);
        assert.deepEqual(toDraft.followUp?.key, 'phase:0');
        assert.deepEqual(toDraft.target.origins, [{ process: 'change', phase: 'intent', phaseIteration: 1, step: 'gate1', stepIteration: 1, level: 'phase', at: '2026-11-11T12:00:00.000Z' }]);
        // The step's: Impact has a follow-up, so its end is a decision (Proceed leads there), with Go on.
        const proceed = (decisionAt(change, at('intent', 'impact'), options()) ?? null);
        assert.equal(proceed, null, 'at the step itself: no decision yet');
        const impact = decisionAt(change, at('intent', 'impact', { decision: true }), options())!.options;
        assert.deepEqual(impact.map((o) => [o.kind, o.label]), [['finish', 'Go on to Gate1'], ['follow-up', 'Continue in Specs › p1']].map(([k, l]) => [k, l.replace('Gate1', 'gate1')]));
        assert.deepEqual([impact[1].target.process, impact[1].target.phase, impact[1].target.step], ['specs', 'p1', 's1'], 'the first phase and step');
        // The process's, at the end of its last phase, beside finishing.
        const end = decisionAt(change, at('close', 'gate2', { decision: true }), options())!.options;
        assert.deepEqual(end.map((o) => o.kind), ['finish-process', 'gate-failed', 'follow-up']);
        assert.equal(end[2].label, 'Gate passed — Continue in Specs › p3 (implement the change)');
        assert.equal(end[2].followUp?.key, 'process:0');
        // Past what the target's conditions leave out: Phase 2 starts at prep unless mode is full.
        const viaPhase = { ...parse(CHANGE) };
        viaPhase.phases[0].followUps = [{ process: 'specs', phase: 'p2' }];
        const two = validateProcessDefinition(viaPhase).definition!;
        const into = (vars: Record<string, string>) => decisionAt(two, at('intent', 'gate1', { decision: true }), options(vars))!.options.find((o) => o.kind === 'follow-up')!.target;
        assert.equal(into({ mode: 'full' }).step, 'prep');
        assert.equal(into({ mode: 'light' }).step, 'draft', 'prep left out by its condition');
        assert.equal(into({ mode: 'light' }).skipped?.[0]?.step, 'prep');
        // Not offered: in a subprocess / branch, without the other processes, when the target is gone.
        assert.deepEqual(followUps(at('intent', 'gate1', { decision: true, nested: { kind: 'branch', followUp: 'ask', startedAt: '' } })), []);
        assert.deepEqual((decisionAt(change, at('intent', 'gate1', { decision: true }), { lookup: conditionLookup({}) })?.options ?? []).filter((o) => o.kind === 'follow-up'), []);
        const gone = decisionAt(change, at('intent', 'gate1', { decision: true }), { lookup: conditionLookup({}), processOf: (id) => (id === 'change' ? change : undefined) })!.options;
        assert.deepEqual(gone.filter((o) => o.kind === 'follow-up'), []);
    });

    test('PF-4: the switch and what the follow-up sees', () => {
        const move = followUps(at('intent', 'gate1', { decision: true }))[0];
        const done = completeFollowUpSwitch(move, (t) => t.replace('${change}', 'CHG-7'), (n) => (n === 'change' ? 'CHG-7' : undefined));
        const origin = done.origins!.at(-1)!;
        assert.deepEqual(origin.carried, { change: 'CHG-7' });
        assert.deepEqual(origin.context, { scope: 'CHG-7', note: 'from the impact evaluation' });
        assert.deepEqual(originVariables(done), { 'process-origin': 'change/intent', 'origin.scope': 'CHG-7', 'origin.note': 'from the impact evaluation' });
        assert.deepEqual(originVariables({ ...EMPTY_PROCESS_STATE, process: 'specs' }), {});
        const unset = completeFollowUpSwitch(move, (t) => t, () => undefined);
        assert.deepEqual(unset.origins!.at(-1)!.carried, { change: '' }, 'a variable not set is recorded empty');
        // The chain grows with each switch, at most MAX_ORIGIN_RECORDS.
        assert.equal(originChainText(done), 'change › intent → specs');
        const back = { ...done, origins: [...done.origins!, { ...origin, process: 'specs', phase: 'p2', level: 'step' as const, step: 'draft' }] };
        assert.equal(originChainText(back), 'change › intent → specs › p2 › draft → specs');
        const long = { ...at('intent', 'gate1', { decision: true }), origins: Array.from({ length: MAX_ORIGIN_RECORDS }, () => origin) };
        assert.equal(followUps(long)[0].target.origins!.length, MAX_ORIGIN_RECORDS);
        // The state file keeps it.
        const read = parseProcessState(stringifyProcessState(done, '2026-11-11T12:00:00Z'));
        assert.deepEqual(read.origins, done.origins);
        // The context block tells the agent.
        const block = processContextBlock(specs, done, '');
        assert.match(block, /Continued from: `change` › `intent` as its phase's follow-up \(`\$\{process-origin\}`; chain: change › intent → specs\); call context `\$\{origin\.scope\}`, `\$\{origin\.note\}`; carried `change`/);
    });

    test('PF-5: the journal entry', () => {
        const move = followUps(at('intent', 'gate1', { decision: true }))[0];
        const done = completeFollowUpSwitch(move, (t) => t.replace('${change}', 'CHG-7'), () => 'CHG-7');
        const entry = followUpJournalEntry(at('intent', 'gate1'), 'Intent › gate1', done, 'Phase 2 › Draft', 'chg7', new Date('2026-11-11T12:00:00Z'));
        assert.equal(entry, [
            '## 2026-11-11T12:00:00.000Z — continued in the follow-up process specs',
            '',
            "- **From:** change › Intent › gate1 (the phase's follow-up)",
            '- **To:** specs › Phase 2 › Draft',
            '- **Run:** chg7',
            '- **Carried:** `change` = CHG-7',
            '- **Call context:** `scope` = CHG-7, `note` = from the impact evaluation',
            '',
        ].join('\n'));
        assert.doesNotMatch(followUpJournalEntry(at('intent', 'gate1'), 'x', done, 'y', 'default'), /Run:/);
    });
});
