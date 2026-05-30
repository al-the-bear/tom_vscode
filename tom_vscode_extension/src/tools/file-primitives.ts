/**
 * File primitives — `tomAi_readFile`, `tomAi_listDirectory`,
 * `tomAi_findFiles`, `tomAi_findTextInFiles`.
 *
 * Carved out of `tool-executors.ts` so the implementations can be
 * tested without `vscode` and the executor file stops growing without
 * bound. Each tool follows the `*Impl(deps, input)` pattern set by
 * `guideline-tools.ts` and `prompt-history-tools.ts`:
 *
 *   - The Impl takes its dependencies explicitly (workspace root, an
 *     optional walker callback) and returns a string.
 *   - The thin `execute*` wrapper grabs the deps from the live VS Code
 *     workspace and forwards.
 *
 * Two non-trivial design decisions:
 *
 *   1. **`findFiles` keeps an injectable walker.** The production
 *      executor still delegates to `vscode.workspace.findFiles` so we
 *      preserve VS Code's `search.exclude` integration and avoid a
 *      glob-engine rewrite. Tests inject a Node-native walker built
 *      on the matcher in this file, which is enough to verify the
 *      orchestration (input → walker call → output formatting).
 *
 *   2. **`findTextInFiles` no longer shells out.** The original
 *      implementation interpolated the user's `searchText` into a
 *      `grep -E "${pattern}"` command after regex-escaping but
 *      **not** shell-escaping it. `searchText: 'foo"; rm -rf ~; #'`
 *      executed verbatim. The Node-native scanner here closes that
 *      hole and also removes the system-grep dependency (works on
 *      Windows out of the box).
 */

import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

// ---------------------------------------------------------------------------
// Input shapes (re-exported so tests share the types)
// ---------------------------------------------------------------------------

export interface ReadFileInput {
    filePath: string;
    startLine?: number;
    endLine?: number;
}

export interface ListDirectoryInput {
    dirPath: string;
}

export interface FindFilesInput {
    pattern: string;
    maxResults?: number;
}

export interface FindTextInFilesInput {
    searchText: string;
    filePattern?: string;
    isRegex?: boolean;
    maxResults?: number;
}

// ---------------------------------------------------------------------------
// Shared resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a possibly-relative path against the workspace root. Absolute
 * paths are returned as-is. Empty `wsRoot` means "no workspace open" —
 * the caller is expected to surface a friendlier error than a raw fs
 * exception.
 */
export function resolveAgainstWsRoot(filePath: string, wsRoot: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(wsRoot || process.cwd(), filePath);
}

/**
 * Guard against path-traversal outside the workspace. When `wsRoot` is
 * empty (no workspace open) we let anything through — there's no
 * workspace to protect.
 */
