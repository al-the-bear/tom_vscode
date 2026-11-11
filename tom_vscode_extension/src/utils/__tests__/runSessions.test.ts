/**
 * The sessions of a process run (src/utils/runSessions.ts; vscimpb44) and how a process's session is named in a run
 * (processDefinition.effectiveSession, processActionPrompt.actionSession).
 *
 *   RS-1 `<session>@<run>` for a run other than `default`; the `default` run, the shared `default` / `chat`, a
 *        temporary session and a name that already has its run stay as they are; the run and the base name of a
 *        session; the sessions of runs
 *   RS-2 a session name may carry `@<run>` (SESSION_NAME_PATTERN); a definition still may not
 *   RS-3 effectiveSession / actionSession in a run: the name with the run, iteration placeholders filled first; a
 *        `basedOn` the process names belongs to the run, another (a prepared context) stays shared; an override is
 *        taken as given
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { runSessionName, sessionBaseName, sessionRun, sessionsOfRuns } from '../runSessions.js';
import { isValidSessionName } from '../agentSdkSessions.js';
import { effectiveSession, parseProcessYaml, selectProcess, validateProcessDefinition } from '../processDefinition.js';
import { actionSession } from '../processActionPrompt.js';

const DEF = parseProcessYaml([
    'id: p', 'session: work', 'phases:', '  - id: a', '    steps:', '      - id: s1',
    '      - id: s2', '        session: {name: "review-${step-iteration}", basedOn: work, mode: per-prompt}',
    '      - id: s3', '        session: {name: notes, basedOn: prepared}',
    '    gate:', '      id: g', '',
].join('\n')).definition!;

describe('run sessions', () => {
    test('RS-1: names', () => {
        assert.equal(runSessionName('work', 'chg1'), 'work@chg1');
        assert.equal(runSessionName('work', 'default'), 'work');
        assert.equal(runSessionName('work', undefined), 'work');
        for (const shared of ['default', 'chat', 'tmp-261111-080000-ab12', 'work@chg2', '']) {
            assert.equal(runSessionName(shared, 'chg1'), shared, shared);
        }
        assert.equal(sessionRun('work@chg1'), 'chg1');
        assert.equal(sessionRun('work'), 'default');
        assert.equal(sessionBaseName('work@chg1'), 'work');
        assert.deepEqual(sessionsOfRuns(['work', 'work@chg1', 'review@chg1', 'work@chg2', 'work@chg10'], ['chg1', 'default']), ['work@chg1', 'review@chg1']);
    });

    test('RS-2: the name rules', () => {
        assert.equal(isValidSessionName('work@chg1'), true);
        assert.equal(isValidSessionName('work@'), false);
        assert.equal(isValidSessionName('@chg1'), false);
        assert.equal(isValidSessionName('a@b@c'), false);
        assert.notEqual(validateProcessDefinition({ id: 'x', session: 'work@chg1', phases: [{ id: 'a', steps: [], gate: { id: 'g' } }] }).errors.length, 0,
            'a definition names plain sessions; the run is added when it runs');
    });

    test('RS-3: a process\'s sessions in a run', () => {
        const at = (step: string) => ({ ...selectProcess(DEF), step, stepIteration: 2 });
        assert.equal(effectiveSession(DEF, at('s1'), 'chg1')?.name, 'work@chg1');
        assert.equal(effectiveSession(DEF, at('s1'))?.name, 'work', 'the default run');
        assert.deepEqual(effectiveSession(DEF, at('s2'), 'chg1'), { name: 'review-2@chg1', basedOn: 'work@chg1', mode: 'per-prompt' }, 'its own base is the run\'s');
        assert.deepEqual(effectiveSession(DEF, at('s3'), 'chg1'), { name: 'notes@chg1', basedOn: 'prepared' }, 'a prepared context stays shared');
        assert.equal(actionSession(DEF, at('s1'), undefined, null, 'chg1').name, 'work@chg1');
        assert.equal(actionSession(DEF, at('s1'), 'picked', null, 'chg1').name, 'picked', 'an override as given');
    });
});
