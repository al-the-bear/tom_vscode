/**
 * Choices in a question (tomAi_askUser, and the Agent SDK's intercepted
 * AskUserQuestion): buttons the agent places at a `{{choice:<id>}}` marker in
 * a question's text, or under a question when its text has no marker.
 *
 * A choice is a plain answer, a move in the quest's current process, or a
 * branch / subprocess of the current step. Decisions are the user's, so a
 * move is made by the extension on the click (as the PROCESS view makes one)
 * and the agent is told what was moved. Only positions of the current process
 * and the step's closed `branches:` / `subprocesses:` lists may be offered;
 * anything else is refused when the ask is made, before anything is shown.
 *
 * vscode-free: the process definition and state come in as arguments.
 */

import { positionProcessLists } from './processStack';
import {
    findPhase, findStep, findSubstep,
    type ProcessChange, type ProcessDefinition, type ProcessState,
} from './processDefinition';

export const ASK_CHOICE_KINDS = ['answer', 'move', 'branch', 'subprocess'] as const;
export type AskChoiceKind = typeof ASK_CHOICE_KINDS[number];

/** At most this many choices in one ask. */
export const MAX_ASK_CHOICES = 20;

export interface AskChoice {
    /** Letters, digits, `_` and `-`; what the `{{choice:<id>}}` marker names. */
    id: string;
    label: string;
    kind: AskChoiceKind;
    /**
     * answer: the text the click answers (default the label); move: the
     * position — `step`, `phase/step` or `phase/step/substep` of the current
     * process; branch / subprocess: an entry of the step's list.
     */
    target?: string;
    /** The question (1-based) a choice without a marker goes under; default the last one. */
    question?: number;
}

/** What a choice is checked against: the quest's process and where it is. */
export interface ChoiceContext {
    def: ProcessDefinition | null;
    state: ProcessState;
}

/** A question's text cut at its markers, and the choices that go under it. */
export interface QuestionLayout {
    segments: Array<{ text: string } | { choiceId: string }>;
    below: string[];
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const MARKER = /\{\{choice:([^}]*)\}\}/g;

/** The ids the markers of `text` name, in order. */
export function choiceMarkers(text: string): string[] {
    return [...text.matchAll(MARKER)].map((m) => m[1].trim());
}

/**
 * A move's target as a change of the current process: `step` (searched in
 * the current phase first, then in every phase — it must be unique there),
 * `phase/step`, or `phase/step/substep`. A string is the reason it is refused.
 */
export function resolveMoveTarget(def: ProcessDefinition, state: ProcessState, target: string): ProcessChange | string {
    const parts = target.split('/').map((p) => p.trim());
    if (parts.length > 3 || parts.some((p) => p === '')) {
        return `"${target}" is no position: write \`step\`, \`phase/step\` or \`phase/step/substep\``;
    }
    let phaseId: string;
    let stepId: string;
    let subId = '';
    if (parts.length === 1) {
        stepId = parts[0];
        const here = findPhase(def, state.phase);
        if (here && findStep(here, stepId)) {
            phaseId = here.id;
        } else {
            const holders = def.phases.filter((p) => findStep(p, stepId));
            if (holders.length === 0) { return `process "${def.id}" has no step "${stepId}"`; }
            if (holders.length > 1) { return `step "${stepId}" is in several phases (${holders.map((p) => p.id).join(', ')}); write \`phase/step\``; }
            phaseId = holders[0].id;
        }
    } else {
        [phaseId, stepId, subId = ''] = parts;
    }
    const phase = findPhase(def, phaseId);
    if (!phase) { return `process "${def.id}" has no phase "${phaseId}"`; }
    const step = findStep(phase, stepId);
    if (!step) { return `phase "${phaseId}" has no step "${stepId}"`; }
    if (subId && !findSubstep(step, subId)) { return `step "${stepId}" has no sub-step "${subId}"`; }
    return { phase: phaseId, step: stepId, ...(subId ? { substep: subId } : {}) };
}

