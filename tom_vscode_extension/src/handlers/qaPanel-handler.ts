/**
 * The Q&A page (`@T: Q&A`, `tomAi.showAnswers`): an editor-area page with two
 * tabs over the quests a filter picks (the window's quest, the workspace's
 * quests, or quests the user selects):
 *
 * - **Questions** — every entry of the quests' Q&A journals
 *   (`qa.<host>.<quest>.md`, every host's; services/qaJournal.ts): the
 *   questions asked of the user with their answers, the answers agents gave with tomAi_answerUser, the process
 *   decisions; newest first, each with its host. The list on the left, the
 *   selected entry on the right. An answer given that this machine's answer
 *   store holds (utils/userAnswers.ts) shows its suggested todos (**Add todo**
 *   creates the record through the todo tool's own create with the answering
 *   agent's `filed_by`) and prompts (**Copy** puts one on the clipboard);
 *   **Delete**, **Delete read** and **Delete all** (asked first) remove
 *   answers from the store, never from a journal.
 * - **Decisions** — the `decisions` of the quests' todos (the live and
 *   archived todo files): the open ones first, answerable in place (a text
 *   field, the option letters the decision offers); Save writes the answer
 *   into that decision through questTodoManager.updateTodo and, when it was
 *   the todo's last open one, sets a `decision-needed` todo `not-started`
 *   (utils/todoDecisions.ts answerTodoDecision).
 *
 * Each tab counts its new entries from this machine's read marker
 * (services/qaPageData.ts); showing a tab marks its entries read. The page
 * follows the journals, the todo files and the answer store as they change
 * (`fs.watch`). A stored answer of this window goes to the notification log
 * as an `answer` event, which USER NOTIFICATIONS opens here.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { stringify as stringifyYaml } from 'yaml';

import { bridgeLog, getExtensionPath, reportException } from './handler_shared.js';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown';
import {
    ANSWERS_WARN_LIMIT, ANSWER_CLEANUP_LABELS, cleanupIds, countAnswers, deleteAnswers, markAnswerRead, readAnswer, readAnswerIds, readAnswers,
    type AnswerCleanup, type UserAnswer,
} from '../utils/userAnswers';
import { answersDir, onAnswerStored } from '../services/userAnswersStore';
import { emitNotifications, type NotificationDraft } from '../services/notificationLog';
import { addSuggestedTodo } from '../tools/answer-user-tool';
import { createQuestTodoImpl, type CreateQuestTodoInput } from '../tools/quest-todo-tools';
import { questTodoDepsFiledBy } from '../tools/chat-enhancement-tools';
import { WsPaths } from '../utils/workspacePaths';
import { findTodoById, listQuestIds, updateTodo } from '../managers/questTodoManager';
import { answerTodoDecision } from '../utils/todoDecisions';
import {
    DEFAULT_QA_FILTER, isNewEntry, newCount, normaliseQaFilter,
    type QaDecisionEntry, type QaFilter, type QaQuestionEntry, type QaTab,
} from '../utils/qaView';
import { filterQuests, markTabShown, readDecisionEntries, readQaMarker, readQuestionEntries } from '../services/qaPageData';

export const SHOW_ANSWERS_COMMAND = 'tomAi.showAnswers';
const PAGE_TITLE = 'Tom AI — Q&A';

let panel: vscode.WebviewPanel | undefined;
let tab: QaTab = 'questions';
let filter: QaFilter = { ...DEFAULT_QA_FILTER };
/** The selected entry of the Questions tab (`<quest>|<id>`), or a stored answer's id until it is resolved. */
let selectedKey: string | undefined;
/** The stored answer the user marked unread while it is in view: not read again until another selection. */
let heldUnread: string | undefined;
let watchers: fs.FSWatcher[] = [];
let watchedKey = '';
let debounce: ReturnType<typeof setTimeout> | undefined;
/** When the over-limit warning was last shown (once an hour at most). */
let lastLimitWarning = 0;

