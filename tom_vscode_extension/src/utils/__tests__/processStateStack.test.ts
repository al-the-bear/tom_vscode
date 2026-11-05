/**
 * The process state as a stack of levels (src/utils/processDefinition.ts,
 * ProcessStateStack; src/utils/processRepository.ts), and its conversion by the
 * `_ai` format migration (aiFormatMigration.ts, format version 2).
 *
 *   PS-1 an older, flat state file reads as a stack of its one level; the position is the same
 *   PS-2 a stack is written as `levels`; the top level is the position, and writing the position
 *        keeps the levels below it
 *   PS-3 the migration rewrites a flat file as a stack (its `updated` kept), leaves a stack alone, lists it
 *        in a dry run without writing, and stamps format version 2; a second run lists nothing
 *   PS-4 every reader sees the same position before and after the conversion: the repository, the chat
 *        variables (processVariableValues) and the system prompt's *Current process* (processContextBlock)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';

import { ProcessRepository } from '../processRepository.js';
import {
    parseProcessState,
    parseProcessStateStack,
    processContextBlock,
    processVariableValues,
    stringifyProcessDefinition,
    stringifyProcessStateStack,
    type ProcessDefinition,
    type ProcessState,
} from '../processDefinition.js';
import { migrateAiFormats } from '../aiFormatMigration.js';
import { AI_FORMAT_VERSION, readAiFormatStamp } from '../aiFormatVersion.js';

const FLAT = `process: demo
phase: phase1
phaseIteration: 2
step: work
stepIteration: 3
substep: ""
substepIteration: 1
decision: true
stepIterations:
  phase: phase1
  phaseIteration: 2
  steps:
    work: 2
updated: 2026-11-05T16:08:44.593Z
`;

const DEF: ProcessDefinition = {
    id: 'demo', name: 'Demo', summary: '',
    phases: [{ id: 'phase1', name: 'Phase 1', description: 'the phase', repeatable: true, steps: [{ id: 'work', name: 'Work', repeatable: true }], gate: { id: 'gate', name: 'Gate' } }],
};

function workspace() {
    const ai = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'process-stack-')), '_ai');
    fs.mkdirSync(path.join(ai, 'quests', 'qa'), { recursive: true });
    fs.mkdirSync(path.join(ai, 'processes', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(ai, 'processes', 'demo', 'demo.process.yaml'), stringifyProcessDefinition(DEF));
    fs.writeFileSync(path.join(ai, 'processes', 'demo', 'demo.md'), 'Demo process');
    const file = path.join(ai, 'quests', 'qa', 'process-state.qa.yaml');
    const repo = new ProcessRepository(path.join(ai, 'processes'), path.join(ai, 'quests'));
    return { ai, file, repo };
}

const migrate = (ai: string, apply: boolean) =>
    migrateAiFormats({ aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, today: '2026-11-05' });

const EXPECTED: ProcessState = {
    process: 'demo', phase: 'phase1', phaseIteration: 2, step: 'work', stepIteration: 3, substep: '', substepIteration: 1,
    completed: false, decision: true, stepIterations: { phase: 'phase1', phaseIteration: 2, steps: { work: 2 } },
};

describe('process state stack', () => {
    test('PS-1: a flat file is a stack of one level', () => {
        assert.deepEqual(parseProcessStateStack(FLAT), { levels: [EXPECTED] });
        assert.deepEqual(parseProcessState(FLAT), EXPECTED);
        assert.deepEqual(parseProcessState('levels: []\n'), parseProcessState(''), 'an empty stack is the empty state');
    });

    test('PS-2: written as levels; the levels below the top stay', () => {
        const { repo, file } = workspace();
        const below: ProcessState = { ...EXPECTED, process: 'outer', decision: undefined, stepIterations: undefined };
        delete below.decision; delete below.stepIterations;
        fs.writeFileSync(file, stringifyProcessStateStack({ levels: [below, EXPECTED] }, '2026-11-05T00:00:00.000Z'));
        assert.deepEqual(repo.readState('qa'), EXPECTED, 'the top level is the position');
        repo.writeState('qa', { ...EXPECTED, step: 'gate', stepIteration: 1 });
        const raw = parse(fs.readFileSync(file, 'utf8'));
        assert.equal(raw.levels.length, 2);
        assert.equal(raw.levels[0].process, 'outer', 'the level below is kept');
        assert.equal(raw.levels[1].step, 'gate');
        assert.equal(raw.process, undefined, 'nothing at the top of the file but levels and updated');
    });

    test('PS-3: the migration converts flat files', () => {
        const { ai, file } = workspace();
        fs.writeFileSync(file, FLAT);
        const dry = migrate(ai, false);
        assert.ok(dry.changes.some((c) => c.quest === 'qa' && c.step === 'process-state'));
        assert.equal(fs.readFileSync(file, 'utf8'), FLAT, 'a dry run writes nothing');
        migrate(ai, true);
        const raw = parse(fs.readFileSync(file, 'utf8'));
        assert.equal(raw.levels.length, 1);
        assert.equal(raw.updated, '2026-11-05T16:08:44.593Z', 'the time the position was set stays');
        assert.equal(readAiFormatStamp(ai)?.version, AI_FORMAT_VERSION);
        assert.equal(AI_FORMAT_VERSION >= 2, true, 'the stack is format version 2');
        assert.deepEqual(migrate(ai, false).changes, [], 'nothing left to migrate');
    });

    test('PS-4: every reader sees the same position', () => {
        const { ai, file, repo } = workspace();
        fs.writeFileSync(file, FLAT);
        const read = () => {
            const state = repo.readState('qa');
            const def = repo.list().find((e) => e.id === 'demo')!.definition!;
            return { state, vars: processVariableValues(def, state, 'Demo process'), context: processContextBlock(def, state, 'Demo process') };
        };
        const before = read();
        migrate(ai, true);
        const after = read();
        assert.deepEqual(after, before);
        assert.equal(after.vars.step, 'work');
        assert.match(after.context, /Work/);
    });
});
