/**
 * `tomAi_answerUser` (vscimpb171): give the user an answer without waiting.
 *
 * A prompt often asks for work and also asks questions. The answers used to
 * end up in the trail, where they are lost among the items that run after.
 * With this tool the agent hands each answer to the extension — a title, the
 * Markdown answer, optionally the question quoted, prompts to continue with
 * and complete todos to add — and goes on with its turn: the call returns at
 * once. The answers are stored for the machine (utils/userAnswers.ts) and
 * shown in the Answers page, where a suggested todo is added on a click
 * (exactly the record given, checked here as tomAi_createQuestTodo checks it)
 * and a suggested prompt is copied to the clipboard.
 *
 * The opposite direction — a question to the user — stays tomAi_askUser.
 *
 * vscode-free: storing, the context and what follows a stored answer come in
 * as {@link AnswerUserDeps}.
 */

import type { SharedToolDefinition } from './shared-tool-registry';
import { markTodoAdded, newAnswerId, readAnswer, type SuggestedPrompt, type SuggestedTodo, type UserAnswer } from '../utils/userAnswers';

export interface AnswerUserInput {
    title: string;
    answer: string;
    question?: string;
    suggestedPrompts?: Array<{ label?: string; text?: string }>;
    suggestedTodos?: Array<{ quest?: string; file?: string; todo?: Record<string, unknown> }>;
}

/** Where a call runs, recorded with the answer. */
export interface AnswerContext {
    windowId: string;
    quest: string;
    run: string;
    session?: string;
    queueItemId?: string;
    /** The `filed_by` a todo filed in this call would get. */
    filedBy?: Record<string, string>;
}

export interface AnswerUserDeps {
    context(): AnswerContext;
    /** Why tomAi_createQuestTodo would refuse this todo in `quest`, or undefined. */
    todoProblem(quest: string, todo: Record<string, unknown>, file?: string): string | undefined;
    /** Store the answer (throws when it cannot). */
    store(answer: UserAnswer): void;
    /** After it is stored: the notification, the Answers page, the over-limit notice. Never fails the call. */
    onStored?(answer: UserAnswer): void;
    now?(): Date;
}

const err = (error: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ ok: false, error, ...extra });

/**
 * The input's suggested prompts and todos, checked: the problems found (each
 * naming its entry), and the entries as they are stored.
 */
export function checkSuggestions(deps: Pick<AnswerUserDeps, 'todoProblem'>, input: AnswerUserInput, defaultQuest: string): { problems: string[]; prompts: SuggestedPrompt[]; todos: SuggestedTodo[] } {
    const problems: string[] = [];
    const prompts: SuggestedPrompt[] = [];
    const todos: SuggestedTodo[] = [];
    if (input.suggestedPrompts !== undefined && !Array.isArray(input.suggestedPrompts)) { problems.push('`suggestedPrompts` must be a list of {label, text}.'); }
    (Array.isArray(input.suggestedPrompts) ? input.suggestedPrompts : []).forEach((p, i) => {
        const text = typeof p?.text === 'string' ? p.text : '';
        if (!text.trim()) { problems.push(`suggestedPrompts[${i}]: \`text\` is required (the prompt to copy).`); return; }
        const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim() : text.trim().split('\n')[0].slice(0, 60);
        prompts.push({ label, text });
    });
    if (input.suggestedTodos !== undefined && !Array.isArray(input.suggestedTodos)) { problems.push('`suggestedTodos` must be a list of {quest?, todo, file?}.'); }
    const seen = new Set<string>();
    (Array.isArray(input.suggestedTodos) ? input.suggestedTodos : []).forEach((s, i) => {
        const at = `suggestedTodos[${i}]`;
        const todo = s?.todo;
        if (!todo || typeof todo !== 'object' || Array.isArray(todo)) { problems.push(`${at}: \`todo\` is required: the complete todo record, as tomAi_createQuestTodo takes it.`); return; }
        const quest = typeof s.quest === 'string' && s.quest.trim() ? s.quest.trim() : defaultQuest;
        if (!quest || quest === 'default') { problems.push(`${at}: no quest: name it in \`quest\` (no quest is open in this window).`); return; }
        const file = typeof s.file === 'string' && s.file.trim() ? s.file.trim() : undefined;
        const problem = deps.todoProblem(quest, todo, file);
        if (problem) { problems.push(`${at} (${String(todo.id ?? 'no id')}): ${problem}`); return; }
        const key = `${quest}/${String(todo.id)}`;
        if (seen.has(key)) { problems.push(`${at}: the id ${String(todo.id)} is suggested twice for quest ${quest}.`); return; }
        seen.add(key);
        todos.push({ quest, ...(file ? { file } : {}), todo: todo as SuggestedTodo['todo'] });
    });
    return { problems, prompts, todos };
}

