/**
 * The files of a quest's memory folder, `_ai/quests/<quest>/memory/`.
 *
 * Two kinds of file live there:
 *
 *   - **curated facts** — every file that is not a candidates file: `facts.md`
 *     (the default), a profile's bucket `facts-<suffix>.md`, any other name.
 *     Written deliberately (the memory tools, the user's remember / forget,
 *     the Memory panel) and shared by every host.
 *   - **candidates** — `candidates.<host>.md`, one per host. Written by the
 *     automatic memory extraction on that host only. Each entry names the
 *     session it was extracted in and the curated file it is meant for.
 *
 * This module holds what is pure about them: the folder, the file kinds, the
 * candidate entry's text prefix, the injected block and the Memory panel's
 * list.
 *
 * vscode-free.
 */

import * as path from 'path';

/** The memory folder's name inside the quest folder. */
export const QUEST_MEMORY_FOLDER = 'memory';

/** The curated file a write goes to, and a candidate is meant for, when none is named. */
export const DEFAULT_MEMORY_FILE = 'facts.md';

/** The quest's memory folder; `questsRoot` is `_ai/quests`. */
export function questMemoryFolder(questsRoot: string, quest: string): string {
    return path.join(questsRoot, quest, QUEST_MEMORY_FOLDER);
}

// ============================================================================
// File kinds
// ============================================================================

export type MemoryFileKind = 'curated' | 'candidates';

const CANDIDATES_FILE_RE = /^candidates\.(.+)\.md$/;

/** `host` made safe for a file name: everything but letters, digits, `.`, `_` and `-` becomes `_`. */
export function safeHostForFile(host: string): string {
    const safe = (host || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
    return safe || 'unknown';
}

/** The candidates file of `host`: `candidates.<host>.md`. */
export function candidatesFileName(host: string): string {
    return `candidates.${safeHostForFile(host)}.md`;
}

/** The host a candidates file belongs to (as its name spells it); undefined for any other file. */
export function candidatesHostOf(file: string): string | undefined {
    // Only a file directly in the memory folder is a candidates file.
    if (file.includes('/') || file.includes('\\')) { return undefined; }
    const m = CANDIDATES_FILE_RE.exec(file);
    return m ? m[1] : undefined;
}

/** Whether `file` (relative to the memory folder) holds curated facts or a host's candidates. */
export function memoryFileKind(file: string): MemoryFileKind {
    return candidatesHostOf(file) === undefined ? 'curated' : 'candidates';
}

/** Curated files first, then candidates files; each group by name. */
export function compareMemoryFiles(a: string, b: string): number {
    const ka = memoryFileKind(a) === 'curated' ? 0 : 1;
    const kb = memoryFileKind(b) === 'curated' ? 0 : 1;
    return ka - kb || a.localeCompare(b);
}

// ============================================================================
// The candidate entry's text
// ============================================================================

/**
 * A candidate is a stamped bullet like every memory entry
 * (`- <iso> [<host>] <text>`); its text starts with a fixed prefix naming the
 * session it was extracted in and the curated file it is meant for:
 *
 *     {session=<session> file=<target file>} <fact>
 *
 * The session has no space (session names are letters, digits, `_`, `-` and
 * `@`; it is empty when the extraction ran in no session); the file runs up to
 * the closing brace. `%`, `}`, a space in the session and a line break are
 * percent-encoded, so every value reads back as written.
 */
export interface CandidateText {
    /** The session the candidate was extracted in; undefined when none is named. */
    session?: string;
    /** The curated file it is meant for; undefined on a line without the prefix. */
    targetFile?: string;
    /** The fact itself. */
    text: string;
}

const CANDIDATE_PREFIX_RE = /^\{session=(\S*) file=([^}]+)\}\s+(.*)$/;

