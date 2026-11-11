/**
 * The SESSIONS view's "Remove unused sessions" plan (src/utils/unusedSessions.ts): what it offers, what it
 * keeps and why.
 *
 *   US-1 offered: named sessions nothing uses; those without a conversation ticked, those with one not
 *   US-2 kept: `default` / `chat`, a queue item's session or base (any status but sent), the queue's default
 *        session, a session another one is based on, a temporary session
 *   US-3 kept: what a process definition names at any level (process, phase, step, gate, post-gate,
 *        sub-step), as name or base; a name with placeholders keeps every session it can become
 *   US-5 a process run's session (`<name>@<run>`, vscimpb44) is kept while `<name>` is a session the process names
 *        and its run exists (`named by the process "p" (work), run chg1`); once the run is gone it is offered;
 *        a plain session is judged as before; an unnamed base offers it
 *   US-4 the action is a title-bar command of the SESSIONS view, registered by the handler
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionRecord } from '../agentSdkSessions';
import type { ProcessDefinition } from '../processDefinition';
import { sessionRows } from '../sessionsViewRows';
import { planUnusedSessions, type SessionUsingItem } from '../unusedSessions';

const rec = (name: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({ name, mode: 'continue', createdAt: '2026-11-01T10:00:00Z', ...extra });

function plan(records: SessionRecord[], opts: { items?: SessionUsingItem[]; defaultSession?: string; processes?: ProcessDefinition[]; runs?: string[] } = {}) {
    return planUnusedSessions({
        rows: sessionRows(records),
        queueItems: opts.items ?? [],
        ...(opts.defaultSession ? { queueDefaultSession: opts.defaultSession } : {}),
        processes: opts.processes ?? [],
        runs: opts.runs ?? ['default'],
    });
}

const reasonOf = (p: ReturnType<typeof plan>, name: string) => p.kept.find((k) => k.name === name)?.reason;

describe('remove unused sessions: the plan', () => {
    test('US-1: offered, and ticked when without a conversation', () => {
        const p = plan([
            rec('p2s3-todo', { mode: 'per-prompt' }),
            rec('old-work', { sessionId: 'sdk-1', updatedAt: '2026-10-02T08:00:00Z' }),
        ]);
        assert.deepEqual(p.offered.map((o) => [o.name, o.preselected]), [['old-work', false], ['p2s3-todo', true]]);
        assert.equal(p.offered.find((o) => o.name === 'old-work')!.detail, 'continue · has a conversation · last used 2026-10-02');
        assert.equal(p.offered.find((o) => o.name === 'p2s3-todo')!.detail, 'per prompt · no conversation · last used 2026-11-01');
    });

    test('US-2: kept for the queue, bases and temporary sessions', () => {
        const p = plan([
            rec('running'), rec('staged-in'), rec('base-of-new'), rec('done-with'), rec('queue-default'),
            rec('base'), rec('child', { basedOn: 'base' }), rec('tmp-261107-101500-abc'),
        ], {
            items: [
                { id: 'i1', status: 'sending', session: 'running' },
                { id: 'i2', status: 'staged', session: 'staged-in' },
                { id: 'i3', status: 'error', session: 'not-yet', sessionCreate: { basedOn: 'base-of-new' } },
                { id: 'i4', status: 'sent', session: 'done-with' },
            ],
            defaultSession: 'queue-default',
        });
        assert.match(reasonOf(p, 'default')!, /prompt queue/);
        assert.match(reasonOf(p, 'chat')!, /ANTHROPIC\/LLM panel/);
        assert.equal(reasonOf(p, 'running'), 'queue item i1 (sending) runs in it');
        assert.equal(reasonOf(p, 'staged-in'), 'queue item i2 (staged) runs in it');
        assert.equal(reasonOf(p, 'base-of-new'), 'queue item i3 (error) is created from it');
        assert.equal(reasonOf(p, 'queue-default'), 'the queue\'s default session');
        assert.equal(reasonOf(p, 'base'), 'the base of child');
        assert.match(reasonOf(p, 'tmp-261107-101500-abc')!, /temporary/);
        assert.deepEqual(p.offered.map((o) => o.name).sort(), ['child', 'done-with'], 'a sent item no longer keeps its session');
    });

    test('US-3: kept for the process definitions', () => {
        const def = {
            id: 'flow',
            session: 'flow-main',
            phases: [{
                id: 'p1',
                session: { name: 'phase-one', basedOn: 'phase-base' },
                steps: [{ id: 's1', substeps: [{ id: 'ss1', session: 'todo-p1s1ss${substep-iteration}' }] }],
                gate: { id: 'g1', session: 'gate-review' },
                postGate: { id: 'pg', session: { name: 'post-${phase-iteration}', mode: 'per-prompt' } },
            }],
        } as unknown as ProcessDefinition;
        const p = plan([
            rec('flow-main'), rec('phase-one'), rec('phase-base'), rec('gate-review'),
            rec('todo-p1s1ss3'), rec('post-2'), rec('todo-p1s1ss'), rec('unrelated'),
        ], { processes: [def] });
        assert.equal(reasonOf(p, 'flow-main'), 'named by the process "flow" (flow-main)');
        assert.equal(reasonOf(p, 'phase-one'), 'named by the process "flow" (phase-one)');
        assert.equal(reasonOf(p, 'phase-base'), 'the base of a session of the process "flow"');
        assert.ok(reasonOf(p, 'gate-review'));
        assert.equal(reasonOf(p, 'todo-p1s1ss3'), 'named by the process "flow" (todo-p1s1ss${substep-iteration})');
        assert.ok(reasonOf(p, 'post-2'));
        assert.deepEqual(p.offered.map((o) => o.name).sort(), ['todo-p1s1ss', 'unrelated'],
            'a placeholder stands for at least one character');
    });

    test('US-5: a process run\'s sessions', () => {
        const def = {
            id: 'p',
            session: 'work',
            phases: [{ id: 'p1', steps: [{ id: 's1', session: { name: 'step-${step-iteration}', basedOn: 'seed' } }] }],
        } as unknown as ProcessDefinition;
        const records = [rec('work'), rec('work@chg1'), rec('work@chg2'), rec('step-3@chg1'), rec('seed@chg1'), rec('other@chg1'), rec('lone')];
        const live = plan(records, { processes: [def], runs: ['default', 'chg1'] });
        assert.equal(reasonOf(live, 'work'), 'named by the process "p" (work)', 'a plain session as before');
        assert.equal(reasonOf(live, 'work@chg1'), 'named by the process "p" (work), run chg1');
        assert.equal(reasonOf(live, 'step-3@chg1'), 'named by the process "p" (step-${step-iteration}), run chg1');
        assert.equal(reasonOf(live, 'seed@chg1'), 'the base of a session of the process "p", run chg1');
        assert.deepEqual(live.offered.map((o) => o.name).sort(), ['lone', 'other@chg1', 'work@chg2'],
            'a deleted run\'s session, and a run session the process does not name');
        const gone = plan(records, { processes: [def], runs: ['default'] });
        assert.equal(reasonOf(gone, 'work'), 'named by the process "p" (work)');
        assert.deepEqual(gone.offered.map((o) => o.name).sort(), ['lone', 'other@chg1', 'seed@chg1', 'step-3@chg1', 'work@chg1', 'work@chg2'],
            'the run deleted: its sessions are offered');
        const handler = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'sessionsView-handler.ts'), 'utf8');
        assert.match(handler, /const runs = processes\.runs\(\)\.map\(\(r\) => r\.run\);/);
        assert.match(handler, /^\s+runs,$/m, 'the handler passes the quest\'s runs');
    });

    test('US-4: a title-bar command of the SESSIONS view', () => {
        const root = join(__dirname, '..', '..', '..');
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === 'tomAi.sessions.removeUnused'));
        assert.ok(pkg.contributes.menus['view/title'].some((m: { command: string; when: string }) =>
            m.command === 'tomAi.sessions.removeUnused' && m.when === 'view == tomAi.sessions'));
        const handler = readFileSync(join(root, 'src', 'handlers', 'sessionsView-handler.ts'), 'utf8');
        assert.match(handler, /registerCommand\(REMOVE_UNUSED_SESSIONS_COMMAND/);
        assert.match(handler, /canPickMany: true/);
    });
});
