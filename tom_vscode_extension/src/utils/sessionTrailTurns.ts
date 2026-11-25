/**
 * The @CHAT Logs section's **Trail** tab: one session's prompt/answer turns on
 * this machine, newest first, each shown as a pair (the prompt, then its
 * answer) under its header (time, profile, model) with its actions.
 *
 * The turns are the session's view of this host's trail
 * `_ai/quests/<quest>/history/trail.<host>.md` (src/services/hostTrail.ts,
 * {@link sessionView}); other hosts' trails are not read. OLD PLACE (until the
 * `_ai` format migration): the session's summary trail pair of an older build
 * (`history/sessions/<session>/<quest>.anthropic.{prompts,answers}.md`) adds
 * its turns older than the host trail's oldest turn, merged by request id
 * without duplicates ({@link keepOlderPairAnswer}, the rule the other readers
 * of prompt/answer pairs follow).
 *
 * The shaping ({@link sessionTrailTurns}) and the HTML ({@link renderSessionTrailHtml})
 * are pure; {@link readOlderSessionPairs} reads the old pair files.
 */

import { sessionView, type HostTrailTurn } from '../services/hostTrail';
import { sessionSummaryFile } from '../services/sessionStorage';
import { pairPromptsAndAnswers, readTrailFile } from '../tools/prompt-history-utils';
import { highlightMarkdownSource } from './markdownSourceHighlight';
import { extractTodoResponseValues } from './responseValues';
import { keepOlderPairAnswer } from './todoLogTrailSets';

/** One turn of a session as the Trail tab shows it. */
export interface SessionTrailTurn {
    /** The request id the prompt was sent with. */
    id: string;
    /** ISO time the prompt was sent. */
    time: string;
    profile: string;
    model: string;
    prompt: string;
    answer: string;
    /** OLD PLACE: the turn comes from the session's summary pair of an older build. */
    olderBuild: boolean;
    /** The todo references of its answer (its `TODO*` response values), in order, without duplicates. */
    todoRefs: string[];
}

/** OLD PLACE: one turn of a session's summary trail pair of an older build. */
export interface OlderSessionPair {
    requestId: string;
    timestamp: string;
    prompt: string;
    answer: string;
}

/** The newest turns the tab renders; older ones are reached through *Open in editor*. */
export const MAX_TRAIL_TURNS_SHOWN = 200;

function todoRefsOf(answer: string): string[] {
    return [...new Set(Object.values(extractTodoResponseValues(answer)).map((v) => v.trim()).filter((v) => v))];
}

/**
 * The turns of `session`, newest first: its view of this host's trail
 * (`hostTurns`, the whole trail of this host), plus the older build's pairs
 * (`olderPairs`) the host trail does not have and that are older than its
 * oldest turn.
 */
export function sessionTrailTurns(
    hostTurns: readonly HostTrailTurn[],
    session: string,
    olderPairs: readonly OlderSessionPair[] = [],
): SessionTrailTurn[] {
    const out: SessionTrailTurn[] = sessionView(hostTurns, session).map((t) => ({
        id: t.id,
        time: t.time,
        profile: t.profile,
        model: t.model,
        prompt: t.prompt,
        answer: t.answer,
        olderBuild: false,
        todoRefs: todoRefsOf(t.answer),
    }));
    const seen = new Set<string>();
    for (const p of olderPairs) {
        // OLD PLACE: the merge rule of the readers of prompt/answer pairs.
        if (seen.has(p.requestId) || !keepOlderPairAnswer(p.requestId, p.timestamp, hostTurns)) { continue; }
        seen.add(p.requestId);
        out.push({
            id: p.requestId, time: p.timestamp, profile: '', model: '',
            prompt: p.prompt, answer: p.answer, olderBuild: true, todoRefs: todoRefsOf(p.answer),
        });
    }
    // Newest first; the trail's own order keeps turns of the same time in place (the sort is stable).
    return out.map((t, i) => ({ t, i })).sort((a, b) => {
        if (a.t.time !== b.t.time) { return b.t.time.localeCompare(a.t.time); }
        return b.i - a.i;
    }).map((x) => x.t);
}

/** OLD PLACE: the summary pair files of `session` (`history/sessions/<session>/`), read only. */
export function olderSessionPairFiles(historyRoot: string, quest: string, session: string): { prompts: string; answers: string } {
    return {
        prompts: sessionSummaryFile(historyRoot, session, quest, 'anthropic', 'prompts'),
        answers: sessionSummaryFile(historyRoot, session, quest, 'anthropic', 'answers'),
    };
}