export async function answerUserImpl(deps: AnswerUserDeps, input: AnswerUserInput): Promise<string> {
    try {
        const title = typeof input?.title === 'string' ? input.title.trim() : '';
        const answer = typeof input?.answer === 'string' ? input.answer : '';
        if (!title) { return err('`title` is required: the question this answers, in a few words.'); }
        if (!answer.trim()) { return err('`answer` is required (Markdown).'); }
        const ctx = deps.context();
        const checked = checkSuggestions(deps, input, ctx.quest);
        if (checked.problems.length) {
            return err(`Nothing was stored: ${checked.problems.length === 1 ? 'a suggestion is' : `${checked.problems.length} suggestions are`} not complete. ${checked.problems.join(' ')}`, { problems: checked.problems });
        }
        const now = deps.now?.() ?? new Date();
        const stored: UserAnswer = {
            id: newAnswerId(now),
            at: now.toISOString(),
            windowId: ctx.windowId,
            quest: ctx.quest,
            run: ctx.run,
            ...(ctx.session ? { session: ctx.session } : {}),
            ...(ctx.queueItemId ? { queueItemId: ctx.queueItemId } : {}),
            title,
            ...(typeof input.question === 'string' && input.question.trim() ? { question: input.question.trim() } : {}),
            answer,
            suggestedPrompts: checked.prompts,
            suggestedTodos: checked.todos,
            read: false,
            ...(ctx.filedBy && Object.keys(ctx.filedBy).length ? { filedBy: ctx.filedBy } : {}),
        };
        deps.store(stored);
        try { deps.onStored?.(stored); } catch { /* showing it never fails the call */ }
        return JSON.stringify({
            ok: true,
            id: stored.id,
            stored: true,
            suggestedPrompts: stored.suggestedPrompts.length,
            suggestedTodos: stored.suggestedTodos.length,
            note: 'The user finds the answer in the Answers page (@T: Answers) and in USER NOTIFICATIONS. Nothing waits for it: go on with your work. Suggested todos are not created until the user adds them.',
        });
    } catch (e) {
        return err(`The answer was not stored: ${(e as Error).message}`);
    }
}

/** What adding a suggested todo did. */
export type AddSuggestedTodoResult =
    | { ok: true; todoId: string; quest: string; warning?: string }
    | { ok: false; error: string; alreadyAdded?: string };

/**
 * Add suggested todo `index` of answer `id` (the Answers page's **Add todo**):
 * exactly the record the answer holds, created through `create` — the todo
 * tool's own create (tomAi_createQuestTodo), given the answering agent's
 * `filed_by` — and marked added in the answer. One that was added already is
 * not added again.
 */
export async function addSuggestedTodo(
    dir: string,
    id: string,
    index: number,
    create: (quest: string, todo: Record<string, unknown>, file: string | undefined, filedBy: Record<string, string> | undefined) => Promise<string>,
): Promise<AddSuggestedTodoResult> {
    const answer = readAnswer(dir, id);
    const suggestion = answer?.suggestedTodos[index];
    if (!answer || !suggestion) { return { ok: false, error: 'This answer or its suggested todo is no longer stored.' }; }
    if (suggestion.addedId) { return { ok: false, error: `Already added as ${suggestion.addedId}.`, alreadyAdded: suggestion.addedId }; }
    let result: { ok?: boolean; error?: string; todo?: { id?: string }; warning?: string };
    try {
        result = JSON.parse(await create(suggestion.quest, suggestion.todo, suggestion.file, answer.filedBy)) as typeof result;
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
    if (!result.ok) { return { ok: false, error: result.error ?? 'The todo was not created.' }; }
    const todoId = String(result.todo?.id ?? suggestion.todo.id);
    markTodoAdded(dir, id, index, todoId);
    return { ok: true, todoId, quest: suggestion.quest, ...(result.warning ? { warning: result.warning } : {}) };
}

export const ANSWER_USER_DESCRIPTION =
    'Give the user an answer WITHOUT waiting: for a question he asked in a prompt that also asks for work. `title`: the question in a few ' +
    'words; `answer`: Markdown; `question`: his question quoted (optional). The call returns at once and the turn goes on; call it once ' +
    'per question, as soon as you have the answer. The answer is kept out of the trail: stored and shown in the Answers page (list on ' +
    'the left, the answer on the right) and listed in USER NOTIFICATIONS. `suggestedPrompts` `[{label, text}]`: prompts to continue ' +
    'with; the user copies one and queues it himself. `suggestedTodos` `[{quest?, todo, file?}]`: todos he may add with one click, ' +
    'so `todo` must be the COMPLETE record as tomAi_createQuestTodo takes it (id from tomAi_generateIdPrefix, description, decisions ' +
    '…); `quest` defaults to this window\'s. Each is checked as tomAi_createQuestTodo checks it; one that is not complete refuses the ' +
    'whole call with the reasons, nothing stored. A suggested todo is NOT created until the user adds it: create what the prompt asks ' +
    'for with tomAi_createQuestTodo yourself. To ask the user something, use tomAi_askUser instead.';

export const ANSWER_USER_TOOL: SharedToolDefinition<AnswerUserInput> = {
    name: 'tomAi_answerUser',
    displayName: 'Answer User',
    description: ANSWER_USER_DESCRIPTION,
    tags: ['notification', 'user', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['title', 'answer'],
        properties: {
            title: { type: 'string', description: 'The question this answers, short (the list shows it).' },
            answer: { type: 'string', description: 'The answer, Markdown.' },
            question: { type: 'string', description: 'The user\'s question, quoted.' },
            suggestedPrompts: {
                type: 'array',
                description: 'Prompts to continue with; copied to the clipboard on a click, never queued.',
                items: { type: 'object', required: ['text'], properties: { label: { type: 'string' }, text: { type: 'string' } } },
            },
            suggestedTodos: {
                type: 'array',
                description: 'Todos the user may add on a click: each `todo` the complete record as tomAi_createQuestTodo takes it.',
                items: {
                    type: 'object',
                    required: ['todo'],
                    properties: {
                        quest: { type: 'string', description: 'The quest it goes to. Default: this window\'s quest.' },
                        file: { type: 'string', description: 'Target `*.todo.yaml` in that quest. Default: the quest\'s own.' },
                        todo: { type: 'object', description: 'The complete todo record (id, description, title, status, decisions, references …).' },
                    },
                },
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};
