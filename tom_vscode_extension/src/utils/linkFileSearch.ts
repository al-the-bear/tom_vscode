/**
 * Finding the file a document link names when it is not where the link says
 * (or the link names no folder at all): the MD Browser's and the quest notes
 * panel's fallback after utils/linkResolver.ts reported it missing.
 *
 * The file is looked for by its name, scope by scope, and the search stops at
 * the first scope that has it:
 *
 *  1. the folder of the open document and its subfolders,
 *  2. the current quest's folder,
 *  3. the workspace folder's guidelines folder(s),
 *  4. the root's guidelines folder(s) (a nested workspace),
 *  5. the whole workspace folder.
 *
 * When the link names folders as well (`dart/unit_tests.md`), files whose path
 * ends with them are kept over files that only share the name.
 *
 * No vscode import: the handler turns the result into an editor, an MD Browser
 * page or a picker.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Where a search scope comes from; the picker names it. */
export type LinkSearchScopeKind = 'document' | 'quest' | 'workspaceGuidelines' | 'rootGuidelines' | 'workspace';

export interface LinkSearchScope {
    kind: LinkSearchScopeKind;
    dir: string;
}

/** The text a picker shows for a scope. */
export const LINK_SEARCH_SCOPE_LABEL: Readonly<Record<LinkSearchScopeKind, string>> = {
    document: "in the document's folder",
    quest: 'in the quest folder',
    workspaceGuidelines: "in the workspace's guidelines",
    rootGuidelines: "in the root's guidelines",
    workspace: 'in the workspace',
};

/** Folders never entered: tool caches, build output, version control, scratch. */
export const LINK_SEARCH_SKIPPED_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', '.dart_tool', '.pub-cache', '.gradle', '.symlinks', 'Pods',
    'build', 'out', 'dist', 'coverage', 'ztmp', '.vscode-test',
]);

export interface LinkSearchScopeInput {
    /** The document the link is in. */
    currentFilePath?: string;
    /** The current quest's folder (none when no quest is open). */
    questDir?: string;
    /** The workspace folder's guidelines folders. */
    workspaceGuidelineDirs?: readonly string[];
    /** The root's guidelines folders (a nested workspace; empty when standalone). */
    rootGuidelineDirs?: readonly string[];
    /** The workspace folder. */
    workspaceRoot?: string;
}

/** The scopes in search order, existing folders only, each folder once. */
export function linkSearchScopes(input: LinkSearchScopeInput): LinkSearchScope[] {
    const out: LinkSearchScope[] = [];
    const seen = new Set<string>();
    const add = (kind: LinkSearchScopeKind, dir: string | undefined): void => {
        if (!dir || !isDir(dir)) { return; }
        const key = realOrSelf(dir);
        if (seen.has(key)) { return; }
        seen.add(key);
        out.push({ kind, dir });
    };
    add('document', input.currentFilePath ? path.dirname(input.currentFilePath) : undefined);
    add('quest', input.questDir);
    for (const d of input.workspaceGuidelineDirs ?? []) { add('workspaceGuidelines', d); }
    for (const d of input.rootGuidelineDirs ?? []) { add('rootGuidelines', d); }
    add('workspace', input.workspaceRoot);
    return out;
}

/**
 * The path a link names, split for the search: the file name, and the folder
 * names before it with `.`, `..` and an absolute start left out
 * (`../../dart/unit_tests.md` → `unit_tests.md`, `['dart']`).
 */
export function linkSearchName(linkPath: string): { name: string; folders: string[] } {
    const parts = linkPath.split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..');
    const name = parts.pop() ?? '';
    // A Windows drive (`C:`) names no folder to match.
    return { name, folders: parts.filter((p) => !/^[A-Za-z]:$/.test(p)) };
}

export interface LinkSearchOptions {
    /** Stop after this many files in a scope. Default 50. */
    maxResults?: number;
    /** Give up after this many milliseconds in all. Default 15 000. */
    timeBudgetMs?: number;
    /** Give up after this many directory entries in all. Default 400 000. */
    maxEntries?: number;
    /** Checked between folders: true stops the search. */
    isCancelled?: () => boolean;
}

export interface LinkSearchResult {
    /** The scope the files were found in; undefined when none had one. */
    scope?: LinkSearchScope;
    /** The files found (paths as walked, below the scope's folder), best first. */
    files: string[];
    /** The search stopped early (time, entries or cancelled) before finding anything. */
    incomplete: boolean;
}

/**
 * Look for the file `linkPath` names in `scopes`, in order, stopping at the
 * first scope with a match. Symbolic links to folders are followed (`_ai` is
 * one); a folder is entered once across every scope, so a later scope does not
 * walk an earlier one again and a link loop ends.
 */
export async function findLinkedFile(linkPath: string, scopes: readonly LinkSearchScope[], options: LinkSearchOptions = {}): Promise<LinkSearchResult> {
    const { name, folders } = linkSearchName(linkPath);
    if (!name) { return { files: [], incomplete: false }; }
    const maxResults = options.maxResults ?? 50;
    const deadline = Date.now() + (options.timeBudgetMs ?? 15_000);
    const maxEntries = options.maxEntries ?? 400_000;
    const visited = new Set<string>();
    let entries = 0;
    let stopped = false;
    const shouldStop = (): boolean => {
        if (!stopped && (Date.now() > deadline || entries > maxEntries || options.isCancelled?.() === true)) { stopped = true; }
        return stopped;
    };

    for (const scope of scopes) {
        const found: string[] = [];
        // Breadth first: files near the scope's folder come before deep ones.
        const queue: string[] = [scope.dir];
        while (queue.length > 0 && found.length < maxResults) {
            if (shouldStop()) { break; }
            const dir = queue.shift()!;
            const real = await realPath(dir);
            if (visited.has(real)) { continue; }
            visited.add(real);
            let listing: fs.Dirent[];
            try {
                listing = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            entries += listing.length;
            listing.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of listing) {
                const full = path.join(dir, entry.name);
                let isDirectory = entry.isDirectory();
                let isFile = entry.isFile();
                if (entry.isSymbolicLink()) {
                    const stat = await fs.promises.stat(full).catch(() => undefined);
                    isDirectory = stat?.isDirectory() ?? false;
                    isFile = stat?.isFile() ?? false;
                }
                if (isDirectory) {
                    if (!LINK_SEARCH_SKIPPED_DIRS.has(entry.name)) { queue.push(full); }
                } else if (isFile && entry.name === name) {
                    found.push(full);
                    if (found.length >= maxResults) { break; }
                }
            }
        }
        if (found.length > 0) {
            return { scope, files: preferFolderMatches(found, folders), incomplete: false };
        }
        if (stopped) { break; }
    }
    return { files: [], incomplete: stopped };
}

/** The files whose path ends with `folders` + name, when there are any; else all of them. */
export function preferFolderMatches(files: readonly string[], folders: readonly string[]): string[] {
    if (folders.length === 0) { return [...files]; }
    const matching = files.filter((f) => {
        const dirs = path.dirname(f).split(/[\\/]+/);
        const tail = dirs.slice(dirs.length - folders.length);
        return tail.length === folders.length && tail.every((d, i) => d === folders[i]);
    });
    return matching.length > 0 ? matching : [...files];
}

function isDir(dir: string): boolean {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function realOrSelf(p: string): string {
    try { return fs.realpathSync(p); } catch { return p; }
}

async function realPath(p: string): Promise<string> {
    try { return await fs.promises.realpath(p); } catch { return p; }
}
