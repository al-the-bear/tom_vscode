/**
 * The host's compact trail of a quest: `_ai/quests/<quest>/history/trail.<host>.md`,
 * one block per prompt/answer turn of every session of this host whose
 * setting `contributesToTrailAndMemory` is on (src/utils/agentSdkSessions.ts),
 * oldest first. A turn is the prompt as the user (or the queue) sent it and the
 * turn's final answer — no inner steps, no tool calls. A session's trail is a
 * view of it ({@link sessionView}). It is the source of the quest's history and
 * memory; each host writes only its own file.
 *
 * The block format:
 *
 *     <!--tom-trail-turn {"id":"…","time":"…","host":"…","session":"…","profile":"…","model":"…"}-->
 *     ### 2026-11-25T10:00:00.000Z · <session> · <model>
 *     <!--tom-trail-prompt-->
 *     the prompt, line by line
 *     <!--tom-trail-answer-->
 *     the final answer, line by line
 *     <!--tom-trail-end-->
 *
 * The marker lines are the structure; the `###` line is for a reader and is
 * not part of the turn. A line of the prompt or the answer that starts with
 * `<!--tom-trail-` (after any number of backslashes) is written with one more
 * leading backslash and read back with one less, so no text — Markdown
 * headings, fenced code, a quoted block of this very format — can be taken
 * for a marker.
 *
 * The limit `trail.compact.maxEntries` counts the file's turns; over it, the
 * oldest turns are removed, but only those the quest's history covers
 * (`history/history.watermark.json`: a turn of a host is covered when its time
 * is at or before the host's time there). Without a watermark nothing is
 * removed (src/utils/compactTrailTrim.ts).
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import { hostTrailTurnsToKeep } from '../utils/compactTrailTrim';
import { canonicalSessionName } from '../utils/runSessions';

/** One prompt/answer turn of the host trail. */
export interface HostTrailTurn {
    /** The request id the prompt was sent with (unique per turn). */
    id: string;
    /** ISO time the prompt was sent. */
    time: string;
    host: string;
    session: string;
    profile: string;
    model: string;
    prompt: string;
    answer: string;
}

/** The marker every structure line starts with. */
const MARK = '<!--tom-trail-';
const TURN_PREFIX = `${MARK}turn `;
const PROMPT_LINE = `${MARK}prompt-->`;
const ANSWER_LINE = `${MARK}answer-->`;
const END_LINE = `${MARK}end-->`;
/** A text line that would read as a marker (after any number of escaping backslashes). */
const ESCAPED = /^(\\*)<!--tom-trail-/;

/** The file name of `host`'s trail. */
export function hostTrailFileName(host: string): string {
    return `trail.${host}.md`;
}

/** `host`'s trail of the quest in `questFolder` (`<questFolder>/history/trail.<host>.md`). */
export function hostTrailFile(questFolder: string, host: string): string {
    return path.join(questFolder, 'history', hostTrailFileName(host));
}

/** The quest's history watermark file (written by the history build). */
export function historyWatermarkFile(questFolder: string): string {
    return path.join(questFolder, 'history', 'history.watermark.json');
}

function escapeLines(text: string): string {
    return text.split('\n').map((l) => (ESCAPED.test(l) ? `\\${l}` : l)).join('\n');
}

function unescapeLine(line: string): string {
    return ESCAPED.test(line) && line.startsWith('\\') ? line.slice(1) : line;
}