/** A stored answer as the page shows it: the answer rendered, each suggested todo's record as YAML. */
export function answerDetail(a: UserAnswer): Record<string, unknown> {
    return {
        id: a.id,
        title: a.title,
        at: a.at,
        quest: a.quest,
        run: a.run,
        ...(a.session ? { session: a.session } : {}),
        ...(a.queueItemId ? { queueItemId: a.queueItemId } : {}),
        ...(a.question ? { question: a.question } : {}),
        answerHtml: renderQuestLogMarkdown(a.answer),
        prompts: a.suggestedPrompts.map((p) => ({ label: p.label, text: p.text })),
        todos: a.suggestedTodos.map((t) => ({
            quest: t.quest,
            ...(t.file ? { file: t.file } : {}),
            id: t.todo.id,
            title: typeof t.todo.title === 'string' ? t.todo.title : '',
            record: stringifyYaml(t.todo, { lineWidth: 0 }),
            ...(t.addedId ? { addedId: t.addedId } : {}),
        })),
    };
}

/** A Questions-tab entry in the list. */
function questionRow(e: QaQuestionEntry, isNew: boolean): Record<string, unknown> {
    const i = e.item;
    return {
        key: e.key,
        kind: i.kind,
        time: i.time,
        host: i.host,
        quest: i.quest ?? '',
        title: i.title || i.tool || (i.kind === 'decision' ? 'Process decision' : 'Question'),
        ...(i.run ? { run: i.run } : {}),
        open: i.kind === 'question' && !i.reply,
        isNew,
        ...(e.stored ? { stored: true, unread: !e.stored.read } : {}),
    };
}

/** The selected Questions-tab entry as the detail shows it. */
export function questionDetail(e: QaQuestionEntry): Record<string, unknown> {
    const i = e.item;
    const base = {
        key: e.key,
        kind: i.kind,
        title: i.title || i.tool || '',
        time: i.time,
        host: i.host,
        quest: i.quest ?? '',
        ...(i.session ? { session: i.session } : {}),
        ...(i.run ? { run: i.run } : {}),
        ...(i.queueItemId ? { queueItemId: i.queueItemId } : {}),
        ...(i.tool ? { tool: i.tool } : {}),
    };
    if (i.kind === 'answerGiven') {
        if (e.stored) { return { ...answerDetail(e.stored), ...base, stored: true }; }
        return {
            ...base,
            ...(i.userQuestion ? { question: i.userQuestion } : {}),
            answerHtml: renderQuestLogMarkdown(i.answer ?? ''),
            promptLabels: i.suggestedPrompts ?? [],
            todoLabels: i.suggestedTodos ?? [],
        };
    }
    if (i.kind === 'decision') {
        return { ...base, detailsHtml: renderQuestLogMarkdown(i.details ?? '') };
    }
    return {
        ...base,
        questions: i.questions ?? [],
        choices: i.choices ?? [],
        reply: i.reply ? { text: i.reply.text, time: i.reply.time, host: i.reply.host, ...(i.reply.source ? { source: i.reply.source } : {}) } : null,
    };
}

/** A Decisions-tab entry. */
function decisionRow(e: QaDecisionEntry, isNew: boolean): Record<string, unknown> {
    return {
        key: e.key,
        quest: e.quest,
        todoId: e.todoId,
        todoTitle: e.todoTitle,
        todoStatus: e.todoStatus,
        archived: e.archived,
        index: e.index,
        summary: e.summary,
        neededHtml: e.needed ? renderQuestLogMarkdown(e.needed) : '',
        ...(e.decision ? { decision: e.decision } : {}),
        open: e.open,
        time: e.time,
        options: e.options,
        isNew,
    };
}

/** The page's state for `tab` and the filter; the entries of the shown tab are marked read (unless `markRead` is false). */
export function qaState(opts: { markRead?: boolean } = {}): Record<string, unknown> {
    const quests = filterQuests(filter);
    const questions = readQuestionEntries(quests);
    const decisions = readDecisionEntries(quests);
    const marker = readQaMarker();
    const counts = { questions: newCount(questions, 'questions', marker), decisions: newCount(decisions, 'decisions', marker) };
    const chosen = questions.find((e) => e.key === selectedKey)
        ?? questions.find((e) => e.stored?.id === selectedKey)
        ?? questions[0];
    const dir = answersDir();
    const stored = dir ? readAnswers(dir) : [];
    const state = {
        type: 'state',
        tab,
        filter,
        currentQuest: WsPaths.getWorkspaceQuestId(),
        allQuests: listQuestIds(),
        quests,
        counts,
        questions: questions.map((e) => questionRow(e, isNewEntry(e, 'questions', marker))),
        selected: chosen ? questionDetail(chosen) : null,
        decisions: decisions.map((e) => decisionRow(e, isNewEntry(e, 'decisions', marker))),
        total: stored.length,
        unread: stored.filter((a) => !a.read).length,
        limit: ANSWERS_WARN_LIMIT,
    };
    if (opts.markRead !== false) { markTabShown(tab, tab === 'questions' ? questions : decisions); }
    return state;
}