/** OLD PLACE: the turns of `session`'s summary pair of an older build; [] when it has none. */
export function readOlderSessionPairs(historyRoot: string, quest: string, session: string): OlderSessionPair[] {
    const files = olderSessionPairFiles(historyRoot, quest, session);
    const prompts = readTrailFile(files.prompts);
    if (prompts.length === 0) { return []; }
    const answers = readTrailFile(files.answers);
    const answerById = new Map<string, string>();
    for (const a of answers) { if (!answerById.has(a.requestId)) { answerById.set(a.requestId, a.body); } }
    const promptById = new Map<string, string>();
    for (const p of prompts) { if (!promptById.has(p.requestId)) { promptById.set(p.requestId, p.body); } }
    return pairPromptsAndAnswers(prompts, answers, `anthropic:${session}`, quest, 0).map((p) => ({
        requestId: p.requestId,
        timestamp: p.timestamp,
        prompt: promptById.get(p.requestId) ?? '',
        answer: answerById.get(p.requestId) ?? '',
    }));
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/** The last segment of a todo reference (`_ai/quests/<q>/<file>/<id>` → `<id>`). */
function todoLabel(ref: string): string {
    const i = ref.lastIndexOf('/');
    return i >= 0 ? ref.slice(i + 1) : ref;
}

/** The pair's text as Markdown, for the Markdown overlay. */
export function sessionTrailTurnMarkdown(turn: Pick<SessionTrailTurn, 'prompt' | 'answer'>): string {
    return `## Prompt\n\n${turn.prompt}\n\n## Answer\n\n${turn.answer || '_(no answer)_'}`;
}

/** The pair's title, for the Markdown overlay: its time, profile and model. */
export function sessionTrailTurnTitle(turn: Pick<SessionTrailTurn, 'time' | 'profile' | 'model'>): string {
    return [turn.time, turn.profile, turn.model].filter((x) => x).join(' · ');
}

/** The per-pair action buttons: `data-qlog-turn-action` and the codicon / title of each. */
export const TRAIL_TURN_ACTIONS: ReadonlyArray<{ id: string; icon: string; title: string }> = [
    { id: 'copyPrompt', icon: 'copy', title: 'Copy the prompt' },
    { id: 'copyAnswer', icon: 'clippy', title: 'Copy the answer' },
    { id: 'markdown', icon: 'preview', title: 'Prompt and answer rendered as Markdown' },
    { id: 'open', icon: 'go-to-file', title: 'Open the turn in its trail file' },
];

/**
 * The Trail tab's HTML: one block per turn, newest first, at most
 * `maxShown` of them. Every text is escaped; the prompt and the answer are
 * shown as highlighted Markdown source.
 */
export function renderSessionTrailHtml(session: string, turns: readonly SessionTrailTurn[], maxShown: number = MAX_TRAIL_TURNS_SHOWN): string {
    if (turns.length === 0) {
        return `<div class="qlog-empty">Session "${escapeHtml(session)}" has no turns on this machine yet.</div>`;
    }
    const shown = turns.slice(0, Math.max(1, maxShown));
    const parts: string[] = [];
    parts.push(`<div class="qlog-turns-head">${turns.length} turn${turns.length === 1 ? '' : 's'} of session ${escapeHtml(session)} on this machine, newest first`
        + (shown.length < turns.length ? ` (the newest ${shown.length} shown; Open in editor has them all)` : '') + '</div>');
    for (const t of shown) {
        const id = escapeHtml(t.id);
        const meta = [
            `<span class="qlog-turn-time">${escapeHtml(t.time)}</span>`,
            t.profile ? `<span class="qlog-turn-profile" title="Profile">${escapeHtml(t.profile)}</span>` : '',
            t.model ? `<span class="qlog-turn-model" title="Model">${escapeHtml(t.model)}</span>` : '',
            t.olderBuild ? '<span class="qlog-turn-tag" title="From the session\'s summary trail of an older build">older build</span>' : '',
        ].filter((x) => x).join('<span class="qlog-turn-sep"> · </span>');
        const actions = TRAIL_TURN_ACTIONS.map((a) =>
            `<button class="icon-btn" data-qlog-turn-action="${a.id}" data-qlog-turn="${id}" title="${escapeHtml(a.title)}"><span class="codicon codicon-${a.icon}"></span></button>`,
        ).join('');
        const todos = t.todoRefs.length === 0 ? '' : '<div class="qlog-turn-todos">'
            + t.todoRefs.map((r) => `<a href="#" class="qlog-turn-todo" data-qlog-todo="${escapeHtml(r)}" title="Open the todo ${escapeHtml(r)}"><span class="codicon codicon-tasklist"></span>${escapeHtml(todoLabel(r))}</a>`).join('')
            + '</div>';
        parts.push(
            `<div class="qlog-turn" data-qlog-turn="${id}">`
            + `<div class="qlog-turn-header"><span class="qlog-turn-meta">${meta}</span><span class="qlog-turn-actions">${actions}</span></div>`
            + '<div class="qlog-turn-label">Prompt</div>'
            + `<pre class="qlog-source qlog-turn-prompt">${highlightMarkdownSource(t.prompt)}</pre>`
            + '<div class="qlog-turn-label">Answer</div>'
            + (t.answer ? `<pre class="qlog-source qlog-turn-answer">${highlightMarkdownSource(t.answer)}</pre>` : '<div class="qlog-empty qlog-turn-answer">(no answer)</div>')
            + todos
            + '</div>',
        );
    }
    return parts.join('\n');
}
