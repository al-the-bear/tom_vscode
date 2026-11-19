/**
 * The Answers page's host (src/handlers/answersPanel-handler.ts, vscimpb171) and the live tomAi_answerUser, driven
 * through the vscode stub in a sandbox workspace of its own.
 *
 *   AP-1 the live tool stores into this window's store (per `_ai` folder, in global storage — nothing under `_ai`),
 *        writes the `answer` event to the notification log, and the Answers page opens on it without taking focus
 *   AP-2 the page's state: the list newest first with counts, the selected answer rendered (Markdown, the todo
 *        record as YAML); the answer in view is marked read; select / mark unread / delete / delete read / delete
 *        all (asks first, and keeps them on Cancel)
 *   AP-3 Add todo writes exactly the suggested record into the quest's todo file, filed by the answering agent,
 *        and the page shows it added; Copy puts the prompt on the clipboard and queues nothing
 *   AP-4 past the limit the window offers the four cleanups, and the one picked is applied; at most once an hour
 *   AP-5 the command, its title, the Extension Tools entry and the USER NOTIFICATIONS row that opens the answer
 */

/* eslint-disable @typescript-eslint/naming-convention -- todo YAML keys */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_vscimpb171_ap-')));
const WS = path.join(SANDBOX, 'ws');
const GS = path.join(SANDBOX, 'global-storage');
const QUEST = 'q1';
// The sandbox is a root of its own, so nothing resolves to the real workspace.
fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
fs.mkdirSync(path.join(WS, '_ai', 'quests', QUEST), { recursive: true });
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
import { configureAnswersStore, answersDir } from '../../services/userAnswersStore.js';
import { configureNotificationLog, readNotificationEvents, notificationLogFile } from '../../services/notificationLog.js';
import { ANSWER_USER_TOOL } from '../../tools/chat-enhancement-tools.js';
import { SHOW_ANSWERS_COMMAND, answerNotificationDraft, initAnswersPanel, showAnswers, warnWhenOverLimit } from '../answersPanel-handler.js';
import { readAnswer, readAnswers, writeAnswer, type UserAnswer } from '../../utils/userAnswers.js';
import { userNotificationRows } from '../../utils/userNotifications.js';
import { readTodoFile } from '../../managers/questTodoManager.js';

setExtensionPath(EXT);
assert.ok(fs.realpathSync(WsPaths.aiRoot ?? '/').startsWith(SANDBOX), `the _ai root is in the sandbox: ${WsPaths.aiRoot}`);
configureAnswersStore(GS, () => WsPaths.aiRoot);
configureNotificationLog(path.join(GS, 'notifications.jsonl'), { windowId: () => 'w-test', quest: () => QUEST, run: () => 'default', who: () => ({ kind: 'agent' }) } as never);
const context = { subscriptions: [] as Array<{ dispose(): void }>, extensionPath: EXT, globalStorageUri: { fsPath: GS } };
initAnswersPanel(context as never);
after(() => {
    for (const s of context.subscriptions) { s.dispose(); }
    configureAnswersStore(undefined, undefined);
    configureNotificationLog(undefined, undefined);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));
const panels = (): Json[] => stub.window.__webviewPanels as Json[];
const page = (): Json => panels()[panels().length - 1];
const lastState = (): Json => [...page().webview.__posted].reverse().find((m: Json) => m.type === 'state');
const send = async (m: Json): Promise<void> => { page().webview.__receive(m); await tick(); };
const answer = (input: Json): Promise<Json> => ANSWER_USER_TOOL.execute(input).then((raw) => JSON.parse(raw as string));
const TODO = { id: 'x1_akss-follow-up', title: 'Follow up', description: 'Do the follow-up.\n\nDONE WHEN: done.', status: 'decision-needed', priority: 'high', tags: ['a', 'b'], decisions: [{ summary: 'Which way', decision_needed: 'Which way? (a) left (b) right' }] };