/** One turn as its block, ending in a newline, with a blank line after it. */
export function formatHostTrailTurn(turn: HostTrailTurn): string {
    const head = {
        id: turn.id,
        time: turn.time,
        host: turn.host,
        session: turn.session,
        profile: turn.profile,
        model: turn.model,
    };
    // `--` cannot end the comment early: JSON escapes nothing of it, so it is written as `--`.
    const json = JSON.stringify(head).replace(/--/g, '-\\u002d');
    const title = [turn.time, turn.session, turn.model].filter((x) => x).join(' · ');
    return [
        `${TURN_PREFIX}${json}-->`,
        `### ${title.replace(/\n/g, ' ')}`,
        PROMPT_LINE,
        escapeLines(turn.prompt),
        ANSWER_LINE,
        escapeLines(turn.answer),
        END_LINE,
        '',
        '',
    ].join('\n');
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

/**
 * The turns of a host trail text, in file order (oldest first). A block that
 * is not complete (no end marker, a header that does not read) is skipped;
 * text outside the blocks is ignored.
 */
export function parseHostTrail(text: string): HostTrailTurn[] {
    const turns: HostTrailTurn[] = [];
    if (!text) { return turns; }
    const lines = text.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.startsWith(TURN_PREFIX) || !line.endsWith('-->')) { i++; continue; }
        let head: Record<string, unknown>;
        try {
            head = JSON.parse(line.slice(TURN_PREFIX.length, -'-->'.length)) as Record<string, unknown>;
        } catch { i++; continue; }
        // The structure lines after the header; the first non-marker lines before the prompt marker are the title.
        let j = i + 1;
        while (j < lines.length && lines[j] !== PROMPT_LINE && !lines[j].startsWith(TURN_PREFIX)) { j++; }
        if (lines[j] !== PROMPT_LINE) { i = j; continue; }
        const prompt: string[] = [];
        j++;
        while (j < lines.length && lines[j] !== ANSWER_LINE && lines[j] !== END_LINE && !lines[j].startsWith(TURN_PREFIX)) { prompt.push(unescapeLine(lines[j])); j++; }
        if (lines[j] !== ANSWER_LINE) { i = j; continue; }
        const answer: string[] = [];
        j++;
        while (j < lines.length && lines[j] !== END_LINE && !lines[j].startsWith(TURN_PREFIX)) { answer.push(unescapeLine(lines[j])); j++; }
        if (lines[j] !== END_LINE) { i = j; continue; }
        const id = str(head.id);
        if (id) {
            turns.push({
                id,
                time: str(head.time),
                host: str(head.host),
                session: str(head.session),
                profile: str(head.profile),
                model: str(head.model),
                prompt: prompt.join('\n'),
                answer: answer.join('\n'),
            });
        }
        i = j + 1;
    }
    return turns;
}

/** The number of turn blocks in a host trail text (headers counted; cheap). */
export function countHostTrailTurns(text: string): number {
    let n = 0;
    for (const line of text.split('\n')) { if (line.startsWith(TURN_PREFIX)) { n++; } }
    return n;
}

/** The turns of one host trail file; [] when it is missing or does not read. */
export function readHostTrailFile(file: string): HostTrailTurn[] {
    try { return parseHostTrail(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}

/** `host`'s turns of the quest in `questFolder`. */
export function readHostTrail(questFolder: string, host: string): HostTrailTurn[] {
    return readHostTrailFile(hostTrailFile(questFolder, host));
}

/** Every host's trail of the quest in `questFolder`, by host (each in file order). */
export function readHostTrails(questFolder: string): Map<string, HostTrailTurn[]> {
    const out = new Map<string, HostTrailTurn[]>();
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(questFolder, 'history')); } catch { return out; }
    for (const name of names.sort()) {
        const m = /^trail\.(.+)\.md$/.exec(name);
        if (m) { out.set(m[1], readHostTrailFile(path.join(questFolder, 'history', name))); }
    }
    return out;
}

/** The turns of `session` (a bare `default` is `default@default`), in the order given. */
export function sessionView(turns: readonly HostTrailTurn[], session: string): HostTrailTurn[] {
    const wanted = canonicalSessionName(session);
    return turns.filter((t) => canonicalSessionName(t.session) === wanted);
}

/**
 * A session's view of the host trail as one Markdown text (newest turn
 * first): a heading per turn with its time, profile and model, then the
 * prompt and the answer.
 */
export function formatSessionTrailView(session: string, turns: readonly HostTrailTurn[]): string {
    const out = [`# Trail of session ${session}`, '', `${turns.length} turn${turns.length === 1 ? '' : 's'}, newest first.`, ''];
    for (const t of [...turns].reverse()) {
        out.push(`## ${t.time}${t.profile ? ` · ${t.profile}` : ''}${t.model ? ` · ${t.model}` : ''}`, '', '**Prompt**', '', t.prompt, '', '**Answer**', '', t.answer, '');
    }
    return out.join('\n');
}

