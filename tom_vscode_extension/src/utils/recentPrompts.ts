/**
 * The Recent prompts panel's content (handlers/recentPromptsPanel-handler.ts):
 * the last prompts the prompt queue sent in this window's quest, shaped from
 * what the queue keeps of its items — sent and sending items with their stages
 * (pre-prompts, the main prompt per iteration, the continuations of a walk
 * iteration, follow-ups), and the chat sends shown in the queue.
 *
 * Prompts are counted, not items: an item of 3 iterations after a pre-prompt
 * is 4 prompts. The rows (one per item) are newest first; at most
 * {@link RECENT_PROMPTS_LIMIT} prompts are shown, the oldest prompts of the
 * last row cut when it crosses the limit.
 *
 * What a prompt shows as sent: the queue keeps the expanded text of the last
 * prompt an item dispatched (`lastDispatched`) and of a chat send, and a
 * continuation is the queue's fixed continuation prompt; for every other
 * prompt it keeps the text as queued (`expanded: false`). Its answer is
 * the stage's answer (`answerText` of the pre-prompt / follow-up: the last of
 * its repetitions), the iteration's answer (`repetitionAnswers`, with the
 * answers of a walk iteration's turns before its last in `earlier`), the
 * item's latest main answer, or a chat send's answer or error.
 *
 * vscode-free and pure.
 */

import { deriveQueueItemKind, parseQueueItemKind, type QueueItemKind } from './queueItemKind';
import { parseTodoWalk } from './queueStep3Utils';
import type { RepetitionAnswer } from './repetitionAnswers';
import { continuationPrompt } from './walkCompletionCheck';

/** The most prompts the panel shows. */
export const RECENT_PROMPTS_LIMIT = 100;

/** How much of an answer a row and a prompt show before Full text. */
export const ANSWER_START_CHARS = 200;

/** What the collector reads of a queue item (a subset of QueuedPrompt). */
export interface RecentPromptSourceItem {
    id: string;
    status: string;
    template?: string;
    originalText: string;
    expandedText?: string;
    createdAt: string;
    sentAt?: string;
    error?: string;
    chatSource?: string;
    itemKind?: string;
    repeatCount?: number | string;
    repeatIndex?: number;
    repeatTodoId?: string;
    templateRepeatCount?: number | string;
    templateRepeatIndex?: number;
    iterationSeq?: number;
    walkedTodos?: string[];
    repetitionAnswers?: RepetitionAnswer[];
    todoIdPattern?: string;
    prePrompts?: Array<{ text: string; status?: string; repeatIndex?: number; answerText?: string }>;
    followUps?: Array<{ originalText: string; repeatIndex?: number; answerText?: string }>;
    answerText?: string;
    lastDispatched?: { kind: 'prePrompt' | 'main' | 'followUp'; prePromptIndex?: number; followUpIndex?: number; expandedText: string; dispatchedAt: string };
    run?: string;
    session?: string;
    anthropicProfileId?: string;
    role?: string;
}

/** The stage a prompt was sent in. */
export type RecentPromptStage = 'prePrompt' | 'main' | 'continuation' | 'followUp' | 'chat';

/** One prompt sent. */
export interface RecentPrompt {
    stage: RecentPromptStage;
    /** What it is, e.g. `Pre-prompt 1`, `Main prompt`, `Continuation 2`, `Follow-up 1 (2/3)`. */
    label: string;
    /** The prompt: as sent when `expanded`, else as queued. */
    text: string;
    /** `text` is the expanded text the prompt went out with. */
    expanded: boolean;
    /** Its answer ('' when none is kept). */
    answer: string;
    /** The answer is the error the send ended with. */
    error?: boolean;
    /** When it was sent or answered (ISO), when known. */
    at?: string;
}

/** A node under a row: a single prompt, or an iteration holding its prompts. */
export type RecentPromptNode =
    | { type: 'prompt'; prompt: RecentPrompt }
    | { type: 'iteration'; label: string; todoId?: string; todoTitle?: string; prompts: RecentPrompt[] };

