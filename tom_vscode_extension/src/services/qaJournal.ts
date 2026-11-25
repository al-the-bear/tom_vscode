/**
 * This window's writer and reader of the Q&A journal (utils/qaJournal.ts):
 * `_ai/quests/<quest>/qa.<host>.<quest>.md`, `<host>` this machine's
 * {@link hostSlugOf}.
 *
 * - {@link appendQuestionAsked}: a question as it is asked (the ask tools);
 * - {@link appendQuestionLogEntry}: the exchange as it resolves — the answer
 *   block naming the question written when it was asked, or, for a path that
 *   wrote nothing when it asked (the intercepted `AskUserQuestion`, a message
 *   into a running turn), the question and its answer together;
 * - {@link appendAnswerGiven}: an answer of tomAi_answerUser;
 * - {@link appendProcessDecision}: a process decision.
 *
 * The asking session, run and queue item come from the call's context when
 * the entry does not name them. Writing is best-effort: an ask blocks a
 * running prompt, and a journal that could fail the prompt it was recording
 * would be worse than no journal.
 *
 * {@link readQaItems} reads every host's journal of a quest and, old place,
 * an existing `questions.<quest>.md` (read-only, entries of unknown host).
 */

import * as fs from 'fs';
import * as path from 'path';

import { WsPaths } from '../utils/workspacePaths';
import { hostSlugOf } from '../utils/hostSlug';
import {
    appendQaBlocks, combineQaBlocks, newQaId, processDecisionBlock, qaJournalHasBlock, readQaBlocks, sortQaItems,
    type QaBlock, type QaItem,
} from '../utils/qaJournal';
import { parseLegacyQuestionsJournal, type QuestionAskedEntry, type QuestionLogEntry } from '../utils/questionsLogFormat';
import type { UserAnswer } from '../utils/userAnswers';
import { currentInteractionRun, currentQueueItemId } from './userWaits';
import { getActiveToolTrail } from './tool-trail';

/** Where a write goes: the quest (default the window's), its folder (default under `_ai/quests/`), the host (default this machine's). */
export interface QaTarget {
    quest?: string;
    questFolder?: string;
    host?: string;
}

function resolveTarget(t: QaTarget = {}): { quest: string; folder: string; host: string } | undefined {
    const quest = t.quest || WsPaths.getWorkspaceQuestId();
    const folder = t.questFolder ?? WsPaths.ai('quests', quest);
    if (!quest || !folder) { return undefined; }
    return { quest, folder, host: t.host || hostSlugOf() };
}

/** The session, run and queue item of the calling turn. */
function callContext(): { session?: string; run: string; queueItemId?: string } {
    let session: string | undefined;
    try { session = getActiveToolTrail()?.session || undefined; } catch { session = undefined; }
    const queueItemId = currentQueueItemId();
    return { ...(session ? { session } : {}), run: currentInteractionRun(), ...(queueItemId ? { queueItemId } : {}) };
}

const iso = (ms: number): string => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();

/** The question block's id of an ask's request id. */
export function questionBlockId(requestId: string): string {
    return `q-${requestId}`;
}

function write(target: QaTarget | undefined, blocks: (host: string) => QaBlock[]): string | undefined {
    try {
        const t = resolveTarget(target);
        if (!t) { return undefined; }
        return appendQaBlocks(t.folder, t.quest, t.host, blocks(t.host));
    } catch {
        return undefined; // Best-effort — never fail the prompt over its own journal.
    }
}

/** A question as it is asked. */
export function appendQuestionAsked(entry: QuestionAskedEntry, target?: QaTarget): void {
    const ctx = callContext();
    write(target, (host) => [{
        id: questionBlockId(entry.requestId),
        kind: 'question',
        time: iso(entry.askedAt),
        host,
        session: entry.session ?? ctx.session,
        run: entry.run ?? ctx.run,
        queueItemId: entry.queueItemId ?? ctx.queueItemId,
        tool: entry.tool,
        ...(entry.title ? { title: entry.title } : {}),
        questions: [...entry.questions],
        ...(entry.choices?.length ? { choices: [...entry.choices] } : {}),
    }]);
}

