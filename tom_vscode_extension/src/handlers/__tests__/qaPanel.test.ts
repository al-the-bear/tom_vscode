/**
 * The Q&A page's host (src/handlers/qaPanel-handler.ts), the Q&A journal's writers (src/services/qaJournal.ts) and
 * the live tomAi_answerUser, driven through the vscode stub in a sandbox workspace of its own.
 *
 *   QA-1 the live tool stores into this window's store (in global storage), writes an `answerGiven` block to this
 *        host's journal `qa.<host>.<quest>.md`, the `answer` event to the notification log, and the Q&A page opens
 *        on it without taking focus
 *   QA-2 the Questions tab's stored answer: rendered, its todo record as YAML; read once in view; select / mark
 *        unread / delete / delete read / delete all (asks first, Cancel keeps them); the journal keeps its entry
 *   QA-3 Add todo writes exactly the suggested record, filed by the answering agent; Copy queues nothing
 *   QA-4 past the limit the window offers the four cleanups, and the one picked is applied; at most once an hour
 *   QA-5 the writers: an ask's question written when asked and its answer block naming it (answered, timed out),
 *        a resolution without an asked block writes both; a process decision; nothing goes to `questions.<quest>.md`
 *        or `decisions.<quest>.md`
 *   QA-6 the Questions tab: every host's journal and the old questions file, newest first with the host; the filter
 *        (current, selected, workspace); the counters and marking read (the marker in global storage, not in `_ai`)
 *   QA-7 the Decisions tab: open first; Save writes the decision through the todo store and flips a decision-needed
 *        todo to not-started with its last open decision only; an archived todo's decisions are listed, not open
 *   QA-8 the command, its title, the Extension Tools entry and the entry points (USER NOTIFICATIONS' answer row and its
 *        Q&A link with the counts)
 */

/* eslint-disable @typescript-eslint/naming-convention -- todo YAML keys */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_251125_01_aifmt-4_qa-')));
const WS = path.join(SANDBOX, 'ws');
const GS = path.join(SANDBOX, 'global-storage');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
// The sandbox is a root of its own, so nothing resolves to the real workspace.
fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
fs.mkdirSync(QDIR, { recursive: true });
fs.mkdirSync(path.join(WS, '_ai', 'quests', 'q2'), { recursive: true });
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.mkdirSync(GS, { recursive: true });
process.env.HOME = path.join(SANDBOX, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const warnings: Json[][] = [];
let warningAnswer: string | undefined;
const vs = installVscodeStub({
    workspaceFolders: [WS],
    methodOverrides: { showWarningMessage: async (...args: unknown[]) => { warnings.push(args); return warningAnswer; } },
});
const stub = vs.stub as Json;
stub.workspace.workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };
const clipboard: string[] = [];
stub.env.clipboard = { writeText: async (t: string) => { clipboard.push(t); } };

import { setExtensionPath } from '../handler_shared.js';
import { WsPaths } from '../../utils/workspacePaths.js';
import { hostSlugOf } from '../../utils/hostSlug.js';
import { configureAnswersStore, answersDir, qaReadMarkerFile } from '../../services/userAnswersStore.js';
import { configureNotificationLog, readNotificationEvents, notificationLogFile } from '../../services/notificationLog.js';
import { ANSWER_USER_TOOL } from '../../tools/chat-enhancement-tools.js';
import { SHOW_ANSWERS_COMMAND, answerNotificationDraft, initQaPanel, resetQaPage, saveTodoDecision, showAnswers, warnWhenOverLimit } from '../qaPanel-handler.js';
import { readAnswer, readAnswers, writeAnswer, type UserAnswer } from '../../utils/userAnswers.js';
import { userNotificationRows } from '../../utils/userNotifications.js';
import { findTodoById, readTodoFile } from '../../managers/questTodoManager.js';
import { appendProcessDecision, appendQuestionAsked, appendQuestionLogEntry } from '../../services/qaJournal.js';
import { appendQaBlocks, parseQaJournal, qaJournalFileName } from '../../utils/qaJournal.js';
import { askUserImpl, type AskUserDeps } from '../../tools/ask-user-tool.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { processResetJournalEntry } from '../../utils/processReset.js';
import { qaNewCounts } from '../../services/qaPageData.js';