/** One row: an item and the prompts it sent. */
export interface RecentPromptRow {
    id: string;
    kind: QueueItemKind;
    status: string;
    /** The todos the item runs (`<prefix>*` as id for a walk). */
    todos: Array<{ id: string; title?: string }>;
    /** The prompt's first line. */
    firstLine: string;
    settings: { run?: string; session?: string; profile?: string; role?: string; template?: string };
    /** The time the item last sent (ISO). */
    sentAt: string;
    /** The prompts under the row (after the limit's cut). */
    promptCount: number;
    /** The start of the last answer, whitespace folded. */
    lastAnswerStart: string;
    nodes: RecentPromptNode[];
}

/** Lookups the host gives (todo titles, profile names); both optional. */
export interface RecentPromptLookups {
    todoTitle?: (id: string) => string | undefined;
    profileName?: (id: string) => string | undefined;
}

const CHAT_STATUSES = new Set(['chat', 'chat-sent']);

/** The start of `text`: whitespace folded, at most `max` characters (an ellipsis when cut). */
export function answerStart(text: string, max = ANSWER_START_CHARS): string {
    const folded = (text ?? '').replace(/\s+/g, ' ').trim();
    return folded.length > max ? `${folded.slice(0, max).trimEnd()}…` : folded;
}

/** The first non-empty line of `text`. */
function firstLineOf(text: string): string {
    return (text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
}

function countOf(raw: number | string | undefined): number {
    if (typeof raw === 'number') { return raw; }
    if (typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw.trim()))) { return Number(raw.trim()); }
    return 0;
}

/** The time an item last sent: its last dispatch, its send time, else its creation. */
function sentAtOf(item: RecentPromptSourceItem): string {
    const times = [item.lastDispatched?.dispatchedAt, item.sentAt].filter((t): t is string => !!t);
    return times.sort().pop() ?? item.createdAt;
}

/** The keys of the main stage's iterations, oldest first: a walk's todos, else the repetition numbers. */
function iterationKeys(item: RecentPromptSourceItem, kind: QueueItemKind): string[] {
    const answers = item.repetitionAnswers ?? [];
    if (kind === 'prefix' || kind === 'group' || kind === 'todo') {
        const keys = [...(item.walkedTodos ?? [])];
        for (const a of answers) { if (!keys.includes(a.key)) { keys.push(a.key); } }
        if (item.repeatTodoId && !keys.includes(item.repeatTodoId)) { keys.push(item.repeatTodoId); }
        if (!keys.length && kind === 'todo') {
            const walk = parseTodoWalk(item.repeatCount);
            if (walk && walk.kind === 'todo') { keys.push(walk.id); }
        }
        return keys;
    }
    // A counted repetition: the repeat count, else the template repeat count.
    const repeats = countOf(item.repeatCount) > 1 || (typeof item.repeatCount === 'string' && !Number.isFinite(Number(item.repeatCount.trim())));
    const sent = Math.max(
        item.iterationSeq ?? 0,
        repeats ? item.repeatIndex ?? 0 : 0,
        !repeats && countOf(item.templateRepeatCount) > 1 ? item.templateRepeatIndex ?? 0 : 0,
        ...answers.map((a) => Number(a.key)).filter((n) => Number.isFinite(n)),
    );
    if (sent > 0) { return Array.from({ length: sent }, (_, i) => String(i + 1)); }
    // A plain item that sent its main prompt.
    const mainSent = !!item.answerText || item.lastDispatched?.kind === 'main' || item.lastDispatched?.kind === 'followUp'
        || item.status === 'sent' || (item.followUps ?? []).some((f) => (f.repeatIndex ?? 0) > 0);
    return mainSent ? ['1'] : [];
}

/** The prompts of a chat send. */
function chatPrompts(item: RecentPromptSourceItem): RecentPrompt[] {
    const error = !item.answerText && !!item.error;
    return [{
        stage: 'chat',
        label: item.chatSource ? `Chat send (${item.chatSource})` : 'Chat send',
        text: item.expandedText || item.originalText,
        expanded: true,
        answer: item.answerText ?? (item.error ? `Error: ${item.error}` : ''),
        ...(error ? { error: true } : {}),
        ...(item.sentAt ? { at: item.sentAt } : {}),
    }];
}