export function isInsideWorkspace(resolved: string, wsRoot: string): boolean {
    if (!wsRoot) { return true; }
    const rel = path.relative(wsRoot, resolved);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

export async function readFileImpl(wsRoot: string, input: ReadFileInput): Promise<string> {
    const resolved = resolveAgainstWsRoot(input.filePath, wsRoot);
    if (!isInsideWorkspace(resolved, wsRoot)) {
        return `Error: path is outside the workspace: ${input.filePath}`;
    }
    let stat: fs.Stats;
    try {
        stat = fs.statSync(resolved);
    } catch {
        return `File not found: ${resolved}`;
    }
    if (stat.isDirectory()) {
        return `Error: \`${input.filePath}\` is a directory. Use \`tomAi_listDirectory\` to list its contents.`;
    }
    let content: string;
    try {
        content = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
        return `Error reading file: ${(err as Error).message}`;
    }
    if (input.startLine === undefined && input.endLine === undefined) {
        return content;
    }
    const lines = content.split('\n');
    // 1-based, inclusive on both ends. Out-of-range values clamp.
    const start = Math.max(0, (input.startLine ?? 1) - 1);
    const end = Math.min(lines.length, input.endLine ?? lines.length);
    if (start >= end) {
        return `(empty: requested range startLine=${input.startLine ?? 1}, endLine=${input.endLine ?? lines.length} ` +
               `is out of bounds for a ${lines.length}-line file)`;
    }
    return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

export async function listDirectoryImpl(wsRoot: string, input: ListDirectoryInput): Promise<string> {
    const resolved = resolveAgainstWsRoot(input.dirPath, wsRoot);
    if (!isInsideWorkspace(resolved, wsRoot)) {
        return `Error: path is outside the workspace: ${input.dirPath}`;
    }
    let stat: fs.Stats;
    try {
        stat = fs.statSync(resolved);
    } catch {
        return `Directory not found: ${resolved}`;
    }
    if (!stat.isDirectory()) {
        return `Error: \`${input.dirPath}\` is a file. Use \`tomAi_readFile\` to read it.`;
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (err) {
        return `Error listing directory: ${(err as Error).message}`;
    }
    if (entries.length === 0) {
        return `(empty directory: ${input.dirPath})`;
    }
    return entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`)
        .join('\n');
}

// ---------------------------------------------------------------------------
// findFiles
// ---------------------------------------------------------------------------

export interface FindFilesDeps {
    wsRoot: string;
    /**
     * Walk the workspace and return paths matching `pattern` and not
     * matching `exclude`. Paths are returned workspace-relative. The
     * caller (this Impl) guarantees the limit is sane.
     *
     * Production wires this to `vscode.workspace.findFiles`; tests
     * wire it to `nodeNativeWalker` from this file. Returning paths in
     * a stable sort order is the walker's responsibility — the Impl
     * does not re-sort.
     */
    walk(pattern: string, exclude: string, limit: number): Promise<string[]>;
}

export async function findFilesImpl(deps: FindFilesDeps, input: FindFilesInput): Promise<string> {
    const limit = clampLimit(input.maxResults, 100, 1000);
    if (!input.pattern || typeof input.pattern !== 'string') {
        return `Error: \`pattern\` is required and must be a non-empty glob string ` +
               `(e.g. \`**/*.ts\` for recursive .ts files, or \`src/**/*.dart\`).`;
    }
    try {
        const paths = await deps.walk(input.pattern, '**/node_modules/**', limit);
        if (paths.length === 0) {
            // Common LLM trap: `*.ts` instead of `**/*.ts`. Surface the hint when
            // the pattern looks like it was meant to be recursive.
            const looksNonRecursive = /^[^/]*\*[^/]*$/.test(input.pattern) && !input.pattern.startsWith('**/');
            const hint = looksNonRecursive
                ? `\n  Hint: \`${input.pattern}\` only matches root-level files. Try \`**/${input.pattern}\` for recursive matching.`
                : '';
            return `No files found matching: ${input.pattern}${hint}`;
        }
        return paths.join('\n');
    } catch (err) {
        return `Error finding files: ${(err as Error).message}`;
    }
}

// ---------------------------------------------------------------------------
// findTextInFiles — Node-native, no shell, no injection surface
// ---------------------------------------------------------------------------

export interface FindTextDeps {
    wsRoot: string;
    /**
     * Optional override for the file walker. Production uses the
     * `nodeNativeWalker` in this file; tests pass a stub to keep the
     * fixture small. The walker returns workspace-relative paths.
     */
    walk?(pattern: string, exclude: string, limit: number): Promise<string[]>;
}

export async function findTextInFilesImpl(deps: FindTextDeps, input: FindTextInFilesInput): Promise<string> {
    if (!input.searchText) {
        return `Error: \`searchText\` is required.`;
    }
    const limit = clampLimit(input.maxResults, 50, 1000);
    const includePattern = normalizeFilePattern(input.filePattern);
    const walker = deps.walk ?? ((p, e, l) => nodeNativeWalker(deps.wsRoot, p, e, l));

    // Compile the search predicate. For non-regex inputs we test for
    // substring directly — no escape-then-recompile dance, no surprise
    // regex-specials behaviour for the LLM.
    let predicate: (line: string) => boolean;
    if (input.isRegex) {
        let re: RegExp;
        try {
            re = new RegExp(input.searchText);
        } catch (err) {
            return `Error: \`searchText\` is not a valid regex: ${(err as Error).message}`;
        }
        predicate = (line) => re.test(line);
    } else {
        const needle = input.searchText;
        predicate = (line) => line.includes(needle);
    }

    let files: string[];
    try {
        // Scan up to 50× the result limit of files so we don't load the
        // entire repo into memory if the LLM passes `*` as the include.
        // The first `limit` matches win.
        files = await walker(includePattern, '**/node_modules/**', limit * 50);
    } catch (err) {
        return `Error walking files: ${(err as Error).message}`;
    }

    const out: string[] = [];
    let scanned = 0;
    for (const rel of files) {
        if (out.length >= limit) { break; }
        const abs = path.join(deps.wsRoot, rel);
        let content: string;
        try {
            const buf = fs.readFileSync(abs);
            if (looksBinary(buf)) { continue; }   // skip binaries silently
            content = buf.toString('utf8');
        } catch {
            continue;                              // skip unreadable files silently
        }
        scanned += 1;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (predicate(lines[i])) {
                out.push(`${rel}:${i + 1}:${lines[i]}`);
                if (out.length >= limit) { break; }
            }
        }
    }

    if (out.length === 0) {
        const kind = input.isRegex ? 'regex' : 'substring';
        return `No matches for ${kind} \`${input.searchText}\` (scanned ${scanned} file${scanned === 1 ? '' : 's'} ` +
               `matching \`${includePattern}\`).`;
    }
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Glob matching + Node-native walker (shared by findFiles + findTextInFiles
// in tests, and by findTextInFiles in production)
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a `RegExp` anchored on both ends.
 *
 * Supports:
 *   - `**`  — zero or more path segments (including `**` alone)
 *   - `*`   — zero or more chars within one segment (no slashes)
 *   - `?`   — exactly one non-slash char
 *   - `{a,b,c}` — alternation
 *   - literal chars (regex specials escaped)
 *
 * Deliberately does **not** handle character classes (`[abc]`), negation,
 * or POSIX extensions — they're rare in LLM-issued patterns and not worth
 * the complexity to support.
 */
export function globToRegExp(glob: string): RegExp {
    let re = '^';
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            // `**/` or `**` at end → optional path prefix / suffix
            const slash = glob[i + 2] === '/';
            re += slash ? '(?:.*/)?' : '.*';
            i += slash ? 3 : 2;
        } else if (c === '*') {
            re += '[^/]*';
            i += 1;
        } else if (c === '?') {
            re += '[^/]';
            i += 1;
        } else if (c === '{') {
            const close = glob.indexOf('}', i);
            if (close === -1) {
                re += '\\{';
                i += 1;
            } else {
                const alts = glob.slice(i + 1, close).split(',').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
                re += `(?:${alts.join('|')})`;
                i = close + 1;
            }
        } else if ('.+^${}()|[]\\'.includes(c)) {
            re += `\\${c}`;
            i += 1;
        } else {
            re += c;
            i += 1;
        }
    }
    re += '$';
    return new RegExp(re);
}

/**
 * Walk `root` recursively, returning workspace-relative paths that
 * match `pattern` and don't match `exclude`. Stops after `limit`
 * matches. `.git/` and `node_modules/` are always skipped — the
 * `exclude` parameter is folded on top of that for compatibility
 * with the vscode.workspace.findFiles signature.
 *
 * Returned paths are sorted ascending so the result is stable across
 * runs (vscode's findFiles is not).
 */
export async function nodeNativeWalker(
    root: string,
    pattern: string,
    exclude: string,
    limit: number,
): Promise<string[]> {
    const includeRe = globToRegExp(pattern);
    const excludeRe = exclude ? globToRegExp(exclude) : null;
    const matches: string[] = [];

    const stack: string[] = [root];
    while (stack.length > 0 && matches.length < limit * 2) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            const abs = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === 'node_modules' || ent.name === '.git') { continue; }
                stack.push(abs);
            } else if (ent.isFile()) {
                const rel = path.relative(root, abs).split(path.sep).join('/');
                if (includeRe.test(rel) && !(excludeRe && excludeRe.test(rel))) {
                    matches.push(rel);
                }
            }
        }
    }
    matches.sort();
    return matches.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clampLimit(value: number | undefined, defaultValue: number, hardMax: number): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) { return defaultValue; }
    return Math.min(Math.floor(n), hardMax);
}