setExtensionPath(EXT);
assert.ok(fs.realpathSync(WsPaths.aiRoot ?? '/').startsWith(SANDBOX), `the _ai root is in the sandbox: ${WsPaths.aiRoot}`);
configureAnswersStore(GS, () => WsPaths.aiRoot);
configureNotificationLog(path.join(GS, 'notifications.jsonl'), { windowId: () => 'w-test', quest: () => QUEST, run: () => 'default', who: () => ({ kind: 'agent' }) } as never);
const context = { subscriptions: [] as Array<{ dispose(): void }>, extensionPath: EXT, globalStorageUri: { fsPath: GS } };
initQaPanel(context as never);
after(() => {
    for (const s of context.subscriptions) { s.dispose(); }
    configureAnswersStore(undefined, undefined);
    configureNotificationLog(undefined, undefined);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const HOST = hostSlugOf();
const JOURNAL = path.join(QDIR, qaJournalFileName(QUEST, HOST));
const blocks = (): Json[] => (fs.existsSync(JOURNAL) ? parseQaJournal(fs.readFileSync(JOURNAL, 'utf8')) : []);
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));
const panels = (): Json[] => stub.window.__webviewPanels as Json[];
const page = (): Json => panels()[panels().length - 1];
const lastState = (): Json => [...page().webview.__posted].reverse().find((m: Json) => m.type === 'state');
const send = async (m: Json): Promise<void> => { page().webview.__receive(m); await tick(); };
const answer = (input: Json): Promise<Json> => ANSWER_USER_TOOL.execute(input).then((raw) => JSON.parse(raw as string));
const keyOf = (title: string): string => lastState().questions.find((r: Json) => r.title === title).key;
const TODO = { id: 'x1_akss-follow-up', title: 'Follow up', description: 'Do the follow-up.\n\nDONE WHEN: done.', status: 'decision-needed', priority: 'high', tags: ['a', 'b'], decisions: [{ summary: 'Which way', decision_needed: 'Which way? (a) left (b) right' }] };

