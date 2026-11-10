/**
 * The agent's tools for nested processes (src/tools/process-stack-tools.ts, tomAi_getProcessState {level}),
 * over fake deps built from the real stack rules (src/utils/processStack.ts).
 *
 *   PT-1 tomAi_getProcessStack: every level bottom to top — kind, process, position, the step it was started
 *        from, follow-up and start, inputs, open suggestions; the last one runs
 *   PT-2 tomAi_getProcessState {level}: 0 the bottom, -1 the top (default), -2 the one below; out of range
 *        refused; a lower level's answer says it waits and carries its own context
 *   PT-3 tomAi_listSubprocessCandidates: the running step's listed processes, both lists, with summary, start,
 *        inputs, and which were suggested; none at a step without lists
 *   PT-4 tomAi_suggestSubprocess: a listed process with a reason is stored and nothing starts; shown now when no
 *        run of the step is open, when its queue items are done otherwise; an unlisted process, a missing reason,
 *        an ambiguous kind, a bad follow-up are refused; a process suggested again replaces its suggestion
 *   PT-5 tomAi_getSubprocessRuns: the runs started from the level's current step (all: every step), finished
 *        or aborted, the follow-up, where it was left, the outputs handed back
 *   PT-6 the five are registered; none starts or aborts a level
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    getProcessStackImpl, getSubprocessRunsImpl, listSubprocessCandidatesImpl, suggestSubprocessImpl, PROCESS_STACK_TOOLS, type ProcessStackDeps,
} from '../process-stack-tools.js';
import { getProcessStateImpl, resolveLevelIndex, type ProcessToolDeps } from '../quest-process-tools.js';
import { checkSuggestions, endNestedLevel, mergeSuggestions, pushNestedLevel } from '../../utils/processStack.js';
import { selectProcess, type ProcessDefinition, type ProcessState } from '../../utils/processDefinition.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const MAIN = {
    id: 'main', name: 'Main', phases: [{ id: 'p1', name: 'P1', steps: [
        { id: 'plan', name: 'Plan', subprocesses: [{ process: 'team', inputs: { documents: 'docs' } }, 'both'], branches: ['side', 'both'] },
        { id: 'build', name: 'Build' },
    ], gate: { id: 'g' } }],
} as unknown as ProcessDefinition;
const TEAM = { id: 'team', name: 'Team review', summary: 'Merge reviewed copies', inputs: [{ name: 'documents', required: true }], outputs: [{ name: 'merged' }], phases: [{ id: 'prep', name: 'Prepare', steps: [{ id: 'dist', name: 'Distribute' }], gate: { id: 'g' } }] } as unknown as ProcessDefinition;
const SIDE = { id: 'side', phases: [{ id: 'a', steps: [{ id: 'b' }], gate: { id: 'g' } }] } as unknown as ProcessDefinition;
const BOTH = { id: 'both', phases: [{ id: 'a', steps: [{ id: 'b' }], gate: { id: 'g' } }] } as unknown as ProcessDefinition;
const DEFS = new Map<string, ProcessDefinition>([['main', MAIN], ['team', TEAM], ['side', SIDE], ['both', BOTH]]);

function fixture(start: ProcessState[] = [selectProcess(MAIN)]) {
    let levels = start;
    let running = false;
    let shown = 0;
    const deps: ProcessStackDeps = {
        activeQuest: () => 'q1',
        levels: () => levels,
        definitions: () => DEFS,
        suggest: (input) => {
            const top = levels[levels.length - 1];
            const checked = checkSuggestions(DEFS.get(top.process) ?? null, top, input, new Date('2026-11-10T03:00:00Z'));
            if (!checked.ok) { return checked; }
            const next = { ...top, suggestions: mergeSuggestions(top.suggestions, checked.suggestions) };
            levels = [...levels.slice(0, -1), next];
            return { ok: true, state: next };
        },
        stepRunning: () => running,
        showSuggestions: () => { shown++; },
    };
    return {
        deps,
        get levels() { return levels; },
        set levels(v: ProcessState[]) { levels = v; },
        setRunning: (r: boolean) => { running = r; },
        get shown() { return shown; },
    };
}
const parse = (s: string): Json => JSON.parse(s);

describe('nested-process tools', () => {
    test('PT-1: tomAi_getProcessStack', async () => {
        const f = fixture();
        f.levels = pushNestedLevel(f.levels, TEAM, 'subprocess', 'go-on', new Date('2026-11-10T02:00:00Z'), { documents: 'docs' });
        const r = parse(await withTiming('tomAi_getProcessStack:typical', () => getProcessStackImpl(f.deps)));
        assert.equal(r.ok, true);
        assert.deepEqual(r.levels.map((l: Json) => [l.level, l.kind, l.process, l.running]), [[0, 'process', 'main', false], [1, 'subprocess', 'team', true]]);
        assert.match(r.levels[0].position, /Plan/);
        assert.match(r.levels[1].position, /Prepare.*Distribute/);
        assert.match(r.levels[1].startedFrom, /^main › .*Plan/);
        assert.deepEqual([r.levels[1].followUp, r.levels[1].followUpText, r.levels[1].startedAt, r.levels[1].inputs], ['go-on', 'Go on past the step', '2026-11-10T02:00:00.000Z', { documents: 'docs' }]);
        assert.equal(r.levels[0].startedFrom, undefined);
    });

    test('PT-2: tomAi_getProcessState {level}', async () => {
        const f = fixture();
        f.levels = pushNestedLevel(f.levels, SIDE, 'branch', 'ask');
        const deps: ProcessToolDeps = {
            list: () => [], activeQuest: () => 'q1', state: () => f.levels[f.levels.length - 1], currentRole: () => 'reviewer',
            contextBlock: () => 'TOP CONTEXT', apply: () => ({ ok: false, error: 'n/a' }), dropProcessMoveMarkers: () => 0,
            levels: () => f.levels, levelContextBlock: (i) => `CONTEXT OF LEVEL ${i}`,
        };
        const top = parse(await withTiming('tomAi_getProcessState:level', () => getProcessStateImpl(deps, {})));
        assert.deepEqual([top.level, top.levels, top.state.process, top.role, top.context], [1, 2, 'side', 'reviewer', 'TOP CONTEXT']);
        const bottom = parse(await getProcessStateImpl(deps, { level: 0 }));
        assert.deepEqual([bottom.level, bottom.state.process, bottom.role, bottom.context], [0, 'main', undefined, 'CONTEXT OF LEVEL 0']);
        assert.match(bottom.waiting, /waits at its step/);
        assert.equal(parse(await getProcessStateImpl(deps, { level: -2 })).state.process, 'main');
        assert.match(parse(await getProcessStateImpl(deps, { level: 2 })).error, /no level 2: the stack has 2 level\(s\)/);
        assert.deepEqual([resolveLevelIndex(3, undefined), resolveLevelIndex(3, -3), resolveLevelIndex(3, 1.5)], [2, 0, { error: '`level` is a whole number: 0 the bottom, -1 the top' }]);
    });

    test('PT-3: tomAi_listSubprocessCandidates', async () => {
        const f = fixture();
        const r = parse(await withTiming('tomAi_listSubprocessCandidates:typical', () => listSubprocessCandidatesImpl(f.deps)));
        assert.deepEqual(r.candidates.map((c: Json) => [c.kind, c.process]), [['subprocess', 'team'], ['subprocess', 'both'], ['branch', 'side'], ['branch', 'both']]);
        const team = r.candidates[0];
        assert.deepEqual([team.name, team.summary, team.valid, team.inputs], ['Team review', 'Merge reviewed copies', true, [{ name: 'documents', required: true, from: 'docs' }]]);
        assert.match(team.startsAt, /Prepare.*Distribute/);
        await suggestSubprocessImpl(f.deps, { suggestions: [{ process: 'side', reason: 'try another way' }] });
        const again = parse(await listSubprocessCandidatesImpl(f.deps));
        assert.equal(again.candidates[0].process, 'side', 'the suggested one first');
        assert.equal(again.candidates[0].suggested, 'try another way');
        f.levels = [{ ...f.levels[0], step: 'build' }];
        assert.equal(parse(await listSubprocessCandidatesImpl(f.deps)).candidates.length, 0);
    });

    test('PT-4: tomAi_suggestSubprocess', async () => {
        const f = fixture();
        f.setRunning(true);
        const r = parse(await withTiming('tomAi_suggestSubprocess:typical', () => suggestSubprocessImpl(f.deps, { suggestions: [{ process: 'team', reason: 'three reviewers', followUp: 'go-on' }] })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.suggestions, [{ kind: 'subprocess', process: 'team', reason: 'three reviewers', followUp: 'go-on', at: '2026-11-10T03:00:00.000Z' }]);
        assert.match(r.shown, /when the step's queue items are done/);
        assert.equal(f.shown, 0, 'the running step is not interrupted');
        assert.equal(f.levels.length, 1, 'nothing started');
        f.setRunning(false);
        const now = parse(await suggestSubprocessImpl(f.deps, { suggestions: [{ process: 'team', reason: 'two reviewers now' }, { process: 'side', reason: 'explore' }] }));
        assert.match(now.shown, /^now/);
        assert.equal(f.shown, 1);
        assert.deepEqual(f.levels[0].suggestions!.map((x) => [x.process, x.reason]), [['team', 'two reviewers now'], ['side', 'explore']], 'replaced, added');
        for (const [input, why] of [
            [{ suggestions: [{ process: 'other', reason: 'x' }] }, /lists no process "other"; it lists team \(subprocess\), both \(subprocess\), side \(branch\), both \(branch\)/],
            [{ suggestions: [{ process: 'team', reason: ' ' }] }, /give the reason for suggesting "team"/],
            [{ suggestions: [{ process: 'both', reason: 'x' }] }, /listed as a subprocess and as a branch: say which/],
            [{ suggestions: [{ process: 'side', kind: 'subprocess', reason: 'x' }] }, /does not list "side" as a subprocess/],
            [{ suggestions: [{ process: 'team', reason: 'x', followUp: 'later' }] }, /followUp is "ask", "go-on" or "run-again"/],
            [{ suggestions: [] }, /suggest at least one process/],
        ] as const) {
            assert.match(parse(await suggestSubprocessImpl(f.deps, input as Json)).error, why);
        }
        assert.equal(parse(await suggestSubprocessImpl(f.deps, { suggestions: [{ process: 'both', kind: 'branch', reason: 'x' }] })).ok, true);
        f.levels = [{ ...f.levels[0], decision: true }];
        assert.match(parse(await suggestSubprocessImpl(f.deps, { suggestions: [{ process: 'team', reason: 'x' }] })).error, /at a decision/);
    });

    test('PT-5: tomAi_getSubprocessRuns', async () => {
        const f = fixture();
        f.levels = pushNestedLevel(f.levels, TEAM, 'subprocess', 'run-again', new Date('2026-11-10T01:00:00Z'), { documents: 'docs' });
        f.levels = [...f.levels.slice(0, -1), { ...f.levels[1], outputs: { merged: 'm.md' }, completed: true }];
        f.levels = (endNestedLevel(f.levels, DEFS, 'finished', new Date('2026-11-10T01:30:00Z')) as Json).levels;
        f.levels = pushNestedLevel(f.levels, SIDE, 'branch', 'ask');
        f.levels = (endNestedLevel(f.levels, DEFS, 'aborted') as Json).levels;
        const r = parse(await withTiming('tomAi_getSubprocessRuns:typical', () => getSubprocessRunsImpl(f.deps, {})));
        assert.deepEqual(r.runs.map((x: Json) => [x.process, x.kind, x.outcome, x.followUp]), [['team', 'subprocess', 'finished', 'run-again'], ['side', 'branch', 'aborted', 'ask']]);
        assert.deepEqual([r.runs[0].outputs, r.runs[0].startedAt, r.runs[0].endedAt], [{ merged: 'm.md' }, '2026-11-10T01:00:00.000Z', '2026-11-10T01:30:00.000Z']);
        assert.match(r.runs[0].from, /Plan/);
        assert.match(r.runs[1].left, /A|b/);
        assert.equal(r.scope, 'this step, in its current iteration');
        // Another step: none from it, all of them with `all`.
        f.levels = [{ ...f.levels[0], step: 'build' }];
        assert.equal(parse(await getSubprocessRunsImpl(f.deps, {})).runs.length, 0);
        assert.equal(parse(await getSubprocessRunsImpl(f.deps, { all: true })).runs.length, 2);
        assert.match(parse(await getSubprocessRunsImpl(f.deps, { level: 3 })).error, /no level 3/);
    });

    test('PT-6: registration', () => {
        assert.deepEqual(PROCESS_STACK_TOOLS.map((t) => [t.name, t.readOnly]), [
            ['tomAi_getProcessStack', true], ['tomAi_listSubprocessCandidates', true], ['tomAi_suggestSubprocess', false], ['tomAi_getSubprocessRuns', true],
        ]);
        for (const t of PROCESS_STACK_TOOLS) { assert.doesNotMatch(t.name, /start|abort/i); }
        assert.match(PROCESS_STACK_TOOLS[2].description, /starts nothing/);
    });
});
