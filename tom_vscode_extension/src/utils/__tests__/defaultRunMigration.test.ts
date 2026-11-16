/**
 * The `default` run runs no process: the `_ai` format migration moves a process a quest still follows on
 * `default` into a run of its own (utils/defaultRunMigration.ts; vscimpb122, format version 9).
 *
 *   DM-1 a dry run lists the move and writes nothing
 *   DM-2 the move: the whole state stack into a run named after the process; `default` left with no process and
 *        naming the run (`movedTo`); the variables the process uses (run parameters, `process-subject`, the ones
 *        its definition and included prompts name) go to the run's set of every chat-variable file, the others
 *        stay; its named sessions become the run's (session file, storage, quest memory; a based-on session
 *        follows); its staged / pending queue items move to the run with their sessions, other items stay; the
 *        decisions journal records it
 *   DM-3 idempotent: a second run moves nothing
 *   DM-4 the run name: the process id, `-2` when taken; a definition that is gone moves the state only (a problem)
 *   DM-5 through migrateAiFormats: the `default-run` step, and the format version 9
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse, stringify } from 'yaml';

import { migrateDefaultRunProcess, movedToRunOf, runNameForProcess, freeRunName, processSessionNames } from '../defaultRunMigration';
import { parseProcessStateStack, parseProcessYaml } from '../processDefinition';
import { migrateAiFormats } from '../aiFormatMigration';
import { AI_FORMAT_VERSION } from '../aiFormatVersion';

const DES = [
    'id: des', 'name: Design', 'session: work', 'runParameters: [design]',
    'phases:',
    '  - id: p1', '    steps:',
    '      - id: start', '      - id: work', '        prompt: "${file-_ai/processes/_prompts/ctx.md} Work on ${design-input}."',
    '      - id: review', '        session:', '          name: review', '          basedOn: work', '          mode: per-prompt',
    '    gate:', '      id: g1', '',
].join('\n');

function sandbox(): { ai: string; q: string } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'default-run-')));
    const ai = path.join(root, '_ai');
    const put = (rel: string, text: string): void => { const f = path.join(ai, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    put('processes/des/des.process.yaml', DES);
    put('processes/_prompts/ctx.md', 'The mode is ${design-mode}.\n');
    put('quests/q/process-state.q.yaml', stringify({
        levels: [{ process: 'des', phase: 'p1', phaseIteration: 1, step: 'work', stepIteration: 2, substep: '', substepIteration: 1, completed: false, stepIterations: { work: 1 } }],
        updated: '2026-11-15T10:00:00.000Z',
    }));
    put('chat_variables/q.host1.chatvariable.yaml', stringify({ quest: 'q', role: 'designer', custom: { design: 'tom_specs', 'design-mode': 'revise', 'design-input': 'in.md', 'process-subject': 'Revision', TODO: 'keep', other: 'x' } }));
    put('chat_variables/q.host2.chatvariable.yaml', stringify({ quest: 'q', custom: { design: 'other-host' } }));
    put('chat_variables/qq.host1.chatvariable.yaml', stringify({ quest: 'qq', custom: { design: 'another quest' } }));
    put('quests/q/history/work.session.json', JSON.stringify({ mode: 'continue', sessionId: 's-work' }));
    put('quests/q/history/review.session.json', JSON.stringify({ mode: 'per-prompt', basedOn: 'work' }));
    put('quests/q/history/default.session.json', JSON.stringify({ sessionId: 's-default' }));
    put('quests/q/history/sessions/work/live-trail.md', '<!-- tom-ai live-trail -->\n');
    put('memory/q/work/facts.md', '# facts\n');
    const item = (id: string, status: string, main: Record<string, unknown>): string => stringify({
        meta: { id, quest: 'q', status, 'main-prompt': 'P1' },
        'prompt-queue': [{ id: 'P1', type: 'main', 'prompt-text': id, ...main }],
    });
    put('queue/host_q_1-a_q.normal.entry.queue.yaml', item('proceed', 'pending', { 'process-run': { quest: 'q', state: { process: 'des' }, proceedId: 'p1' }, session: 'work' }));
    put('queue/host_q_2-b_q.normal.entry.queue.yaml', item('marker', 'staged', { 'process-run': { quest: 'q', state: { process: 'des' }, proceedId: 'p1' }, 'process-move': { kind: 'proceed' } }));
    put('queue/host_q_3-c_q.normal.entry.queue.yaml', item('chat', 'pending', { session: 'chat' }));
    put('queue/host_q_4-d_q.normal.entry.queue.yaml', item('done', 'sent', { 'process-run': { quest: 'q', state: { process: 'des' } }, session: 'work' }));
    put('queue/host_q_5-e_q.normal.entry.queue.yaml', item('spec', 'staged', { session: { name: 'review', basedOn: 'work' } }));
    return { ai, q: path.join(ai, 'quests', 'q') };
}

const run = (ai: string, apply: boolean) => {
    const changes: string[] = [];
    const problems: string[] = [];
    const move = migrateDefaultRunProcess({ aiRoot: ai, quest: 'q', apply, now: new Date('2026-11-16T12:00:00Z'), change: (d) => changes.push(d), problem: (d) => problems.push(d) });
    return { move, changes, problems };
};
const read = (ai: string, rel: string): Record<string, unknown> => parse(fs.readFileSync(path.join(ai, rel), 'utf8'));
const mainOf = (ai: string, file: string): Record<string, unknown> => (read(ai, `queue/${file}`)['prompt-queue'] as Array<Record<string, unknown>>)[0];

describe('the default run\'s process moves into a run', () => {
    test('DM-1: a dry run lists, writes nothing', () => {
        const { ai, q } = sandbox();
        const before = fs.readFileSync(path.join(q, 'process-state.q.yaml'), 'utf8');
        const { move, changes } = run(ai, false);
        assert.equal(move?.run, 'des');
        assert.ok(changes.some((c) => /^the default run's process des -> run des/.test(c)), changes.join('\n'));
        assert.ok(changes.some((c) => /^session work -> work@des$/.test(c)));
        assert.equal(fs.readFileSync(path.join(q, 'process-state.q.yaml'), 'utf8'), before, 'nothing written');
        assert.equal(fs.existsSync(path.join(q, 'process-state.q.des.yaml')), false);
    });

    test('DM-2: the move', () => {
        const { ai, q } = sandbox();
        const original = fs.readFileSync(path.join(q, 'process-state.q.yaml'), 'utf8');
        const { move, problems } = run(ai, true);
        assert.deepEqual(problems, []);
        // The state stack, as it was, in the run's file; `default` with none, naming the run.
        assert.equal(fs.readFileSync(path.join(q, 'process-state.q.des.yaml'), 'utf8'), original, 'the whole stack, byte for byte');
        const moved = parseProcessStateStack(original).levels[0];
        assert.deepEqual([moved.process, moved.phase, moved.step, moved.stepIteration], ['des', 'p1', 'work', 2]);
        const left = fs.readFileSync(path.join(q, 'process-state.q.yaml'), 'utf8');
        assert.equal(parseProcessStateStack(left).levels[0].process, '');
        assert.equal(movedToRunOf(left), 'des');
        // The chat variables the process uses, in each host's file.
        assert.deepEqual(move?.variables, ['design', 'design-input', 'design-mode', 'process-subject']);
        assert.deepEqual(read(ai, 'chat_variables/q.host1.chatvariable.yaml').custom, { TODO: 'keep', other: 'x' }, 'the others stay');
        assert.equal(read(ai, 'chat_variables/q.host1.chatvariable.yaml').role, 'designer', 'the rest of the file stays');
        assert.deepEqual(read(ai, 'chat_variables/q.host1.des.chatvariable.yaml'), { run: 'des', custom: { design: 'tom_specs', 'design-input': 'in.md', 'design-mode': 'revise', 'process-subject': 'Revision' } });
        assert.deepEqual(read(ai, 'chat_variables/q.host2.des.chatvariable.yaml').custom, { design: 'other-host' });
        assert.deepEqual(read(ai, 'chat_variables/qq.host1.chatvariable.yaml').custom, { design: 'another quest' }, 'another quest untouched');
        // The sessions.
        assert.deepEqual(move?.sessions, [{ from: 'review', to: 'review@des' }, { from: 'work', to: 'work@des' }]);
        const h = path.join(q, 'history');
        assert.equal(JSON.parse(fs.readFileSync(path.join(h, 'work@des.session.json'), 'utf8')).sessionId, 's-work', 'the conversation goes on');
        assert.equal(JSON.parse(fs.readFileSync(path.join(h, 'review@des.session.json'), 'utf8')).basedOn, 'work@des', 'its base follows');
        assert.ok(fs.existsSync(path.join(h, 'sessions', 'work@des', 'live-trail.md')));
        assert.ok(fs.existsSync(path.join(ai, 'memory', 'q', 'work@des', 'facts.md')));
        assert.equal(fs.existsSync(path.join(h, 'work.session.json')), false);
        assert.ok(fs.existsSync(path.join(h, 'default.session.json')), 'the shared default session stays');
        // The queue.
        assert.deepEqual(move?.queueItems, ['proceed', 'marker', 'spec']);
        const proceed = mainOf(ai, 'host_q_1-a_q.normal.entry.queue.yaml');
        assert.deepEqual([proceed.run, (proceed['process-run'] as Record<string, unknown>).run, proceed.session], ['des', 'des', 'work@des']);
        assert.equal(mainOf(ai, 'host_q_2-b_q.normal.entry.queue.yaml').run, 'des');
        assert.deepEqual(mainOf(ai, 'host_q_5-e_q.normal.entry.queue.yaml').session, { name: 'review@des', basedOn: 'work@des' });
        assert.equal(mainOf(ai, 'host_q_3-c_q.normal.entry.queue.yaml').run, undefined, 'a chat item stays');
        assert.equal(mainOf(ai, 'host_q_4-d_q.normal.entry.queue.yaml').run, undefined, 'a sent item stays');
        // The journal.
        assert.match(fs.readFileSync(path.join(q, 'decisions.q.md'), 'utf8'),
            /## 2026-11-16T12:00:00\.000Z — the default run's process moved into run des\n\n- \*\*Process:\*\* des [^\n]*\n- \*\*Run:\*\* des [^\n]*\n- \*\*Chat variables:\*\* `design`[^\n]*\n- \*\*Sessions:\*\* `review` → `review@des`, `work` → `work@des`\n- \*\*Queue items:\*\* 3\n/);
    });

    test('DM-3: idempotent', () => {
        const { ai } = sandbox();
        run(ai, true);
        const again = run(ai, true);
        assert.equal(again.move, undefined);
        assert.deepEqual(again.changes, []);
    });

    test('DM-4: names; a definition that is gone', () => {
        assert.equal(runNameForProcess('idea_to_todos'), 'idea_to_todos');
        assert.equal(runNameForProcess('a.b c'), 'a-b-c');
        assert.equal(runNameForProcess('default'), 'process');
        assert.equal(freeRunName('des', (r) => ['des', 'des-2'].includes(r)), 'des-3');
        assert.deepEqual(processSessionNames(parseProcessYaml(DES).definition!), ['review', 'work']);
        const { ai, q } = sandbox();
        fs.writeFileSync(path.join(q, 'process-state.q.des.yaml'), 'levels: []\n');
        assert.equal(run(ai, true).move?.run, 'des-2', 'the name is taken');
        const gone = sandbox();
        fs.rmSync(path.join(gone.ai, 'processes', 'des'), { recursive: true });
        const r = run(gone.ai, true);
        assert.equal(r.move?.run, 'des');
        assert.match(r.problems[0], /no readable definition/);
        assert.ok(fs.existsSync(path.join(gone.q, 'process-state.q.des.yaml')), 'the state still moves');
    });

    test('DM-5: a step of migrateAiFormats; format version 9', () => {
        assert.equal(AI_FORMAT_VERSION, 9);
        const { ai } = sandbox();
        const result = migrateAiFormats({ aiRoot: ai, hostSlug: 'host1', apply: false, merge: () => undefined, quests: ['q'] });
        assert.ok(result.changes.some((c) => c.quest === 'q' && c.step === 'default-run' && /-> run des/.test(c.detail)), JSON.stringify(result.changes));
    });
});
