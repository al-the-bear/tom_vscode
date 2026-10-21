/**
 * The window's output channels, read back from disk.
 *
 * VS Code has no API to read an output channel, but it writes every channel of
 * an extension host to a file as it goes:
 *
 *   <logs>/<launch>/window<N>/exthost/output_logging_<YYYYMMDDTHHMMSS>/<n>-<channel name>.log
 *
 * One `output_logging_*` folder per extension-host run: a window reload starts
 * a new run, and the earlier ones stay. The extension finds its own window's
 * `exthost` folder from `context.logUri` (`…/exthost/<extension id>`), so the
 * path never has to be known per platform.
 *
 * Pure functions over a folder, plus the one piece of state: the `exthost`
 * folder of this window, set at activation.
 */

import * as fs from 'fs';
import * as path from 'path';

/** `output_logging_20261020T183956` → the run's start, local time. */
const RUN_FOLDER = /^output_logging_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
/** `12-Tom Prompt Queue.log` → number 12, name `Tom Prompt Queue`. */
const CHANNEL_FILE = /^(\d+)-(.+)\.log$/;

/** Most bytes read from one channel file; a longer file is read from its end. */
export const MAX_CHANNEL_BYTES = 32 * 1024 * 1024;

export interface OutputLogRun {
    /** 0 = the newest run (this extension host), 1 = the one before, … */
    index: number;
    folder: string;
    /** `YYYY-MM-DD HH:MM:SS`, local time, from the folder name. */
    started: string;
}

export interface OutputChannelFile {
    /** The channel's name as the Output dropdown shows it. */
    name: string;
    /** The file name, e.g. `12-Tom Prompt Queue.log`. */
    file: string;
    bytes: number;
    /** ISO time of the last write. */
    modified: string;
}

// ---------------------------------------------------------------------------
// This window's exthost folder
// ---------------------------------------------------------------------------

let exthostFolder: string | undefined;

/** Record the window's log location from `context.logUri.fsPath` (`…/exthost/<extension id>`). */
export function setExtensionLogUri(logUriFsPath: string | undefined): void {
    exthostFolder = logUriFsPath ? path.dirname(logUriFsPath) : undefined;
}

/** The `exthost` folder of this window, or undefined before activation. */
export function getExthostFolder(): string | undefined {
    return exthostFolder;
}

// ---------------------------------------------------------------------------
// Runs and channels
// ---------------------------------------------------------------------------