function updateTitle(state: Record<string, unknown>): void {
    if (!panel) { return; }
    const counts = state.counts as { questions: number; decisions: number };
    // The shown tab is read now; the other tab's new entries remain.
    const left = tab === 'questions' ? counts.decisions : counts.questions;
    panel.title = left ? `${PAGE_TITLE} (${left} new)` : PAGE_TITLE;
}

function post(): void {
    if (!panel) { return; }
    try {
        const active = panel.active;
        const state = qaState({ markRead: active });
        // The stored answer in view is read once the page has the focus (a page shown beside the user's work leaves it unread).
        const shown = state.selected as { key?: string; id?: string; stored?: boolean } | null;
        selectedKey = shown?.key;
        const dir = answersDir();
        if (dir && shown?.stored && shown.id && active && tab === 'questions' && shown.id !== heldUnread) {
            const before = readAnswer(dir, shown.id);
            if (before && !before.read) {
                markAnswerRead(dir, shown.id);
                state.questions = (state.questions as Array<Record<string, unknown>>).map((r) => (r.key === shown.key ? { ...r, unread: false } : r));
                state.unread = Math.max(0, (state.unread as number) - 1);
            }
        }
        updateTitle(state);
        void panel.webview.postMessage(state);
        rewatch();
    } catch (error) {
        reportException('qa.post', error);
    }
}

function soon(): void {
    if (debounce) { clearTimeout(debounce); }
    debounce = setTimeout(() => { debounce = undefined; post(); }, 250);
}

/** A file whose change the page follows: a Q&A journal, a todo file. */
function followed(name: string | null | undefined): boolean {
    if (!name) { return true; }
    const n = String(name);
    return n.startsWith('qa.') || n.endsWith('.todo.yaml');
}

function closeWatchers(): void {
    for (const w of watchers) { try { w.close(); } catch { /* gone */ } }
    watchers = [];
    watchedKey = '';
}

/** Watch the answer store and the folders of the quests shown (again when they change). */
function rewatch(): void {
    const quests = filterQuests(filter);
    const dir = answersDir();
    const key = `${dir ?? ''}|${quests.join(',')}`;
    if (key === watchedKey) { return; }
    closeWatchers();
    watchedKey = key;
    const add = (folder: string, accept: (name: string | null) => boolean): void => {
        try {
            const w = fs.watch(folder, (_e, name) => { if (accept(name ? String(name) : null)) { soon(); } });
            w.on('error', () => { try { w.close(); } catch { /* gone */ } });
            watchers.push(w);
        } catch (error) {
            reportException('qa.watch', error);
        }
    };
    if (dir) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* no store */ }
        add(dir, () => true);
    }
    for (const q of quests) {
        const folder = WsPaths.ai('quests', q);
        if (folder && fs.existsSync(folder)) { add(folder, followed); }
    }
}