/**
 * The current position's closed lists (processStack.positionProcessLists): the
 * processes it may branch into (`branches:`, nothing handed back) and start as
 * subprocesses (`subprocesses:`, a result handed back).
 */
export function stepChoiceLists(def: ProcessDefinition | null, state: ProcessState): { step: string; branches: string[]; subprocesses: string[] } {
    const lists = positionProcessLists(def, state);
    return { step: state.step, branches: lists.branches.map((e) => e.process), subprocesses: lists.subprocesses.map((e) => e.process) };
}

/**
 * The choices of an ask, checked: ids, labels, kinds, the markers in the
 * questions, and that every move, branch and subprocess is one the process
 * allows here. Nothing is shown when one is refused.
 */
export function validateChoices(raw: unknown, questions: string[], context: () => ChoiceContext): { ok: true; choices: AskChoice[] } | { ok: false; error: string } {
    const markers = questions.flatMap(choiceMarkers);
    if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
        return markers.length ? { ok: false, error: `the questions name choices (${markers.join(', ')}) but \`choices\` is empty` } : { ok: true, choices: [] };
    }
    if (!Array.isArray(raw)) { return { ok: false, error: '`choices` must be an array of {id, label, kind, target?}' }; }
    if (raw.length > MAX_ASK_CHOICES) { return { ok: false, error: `too many choices (${raw.length}); the maximum is ${MAX_ASK_CHOICES}` }; }
    const choices: AskChoice[] = [];
    let ctx: ChoiceContext | undefined;
    for (const [i, item] of raw.entries()) {
        const c = (item ?? {}) as Record<string, unknown>;
        const id = String(c.id ?? '').trim();
        const label = String(c.label ?? '').trim();
        const kind = String(c.kind ?? 'answer') as AskChoiceKind;
        const target = typeof c.target === 'string' ? c.target.trim() : undefined;
        const name = id ? `choice "${id}"` : `choice ${i + 1}`;
        if (!ID.test(id)) { return { ok: false, error: `${name}: \`id\` must be 1–40 letters, digits, "_" or "-"` }; }
        if (choices.some((x) => x.id === id)) { return { ok: false, error: `${name}: the id is used twice` }; }
        if (!label) { return { ok: false, error: `${name}: \`label\` is empty` }; }
        if (!ASK_CHOICE_KINDS.includes(kind)) { return { ok: false, error: `${name}: \`kind\` must be one of ${ASK_CHOICE_KINDS.join(', ')}` }; }
        let question: number | undefined;
        if (c.question !== undefined) {
            question = Number(c.question);
            if (!Number.isInteger(question) || question < 1 || question > questions.length) {
                return { ok: false, error: `${name}: \`question\` must be a question number from 1 to ${questions.length}` };
            }
        }
        if (kind !== 'answer') {
            ctx ??= context();
            if (!ctx.def || !ctx.state.process) { return { ok: false, error: `${name}: a ${kind} needs a process, and the quest has none set` }; }
            if (!target) { return { ok: false, error: `${name}: a ${kind} needs a \`target\`` }; }
            if (kind === 'move') {
                const change = resolveMoveTarget(ctx.def, ctx.state, target);
                if (typeof change === 'string') { return { ok: false, error: `${name}: ${change}` }; }
            } else {
                const lists = stepChoiceLists(ctx.def, ctx.state);
                const allowed = kind === 'branch' ? lists.branches : lists.subprocesses;
                const listName = kind === 'branch' ? 'branches' : 'subprocesses';
                if (!allowed.includes(target)) {
                    return {
                        ok: false,
                        error: allowed.length
                            ? `${name}: "${target}" is not among the ${listName} of step "${lists.step}" (${allowed.join(', ')})`
                            : `${name}: step "${lists.step}" lists no ${listName}`,
                    };
                }
            }
        }
        choices.push({ id, label, kind, ...(target ? { target } : {}), ...(question ? { question } : {}) });
    }
    const unknown = markers.filter((m) => !choices.some((c) => c.id === m));
    if (unknown.length) { return { ok: false, error: `the questions name choices that are not in \`choices\`: ${unknown.join(', ')}` }; }
    return { ok: true, choices };
}

