/**
 * The quest's history (src/services/questHistory.ts) and the notice after a reconcile
 * (src/services/historyRebuildNotice.ts).
 *
 *   QH-1 the consolidated trail: every host's turns, each id once, sorted by time (ties keep the read order)
 *   QH-2 an archived todo gives the history exactly the fields id, title, status, completed_date, description, notes
 *        (whole), decisions (with who decided), references, last_answer — in that order; open todos are not in it;
 *        the records come in completion order and interleave with the turns by date (a bare day at its end)
 *   QH-3 a build writes the blocks, the snapshot and the watermark (per host the last turn covered, the last archived
 *        todo, the build time); the next build takes only the new turns and todos; more than maxInputs: the oldest
 *        are passed over and the watermark moves past them
 *   QH-4 a failing compaction call stops the build: what was folded stays, the watermark does not cover the rest
 *   QH-5 the old per-session history is read until the quest history exists
 *   QH-6 the first build deletes the old per-session compacted_history.md files once, and records it
 *   QH-7 memory extraction reads the consolidated trail's new turns, one call per session, naming the turn's session
 *   QH-8 the notice: another host's turns newer than its watermark time → notice, once per change; this host's own
 *        trail → none; a change of a file that is no trail → nothing checked
 *   QH-9 applyCompactionOutput and the quest's history.md
 *   QH-10 the build lock `history/.build.<host>.lock`: held while a build runs and released after it (also after a
 *        failure); a second build of the host skips (`locked`) or waits until the first is done; a lock not touched
 *        for 10 minutes is taken over; another host's lock does not stop this one
 *   QH-11 from scratch: the derived history and the watermark are deleted under the lock, then every input is folded
 *        again (every host's trail, the whole todo archive, no maxInputs limit); the timestamped copies stay
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendHostTrailTurn, type HostTrailTurn } from '../hostTrail.js';
import {
    ARCHIVED_TODO_HISTORY_FIELDS,
    HISTORY_BUILD_LOCK_STALE_MS,
    acquireHistoryBuildLock,
    archivedTodoRecord,
    historyBuildLockFile,
    buildQuestHistory,
    consolidateTurns,
    consolidatedTrail,
    formatArchivedTodo,
    loadQuestHistoryBlocks,
    pendingHistoryInputs,
    questCompactedHistoryFile,
    readArchivedTodoRecords,
    readHistoryWatermark,
    todoArchiveFile,
    type QuestHistoryBuildOptions,
} from '../questHistory.js';
import { applyCompactionOutput, parseBlocks, serialiseBlocks } from '../compacted-history.js';
import { formatHistoryAsMarkdown } from '../historySnapshotFormat.js';
import { createHistoryRebuildNotifier } from '../historyRebuildNotice.js';
import type { ConversationMessage } from '../history-compaction.js';

/** A sandbox workspace with its own `.tom/tom_root.yaml`, and its quest folder. */
function sandbox(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-history-'));
    fs.mkdirSync(path.join(root, '.tom'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tom', 'tom_root.yaml'), 'name: sandbox\n');
    const quest = path.join(root, '_ai', 'quests', 'q');
    fs.mkdirSync(quest, { recursive: true });
    return quest;
}

function at(day: number, sec: number): string {
    return new Date(Date.UTC(2026, 10, day, 10, 0, sec)).toISOString();
}

function turn(id: string, host: string, time: string, session = 'default@default'): HostTrailTurn {
    return { id, time, host, session, profile: 'opus', model: 'claude', prompt: `prompt ${id}`, answer: `answer ${id}` };
}

function writeArchive(quest: string, todos: string): void {
    fs.writeFileSync(todoArchiveFile(quest, 'q'), `quest: q\ntodos:\n${todos}`);
}

/** A build with a compaction that answers one block naming what it got, and records every call. */
function builder(quest: string, over: Partial<QuestHistoryBuildOptions> = {}): { opts: QuestHistoryBuildOptions; calls: ConversationMessage[][]; extractions: Array<{ session: string; messages: ConversationMessage[] }> } {
    const calls: ConversationMessage[][] = [];
    const extractions: Array<{ session: string; messages: ConversationMessage[] }> = [];
    let n = 0;
    const opts: QuestHistoryBuildOptions = {
        questFolder: quest,
        quest: 'q',
        host: 'mbp',
        chunkSize: 10,
        maxInputs: 200,
        compact: async ({ messages }) => {
            calls.push(messages);
            n++;
            return `<!-- tom:block created="2026-11-25T00:00:0${n}.000Z" -->\npass ${n}: ${messages.length} messages\n<!-- /tom:block -->`;
        },
        extract: async ({ session, messages }) => { extractions.push({ session, messages }); },
        now: () => new Date('2026-11-25T12:00:00.000Z'),
        ...over,
    };
    return { opts, calls, extractions };
}

describe('the quest history', () => {
    test('QH-1: the consolidated trail', () => {
        const quest = sandbox();
        appendHostTrailTurn(quest, turn('a1', 'mbp', at(25, 1)), 2000);
        appendHostTrailTurn(quest, turn('a2', 'mbp', at(25, 5)), 2000);
        appendHostTrailTurn(quest, turn('b1', 'bomber', at(25, 3)), 2000);
        // The same turn in two files (a copy): once.
        appendHostTrailTurn(quest, turn('a1', 'bomber', at(25, 1)), 2000);
        const ids = consolidatedTrail(quest).map((t) => t.id);
        assert.deepEqual(ids, ['a1', 'b1', 'a2']);
        // Ties keep the read order.
        const tie = consolidateTurns(new Map([['x', [turn('x1', 'x', at(25, 9))]], ['y', [turn('y1', 'y', at(25, 9))]]]));
        assert.deepEqual(tie.map((t) => t.id), ['x1', 'y1']);
    });

    test('QH-2: archived todos — the fields, their order, and the order with the turns', () => {
        const quest = sandbox();
        const longNotes = Array.from({ length: 400 }, (_, i) => `line ${i} of the notes`).join(' ');
        writeArchive(quest, [
            '  - id: t2',
            '    title: Second',
            '    status: cancelled',
            '    completed_date: 2026-11-24',
            '    description: what was to be done',
            '    priority: high',
            '    tags: [x]',
            '    created: 2026-11-01',
            '    blocked_by: [t9]',
            '    role: developer',
            '  - id: t1',
            '    title: First',
            '    status: completed',
            '    completed_date: 2026-11-20',
            '    description: the task',
            `    notes: ${JSON.stringify(longNotes)}`,
            '    decisions:',
            '      - summary: Which way?',
            '        decision_needed: (a) or (b)',
            '        decision: (a)',
            '      - summary: Still open',
            '    references:',
            '      - path: src/x.ts',
            '      - url: https://example.org',
            '    last_answer: done it',
            '    filed_by: { quest: q }',
            '    completed_by: agent',
            '  - id: t3',
            '    title: Open',
            '    status: in-progress',
            '',
        ].join('\n'));
        const records = readArchivedTodoRecords(quest, 'q');
        assert.deepEqual(records.map((r) => r.id), ['t1', 't2'], 'completion order, open todos left out');
        const t1 = records[0];
        assert.deepEqual(Object.keys(t1), ['id', 'title', 'status', 'completed_date', 'description', 'notes', 'decisions', 'references', 'last_answer']);
        assert.deepEqual([...ARCHIVED_TODO_HISTORY_FIELDS], Object.keys(t1));
        assert.equal(t1.notes, longNotes, 'the notes whole');
        assert.deepEqual(t1.decisions, [{ summary: 'Which way?', decision: '(a)', decidedBy: 'user' }, { summary: 'Still open' }]);
        assert.deepEqual(t1.references, [{ path: 'src/x.ts' }, { url: 'https://example.org' }]);
        assert.deepEqual(Object.keys(records[1]), ['id', 'title', 'status', 'completed_date', 'description']);
        assert.equal(archivedTodoRecord({ id: 'x', status: 'not-started' }), undefined);

        const text = formatArchivedTodo(t1);
        const order = ['Archived todo t1 — First', 'Status: completed on 2026-11-20', 'Description:', 'Notes:', 'Decisions:', '- Which way?: (a) (decided by the user)', '- Still open: (not decided)', 'References:', 'Last answer:'].map((s) => text.indexOf(s));
        assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), text);
        assert.doesNotMatch(formatArchivedTodo(records[1]), /high|developer|t9|2026-11-01/, 'nothing of the left-out fields');

        // Interleaved by date: a todo of the 20th sorts after that day's turns.
        const turns = [turn('a', 'mbp', at(20, 1)), turn('b', 'mbp', at(21, 1)), turn('c', 'mbp', at(25, 1))];
        const inputs = pendingHistoryInputs(turns, records, undefined);
        assert.deepEqual(inputs.map((x) => (x.kind === 'turn' ? x.turn.id : x.todo.id)), ['a', 't1', 'b', 't2', 'c']);
    });

    test('QH-3: the watermark, and the next build takes only what is new', async () => {
        const quest = sandbox();
        appendHostTrailTurn(quest, turn('a1', 'mbp', at(25, 1)), 2000);
        appendHostTrailTurn(quest, turn('b1', 'bomber', at(25, 2)), 2000);
        writeArchive(quest, '  - id: t1\n    title: T\n    status: completed\n    completed_date: 2026-11-20\n');
        const first = builder(quest);
        const r1 = await buildQuestHistory(first.opts);
        assert.deepEqual([r1.folded, r1.turns, r1.todos, r1.chunks], [3, 2, 1, 1]);
        assert.ok(fs.existsSync(questCompactedHistoryFile(quest)));
        assert.ok(fs.existsSync(path.join(quest, 'history', 'history.json')));
        assert.ok(fs.existsSync(path.join(quest, 'history', 'history.md')));
        const wm = readHistoryWatermark(quest);
        assert.deepEqual(wm?.hosts, { mbp: at(25, 1), bomber: at(25, 2) });
        assert.deepEqual(wm?.lastArchivedTodo, { id: 't1', completed: '2026-11-20' });
        assert.equal(wm?.builtAt, '2026-11-25T12:00:00.000Z');

        // Nothing new: no call.
        const again = builder(quest);
        assert.equal((await buildQuestHistory(again.opts)).folded, 0);
        assert.equal(again.calls.length, 0);

        appendHostTrailTurn(quest, turn('b2', 'bomber', at(25, 9)), 2000);
        writeArchive(quest, '  - id: t1\n    title: T\n    status: completed\n    completed_date: 2026-11-20\n  - id: t2\n    title: U\n    status: completed\n    completed_date: 2026-11-26\n');
        const second = builder(quest);
        const r2 = await buildQuestHistory(second.opts);
        assert.deepEqual([r2.turns, r2.todos], [1, 1]);
        assert.match(second.calls[0][0].content, /prompt b2/);
        assert.match(second.calls[0][2].content, /Archived todo t2/);
        assert.equal(second.calls[0].length, 3);
        assert.equal(readHistoryWatermark(quest)?.lastArchivedTodo?.id, 't2');
        // Block-format output is the whole new set: the second build's.
        assert.deepEqual(parseBlocks(fs.readFileSync(questCompactedHistoryFile(quest), 'utf-8')).map((b) => b.body), ['pass 1: 3 messages']);
        assert.match(second.calls[0][0].content, /^\[2026-11-25T10:00:09\.000Z · host bomber · session default@default\]/);

        // More than maxInputs: only the newest are folded, the watermark passes the others.
        const quest2 = sandbox();
        for (let i = 1; i <= 5; i++) { appendHostTrailTurn(quest2, turn(`x${i}`, 'mbp', at(25, i)), 2000); }
        const capped = builder(quest2, { maxInputs: 2, chunkSize: 1 });
        const r3 = await buildQuestHistory(capped.opts);
        assert.deepEqual([r3.skipped, r3.folded, r3.chunks], [3, 2, 2]);
        assert.match(capped.calls[0][0].content, /prompt x4/);
        assert.equal(readHistoryWatermark(quest2)?.hosts.mbp, at(25, 5));
    });

    test('QH-4: a failing compaction call stops the build', async () => {
        const quest = sandbox();
        for (let i = 1; i <= 4; i++) { appendHostTrailTurn(quest, turn(`x${i}`, 'mbp', at(25, i)), 2000); }
        let n = 0;
        const b = builder(quest, {
            chunkSize: 2,
            compact: async () => { n++; if (n === 2) { throw new Error('HTTP 500'); } return 'prose summary'; },
        });
        const r = await buildQuestHistory(b.opts);
        assert.equal(r.failed, 'HTTP 500');
        assert.deepEqual([r.folded, r.chunks], [2, 1]);
        assert.equal(readHistoryWatermark(quest)?.hosts.mbp, at(25, 2), 'the rest is folded next time');
        assert.equal(b.extractions.length, 1, 'only the folded chunk was extracted');
    });

    test('QH-5: the old per-session history is read until the quest history exists', () => {
        const quest = sandbox();
        const old = path.join(quest, 'history', 'sessions', 'chat');
        fs.mkdirSync(old, { recursive: true });
        fs.writeFileSync(path.join(old, 'compacted_history.md'), serialiseBlocks([{ created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', body: 'old session history' }]));
        assert.deepEqual(loadQuestHistoryBlocks(quest, old).map((b) => b.body), ['old session history']);
        assert.deepEqual(loadQuestHistoryBlocks(quest), [], 'no session folder, no quest history: nothing');
        fs.writeFileSync(questCompactedHistoryFile(quest), serialiseBlocks([{ created: '2026-02-01T00:00:00.000Z', modified: '2026-02-01T00:00:00.000Z', body: 'quest history' }]));
        assert.deepEqual(loadQuestHistoryBlocks(quest, old).map((b) => b.body), ['quest history']);
    });

    test('QH-6: the first build deletes the old compacted_history.md files once', async () => {
        const quest = sandbox();
        const oldFiles = ['history/sessions/chat', 'history/sessions/default@default', 'history/mbp/sessions/work'].map((rel) => {
            const dir = path.join(quest, rel);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'compacted_history.md'), 'old');
            fs.writeFileSync(path.join(dir, 'rawTurns.json'), '{}');
            return path.join(dir, 'compacted_history.md');
        });
        // Without anything to fold nothing is written, and nothing deleted.
        assert.deepEqual((await buildQuestHistory(builder(quest).opts)).deletedOldHistories, []);
        assert.ok(oldFiles.every((f) => fs.existsSync(f)));

        appendHostTrailTurn(quest, turn('a1', 'mbp', at(25, 1)), 2000);
        const logged: string[] = [];
        const r = await buildQuestHistory(builder(quest, { log: (m) => logged.push(m) }).opts);
        assert.deepEqual([...r.deletedOldHistories].sort(), [...oldFiles].sort());
        assert.ok(oldFiles.every((f) => !fs.existsSync(f)));
        assert.ok(fs.existsSync(path.join(quest, 'history', 'sessions', 'chat', 'rawTurns.json')), 'only the compacted history goes');
        assert.ok(logged.some((l) => l.includes('deleted the old session history')));
        assert.equal(readHistoryWatermark(quest)?.oldSessionHistoriesDeleted, true);

        // Once: a later build leaves such a file (another host's pull brought it back).
        fs.writeFileSync(oldFiles[0], 'old again');
        appendHostTrailTurn(quest, turn('a2', 'mbp', at(25, 2)), 2000);
        assert.deepEqual((await buildQuestHistory(builder(quest).opts)).deletedOldHistories, []);
        assert.ok(fs.existsSync(oldFiles[0]));
    });

    test('QH-7: extraction reads the consolidated turns, per session', async () => {
        const quest = sandbox();
        appendHostTrailTurn(quest, turn('a1', 'mbp', at(25, 1), 'chat'), 2000);
        appendHostTrailTurn(quest, turn('b1', 'bomber', at(25, 2), 'work@run1'), 2000);
        appendHostTrailTurn(quest, turn('a2', 'mbp', at(25, 3), 'chat'), 2000);
        writeArchive(quest, '  - id: t1\n    title: T\n    status: completed\n    completed_date: 2026-11-20\n');
        const b = builder(quest);
        const r = await buildQuestHistory(b.opts);
        assert.equal(r.extractions, 2);
        assert.deepEqual(b.extractions.map((e) => e.session), ['chat', 'work@run1']);
        assert.deepEqual(b.extractions[0].messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
        assert.match(b.extractions[0].messages[2].content, /prompt a2/);
        assert.match(b.extractions[1].messages[0].content, /host bomber/);
        assert.ok(b.extractions.every((e) => e.messages.every((m) => !/Archived todo/.test(m.content))), 'todos are not extracted');
        // Without an extractor: none.
        appendHostTrailTurn(quest, turn('a3', 'mbp', at(25, 4), 'chat'), 2000);
        const none = builder(quest, { extract: undefined });
        assert.equal((await buildQuestHistory(none.opts)).extractions, 0);
    });

    test('QH-8: the notice after a reconcile', async () => {
        const quest = sandbox();
        const shown: string[][] = [];
        const notifier = createHistoryRebuildNotifier({ questFolder: quest, ownHost: 'mbp', show: (hosts) => shown.push(hosts) });
        appendHostTrailTurn(quest, turn('a1', 'mbp', at(25, 1)), 2000);
        assert.equal(notifier.check(), undefined, 'this host\'s own turns: no notice');
        assert.equal(notifier.onHistoryFileChanged('trail.mbp.md'), undefined);

        appendHostTrailTurn(quest, turn('b1', 'bomber', at(25, 2)), 2000);
        assert.deepEqual(notifier.onHistoryFileChanged('trail.bomber.md'), ['bomber']);
        assert.equal(notifier.onHistoryFileChanged('trail.bomber.md'), undefined, 'once per change');
        assert.equal(notifier.onHistoryFileChanged('history.watermark.json'), undefined, 'no trail: nothing checked');

        // The history covers it: nothing ahead.
        await buildQuestHistory(builder(quest).opts);
        assert.equal(notifier.check(), undefined);
        // Newer turns of bomber: a notice again.
        appendHostTrailTurn(quest, turn('b2', 'bomber', at(25, 9)), 2000);
        assert.deepEqual(notifier.onHistoryFileChanged('trail.bomber.md'), ['bomber']);
        assert.deepEqual(shown, [['bomber'], ['bomber']]);

        // The window's wiring (it imports vscode: its source is read).
        const src = (...p: string[]): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', ...p), 'utf8');
        const wiring = src('handlers', 'historyRebuildNotice-handler.ts');
        assert.match(wiring, /createFileSystemWatcher\(new vscode\.RelativePattern\(vscode\.Uri\.file\(path\.join\(questFolder, 'history'\)\), 'trail\.\*\.md'\)\)/);
        assert.match(wiring, /notifier\.onHistoryFileChanged\(name\)/);
        assert.match(wiring, /setTimeout\(\(\) => notifier\.check\(\), 5000\)/, 'checked at window start');
        assert.match(wiring, /showInformationMessage\(historyRebuildNoticeText\(hosts\), REBUILD_HISTORY_ACTION\)/, 'non-modal, with the action');
        assert.match(wiring, /handler\.rebuildQuestHistoryAndMemory\(quest\)/);
        assert.match(wiring, /ownHost: hostSlugOf\(\)/);
        assert.match(src('extension.ts'), /registerHistoryRebuildNotice\(context\);/);
    });

    test('QH-9: applyCompactionOutput and the quest history.md', async () => {
        const prior = [{ created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', body: 'one' }];
        assert.equal(applyCompactionOutput(prior, '  '), prior, 'empty output: unchanged');
        const prose = applyCompactionOutput(prior, 'a prose summary', '2026-02-01T00:00:00.000Z');
        assert.deepEqual(prose.map((b) => b.body), ['one', 'a prose summary']);
        const blocks = applyCompactionOutput(prior, '<!-- tom:block created="2026-01-01T00:00:00.000Z" -->\none, edited\n<!-- /tom:block -->', '2026-03-01T00:00:00.000Z');
        assert.deepEqual(blocks, [{ created: '2026-01-01T00:00:00.000Z', modified: '2026-03-01T00:00:00.000Z', body: 'one, edited' }]);

        const md = formatHistoryAsMarkdown({ messages: { compactedSummary: 'S' }, savedAt: 'now', questId: 'q', title: '# Quest history — `q`' });
        assert.match(md, /^# Quest history — `q`/);
        assert.doesNotMatch(md, /Raw turns/, 'no raw-turn section without raw turns');

        const quest = sandbox();
        appendHostTrailTurn(quest, turn('a1', 'mbp', at(25, 1)), 2000);
        await buildQuestHistory(builder(quest, { archive: true }).opts);
        const written = fs.readFileSync(path.join(quest, 'history', 'history.md'), 'utf-8');
        assert.match(written, /^# Quest history — `q`/);
        assert.match(written, /_Covers mbp up to 2026-11-25T10:00:01\.000Z\._/);
        assert.ok(fs.readdirSync(path.join(quest, 'history')).some((f) => /^\d{8}_\d{6}\.history\.json$/.test(f)), 'the archive copy');
    });

    test('QH-10: one build per host at a time', async () => {
        const quest = sandbox();
        appendHostTrailTurn(quest, turn('a1', 'mbp', at(25, 1)), 2000);
        const lockFile = historyBuildLockFile(quest, 'mbp');
        assert.equal(path.relative(quest, lockFile), path.join('history', '.build.mbp.lock'));

        // Held while the build runs, gone after it.
        let heldDuring = false;
        const b = builder(quest, { now: undefined, compact: async () => { heldDuring = fs.existsSync(lockFile); return 'summary'; } });
        await buildQuestHistory(b.opts);
        assert.ok(heldDuring, 'held while folding');
        assert.ok(!fs.existsSync(lockFile), 'released');

        // Released after a failure, too.
        appendHostTrailTurn(quest, turn('a2', 'mbp', at(25, 2)), 2000);
        const failing = builder(quest, { now: undefined, compact: async () => { throw new Error('HTTP 500'); } });
        assert.equal((await buildQuestHistory(failing.opts)).failed, 'HTTP 500');
        assert.ok(!fs.existsSync(lockFile));

        // Another window holds it: skip, or wait until it is released.
        const held = acquireHistoryBuildLock(quest, 'mbp');
        assert.ok(held);
        assert.equal(acquireHistoryBuildLock(quest, 'mbp'), undefined, 'one holder');
        const skipper = builder(quest, { now: undefined, onLocked: 'skip' });
        const skipped = await buildQuestHistory(skipper.opts);
        assert.equal(skipped.locked, true);
        assert.equal(skipper.calls.length, 0);
        const other = acquireHistoryBuildLock(quest, 'bomber');
        assert.ok(other, 'another host\'s lock is its own');
        other!.release();

        const waiter = builder(quest, { now: undefined, onLocked: 'wait', lockPollMs: 10 });
        let done = false;
        const waiting = buildQuestHistory(waiter.opts).then((r) => { done = true; return r; });
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(done, false, 'waits while the lock is held');
        assert.equal(waiter.calls.length, 0);
        held!.release();
        const r = await waiting;
        assert.equal(r.locked, undefined);
        assert.equal(r.turns, 1, 'folds once the lock is free');
        assert.ok(!fs.existsSync(lockFile));

        // A lock not touched for 10 minutes is taken over.
        fs.writeFileSync(lockFile, '{"pid":1}\n');
        const old = new Date(Date.now() - HISTORY_BUILD_LOCK_STALE_MS - 1000);
        fs.utimesSync(lockFile, old, old);
        const takeover = acquireHistoryBuildLock(quest, 'mbp');
        assert.ok(takeover, 'stale lock taken over');
        assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid);
        takeover!.touch();
        assert.ok(Date.now() - fs.statSync(lockFile).mtimeMs < 5000, 'touch refreshes its time');
        takeover!.release();
        assert.equal(HISTORY_BUILD_LOCK_STALE_MS, 10 * 60 * 1000);
    });

    test('QH-11: a build from scratch', async () => {
        const quest = sandbox();
        for (let i = 1; i <= 3; i++) { appendHostTrailTurn(quest, turn(`x${i}`, 'mbp', at(25, i)), 2000); }
        appendHostTrailTurn(quest, turn('y1', 'bomber', at(25, 4)), 2000);
        writeArchive(quest, '  - id: t1\n    title: T\n    status: completed\n    completed_date: 2026-11-20\n');
        await buildQuestHistory(builder(quest, { archive: true }).opts);
        const copies = (): string[] => fs.readdirSync(path.join(quest, 'history')).filter((f) => /^\d{8}_\d{6}\.history\./.test(f));
        assert.equal(copies().length, 2);
        assert.equal((await buildQuestHistory(builder(quest).opts)).folded, 0, 'covered');

        let lockedWhileReset = false;
        const scratch = builder(quest, {
            fromScratch: true,
            maxInputs: 2,
            chunkSize: 10,
            log: () => { lockedWhileReset ||= fs.existsSync(historyBuildLockFile(quest, 'mbp')); },
        });
        const r = await buildQuestHistory(scratch.opts);
        assert.ok(lockedWhileReset, 'the reset runs under the lock');
        assert.deepEqual(r.reset?.map((f) => path.basename(f)).sort(), ['compacted_history.md', 'history.json', 'history.md', 'history.watermark.json']);
        assert.deepEqual([r.folded, r.turns, r.todos, r.skipped], [5, 4, 1, 0], 'everything again, no maxInputs limit');
        assert.equal(scratch.calls[0].length, 9, 'four turns of two messages, one todo');
        assert.deepEqual(readHistoryWatermark(quest)?.hosts, { mbp: at(25, 3), bomber: at(25, 4) });
        assert.ok(fs.existsSync(questCompactedHistoryFile(quest)));
        assert.equal(copies().length, 2, 'the timestamped copies stay');
    });
});
