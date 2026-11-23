/**
 * `@<path>` line imports in the files the placeholder engine injects (gsel18;
 * guideline_sectioning.md D-20, D-29) — Anthropic's `@import` notation, so a
 * guideline file reads the same in the extension and in Claude Code.
 *
 * - A line that holds only `@<path>` (whitespace around it allowed) is
 *   replaced in place by that file's content when the path names an existing
 *   file: relative to the importing file, `~/…` or absolute (the path rule of
 *   services/claudeMd.ts, `resolveImportPath`).
 * - The imported text is expanded the same way, nested up to
 *   {@link MAX_IMPORT_DEPTH} levels; an import line deeper than that stays as
 *   written.
 * - Each file is imported once per resolution: a second import of a file
 *   already in it (a repeat, or a cycle back to a file on the way) drops the
 *   line. The importing file itself counts as in it.
 * - Never inside a fenced code block (``` or ~~~). An `@` anywhere else — in a
 *   sentence, `@T: …`, `@CHAT`, an inline code span, a path that names no
 *   file — stays as written.
 *
 * vscode-free; the file system is read through `read` (default `fs`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_IMPORT_DEPTH, resolveImportPath } from '../services/claudeMd';

export { MAX_IMPORT_DEPTH };

/** A line that is one `@<path>` and nothing else. */
const IMPORT_LINE = /^\s*@((?:~\/|\/|\.{1,2}\/)?[^\s`'"<>()[\]{}]+)\s*$/;
const FENCE = /^\s*(```|~~~)/;

export interface LineImportOptions {
    /** The home folder for `@~/…` (default `os.homedir()`). */
    homeDir?: string;
    /** A file's text; undefined when it is no readable file (default: `fs`). */
    read?: (file: string) => string | undefined;
    /**
     * The files already in this resolution (absolute): a later import of one
     * is dropped. Pass one set to every call of one resolution; the importing
     * file is added to it.
     */
    seen?: Set<string>;
}

function readFileDefault(file: string): string | undefined {
    try { return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : undefined; } catch { return undefined; }
}

/** `text`, the content of `file`, with its `@<path>` import lines replaced by the files they name. */
export function expandLineImports(text: string, file: string, opts: LineImportOptions = {}): string {
    const homeDir = opts.homeDir ?? os.homedir();
    const read = opts.read ?? readFileDefault;
    const seen = opts.seen ?? new Set<string>();
    seen.add(path.resolve(file));
    return expand(text, path.resolve(file), 1, { homeDir, read, seen });
}

function expand(text: string, file: string, depth: number, ctx: { homeDir: string; read: (f: string) => string | undefined; seen: Set<string> }): string {
    if (!text.includes('@')) { return text; }
    const lines = text.split('\n');
    const out: string[] = [];
    let fenced = false;
    for (const line of lines) {
        if (FENCE.test(line)) { fenced = !fenced; out.push(line); continue; }
        const m = fenced || depth > MAX_IMPORT_DEPTH ? null : IMPORT_LINE.exec(line);
        if (!m) { out.push(line); continue; }
        const target = resolveImportPath(m[1], path.dirname(file), ctx.homeDir);
        const content = ctx.read(target);
        if (content === undefined) { out.push(line); continue; }
        if (ctx.seen.has(target)) { continue; }
        ctx.seen.add(target);
        out.push(expand(content.replace(/\r?\n$/, ''), target, depth + 1, ctx));
    }
    return out.join('\n');
}