/**
 * Where each choice is shown: at its marker (cut out of the question's text),
 * or under its question — `question`, else the last — when no marker names
 * it. A choice whose marker is in a question shows there only.
 */
export function layoutChoices(questions: string[], choices: AskChoice[]): QuestionLayout[] {
    const marked = new Set(questions.flatMap(choiceMarkers));
    return questions.map((q, i) => {
        const segments: QuestionLayout['segments'] = [];
        let at = 0;
        for (const m of q.matchAll(MARKER)) {
            if (m.index! > at) { segments.push({ text: q.slice(at, m.index) }); }
            segments.push({ choiceId: m[1].trim() });
            at = m.index! + m[0].length;
        }
        if (at < q.length) { segments.push({ text: q.slice(at) }); }
        const below = choices
            .filter((c) => !marked.has(c.id) && (c.question ?? questions.length) === i + 1)
            .map((c) => c.id);
        return { segments, below };
    });
}

/** A question as plain text: each marker replaced by its choice's label in brackets (Telegram, the journal). */
export function questionText(question: string, choices: AskChoice[]): string {
    return question.replace(MARKER, (all, id: string) => {
        const c = choices.find((x) => x.id === id.trim());
        return c ? `[${c.label}]` : all;
    });
}

/** What a move did, as the click's handler reports it. */
export interface MoveOutcome {
    ok: boolean;
    /** Where the process is now (a readable position). */
    where?: string;
    error?: string;
}

/** What a clicked branch / subprocess choice started: the level, or why nothing started. */
export interface StartOutcome {
    ok: boolean;
    /** The level started, e.g. "the subprocess team_review". */
    started?: string;
    /** What the step does when the level ends (its label). */
    followUp?: string;
    /** The inputs it started with. */
    inputs?: Record<string, string>;
    error?: string;
    /** The user cancelled (no follow-up chosen, the depth confirmation declined). */
    cancelled?: boolean;
}

/** The answer the agent receives for a click on `choice`. */
/** The id of the choice a reply of {@link choiceAnswer} reports clicked; undefined for a typed reply. */
export function clickedChoiceId(reply: string): string | undefined {
    return /^The user clicked the choice ".*" \(id ([\w-]+), [a-z]+\)\./s.exec(reply.trim())?.[1];
}

export function choiceAnswer(choice: AskChoice, move?: MoveOutcome, start?: StartOutcome): string {
    const head = `The user clicked the choice "${choice.label}" (id ${choice.id}, ${choice.kind}).`;
    switch (choice.kind) {
        case 'answer':
            return choice.target ? `${head} Answer: ${choice.target}` : head;
        case 'move':
            return move?.ok
                ? `${head} The extension moved the process to ${move.where ?? choice.target}; do not move it yourself.`
                : `${head} The move to ${choice.target} failed: ${move?.error ?? 'unknown error'}. The process was not moved.`;
        default: {
            // A branch or subprocess the step lists: the extension starts it on the click (choiceClickAnswerAsync).
            if (!start) { return `${head} Starting a ${choice.kind} from this question is not available here; nothing was started.`; }
            if (!start.ok) {
                return start.cancelled
                    ? `${head} Starting ${choice.target} was cancelled: ${start.error ?? 'the user did not confirm'}. Nothing was started.`
                    : `${head} Starting ${choice.target} failed: ${start.error ?? 'unknown error'}. Nothing was started.`;
            }
            const inputs = Object.entries(start.inputs ?? {});
            return `${head} The extension started ${start.started ?? `the ${choice.kind} ${choice.target}`} on the quest's process stack`
                + `${inputs.length ? `, with the inputs ${inputs.map(([n, v]) => `${n} = ${v}`).join(', ')}` : ''}.`
                + ` The step waits until it ends, then: ${start.followUp ?? 'the decision Go on / Run the step again'}.`
                + ' Do not move the process yourself; the new level runs once you end this turn.';
        }
    }
}

