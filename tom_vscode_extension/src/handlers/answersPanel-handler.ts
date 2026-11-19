/**
 * The Answers page (`@T: Answers`, `tomAi.showAnswers`, vscimpb171): the
 * answers agents gave the user with tomAi_answerUser, kept out of the trails.
 * An editor-area page: the list on the left (newest first, unread bold, with
 * quest and run), the selected answer on the right as rendered Markdown, its
 * suggested todos and prompts below it.
 *
 * - **Add todo** creates a suggested todo exactly as the answer holds it,
 *   through the todo tool's own create with the answering agent's `filed_by`
 *   (tools/answer-user-tool.ts addSuggestedTodo); an added one shows its id.
 * - **Copy** puts a suggested prompt on the clipboard; nothing is queued.
 * - **Delete**, **Delete read** and **Delete all** (asked first) remove
 *   answers from the store; nothing else removes them. Past
 *   {@link ANSWERS_WARN_LIMIT} a warning offers to delete old ones.
 *
 * The store is the machine's, per `_ai` folder (utils/userAnswers.ts): the
 * page follows it as other windows write to it (`fs.watch`). A stored answer
 * of this window goes to the notification log as an `answer` event, which USER
 * NOTIFICATIONS opens here.
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

export const SHOW_ANSWERS_COMMAND = 'tomAi.showAnswers';

let panel: vscode.WebviewPanel | undefined;
let selectedId: string | undefined;
/** The answer the user marked unread while it is in view: not read again until another selection. */
let heldUnread: string | undefined;
let watcher: fs.FSWatcher | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;
/** When the over-limit warning was last shown (once an hour at most). */
let lastLimitWarning = 0;

function thisWindowId(): string {
    return `${vscode.env.sessionId.substring(0, 8)}_${vscode.env.machineId.substring(0, 8)}`;
}

/** The list entry of an answer. */
export function answerListEntry(a: UserAnswer, me: string): Record<string, unknown> {
    return {
        id: a.id,
        title: a.title,
        at: a.at,
        quest: a.quest,
        run: a.run,
        read: a.read,
        thisWindow: a.windowId === me,
        todos: a.suggestedTodos.length,
        prompts: a.suggestedPrompts.length,
    };
}

/** The selected answer as the page shows it: the answer rendered, each suggested todo's record as YAML. */
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

/** The page's state: the list, the selected answer (the newest when none is chosen), the counts. */
export function answersState(dir: string | undefined, selected: string | undefined, me: string): Record<string, unknown> {
    const answers = dir ? readAnswers(dir) : [];
    const chosen = answers.find((a) => a.id === selected) ?? answers[0];
    return {
        type: 'state',
        answers: answers.map((a) => answerListEntry(a, me)),
        selected: chosen ? answerDetail(chosen) : null,
        total: answers.length,
        unread: answers.filter((a) => !a.read).length,
        limit: ANSWERS_WARN_LIMIT,
    };
}

function post(): void {
    if (!panel) { return; }
    try {
        const dir = answersDir();
        const state = answersState(dir, selectedId, thisWindowId());
        // The answer in view is read once the page has the focus (a page shown beside the user's work leaves it unread).
        const shown = (state.selected as { id?: string } | null)?.id;
        if (dir && shown && panel.active && shown !== heldUnread) {
            const before = readAnswer(dir, shown);
            if (before && !before.read) {
                markAnswerRead(dir, shown);
                void panel.webview.postMessage(answersState(dir, shown, thisWindowId()));
                selectedId = shown;
                return;
            }
        }
        selectedId = shown;
        void panel.webview.postMessage(state);
    } catch (error) {
        reportException('answers.post', error);
    }
}

function soon(): void {
    if (debounce) { clearTimeout(debounce); }
    debounce = setTimeout(() => { debounce = undefined; post(); }, 250);
}

function watch(): void {
    watcher?.close();
    watcher = undefined;
    const dir = answersDir();
    if (!dir) { return; }
    try {
        fs.mkdirSync(dir, { recursive: true });
        watcher = fs.watch(dir, () => soon());
        watcher.on('error', () => { watcher?.close(); watcher = undefined; });
    } catch (error) {
        reportException('answers.watch', error);
    }
}