/** The nodes of a queue item, oldest first: pre-prompts, the main stage (per iteration), follow-ups. */
function itemNodes(item: RecentPromptSourceItem, kind: QueueItemKind, lookups: RecentPromptLookups): RecentPromptNode[] {
    const nodes: RecentPromptNode[] = [];
    const last = item.lastDispatched;
    // Pre-prompts: each sent `repeatIndex` times (once when only its status says so).
    (item.prePrompts ?? []).forEach((pp, i) => {
        const n = pp.repeatIndex ?? (pp.status === 'sent' ? 1 : 0);
        for (let r = 1; r <= n; r++) {
            const isLast = r === n;
            const asSent = isLast && last?.kind === 'prePrompt' && last.prePromptIndex === i;
            nodes.push({ type: 'prompt', prompt: {
                stage: 'prePrompt',
                label: `Pre-prompt ${i + 1}${n > 1 ? ` (${r}/${n})` : ''}`,
                text: asSent ? last.expandedText : pp.text,
                expanded: asSent,
                answer: isLast ? pp.answerText ?? '' : '',
                ...(asSent ? { at: last.dispatchedAt } : {}),
            } });
        }
    });
    // The main stage: one iteration per todo walked / repetition; a walk iteration's continuations under it.
    const keys = iterationKeys(item, kind);
    const answers = new Map((item.repetitionAnswers ?? []).map((a) => [a.key, a]));
    const asIterations = kind === 'prefix' || kind === 'group' || kind === 'iteration' || keys.length > 1;
    const followUpsSent = (item.followUps ?? []).some((f) => (f.repeatIndex ?? 0) > 0);
    keys.forEach((key, idx) => {
        const isLastIteration = idx === keys.length - 1;
        const entry = answers.get(key);
        const continuations = entry?.continuations ?? 0;
        const turns = continuations + 1;
        const prompts: RecentPrompt[] = [];
        for (let t = 0; t < turns; t++) {
            const isLastTurn = t === turns - 1;
            const answer = entry
                ? (isLastTurn ? entry.text : entry.earlier?.[t] ?? '')
                : (isLastIteration && isLastTurn ? item.answerText ?? '' : '');
            const asSent = t === 0 && isLastIteration && last?.kind === 'main';
            // A continuation's text is the queue's fixed continuation prompt for the walked todo.
            const text = t > 0 ? continuationPrompt(key) : asSent ? last.expandedText : item.originalText;
            prompts.push({
                stage: t === 0 ? 'main' : 'continuation',
                label: t === 0 ? 'Main prompt' : `Continuation ${t}`,
                text,
                expanded: asSent || t > 0,
                answer,
                ...(asSent && !followUpsSent ? { at: last.dispatchedAt } : entry?.at && isLastTurn ? { at: entry.at } : {}),
            });
        }
        if (!asIterations) {
            for (const p of prompts) { nodes.push({ type: 'prompt', prompt: p }); }
            return;
        }
        const walked = kind === 'prefix' || kind === 'group' || kind === 'todo';
        const title = walked ? lookups.todoTitle?.(key) : undefined;
        nodes.push({
            type: 'iteration',
            label: walked ? `Todo ${key}${title ? ` — ${title}` : ''}` : `Repetition ${key}`,
            ...(walked ? { todoId: key } : {}),
            ...(title ? { todoTitle: title } : {}),
            prompts,
        });
    });
    // Follow-ups: each sent `repeatIndex` times.
    (item.followUps ?? []).forEach((fu, i) => {
        const n = fu.repeatIndex ?? 0;
        for (let r = 1; r <= n; r++) {
            const isLast = r === n;
            const asSent = isLast && last?.kind === 'followUp' && last.followUpIndex === i;
            nodes.push({ type: 'prompt', prompt: {
                stage: 'followUp',
                label: `Follow-up ${i + 1}${n > 1 ? ` (${r}/${n})` : ''}`,
                text: asSent ? last.expandedText : fu.originalText,
                expanded: asSent,
                answer: isLast ? fu.answerText ?? '' : '',
                ...(asSent ? { at: last.dispatchedAt } : {}),
            } });
        }
    });
    return nodes;
}

function promptsOf(node: RecentPromptNode): RecentPrompt[] {
    return node.type === 'prompt' ? [node.prompt] : node.prompts;
}

/** The number of prompts under `nodes`. */
export function countPrompts(nodes: readonly RecentPromptNode[]): number {
    return nodes.reduce((sum, n) => sum + promptsOf(n).length, 0);
}