/** The extension-host runs of a window, newest first. */
export function listOutputLogRuns(exthost: string): OutputLogRun[] {
    let names: string[];
    try { names = fs.readdirSync(exthost); } catch { return []; }
    return names
        .map((name) => ({ name, m: RUN_FOLDER.exec(name) }))
        .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
        // The folder name is a fixed-width timestamp, so name order is time order.
        .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
        .map(({ name, m }, index) => ({
            index,
            folder: path.join(exthost, name),
            started: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`,
        }));
}

/** The channel files of one run, in the order the channels were created. */
export function listOutputChannels(runFolder: string): OutputChannelFile[] {
    let names: string[];
    try { names = fs.readdirSync(runFolder); } catch { return []; }
    return names
        .map((file) => ({ file, m: CHANNEL_FILE.exec(file) }))
        .filter((x): x is { file: string; m: RegExpExecArray } => x.m !== null)
        .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
        .map(({ file, m }) => {
            const stat = fs.statSync(path.join(runFolder, file));
            return { name: m[2], file, bytes: stat.size, modified: stat.mtime.toISOString() };
        });
}

export type ChannelMatch =
    | { ok: true; channel: OutputChannelFile }
    | { ok: false; error: string; candidates: string[] };

/**
 * Find one channel by `query`: its file name, its exact name (any case), or
 * failing those the one name that contains it. Two channels can share a name,
 * so an exact name held twice is ambiguous too — the file name settles it.
 */
export function matchOutputChannel(channels: OutputChannelFile[], query: string): ChannelMatch {
    const q = query.trim().toLowerCase();
    const byFile = channels.filter((c) => c.file.toLowerCase() === q);
    if (byFile.length === 1) { return { ok: true, channel: byFile[0] }; }
    const exact = channels.filter((c) => c.name.toLowerCase() === q);
    const hits = exact.length > 0 ? exact : channels.filter((c) => c.name.toLowerCase().includes(q));
    if (hits.length === 1) { return { ok: true, channel: hits[0] }; }
    if (hits.length === 0) {
        return { ok: false, error: `No output channel matches "${query}".`, candidates: channels.map((c) => c.name) };
    }
    return {
        ok: false,
        error: `"${query}" matches ${hits.length} channels; name one exactly (or by its file name).`,
        candidates: hits.map((c) => (exact.length > 1 ? c.file : c.name)),
    };
}

// ---------------------------------------------------------------------------
// Reading a channel
// ---------------------------------------------------------------------------

export interface ReadChannelOptions {
    /** Keep only lines containing this text (any case), or matching it with `regex`. */
    grep?: string;
    regex?: boolean;
    /** Lines kept around each match. Default 0. */
    context?: number;
    /** Most lines returned — the last ones. */
    maxLines: number;
}

export interface ChannelText {
    totalLines: number;
    /** Lines that matched `grep` (all lines without one). */
    matchedLines: number;
    /** Lines returned, context included. */
    returnedLines: number;
    /** More lines matched than were returned: the earliest were left out. */
    truncated: boolean;
    /** The file was longer than {@link MAX_CHANNEL_BYTES} and was read from its end. */
    readFromEnd: boolean;
    /** `<line number>: <text>`, one per line; `--` between groups that do not touch. */
    text: string;
}

/** Build the line filter for `grep`; throws on an invalid regular expression. */
export function lineFilter(grep: string | undefined, regex: boolean | undefined): (line: string) => boolean {
    if (!grep) { return () => true; }
    if (regex) {
        const re = new RegExp(grep, 'i');
        return (line) => re.test(line);
    }
    const needle = grep.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
}

/** Read the file, or its last {@link MAX_CHANNEL_BYTES} when longer. */
function readTail(file: string): { content: string; readFromEnd: boolean } {
    const size = fs.statSync(file).size;
    if (size <= MAX_CHANNEL_BYTES) { return { content: fs.readFileSync(file, 'utf8'), readFromEnd: false }; }
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(MAX_CHANNEL_BYTES);
        fs.readSync(fd, buf, 0, MAX_CHANNEL_BYTES, size - MAX_CHANNEL_BYTES);
        // Drop the partial first line.
        const content = buf.toString('utf8');
        return { content: content.slice(content.indexOf('\n') + 1), readFromEnd: true };
    } finally {
        fs.closeSync(fd);
    }
}

/** The lines of a channel file, filtered, with context, the last `maxLines` of them. */
export function readOutputChannel(file: string, options: ReadChannelOptions): ChannelText {
    const { content, readFromEnd } = readTail(file);
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') { lines.pop(); }
    const keep = lineFilter(options.grep, options.regex);
    const ctx = Math.max(0, Math.floor(options.context ?? 0));

    const matched: number[] = [];
    lines.forEach((line, i) => { if (keep(line)) { matched.push(i); } });

    // Every line to show (match or context), in order, without repeats.
    const shown = new Set<number>();
    for (const i of matched) {
        for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) { shown.add(j); }
    }
    const ordered = [...shown].sort((a, b) => a - b);
    const kept = ordered.slice(Math.max(0, ordered.length - options.maxLines));

    const out: string[] = [];
    let previous = -2;
    for (const i of kept) {
        if (out.length > 0 && i !== previous + 1) { out.push('--'); }
        out.push(`${i + 1}: ${lines[i]}`);
        previous = i;
    }
    return {
        totalLines: lines.length,
        matchedLines: matched.length,
        returnedLines: kept.length,
        truncated: kept.length < ordered.length,
        readFromEnd,
        text: out.join('\n'),
    };
}