/** The history watermark's time of each host; undefined when there is no (readable) watermark. */
export function readWatermarkHosts(questFolder: string): Record<string, string> | undefined {
    try {
        const raw = JSON.parse(fs.readFileSync(historyWatermarkFile(questFolder), 'utf-8')) as { hosts?: unknown };
        if (!raw || typeof raw.hosts !== 'object' || raw.hosts === null || Array.isArray(raw.hosts)) { return undefined; }
        const out: Record<string, string> = {};
        for (const [host, at] of Object.entries(raw.hosts as Record<string, unknown>)) {
            if (typeof at === 'string') { out[host] = at; }
        }
        return out;
    } catch {
        return undefined;
    }
}

/** Whether the watermark covers `turn`: its time is at or before its host's watermark time. */
export function coveredByWatermark(turn: Pick<HostTrailTurn, 'host' | 'time'>, hosts: Record<string, string> | undefined): boolean {
    const at = hosts?.[turn.host];
    if (!at) { return false; }
    const mark = Date.parse(at);
    const time = Date.parse(turn.time);
    return Number.isFinite(mark) && Number.isFinite(time) && time <= mark;
}

/**
 * Trim `host`'s trail of the quest in `questFolder` to `maxEntries` turns,
 * removing only the oldest turns the history watermark covers. Answers the
 * number of turns removed (0 without a watermark or within the limit).
 */
export function trimHostTrail(questFolder: string, host: string, maxEntries: number): number {
    const file = hostTrailFile(questFolder, host);
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return 0; }
    if (countHostTrailTurns(text) <= maxEntries) { return 0; }
    const hosts = readWatermarkHosts(questFolder);
    if (!hosts) { return 0; }
    const turns = parseHostTrail(text);
    const kept = hostTrailTurnsToKeep(turns, maxEntries, (t) => coveredByWatermark(t, hosts));
    const removed = turns.length - kept.length;
    if (removed <= 0) { return 0; }
    fs.writeFileSync(file, kept.map(formatHostTrailTurn).join(''), 'utf-8');
    return removed;
}

/**
 * Append one turn to its host's trail of the quest in `questFolder`, then
 * trim the file to `maxEntries` turns (only covered turns go).
 */
export function appendHostTrailTurn(questFolder: string, turn: HostTrailTurn, maxEntries: number): void {
    const file = hostTrailFile(questFolder, turn.host);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, formatHostTrailTurn(turn), 'utf-8');
    trimHostTrail(questFolder, turn.host, maxEntries);
}

// ---------------------------------------------------------------------------
// Turns in flight: the prompt is known when it is sent, the answer when the turn ends
// ---------------------------------------------------------------------------

/** A turn whose prompt was sent and whose answer is still to come. */
export interface PendingHostTrailTurn {
    id: string;
    time: string;
    host: string;
    session: string;
    profile: string;
    model: string;
    prompt: string;
    /** The quest folder whose trail the turn goes to. */
    questFolder: string;
}

const pending = new Map<string, PendingHostTrailTurn>();

/** Note a turn's prompt as it is sent; {@link completeHostTrailTurn} writes the turn with its answer. */
export function beginHostTrailTurn(turn: PendingHostTrailTurn): void {
    pending.set(turn.id, turn);
}

/** What the completion needs to know besides the answer. */
export interface CompleteHostTrailOptions {
    maxEntries: number;
    /** Whether the session's turns go into the trail (its setting `contributesToTrailAndMemory`). */
    contributes(questFolder: string, session: string): boolean;
}

/**
 * Write turn `id` with its final answer to its host's trail — when its prompt
 * was noted and its session contributes. A turn is written once: a second
 * completion of the same id (an answer after an error answer) does nothing.
 * Answers whether the turn was written.
 */
export function completeHostTrailTurn(id: string, answer: string, opts: CompleteHostTrailOptions): boolean {
    const turn = pending.get(id);
    if (!turn) { return false; }
    pending.delete(id);
    if (!opts.contributes(turn.questFolder, turn.session)) { return false; }
    const { questFolder, ...head } = turn;
    appendHostTrailTurn(questFolder, { ...head, answer }, opts.maxEntries);
    return true;
}