describe('the Answers page', () => {
    test('AP-1: the live tool stores, notifies and opens the page', async () => {
        const dir = answersDir()!;
        assert.ok(dir.startsWith(path.join(GS, 'answers')), 'the store is in global storage');
        const r = await answer({ title: 'Why is it slow?', answer: 'Because of **x**.\n\n- one\n- two', question: 'Why is the build slow?', suggestedPrompts: [{ label: 'Next', text: 'Do the next step' }], suggestedTodos: [{ todo: { ...TODO } }] });
        assert.equal(r.ok, true, JSON.stringify(r));
        const stored = readAnswer(dir, r.id)!;
        assert.equal(stored.quest, QUEST);
        assert.equal(stored.run, 'default');
        assert.equal(stored.windowId, 'test-ses_test-mac');
        assert.ok(stored.filedBy, 'the caller\'s filed_by is kept for an added todo');
        assert.deepEqual(fs.readdirSync(path.join(WS, '_ai')), ['quests'], 'nothing is written under _ai');
        assert.equal(fs.existsSync(path.join(WS, '_ai', 'quests', QUEST, `todos.${QUEST}.todo.yaml`)), false, 'the suggested todo is not created');
        // The event, and its row in USER NOTIFICATIONS.
        const events = readNotificationEvents(notificationLogFile()!).filter((e) => e.type === 'answer');
        assert.equal(events.length, 1);
        assert.equal(events[0].user?.key, r.id);
        assert.equal(events[0].user?.title, 'Why is it slow?');
        const rows = userNotificationRows(events, new Set());
        assert.deepEqual(rows.map((x) => [x.type, x.state, x.key, x.title]), [['answer', 'notice', r.id, 'Why is it slow?']]);
        assert.ok(rows[0].details.includes('Question: Why is the build slow?') && rows[0].details.some((d) => /1 suggested todo\(s\): x1_akss-follow-up/.test(d)));
        // The page: opened on the answer, beside what the user does.
        assert.equal(panels().length, 1);
        assert.equal(page().title, 'Tom AI — Answers');
        assert.match(page().webview.html, /answersPanel/);
        const created = vs.spies.calls.find((c) => c.method === 'window.createWebviewPanel');
        assert.ok(created);
        // An incomplete suggestion: refused, nothing stored, no event.
        const bad = await answer({ title: 't', answer: 'a', suggestedTodos: [{ todo: { id: 'nodesc1' } }] });
        assert.equal(bad.ok, false);
        assert.match(bad.problems[0], /`todo\.description` is required/);
        assert.equal(readAnswers(dir).length, 1);
    });

    test('AP-2: the state and the page\'s actions', async () => {
        const dir = answersDir()!;
        const first = readAnswers(dir)[0];
        await send({ type: 'ready' });
        let s = lastState();
        assert.equal(s.total, 1);
        assert.equal(s.limit, 500);
        assert.deepEqual(s.answers.map((a: Json) => [a.id, a.title, a.quest, a.run, a.todos, a.prompts, a.thisWindow]), [[first.id, 'Why is it slow?', QUEST, 'default', 1, 1, true]]);
        assert.equal(s.selected.id, first.id);
        assert.match(s.selected.answerHtml, /<strong>x<\/strong>/);
        assert.match(s.selected.answerHtml, /<li>one<\/li>/);
        assert.equal(s.selected.question, 'Why is the build slow?');
        assert.deepEqual(s.selected.prompts, [{ label: 'Next', text: 'Do the next step' }]);
        assert.equal(s.selected.todos[0].id, TODO.id);
        assert.match(s.selected.todos[0].record, /^id: x1_akss-follow-up\ntitle: Follow up\n/);
        assert.match(s.selected.todos[0].record, /decisions:\n {2}- summary: Which way/);
        // The page has the focus (the stub's panel is active): the answer in view is read.
        assert.equal(readAnswer(dir, first.id)!.read, true);
        assert.equal(s.unread, 0);
        // A second answer: unread while the first is in view; select reads it.
        const second = await answer({ title: 'Second', answer: 'two' });
        await tick();
        s = lastState();
        assert.deepEqual(s.answers.map((a: Json) => [a.title, a.read]), [['Second', false], ['Why is it slow?', true]]);
        assert.equal(s.selected.id, first.id, 'the page stays on the answer the user reads');
        await send({ type: 'select', id: second.id });
        assert.equal(lastState().selected.id, second.id);
        assert.equal(readAnswer(dir, second.id)!.read, true);
        await send({ type: 'markUnread', id: second.id });
        assert.equal(readAnswer(dir, second.id)!.read, false, 'unread again');
        assert.equal(lastState().selected.id, second.id, 'it stays in view');
        await send({ type: 'ready' });
        assert.equal(readAnswer(dir, second.id)!.read, false, 'and stays unread while it is in view');
        await send({ type: 'select', id: first.id });
        // Delete read: the read one goes, the unread stays.
        const third = await answer({ title: 'Third', answer: 'three' });
        await send({ type: 'select', id: third.id });
        await send({ type: 'select', id: first.id });
        await send({ type: 'delete', id: third.id });
        assert.equal(readAnswer(dir, third.id), undefined);
        // Delete all asks; Cancel keeps them.
        warningAnswer = undefined;
        await send({ type: 'deleteAll' });
        assert.match(String(warnings[warnings.length - 1][0]), /Delete all 2 answers\?/);
        assert.deepEqual(warnings[warnings.length - 1].slice(1), [{ modal: true, detail: 'They are removed from this machine\'s answer store, for every quest that shares this _ai folder.' }, 'Delete all']);
        assert.equal(readAnswers(dir).length, 2, 'cancelled: nothing deleted');
    });

    test('AP-3: Add todo and Copy', async () => {
        const dir = answersDir()!;
        const first = readAnswers(dir).find((a) => a.title === 'Why is it slow?')!;
        await send({ type: 'copyPrompt', id: first.id, index: 0 });
        assert.deepEqual(clipboard, ['Do the next step']);
        await send({ type: 'addTodo', id: first.id, index: 0 });
        const file = path.join(WS, '_ai', 'quests', QUEST, `todos.${QUEST}.todo.yaml`);
        const todos = readTodoFile(file) as Json[];
        assert.equal(todos.length, 1);
        const t = todos[0];
        for (const [k, v] of Object.entries(TODO)) { assert.deepEqual(t[k], v, k); }
        assert.deepEqual(t.filed_by, first.filedBy, 'filed by the answering agent');
        assert.equal(readAnswer(dir, first.id)!.suggestedTodos[0].addedId, TODO.id);
        assert.equal(lastState().answers.length, 2);
        await send({ type: 'select', id: first.id });
        assert.equal(lastState().selected.todos[0].addedId, TODO.id, 'the page shows it added');
        // A second click adds nothing.
        await send({ type: 'addTodo', id: first.id, index: 0 });
        assert.equal(readTodoFile(file).length, 1);
        // Delete read, then Delete all confirmed.
        await send({ type: 'deleteRead' });
        assert.deepEqual(readAnswers(dir).map((a) => a.title), ['Second']);
        warningAnswer = 'Delete all';
        await send({ type: 'deleteAll' });
        assert.equal(readAnswers(dir).length, 0);
        assert.equal(lastState().selected, null);
        assert.equal(readTodoFile(file).length, 1, 'the added todo stays');
    });

    test('AP-4: past the limit', async () => {
        const dir = answersDir()!;
        const now = Date.parse('2026-11-19T10:00:00Z');
        for (let i = 0; i < 503; i++) {
            const a: UserAnswer = { id: `m${i}`, at: new Date(now - i * 3_600_000).toISOString(), windowId: 'w', quest: QUEST, run: 'default', title: `t${i}`, answer: 'a', suggestedPrompts: [], suggestedTodos: [], read: true };
            writeAnswer(dir, a);
        }
        const before = warnings.length;
        warningAnswer = 'Delete the 100 oldest';
        await warnWhenOverLimit(now + 2 * 3_600_000);
        assert.equal(warnings.length, before + 1);
        assert.deepEqual(warnings[before], ['503 answers are stored (more than 500). Delete old ones?', 'Delete the 100 oldest', 'Delete the 200 oldest', 'Older than 7 days', 'Older than 30 days']);
        assert.equal(readAnswers(dir).length, 403);
        assert.equal(readAnswer(dir, 'm502'), undefined, 'the oldest went');
        assert.ok(readAnswer(dir, 'm0'));
        // Under the limit: nothing asked. Over it again within the hour: not asked again.
        await warnWhenOverLimit(now + 4 * 3_600_000);
        assert.equal(warnings.length, before + 1);
        for (let i = 600; i < 700; i++) { writeAnswer(dir, { ...readAnswer(dir, 'm0')!, id: `m${i}` }); }
        await warnWhenOverLimit(now + 2.5 * 3_600_000);
        assert.equal(warnings.length, before + 1, 'at most once an hour');
        warningAnswer = 'Older than 7 days';
        await warnWhenOverLimit(now + 4 * 3_600_000);
        assert.equal(warnings.length, before + 2);
        assert.ok(readAnswers(dir).every((a) => Date.parse(a.at) >= Date.now() - 7 * 86_400_000 || a.id === 'never'), 'only the last 7 days are left');
        warningAnswer = undefined;
    });

    test('AP-5: the command and where the page opens from', () => {
        assert.equal(SHOW_ANSWERS_COMMAND, 'tomAi.showAnswers');
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        assert.equal(pkg.contributes.commands.find((c: Json) => c.command === 'tomAi.showAnswers')?.title, '@T: Answers');
        assert.match(fs.readFileSync(path.join(EXT, 'src', 'utils', 'extensionToolsCatalog.ts'), 'utf8'), /tomAi\.showAnswers/);
        const handler = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'userNotifications-handler.ts'), 'utf8');
        assert.match(handler, /msg\.type === 'openAnswer'[\s\S]{0,400}executeCommand\(SHOW_ANSWERS_COMMAND, \{ id: row\.key \}\)/);
        assert.match(fs.readFileSync(path.join(EXT, 'media', 'userNotifications', 'main.js'), 'utf8'), /r\.type === 'answer' && r\.key\) \{ vscode\.postMessage\(\{ type: 'openAnswer', id: id \}\)/);
        assert.match(fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8'), /configureAnswersStore\(context\.globalStorageUri\.fsPath, \(\) => WsPaths\.aiRoot\);\s*initAnswersPanel\(context\);/);
        const draft = answerNotificationDraft({ id: 'a1', at: '', windowId: 'w', quest: QUEST, run: 'r2', session: 's', queueItemId: 'item-1', title: 'T', answer: 'line', suggestedPrompts: [{ label: 'l', text: 't' }], suggestedTodos: [], read: false });
        assert.deepEqual(draft, { type: 'answer', run: 'r2', user: { kind: 'answer', key: 'a1', title: 'T', details: ['line', '1 suggested prompt(s)'], session: 's', queueItemId: 'item-1' } });
        showAnswers({ id: 'a1' });
        assert.equal(panels().length, 1, 'one Answers page: shown again, not opened twice');
    });
});