function encodePrefixValue(value: string, alsoSpace: boolean): string {
    return value.replace(alsoSpace ? /[%}\s]/g : /[%}\r\n]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function decodePrefixValue(value: string): string {
    return value.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The text of a candidate entry: the prefix, then the fact. */
export function formatCandidateText(candidate: { session?: string; targetFile?: string; text: string }): string {
    const session = encodePrefixValue(candidate.session ?? '', true);
    const file = encodePrefixValue((candidate.targetFile ?? '').trim() || DEFAULT_MEMORY_FILE, false);
    return `{session=${session} file=${file}} ${candidate.text.trim()}`;
}

/**
 * Read a candidate entry's text. A line without the prefix (written by hand,
 * or before the prefix existed) is the fact alone: no session, no target file.
 */
export function parseCandidateText(text: string): CandidateText {
    const m = CANDIDATE_PREFIX_RE.exec(text.trim());
    if (!m) { return { text: text.trim() }; }
    const session = decodePrefixValue(m[1]);
    return {
        ...(session ? { session } : {}),
        targetFile: decodePrefixValue(m[2]).trim(),
        text: m[3].trim(),
    };
}

/** The curated file a candidate is meant for: the one it names, else the default file. */
export function candidateTargetFile(text: string): string {
    return parseCandidateText(text).targetFile || DEFAULT_MEMORY_FILE;
}

/** One memory file as the injection reads it. */
export interface MemoryFileBody {
    /** Relative to its folder, `/`-separated. */
    file: string;
    body: string;
    bytes: number;
    mtime: number;
}

// ============================================================================
// The injected block
// ============================================================================

export type InjectedMemoryKind = MemoryFileKind;

export interface InjectedMemoryFile {
    kind: InjectedMemoryKind;
    file: string;
    bytes: number;
    mtime: number;
}

export interface MemoryBlock {
    /** The block for the prompt; empty when there is nothing to inject. */
    text: string;
    /** What it holds, in the order of `text`. */
    included: InjectedMemoryFile[];
}

export interface MemoryBlockInput {
    /** The curated files, in the order they are offered (newest first). */
    curated: MemoryFileBody[];
    /** This host's candidates file and its entry lines (newest first), already narrowed to the ones to inject. */
    candidates?: { file: string; lines: string[]; bytes: number; mtime: number };
    /** The budget in characters for the blocks together. */
    charBudget: number;
}

/** The heading the candidates stand under in the injected block. */
export function candidatesHeading(file: string): string {
    return `### candidates/${file} — extracted automatically on this host, not curated: `
        + 'each line names the session it comes from and the curated file it is meant for';
}

/**
 * The memory block of a prompt: the curated files, then this host's
 * candidates under their own heading, all within
 * `charBudget`. A file that does not fit is left out and the next one tried;
 * of the candidates as many entries as fit are taken, from the newest on.
 */
export function buildMemoryBlock(input: MemoryBlockInput): MemoryBlock {
    const pieces: string[] = [];
    const included: InjectedMemoryFile[] = [];
    let used = 0;

    const addFile = (kind: InjectedMemoryKind, heading: string, f: MemoryFileBody): void => {
        const body = f.body.trim();
        if (!body) { return; }
        const block = `${heading}\n${body}\n`;
        if (used + block.length > input.charBudget) { return; }
        pieces.push(block);
        included.push({ kind, file: f.file, bytes: f.bytes, mtime: f.mtime });
        used += block.length;
    };

    for (const f of input.curated) { addFile('curated', `### quest/${f.file}`, f); }

    const cand = input.candidates;
    if (cand && cand.lines.length > 0) {
        const heading = candidatesHeading(cand.file);
        const taken: string[] = [];
        let size = heading.length + 1;
        for (const line of cand.lines) {
            if (used + size + line.length + 1 > input.charBudget) { break; }
            taken.push(line);
            size += line.length + 1;
        }
        if (taken.length > 0) {
            pieces.push(`${heading}\n${taken.join('\n')}\n`);
            included.push({ kind: 'candidates', file: cand.file, bytes: cand.bytes, mtime: cand.mtime });
            used += size;
        }
    }

    return { text: pieces.length > 0 ? `## Memory\n\n${pieces.join('\n')}` : '', included };
}

// ============================================================================
// The Memory panel's list
// ============================================================================

/** One file of the Memory panel's list. */
export interface MemoryPanelRow {
    file: string;
    bytes: number;
    kind: MemoryFileKind;
    /** A candidates file's host (as its name spells it). */
    host?: string;
    /** A candidates file: whether it is this host's (the one the extraction here writes). */
    ownHost?: boolean;
}

/** The Memory panel's files: the curated ones first, then the candidates files, each marked with its host. */
export function memoryPanelRows(files: ReadonlyArray<{ file: string; bytes: number }>, thisHost: string): MemoryPanelRow[] {
    const own = candidatesFileName(thisHost);
    return [...files]
        .sort((a, b) => compareMemoryFiles(a.file, b.file))
        .map((f) => {
            const host = candidatesHostOf(f.file);
            return host === undefined
                ? { file: f.file, bytes: f.bytes, kind: 'curated' as const }
                : { file: f.file, bytes: f.bytes, kind: 'candidates' as const, host, ownHost: f.file === own };
        });
}