/** `nodes` without their `drop` oldest prompts (an iteration emptied by it goes). */
function dropOldest(nodes: RecentPromptNode[], drop: number): RecentPromptNode[] {
    const out: RecentPromptNode[] = [];
    let left = drop;
    for (const node of nodes) {
        if (left <= 0) { out.push(node); continue; }
        if (node.type === 'prompt') { left--; continue; }
        if (node.prompts.length <= left) { left -= node.prompts.length; continue; }
        out.push({ ...node, prompts: node.prompts.slice(left) });
        left = 0;
    }
    return out;
}

/** The todos an item runs, for its row. */
function todosOf(item: RecentPromptSourceItem, lookups: RecentPromptLookups): Array<{ id: string; title?: string }> {
    const named = (id: string): { id: string; title?: string } => {
        const title = lookups.todoTitle?.(id);
        return title ? { id, title } : { id };
    };
    const walk = parseTodoWalk(item.repeatCount);
    if (walk) { return [walk.kind === 'prefix' ? { id: `${walk.prefix}*` } : named(walk.id)]; }
    const pattern = (item.todoIdPattern ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return pattern.map((id) => (id.endsWith('*') ? { id } : named(id)));
}

/** Whether an item is a template's "no template". */
function templateOf(template: string | undefined): string | undefined {
    const t = (template ?? '').trim();
    return t && !/^\(none\)$/i.test(t) ? t : undefined;
}

/** One row per item that sent a prompt; unsorted, uncut. */
export function recentPromptRow(item: RecentPromptSourceItem, lookups: RecentPromptLookups = {}): RecentPromptRow | undefined {
    const isChat = CHAT_STATUSES.has(item.status) || !!item.chatSource;
    // An item that never went out (staged / pending, never sent) has nothing to show.
    if (!isChat && !item.sentAt && !item.lastDispatched) { return undefined; }
    const kind = parseQueueItemKind(item.itemKind) ?? deriveQueueItemKind(item);
    const nodes = isChat ? chatPrompts(item).map((prompt): RecentPromptNode => ({ type: 'prompt', prompt })) : itemNodes(item, kind, lookups);
    const promptCount = countPrompts(nodes);
    if (promptCount === 0) { return undefined; }
    return {
        id: item.id,
        kind,
        status: item.status,
        todos: todosOf(item, lookups),
        firstLine: firstLineOf(item.originalText),
        settings: {
            run: item.run || 'default',
            ...(item.session ? { session: item.session } : {}),
            ...(item.anthropicProfileId ? { profile: lookups.profileName?.(item.anthropicProfileId) ?? item.anthropicProfileId } : {}),
            ...(item.role ? { role: item.role } : {}),
            ...(templateOf(item.template) ? { template: templateOf(item.template) } : {}),
        },
        sentAt: sentAtOf(item),
        promptCount,
        lastAnswerStart: lastAnswerStartOf(nodes),
        nodes,
    };
}

function lastAnswerStartOf(nodes: readonly RecentPromptNode[]): string {
    const all = nodes.flatMap(promptsOf);
    for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].answer.trim()) { return answerStart(all[i].answer); }
    }
    return '';
}

/**
 * The rows of the last prompts sent, newest item first, at most `limit`
 * prompts: the row crossing the limit keeps its newest prompts.
 */
export function collectRecentPrompts(
    items: readonly RecentPromptSourceItem[],
    lookups: RecentPromptLookups = {},
    limit = RECENT_PROMPTS_LIMIT,
): { rows: RecentPromptRow[]; promptCount: number; truncated: boolean } {
    const rows = items
        .map((item) => recentPromptRow(item, lookups))
        .filter((r): r is RecentPromptRow => !!r)
        .sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));
    const out: RecentPromptRow[] = [];
    let total = 0;
    let truncated = false;
    for (const row of rows) {
        if (total >= limit) { truncated = true; break; }
        const room = limit - total;
        if (row.promptCount > room) {
            const nodes = dropOldest(row.nodes, row.promptCount - room);
            out.push({ ...row, nodes, promptCount: room, lastAnswerStart: lastAnswerStartOf(nodes) });
            total = limit;
            truncated = true;
            continue;
        }
        out.push(row);
        total += row.promptCount;
    }
    if (out.length < rows.length) { truncated = true; }
    return { rows: out, promptCount: total, truncated };
}