// The LLM frequently passes `*` (or omits the field) intending "any
// file". `grep --include='*'` works recursively, but in glob terms
// `*` is single-segment and wouldn't match `src/foo/bar.ts`. Coerce
// to the recursive equivalent so the user intent survives.
//
// (Line comments rather than JSDoc here because the literal pattern
// contains `*` followed by `/` which closes a block comment.)
function normalizeFilePattern(pattern: string | undefined): string {
    if (!pattern || pattern === '*' || pattern === '**') { return '**/*'; }
    return pattern;
}

/**
 * Heuristic binary check: a null byte in the first 8 KB. Same trick
 * `git diff` uses for its `is_binary` shortcut.
 */
function looksBinary(buf: Buffer): boolean {
    const limit = Math.min(buf.length, 8192);
    for (let i = 0; i < limit; i++) {
        if (buf[i] === 0) { return true; }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Tool definitions (the thin executor wrapper lives in tool-executors.ts so
// it can pick up vscode.workspace at runtime; we just export the impls here)
// ---------------------------------------------------------------------------

export const READ_FILE_DESCRIPTION =
    'Read a UTF-8 text file. Paths are workspace-relative unless absolute. ' +
    'Optional `startLine`/`endLine` are 1-based and inclusive; out-of-range ' +
    'values clamp. Errors with a clear message if the path is a directory, ' +
    'missing, or outside the workspace. Binary files return their bytes ' +
    'interpreted as UTF-8 (may include replacement characters) — use a ' +
    'different tool for binary inspection.';

export const READ_FILE_TOOL: SharedToolDefinition<ReadFileInput> = {
    name: 'tomAi_readFile',
    displayName: 'Read File',
    description: READ_FILE_DESCRIPTION,
    tags: ['files', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'Workspace-relative or absolute path. Example: `src/extension.ts`.' },
            startLine: { type: 'number', description: '1-based start line (inclusive). Default 1.' },
            endLine: { type: 'number', description: '1-based end line (inclusive). Default = last line.' },
        },
        required: ['filePath'],
    },
    // The actual execute closure is installed by tool-executors.ts since
    // it needs to grab `vscode.workspace.workspaceFolders` at call time.
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

export const LIST_DIRECTORY_DESCRIPTION =
    'List the immediate children of a directory (non-recursive). Directory ' +
    'entries have a trailing `/`; entries are sorted alphabetically. Returns ' +
    'a clear message for empty directories. Errors if the path is a file, ' +
    'missing, or outside the workspace. For recursive search use `tomAi_findFiles`.';

export const LIST_DIRECTORY_TOOL: SharedToolDefinition<ListDirectoryInput> = {
    name: 'tomAi_listDirectory',
    displayName: 'List Directory',
    description: LIST_DIRECTORY_DESCRIPTION,
    tags: ['files', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            dirPath: { type: 'string', description: 'Workspace-relative or absolute directory path. Example: `src/tools`.' },
        },
        required: ['dirPath'],
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

export const FIND_FILES_DESCRIPTION =
    'Find files in the workspace by glob pattern. Use `**/` for recursive ' +
    'matching: `**/*.ts` finds every .ts file, while bare `*.ts` only matches ' +
    'files at the workspace root. `**/node_modules/**` is always excluded. ' +
    'Returns workspace-relative paths, one per line, up to `maxResults` ' +
    '(default 100, hard max 1000). Brace expansion (`**/*.{ts,tsx}`) is ' +
    'supported. For text search inside files use `tomAi_findTextInFiles`.';

export const FIND_FILES_TOOL: SharedToolDefinition<FindFilesInput> = {
    name: 'tomAi_findFiles',
    displayName: 'Find Files',
    description: FIND_FILES_DESCRIPTION,
    tags: ['files', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'Glob pattern. Examples: `**/*.ts`, `src/**/*.{ts,tsx}`, `_ai/quests/**/overview*.md`.',
            },
            maxResults: { type: 'number', description: 'Maximum results to return (default 100, max 1000).' },
        },
        required: ['pattern'],
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

export const FIND_TEXT_IN_FILES_DESCRIPTION =
    'Search file contents. `searchText` is treated as a literal substring ' +
    'unless `isRegex: true`. `filePattern` is a glob restricting the file set ' +
    '(default `**/*` — every text file under the workspace, recursive). ' +
    'Output rows are `path:line:matched-line`, up to `maxResults` (default 50, ' +
    'hard max 1000). Binary files (null byte in first 8 KB) are skipped. ' +
    '`.gitignore` is not consulted — pass a tight `filePattern` for large ' +
    'workspaces. `node_modules/` and `.git/` are always skipped.';

export const FIND_TEXT_IN_FILES_TOOL: SharedToolDefinition<FindTextInFilesInput> = {
    name: 'tomAi_findTextInFiles',
    displayName: 'Find Text in Files',
    description: FIND_TEXT_IN_FILES_DESCRIPTION,
    tags: ['files', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            searchText: { type: 'string', description: 'Substring (default) or regex pattern (when `isRegex: true`).' },
            filePattern: {
                type: 'string',
                description: 'Glob restricting which files to scan. Examples: `**/*.ts`, `src/**/*.dart`. Default `**/*`.',
            },
            isRegex: { type: 'boolean', description: 'Treat `searchText` as a JavaScript regex. Default false.' },
            maxResults: { type: 'number', description: 'Maximum matching lines (default 50, max 1000).' },
        },
        required: ['searchText'],
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

/**
 * Tools exported as a group so `tool-executors.ts` can spread them
 * into `ALL_SHARED_TOOLS` after installing the live executor closures.
 */
export const FILE_PRIMITIVE_TOOLS = [
    READ_FILE_TOOL,
    LIST_DIRECTORY_TOOL,
    FIND_FILES_TOOL,
    FIND_TEXT_IN_FILES_TOOL,
];
