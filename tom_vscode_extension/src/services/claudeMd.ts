/**
 * CLAUDE.md as Claude Code loads it, for the transports that do not run
 * Claude Code — direct, Local LLM, VS Code LM (CC-14 (a)). The Agent SDK
 * loads these files itself (its `project` setting source).
 *
 * The files, in Claude Code's order:
 * 1. the user-level `~/.claude/CLAUDE.md`;
 * 2. every folder of the working folder's chain, from the farthest ancestor
 *    down to the working folder: its `CLAUDE.md`, then its `CLAUDE.local.md`.
 *    The chain runs from the working folder (the workspace root unless a
 *    folder inside the workspace is given) up through the workspace root and
 *    on to the filesystem root, as Claude Code's walk from its working folder
 *    does — the root `/` itself is not read;
 * 3. after each file, the files it imports: `@path` — relative to the
 *    importing file, `~/…` or absolute — naming an existing file, nested up
 *    to five levels; every file is loaded once; `@` inside inline code or a
 *    fenced block, or naming no file (a mention), imports nothing.
 *
 * `renderClaudeMd` writes them under `Contents of <path> (<kind>):` headers;
 * `${claudeMd}` (variableResolver) is that rendering for the workspace.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Imports nest at most this deep (Claude Code's limit). */
export const MAX_IMPORT_DEPTH = 5;

export type ClaudeMdKind = 'user' | 'project' | 'local' | 'import';

export interface ClaudeMdSource {
    /** Absolute path (as found; symlinks not resolved). */
    path: string;
    kind: ClaudeMdKind;
    content: string;
    /** For an import: the file that imports it. */
    importedBy?: string;
}

export interface CollectClaudeMdOptions {
    /** The workspace root. */
    wsRoot: string;
    /** The working folder, inside the workspace; default the workspace root. */
    workingDir?: string;
    /** The user's home folder (for `~/.claude/CLAUDE.md` and `@~/…`). */
    homeDir: string;
}

function readFile(file: string): string | undefined {
    try {
        return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : undefined;
    } catch {
        return undefined;
    }
}

function realOf(file: string): string {
    try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The folders from the farthest ancestor down to `dir` (the filesystem root itself left out). */
function chainDownTo(dir: string): string[] {
    const chain: string[] = [];
    let current = path.resolve(dir);
    for (;;) {
        const parent = path.dirname(current);
        if (parent === current) { break; } // `current` is the filesystem root: not read
        chain.unshift(current);
        current = parent;
    }
    return chain;
}

/** Text with inline code spans and fenced blocks blanked out (their `@` imports nothing). */
function withoutCode(text: string): string {
    const lines = text.split('\n');
    let fenced = false;
    return lines.map((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
            fenced = !fenced;
            return '';
        }
        return fenced ? '' : line.replace(/`[^`]*`/g, '');
    }).join('\n');
}

/** The import targets of a file's text: existing files named by `@path`. */
export function importTargets(text: string, fileDir: string, homeDir: string): string[] {
    const out: string[] = [];
    const re = /(^|\s)@((?:~\/|\/|\.{1,2}\/)?[^\s`'"<>()[\]{}]+)/g;
    let match: RegExpExecArray | null;
    const scan = withoutCode(text);
    while ((match = re.exec(scan)) !== null) {
        const raw = match[2].replace(/[.,;:!?]+$/, '');
        if (!raw) { continue; }
        const target = raw.startsWith('~/')
            ? path.join(homeDir, raw.slice(2))
            : path.isAbsolute(raw) ? raw : path.resolve(fileDir, raw);
        if (readFile(target) !== undefined && !out.includes(target)) { out.push(target); }
    }
    return out;
}

/** The CLAUDE.md files (and their imports) in Claude Code's order. */
export function collectClaudeMd(opts: CollectClaudeMdOptions): ClaudeMdSource[] {
    const wsRoot = path.resolve(opts.wsRoot);
    const working = opts.workingDir && isInside(path.resolve(opts.workingDir), wsRoot) ? path.resolve(opts.workingDir) : wsRoot;
    const sources: ClaudeMdSource[] = [];
    const seen = new Set<string>();

    const add = (file: string, kind: ClaudeMdKind, depth: number, importedBy?: string): void => {
        const real = realOf(file);
        if (seen.has(real)) { return; }
        const content = readFile(file);
        if (content === undefined) { return; }
        seen.add(real);
        sources.push({ path: file, kind, content, ...(importedBy ? { importedBy } : {}) });
        if (depth >= MAX_IMPORT_DEPTH) { return; }
        for (const target of importTargets(content, path.dirname(file), opts.homeDir)) {
            add(target, 'import', depth + 1, file);
        }
    };

    add(path.join(opts.homeDir, '.claude', 'CLAUDE.md'), 'user', 0);
    for (const dir of chainDownTo(working)) {
        add(path.join(dir, 'CLAUDE.md'), 'project', 0);
        add(path.join(dir, 'CLAUDE.local.md'), 'local', 0);
    }
    return sources;
}

const KIND_LABEL: Record<Exclude<ClaudeMdKind, 'import'>, string> = {
    user: 'user instructions',
    project: 'project instructions',
    local: 'private project instructions',
};

/** The files under `Contents of <path> (<kind>):` headers; '' without files. */
export function renderClaudeMd(sources: readonly ClaudeMdSource[]): string {
    return sources.map((s) => {
        const label = s.kind === 'import' ? `imported by ${s.importedBy}` : KIND_LABEL[s.kind];
        return `Contents of ${s.path} (${label}):\n\n${s.content.trim()}`;
    }).join('\n\n');
}
