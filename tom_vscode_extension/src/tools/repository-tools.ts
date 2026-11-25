/**
 * `tomAi_listRepositories` — the repositories of the Tom root's `repos.yaml`
 * (schema `.tom/json-schema/repos/repos.schema.json`): where each lives, its
 * remote, its kind, the branch it follows or the SHA it is pinned to, its
 * description, whether it is cloned on this machine, the workspace folder it is in, and (on
 * request) the buildkit projects inside it.
 *
 * Read-only, on the MCP read-only floor. The implementation reads through a
 * narrow {@link RepositorySource}, so the tests run it on a sandbox root.
 *
 * - `path` is root-relative with `/`, as repos.yaml writes it; `name` its last
 *   segment.
 * - `workspaceFolder`: the deepest workspace folder of the root (a folder with
 *   an `_ai` entry and a `.tom` or CLAUDE.md, utils/workspaceRegistry.ts) the
 *   repository is in or is; absent when none.
 * - `projects` (`includeProjects`): the ids of the projects of the same listing
 *   tomAi_listProjects answers, each given to the deepest repository holding its
 *   folder (a project of a nested repository is not also its parent's).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { SharedToolDefinition } from './shared-tool-registry';
import type { ProjectListing } from '../services/workspaceProjects';

/** The file looked for at the root. */
export const REPOS_FILE = 'repos.yaml';

/** The repository kinds of repos.yaml. */
export const REPOSITORY_KINDS = ['code', 'fork', 'ai', 'binaries', 'upstream'] as const;
export type RepositoryKind = typeof REPOSITORY_KINDS[number];

export interface ListRepositoriesInput {
    /** Only this kind. */
    kind?: RepositoryKind;
    /** Only repositories whose root-relative path is this path or below it. */
    under?: string;
    /** Add the buildkit project ids inside each repository. */
    includeProjects?: boolean;
}

export interface RepositoryEntry {
    path: string;
    name: string;
    url: string;
    kind: string;
    branch?: string;
    pin?: string;
    /** The entry's `description:` (one line: what the repository holds and what it is for). */
    description?: string;
    cloned: boolean;
    workspaceFolder?: string;
    projects?: string[];
}

/** The root repository of repos.yaml (its `root:` record). */
export interface RootRepositoryEntry {
    path: '.';
    url?: string;
    branch?: string;
    description?: string;
    cloned: true;
}

/** repos.yaml read: the root record and every valid entry, in file order. */
export interface ReposFile {
    root: string;
    file: string;
    rootRepository: RootRepositoryEntry;
    entries: RepositoryEntry[];
    /** The raw `repos:` paths (for the project assignment), valid or not. */
    allPaths: string[];
    /** Entries left out: `repos[<i>]: needs path, url and kind`. */
    skipped: string[];
}

