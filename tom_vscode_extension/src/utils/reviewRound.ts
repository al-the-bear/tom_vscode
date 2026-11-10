/**
 * A team review round (SOM §11.9.8, §11.9.9; CC-64, CC-65): files only. The
 * round folder holds the base (the document as it was sent out), one copy per
 * member named by member id, and `round.yaml`; a reviewer's copy comes back
 * over its own file, and the merge writes `merged/`.
 *
 *     <round folder>/
 *       round.yaml          the round: document, base, team, guests, merge
 *       base.<ext>          the document as sent out
 *       alice.<ext>         a member's copy (returned when it differs from the base)
 *       merged/<file>       the merged document; merged/merge-report.json
 *
 * Nothing is written into a copy: whose it is says its file name, and a copy
 * whose structure does not fit the base is reported by the status check.
 *
 * Also the text rules the round tools share for SOM values and plain annotated
 * Markdown alike: a conflict block's decision, and the review counts of a
 * plain Markdown file. vscode-free.
 */

import { parse, stringify } from 'yaml';

/** The round file's format version. */
export const ROUND_FORMAT = 1;
export const ROUND_FILE = 'round.yaml';
export const MERGED_FOLDER = 'merged';
export const MERGE_REPORT_FILE = 'merge-report.json';
export const MEMBER_ID = /^[a-z0-9_]+$/;

/** A member of the round's team, or a guest (a copy from somebody not on it). */
export interface RoundMember {
    memberId: string;
    displayName: string;
    role: string;
}

export interface ReviewRound {
    format: number;
    /** The reviewed document, workspace-relative. */
    document: string;
    /** `som` (a TomSpecs document) or `markdown` (plain annotated Markdown). */
    kind: 'som' | 'markdown';
    /** The base file in the round folder. */
    base: string;
    /** The copies' file extension, with its dot (`.docspecs.yaml`, `.md`). */
    extension: string;
    /** ISO time the round was created. */
    created: string;
    /** The round's date (YYYY-MM-DD): the revision entry's, and generated item ids'. */
    date: string;
    /** The revision entry's author (the owner, else the user). */
    author: string;
    team: RoundMember[];
    /** Copies from people not on the team, as named when they came back. */
    guests: RoundMember[];
    /** The last merge: when, and the merged file (round-folder relative). */
    merged?: { at: string; file: string; report: string };
}

/** A document's file extension as the copies take it: `.docspecs.yaml`, `.yaml`, `.md`. */
export function documentExtension(file: string): string {
    const lower = file.toLowerCase();
    if (lower.endsWith('.docspecs.yaml')) { return '.docspecs.yaml'; }
    const m = /\.[^./\\]+$/.exec(file);
    return m ? m[0] : '';
}

/** A member's copy file name. */
export function copyFileName(memberId: string, extension: string): string {
    return `${memberId}${extension}`;
}

/** The member id a file in the round folder names; null for the base, the round file and anything else. */
export function memberOfFile(fileName: string, extension: string): string | null {
    if (!fileName.endsWith(extension)) { return null; }
    const id = fileName.slice(0, fileName.length - extension.length);
    return id !== 'base' && MEMBER_ID.test(id) ? id : null;
}