// ── Answers sent together (Send answers) ──────────────────────────────────────

/** One question's answer as the panel sends it: the `answer` choice selected for it and the user's own words. */
export interface QuestionAnswer {
    choiceId?: string;
    text?: string;
}

/** The question (0-based) each choice is shown with: its marker's question, else the one it is placed under. */
export function choiceQuestionIndex(questions: string[], choices: AskChoice[]): Map<string, number> {
    const at = new Map<string, number>();
    layoutChoices(questions, choices).forEach((place, i) => {
        for (const seg of place.segments) { if ('choiceId' in seg && !at.has(seg.choiceId)) { at.set(seg.choiceId, i); } }
        for (const id of place.below) { if (!at.has(id)) { at.set(id, i); } }
    });
    return at;
}

/**
 * The reply of a question panel whose `answer` choices select (vscimpb35):
 * every question numbered as asked, with the choice selected for it (its
 * label and id, and its `target` when that differs) and the user's own words for it,
 * then the general text. A choice that is no `answer` choice of that question
 * is ignored (a stale or forged id); a question with neither says so.
 */
export function composeChoiceAnswers(questions: string[], choices: AskChoice[], answers: QuestionAnswer[], general: string): string {
    const where = choiceQuestionIndex(questions, choices);
    const lines = ['The answers, numbered like the questions:'];
    questions.forEach((_q, i) => {
        const a = answers[i] ?? {};
        const choice = a.choiceId !== undefined
            ? choices.find((c) => c.id === a.choiceId && c.kind === 'answer' && where.get(c.id) === i)
            : undefined;
        const text = typeof a.text === 'string' ? a.text.trim() : '';
        const parts: string[] = [];
        if (choice) {
            const target = choice.target && choice.target !== choice.label ? `, answer: ${choice.target}` : '';
            parts.push(`chose "${choice.label}" (id ${choice.id}${target})`);
        }
        if (text) { parts.push(choice ? `and wrote: ${text}` : text); }
        lines.push(`${i + 1}. ${parts.length ? parts.join(' ') : '(no answer)'}`);
    });
    const rest = general.trim();
    if (rest) { lines.push('', rest); }
    return lines.join('\n');
}

/** The header of a {@link composeChoiceAnswers} reply. */
const ANSWERS_HEAD = 'The answers, numbered like the questions:';

/**
 * A one-question reply read back, whatever answered it: a Send-answers reply
 * ({@link composeChoiceAnswers}: the choice selected and the user's words, the
 * general text after them), a click on a choice that acts at once
 * ({@link choiceAnswer}), or text typed anywhere (the panel without choices,
 * Telegram). `text` is the user's own words, '' when none.
 */
export function readSingleAnswer(reply: string): { choiceId?: string; text: string } {
    const trimmed = reply.trim();
    const clicked = clickedChoiceId(trimmed);
    if (clicked !== undefined) { return { choiceId: clicked, text: '' }; }
    if (!trimmed.startsWith(ANSWERS_HEAD)) { return { text: trimmed }; }
    const body = trimmed.slice(ANSWERS_HEAD.length).replace(/^\n/, '');
    const blank = body.indexOf('\n\n');
    const first = (blank < 0 ? body : body.slice(0, blank)).replace(/^1\. /, '');
    const general = blank < 0 ? '' : body.slice(blank + 2).trim();
    const chose = /^chose ".*?" \(id ([\w-]+)(?:, answer: [^)]*)?\)(?: and wrote: ([\s\S]*))?$/.exec(first);
    const own = chose ? (chose[2] ?? '') : first === '(no answer)' ? '' : first;
    const text = [own.trim(), general].filter(Boolean).join('\n\n');
    return chose ? { choiceId: chose[1], text } : { text };
}
