/**
 * Process tools (src/tools/quest-process-tools.ts) — listProcesses,
 * getProcess, getProcessState, setProcessState — against real definitions in
 * a temporary `_ai/processes` and an in-memory quest state.
 *
 *   QP-1  listProcesses: valid processes with their outline (steps with kind), invalid ones with errors
 *   QP-2  getProcess: definition, description, files; defaults to the quest's process; unknown id refused
 *   QP-3  setProcessState moves the quest and reports the role; a refused move changes nothing
 *   QP-4  getProcessState: state, role and the system-prompt block
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { withTiming } from './_timing.js';
import {
    getProcessImpl,
    getProcessStateImpl,
    listProcessesImpl,
    setProcessStateImpl,
    type ProcessToolDeps,
} from '../quest-process-tools.js';
import { ProcessRepository } from '../../utils/processRepository.js';
import {
    EMPTY_PROCESS_STATE,
    applyProcessChange,
    currentRole,
    processContextBlock,
    type ProcessState,
} from '../../utils/processDefinition.js';

const FLOW = `id: flow
name: Flow
phases:
  - id: build
    steps:
      - id: code
        role: senior_developer
      - id: review
        repeatable: true
        role: code_reviewer
    gate:
      id: gate
    postGate:
      id: wrap
      todos:
        - title: Tag the release
`;

let deps: ProcessToolDeps;
let state: ProcessState;

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-tools-'));
    for (const [id, yaml] of [['flow', FLOW], ['broken', 'id: broken\nphases: []\n']]) {
        fs.mkdirSync(path.join(root, 'processes', id), { recursive: true });
        fs.writeFileSync(path.join(root, 'processes', id, `${id}.process.yaml`), yaml);
    }
    fs.writeFileSync(path.join(root, 'processes', 'flow', 'flow.md'), '# Flow\n\nBuild, then wrap up.');
    const repo = new ProcessRepository(path.join(root, 'processes'), path.join(root, 'quests'));
    state = { ...EMPTY_PROCESS_STATE };
    const def = (): ReturnType<ProcessRepository['definitions']> => repo.definitions();
    deps = {
        list: () => repo.list(),
        activeQuest: () => 'q1',
        state: () => state,
        currentRole: () => currentRole(def().get(state.process) ?? null, state),
        contextBlock: () => processContextBlock(def().get(state.process) ?? null, state, repo.list().find((e) => e.id === state.process)?.description ?? ''),
        apply: (change) => {
            const r = applyProcessChange(state, def(), change);
            if (r.ok) { state = r.state; }
            return r;
        },
    };
});

describe('process tools', () => {
    test('QP-1: listProcesses', async () => {
        const r = JSON.parse(await withTiming('tomAi_listProcesses:typical', () => listProcessesImpl(deps)));
        assert.equal(r.quest, 'q1');
        assert.deepEqual(r.processes.map((p: { id: string; valid: boolean }) => [p.id, p.valid]), [['broken', false], ['flow', true]]);
        assert.deepEqual(r.processes[1].phases[0].steps.map((s: { id: string; kind: string }) => `${s.id}:${s.kind}`),
            ['code:step', 'review:step', 'gate:gate', 'wrap:post-gate']);
        assert.match(r.processes[0].errors[0], /^phases: /);
    });

    test('QP-2: getProcess', async () => {
        const r = JSON.parse(await withTiming('tomAi_getProcess:typical', () => getProcessImpl(deps, { id: 'flow' })));
        assert.equal(r.description, '# Flow\n\nBuild, then wrap up.');
        assert.equal(r.definition.phases[0].postGate.todos[0].title, 'Tag the release');
        assert.match(r.files.yaml, /flow\.process\.yaml$/);
        assert.equal(JSON.parse(await getProcessImpl(deps, {})).ok, false, 'no id and no process');
        await setProcessStateImpl(deps, { process: 'flow' });
        assert.equal(JSON.parse(await getProcessImpl(deps, {})).id, 'flow', 'the quest\'s process by default');
        assert.match(JSON.parse(await getProcessImpl(deps, { id: 'nope' })).error, /no process "nope"/);
    });

    test('QP-3: setProcessState', async () => {
        const r = JSON.parse(await withTiming('tomAi_setProcessState:typical', () => setProcessStateImpl(deps, { process: 'flow' })));
        assert.deepEqual([r.ok, r.state.step, r.role, r.roleChanged], [true, 'code', 'senior_developer', true]);
        const review = JSON.parse(await setProcessStateImpl(deps, { step: 'review', stepIteration: 2 }));
        assert.deepEqual([review.state.step, review.state.stepIteration, review.role], ['review', 2, 'code_reviewer']);
        const refused = JSON.parse(await setProcessStateImpl(deps, { step: 'nope' }));
        assert.deepEqual(refused, { ok: false, error: 'no step "nope" in phase "build"' });
        assert.equal(state.step, 'review', 'nothing changed');
        const gate = JSON.parse(await setProcessStateImpl(deps, { step: 'gate' }));
        assert.deepEqual([gate.state.step, gate.role, gate.roleChanged], ['gate', '', false]);
    });

    test('QP-4: getProcessState', async () => {
        await setProcessStateImpl(deps, { process: 'flow', step: 'wrap' });
        const r = JSON.parse(await withTiming('tomAi_getProcessState:typical', () => getProcessStateImpl(deps)));
        assert.deepEqual([r.quest, r.state.process, r.state.step], ['q1', 'flow', 'wrap']);
        assert.match(r.context, /- Tag the release/);
        assert.match(r.context, /### Process description/);
    });
});