/** The default round folder: beside the document, `review-rounds/<document stem>-<YYYYMMDD-HHMM>`. */
export function defaultRoundFolderName(documentFile: string, now: Date = new Date()): string {
    const base = documentFile.split(/[\\/]/).pop() ?? 'document';
    const stem = base.slice(0, base.length - documentExtension(base).length) || base;
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${stem}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** Check a team: member ids `[a-z0-9_]+`, each once, a display name and a role. */
export function checkTeam(team: readonly RoundMember[]): string | null {
    if (!team.length) { return 'the round needs at least one member'; }
    const seen = new Set<string>();
    for (const m of team) {
        if (!m || typeof m.memberId !== 'string' || !MEMBER_ID.test(m.memberId)) { return `"${m?.memberId ?? ''}" is not a member id (lowercase letters, digits and _)`; }
        if (seen.has(m.memberId)) { return `the member ${m.memberId} is listed twice`; }
        seen.add(m.memberId);
        if (!m.displayName || !m.role) { return `the member ${m.memberId} needs a display name and a role`; }
    }
    return null;
}

export function stringifyRound(round: ReviewRound): string {
    return stringify(round, { lineWidth: 0 });
}

/** Read a round file; throws with the reason when it is not one. */
export function parseRound(text: string): ReviewRound {
    const raw = parse(text) as Partial<ReviewRound> | null;
    if (!raw || typeof raw !== 'object' || raw.format !== ROUND_FORMAT || typeof raw.document !== 'string' || typeof raw.base !== 'string'
        || !Array.isArray(raw.team) || (raw.kind !== 'som' && raw.kind !== 'markdown') || typeof raw.extension !== 'string') {
        throw new Error(`${ROUND_FILE} is not a review round (format ${ROUND_FORMAT}: document, kind, base, extension, team)`);
    }
    return {
        format: ROUND_FORMAT,
        document: raw.document,
        kind: raw.kind,
        base: raw.base,
        extension: raw.extension,
        created: String(raw.created ?? ''),
        date: String(raw.date ?? ''),
        author: String(raw.author ?? ''),
        team: raw.team as RoundMember[],
        guests: Array.isArray(raw.guests) ? raw.guests as RoundMember[] : [],
        ...(raw.merged ? { merged: raw.merged } : {}),
    };
}

// ---- Conflict blocks (SOM §11.9.8) ------------------------------------------

/** A conflict block's header line: `> ⚖️ **X-<n> — <topic>:** …`. */
const CONFLICT_HEADER = /^> ?⚖️? ?\*\*(X-[1-9][0-9]*) — /;
const DECISION_LINE = /^> ?\*\*Decision:\*\*/;

/** A conflict as plain text shows it: id, the alternative letters, the decision written ('' when open). */
export interface TextConflict {
    id: string;
    line: number;
    letters: string[];
    decision: string;
}

function blockEnd(lines: readonly string[], start: number): number {
    let end = start;
    while (end + 1 < lines.length && lines[end + 1].startsWith('>')) { end++; }
    return end;
}

/** The conflict blocks of a text (a SOM value or a plain Markdown file), in order. */
export function textConflicts(text: string): TextConflict[] {
    const lines = text.split('\n');
    const out: TextConflict[] = [];
    for (let i = 0; i < lines.length; i++) {
        const head = CONFLICT_HEADER.exec(lines[i].replace('⚖️', '⚖️'));
        if (!head) { continue; }
        const end = blockEnd(lines, i);
        const letters: string[] = [];
        let decision = '';
        for (let k = i + 1; k <= end; k++) {
            const inner = lines[k].replace(/^> ?/, '');
            const alt = /^- \(([a-z])\)/.exec(inner);
            if (alt) { letters.push(alt[1]); }
            if (DECISION_LINE.test(lines[k])) {
                decision = [inner.replace(/^\*\*Decision:\*\*/, ''), ...lines.slice(k + 1, end + 1).map((l) => l.replace(/^> ?/, ''))].join('\n').trim();
                break;
            }
        }
        out.push({ id: head[1], line: i, letters, decision });
        i = end;
    }
    return out;
}

/**
 * `text` with conflict `id`'s `**Decision:**` set to `decision` — a letter of
 * its alternatives or `base` (written `(a)`, `(base)`), or rewritten text
 * ('' reopens it). Null when the
 * text holds no such conflict. Throws for a letter it has no alternative for.
 */
export function setConflictDecisionText(text: string, id: string, decision: string): string | null {
    const lines = text.split('\n');
    const conflict = textConflicts(text).find((c) => c.id === id);
    if (!conflict) { return null; }
    // A letter or `base`, bare or in brackets, is written `(a)` / `(base)`: the form the runtime reads as a choice.
    let d = decision.trim();
    const choice = /^\(?([a-z]|base)\)?$/.exec(d);
    if (choice) {
        if (choice[1] !== 'base' && !conflict.letters.includes(choice[1])) {
            throw new Error(`the conflict ${id} has no alternative (${choice[1]}); it has ${conflict.letters.map((l) => `(${l})`).join(', ') || 'none'} and (base)`);
        }
        d = `(${choice[1]})`;
    }
    const end = blockEnd(lines, conflict.line);
    let at = -1;
    for (let k = conflict.line + 1; k <= end; k++) { if (DECISION_LINE.test(lines[k])) { at = k; break; } }
    const written = d ? d.split('\n') : [''];
    const block = [`> **Decision:**${written[0] ? ` ${written[0]}` : ''}`, ...written.slice(1).map((l) => (l ? `> ${l}` : '>'))];
    if (at < 0) {
        lines.splice(end + 1, 0, '>', ...block);
    } else {
        lines.splice(at, end - at + 1, ...block);
    }
    return lines.join('\n');
}

/** The review counts of a plain annotated Markdown file (the round status of a Markdown round). */
export function plainReviewCounts(text: string): { comments: number; questions: number; conflicts: number; openConflicts: number; marks: number } {
    const lines = text.split('\n');
    const conflicts = textConflicts(text);
    return {
        comments: lines.filter((l) => /^> ?⬆️ ?\*\*C-[0-9]+\*\*/.test(l)).length,
        questions: lines.filter((l) => /^> ?\*\*❓ /.test(l)).length,
        conflicts: conflicts.length,
        openConflicts: conflicts.filter((c) => !c.decision).length,
        marks: (text.match(/\{(\+\+|--|~~|==|>>)/g) ?? []).length,
    };
}

/** The `#` headings of a Markdown text, in order (what a copy of a plain Markdown round must keep). */
export function headingPaths(text: string): string[] {
    const out: string[] = [];
    const stack: string[] = [];
    let fence = false;
    for (const line of text.split('\n')) {
        if (/^(```|~~~)/.test(line)) { fence = !fence; continue; }
        if (fence) { continue; }
        const h = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
        if (!h) { continue; }
        stack.length = h[1].length - 1;
        stack[h[1].length - 1] = h[2];
        out.push(stack.filter(Boolean).join(' / '));
    }
    return out;
}