describe('the Q&A page', () => {
    test('QA-1: the live tool stores, journals, notifies and opens the page', async () => {
        const dir = answersDir()!;
        assert.ok(dir.startsWith(path.join(GS, 'answers')), 'the store is in global storage');
        const r = await answer({ title: 'Why is it slow?', answer: 'Because of **x**.\n\n## Detail\n\n```\ncode\n```', question: 'Why is the build slow?', suggestedPrompts: [{ label: 'Next', text: 'Do the next step' }], suggestedTodos: [{ todo: { ...TODO } }] });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.match(r.note, /Q&A page \(@T: Q&A\)/);
        const stored = readAnswer(dir, r.id)!;
        assert.equal(stored.quest, QUEST);
        assert.ok(stored.filedBy, 'the caller\'s filed_by is kept for an added todo');
        // The journal: this host's file, one answerGiven block naming the stored answer.
        assert.deepEqual(fs.readdirSync(QDIR), [qaJournalFileName(QUEST, HOST)], 'only the journal is written in the quest');
        const [given] = blocks();
        assert.equal(given.kind, 'answerGiven');
        assert.equal(given.answerId, r.id);
        assert.equal(given.host, HOST);
        assert.equal(given.title, 'Why is it slow?');
        assert.equal(given.userQuestion, 'Why is the build slow?');
        assert.equal(given.answer, 'Because of **x**.\n\n## Detail\n\n```\ncode\n```');
        assert.deepEqual(given.suggestedPrompts, ['Next']);
        assert.deepEqual(given.suggestedTodos, ['x1_akss-follow-up — Follow up']);
        assert.equal(fs.existsSync(path.join(QDIR, `todos.${QUEST}.todo.yaml`)), false, 'the suggested todo is not created');
        // The event, and its row in USER NOTIFICATIONS.
        const events = readNotificationEvents(notificationLogFile()!).filter((e) => e.type === 'answer');
        assert.equal(events.length, 1);
        assert.equal(events[0].user?.key, r.id);
        const rows = userNotificationRows(events, new Set());
        assert.deepEqual(rows.map((x) => [x.type, x.state, x.key, x.title]), [['answer', 'notice', r.id, 'Why is it slow?']]);
        // The page: opened on the answer, beside what the user does.
        assert.equal(panels().length, 1);
        assert.match(page().title, /^Tom AI — Q&A/);
        assert.match(page().webview.html, /qaPanel/);
        // An incomplete suggestion: refused, nothing stored, nothing journalled.
        const bad = await answer({ title: 't', answer: 'a', suggestedTodos: [{ todo: { id: 'nodesc1' } }] });
        assert.equal(bad.ok, false);
        assert.equal(readAnswers(dir).length, 1);
        assert.equal(blocks().length, 1);
    });

    test('QA-2: the stored answer in the Questions tab and the store\'s actions', async () => {
        const dir = answersDir()!;
        const first = readAnswers(dir)[0];
        await send({ type: 'ready' });
        let s = lastState();
        assert.equal(s.tab, 'questions');
        assert.deepEqual(s.quests, [QUEST]);
        assert.equal(s.total, 1);
        assert.deepEqual(s.questions.map((q: Json) => [q.kind, q.title, q.host, q.quest, q.stored]), [['answerGiven', 'Why is it slow?', HOST, QUEST, true]]);
        assert.equal(s.selected.id, first.id);
        assert.match(s.selected.answerHtml, /<strong>x<\/strong>/);
        assert.equal(s.selected.question, 'Why is the build slow?');
        assert.deepEqual(s.selected.prompts, [{ label: 'Next', text: 'Do the next step' }]);
        assert.match(s.selected.todos[0].record, /^id: x1_akss-follow-up\ntitle: Follow up\n/);
        // The page has the focus (the stub's panel is active): the answer in view is read.
        assert.equal(readAnswer(dir, first.id)!.read, true);
        const second = await answer({ title: 'Second', answer: 'two' });
        await tick();
        s = lastState();
        assert.deepEqual(s.questions.map((q: Json) => [q.title, q.unread]), [['Second', true], ['Why is it slow?', false]]);
        assert.equal(s.selected.id, first.id, 'the page stays on the entry the user reads');
        await send({ type: 'select', key: keyOf('Second') });
        assert.equal(lastState().selected.id, second.id);
        assert.equal(readAnswer(dir, second.id)!.read, true);
        await send({ type: 'markUnread', id: second.id });
        assert.equal(readAnswer(dir, second.id)!.read, false, 'unread again');
        await send({ type: 'ready' });
        assert.equal(readAnswer(dir, second.id)!.read, false, 'and stays unread while it is in view');
        await send({ type: 'select', key: keyOf('Why is it slow?') });
        const third = await answer({ title: 'Third', answer: 'three' });
        await send({ type: 'delete', id: third.id });
        assert.equal(readAnswer(dir, third.id), undefined);
        const thirdRow = lastState().questions.find((q: Json) => q.title === 'Third');
        assert.ok(thirdRow && !thirdRow.stored, 'the journal keeps the entry; it is no stored answer now');
        // Delete all asks; Cancel keeps them.
        warningAnswer = undefined;
        await send({ type: 'deleteAll' });
        assert.match(String(warnings[warnings.length - 1][0]), /Delete all 2 stored answers\?/);
        assert.equal(readAnswers(dir).length, 2, 'cancelled: nothing deleted');
    });

    test('QA-3: Add todo and Copy', async () => {
        const dir = answersDir()!;
        const first = readAnswers(dir).find((a) => a.title === 'Why is it slow?')!;
        await send({ type: 'copyPrompt', id: first.id, index: 0 });
        assert.deepEqual(clipboard, ['Do the next step']);
        await send({ type: 'addTodo', id: first.id, index: 0 });
        const file = path.join(QDIR, `todos.${QUEST}.todo.yaml`);
        const todos = readTodoFile(file) as Json[];
        assert.equal(todos.length, 1);
        for (const [k, v] of Object.entries(TODO)) { assert.deepEqual(todos[0][k], v, k); }
        assert.deepEqual(todos[0].filed_by, first.filedBy, 'filed by the answering agent');
        assert.equal(readAnswer(dir, first.id)!.suggestedTodos[0].addedId, TODO.id);
        await send({ type: 'select', key: keyOf('Why is it slow?') });
        assert.equal(lastState().selected.todos[0].addedId, TODO.id, 'the page shows it added');
        await send({ type: 'addTodo', id: first.id, index: 0 });
        assert.equal(readTodoFile(file).length, 1, 'a second click adds nothing');
        await send({ type: 'deleteRead' });
        assert.deepEqual(readAnswers(dir).map((a) => a.title), ['Second']);
        warningAnswer = 'Delete all';
        await send({ type: 'deleteAll' });
        assert.equal(readAnswers(dir).length, 0);
        assert.equal(lastState().questions.length, 3, 'the journal entries stay');
        assert.equal(lastState().questions.filter((q: Json) => q.stored).length, 0);
        warningAnswer = undefined;
    });

    test('QA-4: past the limit', async () => {
        const dir = answersDir()!;
        const now = Date.parse('2026-11-19T10:00:00Z');
        for (let i = 0; i < 503; i++) {
            const a: UserAnswer = { id: `m${i}`, at: new Date(now - i * 3_600_000).toISOString(), windowId: 'w', quest: 'q9', run: 'default', title: `t${i}`, answer: 'a', suggestedPrompts: [], suggestedTodos: [], read: true };
            writeAnswer(dir, a);
        }
        const before = warnings.length;
        warningAnswer = 'Delete the 100 oldest';
        await warnWhenOverLimit(now + 2 * 3_600_000);
        assert.equal(warnings.length, before + 1);
        assert.deepEqual(warnings[before], ['503 answers are stored (more than 500). Delete old ones?', 'Delete the 100 oldest', 'Delete the 200 oldest', 'Older than 7 days', 'Older than 30 days']);
        assert.equal(readAnswers(dir).length, 403);
        await warnWhenOverLimit(now + 2.5 * 3_600_000);
        assert.equal(warnings.length, before + 1, 'under the limit: nothing asked');
        for (const a of readAnswers(dir)) { fs.rmSync(path.join(dir, `${a.id}.json`), { force: true }); }
        warningAnswer = undefined;
    });

    test('QA-5: the writers', async () => {
        const before = blocks().length;
        // An ask, as the live tools journal it: the question when asked, the answer naming it.
        let clock = Date.parse('2026-11-25T10:00:00Z');
        const registry = new AskUserRegistry({ setTimer: (_ms, cb) => { timers.push(cb); return 0 as never; }, clearTimer: () => undefined, genId: () => `ask-${++asks}`, now: () => clock });
        const timers: Array<() => void> = [];
        let asks = 0;
        const deps: AskUserDeps = {
            registry,
            loadConfig: () => ({ maxWaitMinutes: 5, fallbackPrompt: 'FALLBACK' }),
            onOpen: () => undefined,
            onResolve: () => undefined,
            log: (e) => appendQuestionLogEntry(e),
            logAsked: (e) => appendQuestionAsked(e),
            now: () => clock,
        };
        const call = askUserImpl(deps, { questions: ['Which way? {{choice:l}}'], title: 'Route', choices: [{ id: 'l', label: 'Left', kind: 'answer' }] });
        const asked = blocks().slice(before);
        assert.deepEqual(asked.map((b: Json) => [b.kind, b.id, b.title, b.questions, b.choices, b.run]), [['question', 'q-ask-1', 'Route', ['Which way? [Left]'], ['Left'], 'default']]);
        clock += 60_000;
        registry.submit('ask-1', '## Left\n\n```\nshort\n```', 'vscode');
        await call;
        const answered = blocks().slice(before + 1);
        assert.deepEqual(answered.map((b: Json) => [b.kind, b.questionId, b.source, b.answer, b.time]), [['answer', 'q-ask-1', 'vscode', '## Left\n\n```\nshort\n```', '2026-11-25T10:01:00.000Z']]);
        // Timed out: the fallback is the answer of record.
        const call2 = askUserImpl(deps, { questions: ['Anything?'] });
        timers[timers.length - 1]();
        await call2;
        const timedOut = blocks().slice(before + 2);
        assert.deepEqual(timedOut.map((b: Json) => [b.kind, b.source, b.answer]), [['question', undefined, undefined], ['answer', 'timeout', 'FALLBACK']]);
        // A resolution without an asked block (an intercepted AskUserQuestion): both blocks at once.
        appendQuestionLogEntry({ tool: 'AskUserQuestion', questions: ['Pick?'], answer: 'B', source: 'cancel', askedAt: clock, answeredAt: clock + 1000 });
        const both = blocks().slice(before + 4);
        assert.deepEqual(both.map((b: Json) => b.kind), ['question', 'answer']);
        assert.equal(both[1].questionId, both[0].id);
        // A process decision.
        appendProcessDecision(processResetJournalEntry({ mode: 'run', run: 'r2', process: 'des', position: 'p1 › work', processAfter: '', variables: [], nestedLevels: 0, markers: 0 } as never, new Date('2026-11-25T11:00:00Z')), { run: 'r2' });
        const decision = blocks().at(-1);
        assert.deepEqual([decision.kind, decision.title, decision.run, decision.time], ['decision', 'Reset Run: run r2', 'r2', '2026-11-25T11:00:00.000Z']);
        assert.match(decision.details, /- \*\*Was:\*\* des › p1 › work/);
        // Nothing to the old journals.
        assert.equal(fs.existsSync(path.join(QDIR, `questions.${QUEST}.md`)), false);
        assert.equal(fs.existsSync(path.join(QDIR, `decisions.${QUEST}.md`)), false);
    });

    test('QA-6: the Questions tab, the filter, the counters', async () => {
        // Another host's journal and the old questions file of this quest; a journal of q2.
        appendQaBlocks(QDIR, QUEST, 'otherhost', [{ id: 'q-o1', kind: 'question', time: '2026-11-25T10:30:00.000Z', host: 'otherhost', title: 'From the other host', questions: ['There?'] }]);
        fs.writeFileSync(path.join(QDIR, `questions.${QUEST}.md`), '# Questions — q1\n\n## 2026-11-01T08:00:00.000Z — Old one\n\n- **Tool:** `tomAi_askUser`\n- **Run:** default\n- **Answered:** 2026-11-01T08:01:00.000Z via vscode, after 1m 0s\n\n### Answer\n\n> yes\n');
        appendQaBlocks(path.join(WS, '_ai', 'quests', 'q2'), 'q2', HOST, [{ id: 'd-q2', kind: 'decision', time: '2026-11-26T09:00:00.000Z', host: HOST, title: 'q2 decision', details: 'x' }]);
        fs.rmSync(qaReadMarkerFile()!, { force: true });
        resetQaPage();
        // Marked read only once the page shows them: here the counts first.
        assert.deepEqual(qaNewCounts([QUEST]).questions > 0, true);
        await send({ type: 'ready' });
        let s = lastState();
        const titles = s.questions.map((q: Json) => [q.title, q.host]);
        const times = s.questions.map((q: Json) => Date.parse(q.time));
        assert.deepEqual(times, [...times].sort((a: number, b: number) => b - a), 'newest first');
        assert.ok(titles.some((t: string[]) => t[0] === 'From the other host' && t[1] === 'otherhost'), 'the other host\'s journal, with its host');
        assert.ok(titles.some((t: string[]) => t[0] === 'Reset Run: run r2' && t[1] === HOST), 'the process decision');
        assert.deepEqual(titles.at(-1), ['Old one', ''], 'the old file\'s entry, of unknown host, oldest');
        assert.equal(s.questions.find((q: Json) => q.title === 'From the other host').open, true);
        assert.ok(s.counts.questions >= 8, `all new without a marker: ${s.counts.questions}`);
        assert.ok(s.questions.every((q: Json) => q.isNew));
        // Shown: marked read; the marker is in global storage, nothing under _ai.
        const marker = qaReadMarkerFile()!;
        assert.ok(marker.startsWith(path.join(GS, 'qa-read')));
        assert.ok(fs.existsSync(marker));
        assert.equal(qaNewCounts([QUEST]).questions, 0);
        await send({ type: 'ready' });
        assert.equal(lastState().counts.questions, 0);
        // A new entry: counted, and new.
        appendQaBlocks(QDIR, QUEST, 'otherhost', [{ id: 'q-o2', kind: 'question', time: '2026-11-27T10:30:00.000Z', host: 'otherhost', title: 'Newer', questions: ['?'] }]);
        assert.equal(qaNewCounts([QUEST]).questions, 1);
        // The filter: selected quests, then the workspace's (every quest without a list).
        await send({ type: 'filter', filter: { scope: 'selected', selected: ['q2'] } });
        s = lastState();
        assert.deepEqual(s.quests, ['q2']);
        assert.deepEqual(s.questions.map((q: Json) => q.title), ['q2 decision']);
        await send({ type: 'filter', filter: { scope: 'workspace', selected: [] } });
        assert.deepEqual([...lastState().quests].sort(), ['q1', 'q2']);
        await send({ type: 'filter', filter: { scope: 'current', selected: [] } });
        assert.deepEqual(lastState().quests, [QUEST]);
    });

    test('QA-7: the Decisions tab and answering in place', async () => {
        const file = path.join(QDIR, `todos.${QUEST}.todo.yaml`);
        fs.writeFileSync(file, [
            `quest: ${QUEST}`,
            'todos:',
            '  - id: d1_akss-two',
            '    title: Two decisions',
            '    description: Two.',
            '    status: decision-needed',
            '    updated: 2026-11-20',
            '    decisions:',
            '      - summary: First',
            '        decision_needed: "Pick: (a) one (b) two"',
            '      - summary: Second',
            '  - id: d2_akss-done',
            '    description: Done.',
            '    status: completed',
            '    completed_date: 2026-11-24',
            '    decisions:',
            '      - summary: Answered',
            '        decision: yes',
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(QDIR, `todos-archived.${QUEST}.todo.yaml`), [
            `quest: ${QUEST}`, 'todos:', '  - id: d3_akss-old', '    description: Old.', '    status: completed', '    completed_date: 2026-11-25',
            '    decisions:', '      - summary: Archived one', '        decision: b', '',
        ].join('\n'));
        await send({ type: 'tab', tab: 'decisions' });
        let s = lastState();
        assert.equal(s.tab, 'decisions');
        assert.deepEqual(s.decisions.map((d: Json) => [d.summary, d.open, d.archived]), [
            ['First', true, false], ['Second', true, false], ['Archived one', false, true], ['Answered', false, false],
        ]);
        assert.deepEqual(s.decisions[0].options, ['a', 'b']);
        assert.match(s.decisions[0].neededHtml, /Pick: \(a\) one \(b\) two/);
        // The first answer: written, the status stays.
        await send({ type: 'answerDecision', key: s.decisions[0].key, answer: '(b) two, because' });
        let todo = findTodoById(QUEST, 'd1_akss-two')!;
        assert.equal(todo.decisions![0].decision, '(b) two, because');
        assert.equal(todo.status, 'decision-needed', 'one decision is still open');
        s = lastState();
        assert.deepEqual(s.decisions.filter((d: Json) => d.open).map((d: Json) => d.summary), ['Second']);
        // The last one: the todo is not-started.
        await send({ type: 'answerDecision', key: s.decisions[0].key, answer: 'later' });
        todo = findTodoById(QUEST, 'd1_akss-two')!;
        assert.equal(todo.decisions![1].decision, 'later');
        assert.equal(todo.status, 'not-started');
        assert.equal(lastState().decisions.filter((d: Json) => d.open).length, 0);
        // Refused: an unknown todo, an empty answer.
        assert.equal(saveTodoDecision(QUEST, 'nope', 0, 'x').ok, false);
        assert.equal(saveTodoDecision(QUEST, 'd1_akss-two', 0, '  ').ok, false);
        assert.equal(fs.existsSync(path.join(QDIR, `decisions.${QUEST}.md`)), false, 'no decisions file');
        await send({ type: 'tab', tab: 'questions' });
    });

    test('QA-8: the command and where the page opens from', () => {
        assert.equal(SHOW_ANSWERS_COMMAND, 'tomAi.showAnswers');
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        assert.equal(pkg.contributes.commands.find((c: Json) => c.command === 'tomAi.showAnswers')?.title, '@T: Q&A');
        assert.match(fs.readFileSync(path.join(EXT, 'src', 'utils', 'extensionToolsCatalog.ts'), 'utf8'), /label: 'Q&A', group: 'quest', icon: 'comment', command: 'tomAi\.showAnswers'/);
        const handler = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'userNotifications-handler.ts'), 'utf8');
        assert.match(handler, /msg\.type === 'openAnswer'[\s\S]{0,400}executeCommand\(SHOW_ANSWERS_COMMAND, \{ id: row\.key \}\)/);
        assert.match(handler, /msg\.type === 'openQa'\) \{ await vscode\.commands\.executeCommand\(SHOW_ANSWERS_COMMAND, \{ tab: /);
        assert.match(handler, /qa: windowQaCounts\(\)/);
        assert.match(fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8'), /configureAnswersStore\(context\.globalStorageUri\.fsPath, \(\) => WsPaths\.aiRoot\);\s*initQaPanel\(context\);/);
        const draft = answerNotificationDraft({ id: 'a1', at: '', windowId: 'w', quest: QUEST, run: 'r2', session: 's', queueItemId: 'item-1', title: 'T', answer: 'line', suggestedPrompts: [{ label: 'l', text: 't' }], suggestedTodos: [], read: false });
        assert.deepEqual(draft, { type: 'answer', run: 'r2', user: { kind: 'answer', key: 'a1', title: 'T', details: ['line', '1 suggested prompt(s)'], session: 's', queueItemId: 'item-1' } });
        showAnswers({ tab: 'decisions' });
        assert.equal(panels().length, 1, 'one Q&A page: shown again, not opened twice');
        assert.equal(lastState().tab, 'decisions');
    });
});