/**
 * A resolved exchange: the answer block, naming the question written when it
 * was asked; without one, the question block and the answer block together.
 */
export function appendQuestionLogEntry(entry: QuestionLogEntry, target?: QaTarget): void {
    const t = resolveTarget(target);
    if (!t) { return; }
    const ctx = callContext();
    const run = entry.run ?? ctx.run;
    const asked = entry.requestId ? questionBlockId(entry.requestId) : undefined;
    const known = asked ? qaJournalHasBlock(t.folder, t.quest, t.host, asked) : false;
    write({ ...t, questFolder: t.folder }, (host) => {
        const questionId = asked ?? newQaId('q', new Date(entry.askedAt));
        const blocks: QaBlock[] = [];
        if (!known) {
            blocks.push({
                id: questionId,
                kind: 'question',
                time: iso(entry.askedAt),
                host,
                session: entry.session ?? ctx.session,
                run,
                queueItemId: entry.queueItemId ?? ctx.queueItemId,
                tool: entry.tool,
                ...(entry.title ? { title: entry.title } : {}),
                questions: [...entry.questions],
                ...(entry.choices?.length ? { choices: [...entry.choices] } : {}),
            });
        }
        blocks.push({
            id: newQaId('a', new Date(entry.answeredAt)),
            kind: 'answer',
            time: iso(entry.answeredAt),
            host,
            run,
            tool: entry.tool,
            ...(entry.title ? { title: entry.title } : {}),
            questionId,
            source: entry.source,
            answer: entry.answer,
        });
        return blocks;
    });
}

/** An answer of tomAi_answerUser. */
export function appendAnswerGiven(a: UserAnswer, target?: QaTarget): void {
    write({ quest: a.quest, ...target }, (host) => [{
        id: newQaId('g', new Date(a.at)),
        kind: 'answerGiven',
        time: a.at,
        host,
        ...(a.session ? { session: a.session } : {}),
        run: a.run,
        ...(a.queueItemId ? { queueItemId: a.queueItemId } : {}),
        tool: 'tomAi_answerUser',
        title: a.title,
        answerId: a.id,
        ...(a.question ? { userQuestion: a.question } : {}),
        answer: a.answer,
        suggestedPrompts: a.suggestedPrompts.map((p) => p.label),
        suggestedTodos: a.suggestedTodos.map((s) => `${String(s.todo.id)}${typeof s.todo.title === 'string' && s.todo.title ? ` — ${s.todo.title}` : ''}`),
    }]);
}

/**
 * A process decision, from its entry as the process code formats it (`## <ISO
 * time> — <what was decided>` and its bullets).
 */
export function appendProcessDecision(entry: string, opts: QaTarget & { run?: string } = {}): void {
    write(opts, (host) => [processDecisionBlock(entry, { host, ...(opts.run ? { run: opts.run } : {}) })]);
}

/** Old place: the quest's single questions journal, read by the Q&A page until the format migration removes it. */
export function legacyQuestionsJournalPath(questFolder: string, quest: string): string {
    return path.join(questFolder, `questions.${quest}.md`);
}

/**
 * The combined journal of quest `quest` (folder `questFolder`): every host's
 * blocks and the entries of an old questions journal, oldest first.
 */
export function readQaItems(questFolder: string, quest: string): QaItem[] {
    const items = combineQaBlocks(readQaBlocks(questFolder, quest));
    let legacy: QaItem[] = [];
    try {
        const file = legacyQuestionsJournalPath(questFolder, quest);
        if (fs.existsSync(file)) { legacy = parseLegacyQuestionsJournal(fs.readFileSync(file, 'utf-8')); }
    } catch { legacy = []; }
    return sortQaItems([...legacy, ...items].map((i) => ({ ...i, quest })));
}