/** What the tool reads, live or in a test. */
export interface RepositorySource {
    /** The Tom root (the window layout's root); undefined without a workspace. */
    root(): string | undefined;
    /** A file's text; undefined when it cannot be read. */
    readText(file: string): string | undefined;
    /** Whether a folder exists. */
    isDirectory(dir: string): boolean;
    /** The root's workspace folders, root-relative with `/` (`.` for the root itself). */
    workspaceFolders(): string[];
    /** The project listing of tomAi_listProjects. */
    readProjects(): Promise<ProjectListing>;
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** `under` as a root-relative prefix: `/` separators, no leading `./` or `/`, no trailing `/`. */
export function normalizeUnder(under: string): string {
    return toPosix(under.trim()).replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Whether `p` is `prefix` or below it (whole segments). */
export function isAtOrUnder(p: string, prefix: string): boolean {
    return prefix === '' || prefix === '.' || p === prefix || p.startsWith(`${prefix}/`);
}

/** The deepest of `folders` that `p` is or is below; undefined when none. */
export function deepestContaining(p: string, folders: readonly string[]): string | undefined {
    let best: string | undefined;
    for (const f of folders) {
        if (f === '.' || isAtOrUnder(p, f)) {
            if (best === undefined || best === '.' || (f !== '.' && f.length > best.length)) { best = f; }
        }
    }
    return best;
}

const err = (error: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ ok: false, error, ...extra }, null, 2);

/**
 * Read the Tom root's repos.yaml. `{ok: false, error, file?}` without a root, without the file, or when it does not
 * parse or has no `repos:` list; `missing: true` when the file is not there.
 */
export function readReposFile(src: RepositorySource): ({ ok: true } & ReposFile) | { ok: false; error: string; file?: string; missing?: boolean } {
    const root = src.root();
    if (!root) { return { ok: false, error: 'no workspace folder is open, so there is no Tom root to read repos.yaml from' }; }
    const file = path.join(root, REPOS_FILE);
    const text = src.readText(file);
    if (text === undefined) { return { ok: false, error: `no repos.yaml at the Tom root: ${file}`, file, missing: true }; }
    let doc: unknown;
    try { doc = parseYaml(text); } catch (e) { return { ok: false, error: `repos.yaml does not parse: ${(e as Error).message}`, file }; }
    const record = doc && typeof doc === 'object' ? doc as { repos?: unknown; root?: unknown } : {};
    const repos = record.repos;
    if (!Array.isArray(repos)) { return { ok: false, error: 'repos.yaml has no `repos:` list', file }; }
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
    const rootRec = record.root && typeof record.root === 'object' ? record.root as Record<string, unknown> : {};
    const rootRepository: RootRepositoryEntry = {
        path: '.',
        ...(str(rootRec.url) ? { url: str(rootRec.url) } : {}),
        ...(str(rootRec.branch) ? { branch: str(rootRec.branch) } : {}),
        ...(str(rootRec.description) ? { description: str(rootRec.description) } : {}),
        cloned: true,
    };
    const folders = src.workspaceFolders();
    const skipped: string[] = [];
    const entries: RepositoryEntry[] = [];
    repos.forEach((r, i) => {
        const rec = r && typeof r === 'object' ? r as Record<string, unknown> : undefined;
        const p = typeof rec?.path === 'string' ? toPosix(rec.path).replace(/\/+$/, '') : '';
        if (!rec || !p || typeof rec.url !== 'string' || typeof rec.kind !== 'string') {
            skipped.push(`repos[${i}]: needs path, url and kind`);
            return;
        }
        const folder = deepestContaining(p, folders);
        entries.push({
            path: p,
            name: p.split('/').pop() ?? p,
            url: rec.url,
            kind: rec.kind,
            ...(typeof rec.branch === 'string' ? { branch: rec.branch } : {}),
            ...(typeof rec.pin === 'string' ? { pin: rec.pin } : {}),
            ...(str(rec.description) ? { description: str(rec.description) } : {}),
            cloned: src.isDirectory(path.join(root, ...p.split('/'))),
            ...(folder !== undefined ? { workspaceFolder: folder } : {}),
        });
    });
    const allPaths = repos
        .map((r) => (r && typeof r === 'object' && typeof (r as { path?: unknown }).path === 'string' ? toPosix((r as { path: string }).path) : ''))
        .filter(Boolean);
    return { ok: true, root, file, rootRepository, entries, allPaths, skipped };
}

/**
 * tomAi_getWorkspaceInfo's `include: ["repos"]`: the root and every entry of repos.yaml with its description;
 * null when there is no repos.yaml (or no root), `{error, file}` when it cannot be read.
 */
export function workspaceRepos(src: RepositorySource): Record<string, unknown> | null {
    const read = readReposFile(src);
    if (!read.ok) {
        if (read.missing || read.file === undefined) { return null; }
        return { file: read.file, error: read.error };
    }
    return {
        file: read.file,
        root: { ...read.rootRepository, absolutePath: read.root },
        count: read.entries.length,
        ...(read.skipped.length ? { skipped: read.skipped } : {}),
        repositories: read.entries,
    };
}

export async function listRepositoriesImpl(src: RepositorySource, input: ListRepositoriesInput): Promise<string> {
    if (input.kind !== undefined && !(REPOSITORY_KINDS as readonly string[]).includes(input.kind)) {
        return err(`unknown kind "${String(input.kind)}"; one of ${REPOSITORY_KINDS.join(', ')}`);
    }
    const read = readReposFile(src);
    if (!read.ok) { return err(read.error, read.file !== undefined ? { file: read.file } : {}); }
    const { root, file, skipped } = read;
    const under = input.under !== undefined ? normalizeUnder(input.under) : undefined;
    let entries = read.entries;
    if (input.kind !== undefined) { entries = entries.filter((e) => e.kind === input.kind); }
    if (under !== undefined) { entries = entries.filter((e) => isAtOrUnder(e.path, under)); }

    let projectsNote: Record<string, unknown> = {};
    if (input.includeProjects) {
        const listing = await src.readProjects();
        if (!listing.ok) {
            projectsNote = { projectsError: listing.error };
        } else {
            // Every repository of the file (not only the filtered ones) competes, so a project of a nested
            // repository is never given to its parent.
            const allPaths = read.allPaths;
            const byRepo = new Map<string, string[]>();
            for (const project of listing.projects) {
                const rel = toPosix(path.relative(root, project.absolutePath));
                if (rel.startsWith('..')) { continue; }
                const owner = deepestContaining(rel, allPaths);
                if (owner === undefined || owner === '.') { continue; }
                byRepo.set(owner, [...(byRepo.get(owner) ?? []), project.id]);
            }
            entries = entries.map((e) => ({ ...e, projects: [...(byRepo.get(e.path) ?? [])].sort() }));
            if (listing.source === 'javascript') { projectsNote = { projectsFallback: listing.fallback }; }
        }
    }

    return JSON.stringify({
        ok: true,
        root,
        file,
        count: entries.length,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(under !== undefined ? { under } : {}),
        ...projectsNote,
        ...(skipped.length ? { skipped } : {}),
        repositories: entries,
    }, null, 2);
}

export const LIST_REPOSITORIES_DESCRIPTION =
    'List the repositories of the Tom root\'s `repos.yaml` (schema `.tom/json-schema/repos/repos.schema.json`): ' +
    'answers `{ok, root, file, count, repositories: [{path, name, url, kind, branch?, pin?, description?, cloned, ' +
    'workspaceFolder?, projects?}]}` — `path` root-relative with `/`, `name` its last segment, `kind` code / fork / ai / ' +
    'binaries / upstream, `branch` the branch it follows (an upstream has none), `pin` the SHA an upstream is pinned to, ' +
    '`description` what it holds and is for (one line), `cloned` ' +
    'whether its folder exists on this machine, `workspaceFolder` the root\'s workspace folder it is in (absent when ' +
    'none). Filters: `kind`, `under` (a root-relative path: that repository and those below it). `includeProjects: ' +
    'true` adds `projects`, the ids of the buildkit projects inside each repository (the listing of ' +
    'tomAi_listProjects; a project of a nested repository counts for that one only). Without repos.yaml: `{ok: false, ' +
    'error, file}` naming the file looked for. Read-only.';

export const LIST_REPOSITORIES_TOOL_DEF: SharedToolDefinition<ListRepositoriesInput> = {
    name: 'tomAi_listRepositories',
    displayName: 'List Repositories',
    description: LIST_REPOSITORIES_DESCRIPTION,
    tags: ['workspace', 'repositories', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            kind: { type: 'string', enum: [...REPOSITORY_KINDS], description: 'Only repositories of this kind.' },
            under: { type: 'string', description: 'A root-relative path: only that repository and the repositories below it.' },
            includeProjects: { type: 'boolean', description: 'Add the buildkit project ids inside each repository. Default false.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() is installed below"}',
};

// ---------------------------------------------------------------------------
// The live source: the window layout's root, the file system, the root's
// workspace folders, tomAi_listProjects' listing.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-require-imports -- loaded on use: the layout module reads the vscode settings */
export const liveRepositorySource: RepositorySource = {
    root() {
        const { getLayout } = require('../utils/workspaceLayout.js') as typeof import('../utils/workspaceLayout');
        return getLayout()?.root;
    },
    readText(file) {
        try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
    },
    isDirectory(dir) {
        try { return fs.statSync(dir).isDirectory(); } catch { return false; }
    },
    workspaceFolders() {
        const root = this.root();
        if (!root) { return []; }
        const { scanWorkspaceFolders } = require('../utils/workspaceRegistry.js') as typeof import('../utils/workspaceRegistry');
        return scanWorkspaceFolders(root).map(toPosix);
    },
    readProjects() {
        const { WsPaths } = require('../utils/workspacePaths.js') as typeof import('../utils/workspacePaths');
        const { listWorkspaceProjects } = require('../services/workspaceProjects.js') as typeof import('../services/workspaceProjects');
        const wsRoot = WsPaths.wsRoot;
        if (!wsRoot) { return Promise.resolve({ ok: false, error: 'no workspace folder is open' }); }
        return listWorkspaceProjects(wsRoot);
    },
};
/* eslint-enable @typescript-eslint/no-require-imports */

export const LIST_REPOSITORIES_TOOL: SharedToolDefinition<ListRepositoriesInput> = {
    ...LIST_REPOSITORIES_TOOL_DEF,
    execute: (input) => listRepositoriesImpl(liveRepositorySource, input ?? {}),
};