/** Show the Answers page, on answer `id` when given. */
export function showAnswers(opts: { id?: string; preserveFocus?: boolean } = {}): void {
    if (opts.id) { selectedId = opts.id; heldUnread = undefined; }
    if (panel) {
        panel.reveal(undefined, opts.preserveFocus ?? false);
        post();
        return;
    }
    const extPath = getExtensionPath();
    const created = vscode.window.createWebviewPanel(
        'tomAiAnswers',
        'Tom AI — Answers',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: opts.preserveFocus ?? false },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: extPath ? [vscode.Uri.file(path.join(extPath, 'media')), vscode.Uri.file(path.join(extPath, 'node_modules', '@vscode', 'codicons', 'dist'))] : undefined },
    );
    panel = created;
    created.webview.onDidReceiveMessage((msg: Record<string, unknown>) => { void onMessage(msg); });
    created.onDidChangeViewState(() => { if (created.active) { post(); } });
    created.onDidDispose(() => {
        if (panel === created) { panel = undefined; }
        watcher?.close();
        watcher = undefined;
        if (debounce) { clearTimeout(debounce); debounce = undefined; }
    });
    try {
        const codicons = extPath ? created.webview.asWebviewUri(vscode.Uri.file(path.join(extPath, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'))).toString() : '';
        created.webview.html = loadWebviewHtml(created.webview, 'answersPanel', { init: { codiconsUri: codicons } });
    } catch (err) {
        bridgeLog(`[answers] Failed to render the page: ${(err as Error).message}`, 'ERROR');
    }
    watch();
}

/** Add suggested todo `index` of answer `id`, as the answering agent filed it. */
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

async function onMessage(msg: Record<string, unknown>): Promise<void> {
    try {
        const dir = answersDir();
        const id = typeof msg.id === 'string' ? msg.id : '';
        const index = typeof msg.index === 'number' ? msg.index : -1;
        switch (msg.type) {
            case 'ready': post(); return;
            case 'select': selectedId = id; heldUnread = undefined; post(); return;
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
            case 'delete': if (dir) { deleteAnswers(dir, [id]); if (selectedId === id) { selectedId = undefined; } post(); } return;
            case 'deleteRead': {
                if (!dir) { return; }
                const ids = readAnswerIds(readAnswers(dir));
                if (!ids.length) { return; }
                deleteAnswers(dir, ids);
                selectedId = undefined;
                post();
                return;
            }
            case 'deleteAll': {
                if (!dir) { return; }
                const all = readAnswers(dir);
                if (!all.length) { return; }
                const ok = await vscode.window.showWarningMessage(`Delete all ${all.length} answers?`, { modal: true, detail: 'They are removed from this machine\'s answer store, for every quest that shares this _ai folder.' }, 'Delete all');
                if (ok !== 'Delete all') { return; }
                deleteAnswers(dir, all.map((a) => a.id));
                selectedId = undefined;
                post();
                return;
            }
        }
    } catch (error) {
        reportException('answers.onMessage', error, { type: msg?.type });
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

/** Past the limit: offer to delete old answers (at most once an hour per window). */
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
    void vscode.window.showInformationMessage(`${gone} answer(s) deleted; ${countAnswers(dir)} left.`);
    post();
}

/** At activation: the command, and what follows an answer this window stored. */
export function initAnswersPanel(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(SHOW_ANSWERS_COMMAND, (arg?: { id?: string }) => { showAnswers({ ...(arg?.id ? { id: arg.id } : {}) }); return true; }),
        { dispose: onAnswerStored((answer) => {
            emitNotifications([answerNotificationDraft(answer)]);
            // Shown without taking the focus from what the user is doing; an open page only updates.
            if (panel) { post(); } else { showAnswers({ id: answer.id, preserveFocus: true }); }
            void warnWhenOverLimit();
        }) },
        { dispose: () => { panel?.dispose(); } },
    );
}