/** Show the Q&A page: on the Questions tab at stored answer `id` when given. */
export function showAnswers(opts: { id?: string; preserveFocus?: boolean; tab?: QaTab } = {}): void {
    if (opts.id) { selectedKey = opts.id; heldUnread = undefined; tab = 'questions'; }
    if (opts.tab) { tab = opts.tab; }
    if (panel) {
        panel.reveal(undefined, opts.preserveFocus ?? false);
        post();
        return;
    }
    const extPath = getExtensionPath();
    const created = vscode.window.createWebviewPanel(
        'tomAiAnswers',
        PAGE_TITLE,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: opts.preserveFocus ?? false },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: extPath ? [vscode.Uri.file(path.join(extPath, 'media')), vscode.Uri.file(path.join(extPath, 'node_modules', '@vscode', 'codicons', 'dist'))] : undefined },
    );
    panel = created;
    created.webview.onDidReceiveMessage((msg: Record<string, unknown>) => { void onMessage(msg); });
    created.onDidChangeViewState(() => { if (created.active) { post(); } });
    created.onDidDispose(() => {
        if (panel === created) { panel = undefined; }
        closeWatchers();
        if (debounce) { clearTimeout(debounce); debounce = undefined; }
    });
    try {
        const codicons = extPath ? created.webview.asWebviewUri(vscode.Uri.file(path.join(extPath, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'))).toString() : '';
        created.webview.html = loadWebviewHtml(created.webview, 'qaPanel', { init: { codiconsUri: codicons } });
    } catch (err) {
        bridgeLog(`[qa] Failed to render the page: ${(err as Error).message}`, 'ERROR');
    }
    rewatch();
}

/** Add suggested todo `index` of stored answer `id`, as the answering agent filed it. */
export async function addTodoOfAnswer(id: string, index: number): Promise<void> {
    const dir = answersDir();
    if (!dir) { return; }
    const result = await addSuggestedTodo(dir, id, index, (quest, todo, file, filedBy) =>
        createQuestTodoImpl(questTodoDepsFiledBy(filedBy), { questId: quest, todo, ...(file ? { file } : {}) } as CreateQuestTodoInput));
    if (result.ok) {
        void vscode.window.showInformationMessage(`Todo ${result.todoId} added to quest ${result.quest}.${result.warning ? ` ${result.warning}` : ''}`);
    } else if (result.alreadyAdded) {
        void vscode.window.showInformationMessage(result.error);
    } else {
        void vscode.window.showErrorMessage(`The todo was not added: ${result.error}`);
    }
    post();
}

/** What saving an answer to a todo decision did. */
export type SaveDecisionResult = { ok: true; status?: string } | { ok: false; error: string };

/**
 * Save `answer` into decision `index` of todo `todoId` of quest `quest`
 * (the Decisions tab's Save): through questTodoManager.updateTodo, with the
 * status `not-started` when it was the last open decision of a
 * `decision-needed` todo.
 */
export function saveTodoDecision(quest: string, todoId: string, index: number, answer: string): SaveDecisionResult {
    const todo = findTodoById(quest, todoId);
    if (!todo) { return { ok: false, error: `No todo ${todoId} in quest ${quest}.` }; }
    const update = answerTodoDecision(todo.decisions, todo.status, index, answer);
    if (!update) { return { ok: false, error: answer.trim() ? `Todo ${todoId} has no decision ${index + 1}.` : 'The answer is empty.' }; }
    const after = updateTodo(quest, todoId, { decisions: update.decisions, ...(update.status ? { status: update.status } : {}) });
    if (!after) { return { ok: false, error: `Todo ${todoId} could not be updated.` }; }
    return { ok: true, ...(update.status ? { status: update.status } : {}) };
}

async function onMessage(msg: Record<string, unknown>): Promise<void> {
    try {
        const dir = answersDir();
        const id = typeof msg.id === 'string' ? msg.id : '';
        const index = typeof msg.index === 'number' ? msg.index : -1;
        switch (msg.type) {
            case 'ready': post(); return;
            case 'tab': tab = msg.tab === 'decisions' ? 'decisions' : 'questions'; post(); return;
            case 'filter': filter = normaliseQaFilter(msg.filter); post(); return;
            case 'select': selectedKey = typeof msg.key === 'string' ? msg.key : id; heldUnread = undefined; post(); return;
            case 'answerDecision': {
                const key = typeof msg.key === 'string' ? msg.key : '';
                const [quest, todoId, at] = key.split('|');
                const result = saveTodoDecision(quest ?? '', todoId ?? '', Number(at), typeof msg.answer === 'string' ? msg.answer : '');
                if (result.ok) {
                    void vscode.window.showInformationMessage(`Decision saved on ${todoId}${result.status ? `; the todo is ${result.status} now` : ''}.`);
                } else {
                    void vscode.window.showErrorMessage(`The decision was not saved: ${result.error}`);
                }
                post();
                return;
            }
            case 'addTodo': await addTodoOfAnswer(id, index); return;
            case 'copyPrompt': {
                const prompt = dir ? readAnswer(dir, id)?.suggestedPrompts[index] : undefined;
                if (!prompt) { return; }
                await vscode.env.clipboard.writeText(prompt.text);
                void vscode.window.showInformationMessage('Prompt copied. Queue it from the quest\'s chat panel.');
                return;
            }
            case 'copyRecord': {
                const todo = dir ? readAnswer(dir, id)?.suggestedTodos[index] : undefined;
                if (todo) { await vscode.env.clipboard.writeText(stringifyYaml(todo.todo, { lineWidth: 0 })); }
                return;
            }
            case 'markUnread': if (dir) { markAnswerRead(dir, id, false); heldUnread = id; post(); } return;
            case 'delete': if (dir) { deleteAnswers(dir, [id]); post(); } return;
            case 'deleteRead': {
                if (!dir) { return; }
                const ids = readAnswerIds(readAnswers(dir));
                if (!ids.length) { return; }
                deleteAnswers(dir, ids);
                post();
                return;
            }
            case 'deleteAll': {
                if (!dir) { return; }
                const all = readAnswers(dir);
                if (!all.length) { return; }
                const ok = await vscode.window.showWarningMessage(`Delete all ${all.length} stored answers?`, { modal: true, detail: 'They are removed from this machine\'s answer store, for every quest that shares this _ai folder. The Q&A journals keep their entries.' }, 'Delete all');
                if (ok !== 'Delete all') { return; }
                deleteAnswers(dir, all.map((a) => a.id));
                post();
                return;
            }
        }
    } catch (error) {
        reportException('qa.onMessage', error, { type: msg?.type });
    }
}

/** The `answer` event of a stored answer (USER NOTIFICATIONS, NOTIFICATIONS). */
export function answerNotificationDraft(a: UserAnswer): NotificationDraft {
    return {
        type: 'answer',
        run: a.run,
        user: {
            kind: 'answer',
            key: a.id,
            title: a.title,
            details: [
                ...(a.question ? [`Question: ${a.question}`] : []),
                ...a.answer.split('\n').slice(0, 12),
                ...(a.suggestedTodos.length ? [`${a.suggestedTodos.length} suggested todo(s): ${a.suggestedTodos.map((t) => t.todo.id).join(', ')}`] : []),
                ...(a.suggestedPrompts.length ? [`${a.suggestedPrompts.length} suggested prompt(s)`] : []),
            ],
            ...(a.session ? { session: a.session } : {}),
            ...(a.queueItemId ? { queueItemId: a.queueItemId } : {}),
        },
    };
}

/** Past the limit: offer to delete old stored answers (at most once an hour per window). */
export async function warnWhenOverLimit(now: number = Date.now()): Promise<void> {
    const dir = answersDir();
    if (!dir) { return; }
    const count = countAnswers(dir);
    if (count <= ANSWERS_WARN_LIMIT || now - lastLimitWarning < 3_600_000) { return; }
    lastLimitWarning = now;
    const labels = Object.values(ANSWER_CLEANUP_LABELS);
    const picked = await vscode.window.showWarningMessage(`${count} answers are stored (more than ${ANSWERS_WARN_LIMIT}). Delete old ones?`, ...labels);
    const cleanup = (Object.keys(ANSWER_CLEANUP_LABELS) as AnswerCleanup[]).find((k) => ANSWER_CLEANUP_LABELS[k] === picked);
    if (!cleanup) { return; }
    const gone = deleteAnswers(dir, cleanupIds(readAnswers(dir), cleanup));
    void vscode.window.showInformationMessage(`${gone} answer(s) deleted; ${countAnswers(dir)} left. The Q&A journals keep their entries.`);
    post();
}

/** The page's tab and filter back to their defaults (tests; a new window starts there). */
export function resetQaPage(): void {
    tab = 'questions';
    filter = { ...DEFAULT_QA_FILTER };
    selectedKey = undefined;
    heldUnread = undefined;
}

/** At activation: the command, and what follows an answer this window stored. */
export function initQaPanel(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(SHOW_ANSWERS_COMMAND, (arg?: { id?: string; tab?: QaTab }) => {
            showAnswers({ ...(arg?.id ? { id: arg.id } : {}), ...(arg?.tab === 'decisions' || arg?.tab === 'questions' ? { tab: arg.tab } : {}) });
            return true;
        }),
        { dispose: onAnswerStored((answer) => {
            emitNotifications([answerNotificationDraft(answer)]);
            // Shown without taking the focus from what the user is doing; an open page only updates.
            if (panel) { post(); } else { showAnswers({ id: answer.id, preserveFocus: true }); }
            void warnWhenOverLimit();
        }) },
        { dispose: () => { panel?.dispose(); } },
    );
}
