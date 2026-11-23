/**
 * Quest + project introspection tools — carved out of
 * `chat-enhancement-tools.ts` for coverage entry #23.
 *
 *   - `tomAi_getActiveQuest`  — resolves the current quest from the
 *                               open .code-workspace filename.
 *   - `tomAi_listQuests`      — the window's workspace quests
 *                               (`_ai/workspaces/<workspace>.yaml`), or
 *                               every quest folder under `_ai/quests/`.
 *   - `tomAi_listProjects`    — the workspace's projects as buildkit
 *                               sees them (`buildkit :projects --all --json`).
 *   - `tomAi_listDocuments`   — walks a workspace document category
 *                               folder (prompts / answers / notes /
 *                               roles / guidelines).
 *
 * ## Why a separate file
 *
 * The original implementations lived inside `chat-enhancement-tools.ts`,
 * reached straight into `vscode.workspace.workspaceFile`, `fs`, the
 * workspace YAML parser, and `WsPaths.*` — making them impossible to
 * unit-test without the editor.  This carve-out splits the four tools
 * across three narrow source interfaces (`QuestSource`,
 * `ProjectSource`, `DocumentSource`), each implementable by an
 * in-memory fake.  The vscode-bound bridge stays in
 * `chat-enhancement-tools.ts`.
 *
 * ## Audit notes (checklist b), _copilot_guidelines/tool_testing.md)
 *
 *   - Quest id format: free-form, must match the directory name under
 *     `_ai/quests/*`.  No regex enforced — whatever VS Code accepts as
 *     a folder name + whatever the user picks for the .code-workspace
 *     filename round-trips through these tools.
 *   - Project "path" format: workspace-relative with `/` separators, as
 *     buildkit's listing reports it (services/workspaceProjects.ts).
 *   - `listDocuments` returns *every* file in the resolved folder
 *     (recursive), not just markdown.  Filtering by extension would
 *     be a behaviour change; tools doing it can post-filter the array.
 *   - `subPath` on `listDocuments` is traversal-guarded — any
 *     normalised path that escapes the category folder is rejected.
 */

import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import type { WorkspaceQuests } from '../utils/aiWorkspace';
import { PROJECTS_SOURCE, PROJECTS_SOURCE_JS, type ProjectListing, type WorkspaceProject } from '../services/workspaceProjects';

// ===========================================================================
// Narrow deps
// ===========================================================================

/**
 * Workspace quest folder lookup.  In production this is wired through
 * `WsPaths.getWorkspaceQuestId()` + the on-disk `_ai/quests/` walk;
 * tests pass a fake.
 */
export interface QuestSource {
    /**
     * The quest id derived from the open `.code-workspace` filename
     * (extension stripped), or `'default'` when no workspace file is
     * open.  This is the only source of truth for the active quest.
     */
    getActiveQuestId(): string;
    /** `true` when `_ai/quests/<questId>/` exists on disk. */
    questFolderExists(questId: string): boolean;
    /** Directory names under `_ai/quests/` (sorted). */
    listQuestIds(): string[];
    /** Inspection helpers for `tomAi_listQuests`'s `includeOverview` branch. */
    hasOverviewFile(questId: string): boolean;
    listTodoFiles(questId: string): string[];
    /** Workspace-relative path string for the quest folder, used in responses. */
    questFolderRelative(questId: string): string;
    /** The window's AI workspace and its quests (utils/aiWorkspace.ts); undefined: no workspace (every quest). */
    workspaceQuests?(): WorkspaceQuests | undefined;
    /** The text of `short_description.<quest>.md` (vscimpb145). */
    shortDescription?(questId: string): string | undefined;
}

/** The workspace's projects for `tomAi_listProjects` (services/workspaceProjects.ts; a fake in tests). */
export interface ProjectSource {
    readProjects(): Promise<ProjectListing>;
}

/** One project: `{id, name, path, absolutePath, language, type, natures, version?, description?}`. */
export type ProjectInfo = WorkspaceProject;

/** Category folder resolver + filesystem walker for `tomAi_listDocuments`. */
export interface DocumentSource {
    /**
     * Map a `category` enum value to its category folder.  Returns
     * `undefined` when the workspace isn't open.  `relative` is the
     * workspace-relative path for use in response envelopes;
     * `absolute` is what the walker is given.
     */
    resolveCategoryFolder(category: DocumentCategory): { absolute: string; relative: string } | undefined;
    /**
     * Recursive file walk under `absoluteFolder`, returning paths
     * relative to `absoluteFolder`.  Hidden entries (`.foo`) are
     * skipped.  Missing folder → `{ exists: false, files: [] }`.
     */
    listFilesRecursive(absoluteFolder: string): { exists: boolean; files: string[] };
}

export type DocumentCategory = 'prompts' | 'answers' | 'notes' | 'roles' | 'guidelines';

// ===========================================================================
// Inputs
// ===========================================================================

export interface GetActiveQuestInput {
    // no parameters
}

export interface ListQuestsInput {
    /** When `true`, each entry also carries `overviewFile` and `todoFileCount`. */
    includeOverview?: boolean;
    /** `workspace` (default): the window's workspace quests; `all`: every quest. */
    scope?: 'workspace' | 'all';
    /** Every quest (the same as `scope: "all"`). */
    all?: boolean;
}

export interface ListProjectsInput {
    /** Only projects at or below this workspace-relative path (whole segments; `./` and a trailing `/` ignored). */
    under?: string;
    /** Only projects of this language (`dart`, `typescript`, ...; any case). */
    language?: string;
    /** Only projects of this primary nature (`dart_package`, `flutter`, ...; any case). */
    type?: string;
    /** Only projects whose id, name or path contains this text (any case). */
    name?: string;
    /** Each entry only `{id, path, type}`. */
    compact?: boolean;
}

/** A project as `compact: true` answers it. */
export interface CompactProjectInfo { id: string; path: string; type: string }

/** Whether `input` narrows or shortens the answer. */
export function projectFiltersGiven(input: ListProjectsInput): boolean {
    return [input.under, input.language, input.type, input.name].some((v) => typeof v === 'string' && v.trim() !== '') || input.compact === true;
}

/**
 * The projects `input` keeps, in listing order: `under` (the path or below it, whole segments), `language` and
 * `type` (equal, any case), `name` (a substring of id, name or path, any case). Empty strings filter nothing.
 */
export function filterProjects(projects: readonly WorkspaceProject[], input: ListProjectsInput): WorkspaceProject[] {
    const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const under = text(input.under).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    const language = text(input.language).toLowerCase();
    const type = text(input.type).toLowerCase();
    const name = text(input.name).toLowerCase();
    return projects.filter((p) => {
        if (under && under !== '.' && p.path !== under && !p.path.startsWith(`${under}/`)) { return false; }
        if (language && p.language.toLowerCase() !== language) { return false; }
        if (type && p.type.toLowerCase() !== type) { return false; }
        if (name && ![p.id, p.name, p.path].some((v) => v.toLowerCase().includes(name))) { return false; }
        return true;
    });
}

/** The answer's entries: every field, or with `compact` only `{id, path, type}`. */
export function projectEntries(projects: readonly WorkspaceProject[], compact: boolean | undefined): Array<WorkspaceProject | CompactProjectInfo> {
    return compact ? projects.map((p) => ({ id: p.id, path: p.path, type: p.type })) : [...projects];
}

export interface ListDocumentsInput {
    category: DocumentCategory;
    /** Optional sub-path inside the category folder.  Traversal-guarded. */
    subPath?: string;
}

// ===========================================================================
// JSON-envelope helpers
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }, null, 2); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra }, null, 2);
}

// ===========================================================================
// `tomAi_getActiveQuest`
// ===========================================================================

export async function getActiveQuestImpl(quests: QuestSource, _input: GetActiveQuestInput): Promise<string> {
    try {
        const rawId = quests.getActiveQuestId();
        const isDefault = rawId === 'default' || !rawId;
        const folderExists = !isDefault && quests.questFolderExists(rawId);
        const active = !isDefault && folderExists ? rawId : null;
        return ok({
            active,
            rawId,
            questFolderExists: folderExists,
            questFolder: !isDefault ? quests.questFolderRelative(rawId) : null,
            source: 'workspace_file',
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const GET_ACTIVE_QUEST_DESCRIPTION =
    'Return the currently active quest. Discovery: reads the open ' +
    '`.code-workspace` filename, strips the `.code-workspace` suffix, and ' +
    'treats `"default"` (or an empty name) as "no quest". The tool ' +
    'additionally checks that `_ai/quests/<id>/` exists on disk — if the ' +
    'folder is missing, `active` is `null` even when the workspace filename ' +
    'is non-default. Response: `{ok, active, rawId, questFolderExists, ' +
    'questFolder, source}`. `active` is the resolved quest id or `null`; ' +
    '`rawId` is the workspace-file basename verbatim (useful for diagnosing ' +
    '"why isn\'t my quest active"); `questFolder` is workspace-relative ' +
    '(`_ai/quests/<id>`). Use `tomAi_listQuests` to see what folders actually ' +
    'exist, and `tomAi_getWorkspaceInfo` (`include: ["workspaceFolders", "quests"]`) for the workspace folders ' +
    'and the folder each quest was opened in.';

export const GET_ACTIVE_QUEST_TOOL: SharedToolDefinition<GetActiveQuestInput> = {
    name: 'tomAi_getActiveQuest',
    displayName: 'Get Active Quest',
    description: GET_ACTIVE_QUEST_DESCRIPTION,
    tags: ['workspace', 'context', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_listQuests`
// ===========================================================================

export async function listQuestsImpl(quests: QuestSource, input: ListQuestsInput): Promise<string> {
    try {
        const all = quests.listQuestIds();
        const scope: 'workspace' | 'all' = input.all === true || input.scope === 'all' ? 'all' : 'workspace';
        const ws = quests.workspaceQuests?.();
        const ids = scope === 'all' || !ws ? all : ws.quests;
        const entries = ids.map((id) => {
            const shortDescription = quests.shortDescription?.(id);
            return {
                id,
                ...(shortDescription !== undefined ? { shortDescription } : {}),
                ...(input.includeOverview ? {
                    overviewFile: quests.hasOverviewFile(id) ? `overview.${id}.md` : null,
                    todoFileCount: quests.listTodoFiles(id).length,
                } : {}),
            };
        });
        return ok({
            discoveredFrom: '_ai/quests/*',
            scope,
            workspace: ws?.workspace ?? null,
            ...(ws ? {
                workspaceFile: `${quests.questFolderRelative('').replace(/\/quests\/?$/, '')}/workspaces/${ws.workspace}.yaml`,
                workspaceSource: ws.source,
                listApplied: scope === 'workspace' && ws.source === 'list',
                ...(ws.unknown.length ? { unknownQuests: ws.unknown } : {}),
                ...(ws.error ? { workspaceFileError: ws.error } : {}),
            } : {}),
            allCount: all.length,
            count: entries.length,
            quests: entries,
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_QUESTS_DESCRIPTION =
    'List the quests (folders under `_ai/quests/`), by default the window\'s workspace quests: the ' +
    '`quests` list of `_ai/workspaces/<workspace>.yaml` (`<workspace>` the window\'s root folder name; ' +
    'edited in the AI Workspace Quests editor), else the quests whose recorded workspace folder is this window\'s, ' +
    'else every quest. `all: true` (or `scope: "all"`) lists ' +
    'every quest. Answers `{ok, scope, workspace, workspaceFile, workspaceSource (list | recorded | all), ' +
    'listApplied, unknownQuests (listed but missing), allCount, count, quests: [{id, shortDescription}]}` ' +
    '— `shortDescription` the text of `short_description.<quest>.md`; `includeOverview: true` adds ' +
    '`overviewFile` (`overview.<id>.md` or null) and `todoFileCount`. Alphabetical, or the list\'s order. ' +
    'The workspace folders and each quest\'s recorded folder: `tomAi_getWorkspaceInfo` with `include`.';

export const LIST_QUESTS_TOOL: SharedToolDefinition<ListQuestsInput> = {
    name: 'tomAi_listQuests',
    displayName: 'List Quests',
    description: LIST_QUESTS_DESCRIPTION,
    tags: ['quest', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            includeOverview: {
                type: 'boolean',
                description: 'When true, each entry also carries `overviewFile` and `todoFileCount`. Default false.',
            },
            scope: {
                type: 'string',
                enum: ['workspace', 'all'],
                description: '`workspace` (default): the window\'s workspace quests; `all`: every quest.',
            },
            all: {
                type: 'boolean',
                description: 'Every quest (the same as `scope: "all"`). Default false.',
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_listProjects`
// ===========================================================================

export async function listProjectsImpl(projectsSrc: ProjectSource, input: ListProjectsInput = {}): Promise<string> {
    try {
        const result = await projectsSrc.readProjects();
        // The filters and the compact form, on buildkit's listing and the JavaScript port's alike. Unfiltered: the
        // answer as it always was; filtered: `count` the projects answered, `total` the whole listing.
        const filtered = projectFiltersGiven(input);
        const shaped = (all: WorkspaceProject[]): Record<string, unknown> => {
            const kept = filterProjects(all, input);
            return filtered
                ? { count: kept.length, total: all.length, projects: projectEntries(kept, input.compact) }
                : { count: all.length, projects: all };
        };
        if (!result.ok) {
            return err(result.error, {
                discoveredFrom: PROJECTS_SOURCE,
                ...(result.binary ? { binary: result.binary } : {}),
                ...(result.searched ? { searched: result.searched } : {}),
                projects: [],
            });
        }
        if (result.source === 'javascript') {
            // buildkit was not found or could not list: the extension's JavaScript port (qrfix14), and why.
            return ok({
                discoveredFrom: PROJECTS_SOURCE_JS,
                fallback: result.fallback,
                root: result.root,
                ...shaped(result.projects),
            });
        }
        return ok({
            discoveredFrom: PROJECTS_SOURCE,
            binary: result.binary,
            root: result.root,
            ...shaped(result.projects),
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_PROJECTS_DESCRIPTION =
    'List the workspace\'s projects as the build tools see them, from ' +
    '`buildkit :projects --all --json` run in the workspace root: every Dart, ' +
    'Flutter, TypeScript, JavaScript, Python, Java, Go, Rust, C and C++ ' +
    'project of the tree (not: folders under a skip marker, projects nested ' +
    'inside another project, `zom_` test projects). Each entry: `{id, name, path, absolutePath, language, type, ' +
    'natures, version?, description?}` — `path` workspace-relative with `/`, ' +
    '`type` the primary nature (e.g. `flutter`, `dart_package`). Answer `{ok, ' +
    'discoveredFrom, binary, root, count, projects}`. Filters (optional, ' +
    'combined): `under` (a workspace-relative path: the projects at or below ' +
    'it), `language`, `type` (any case), `name` (a substring of id, name or ' +
    'path); `compact: true`: each entry only `{id, path, type}`. With any of ' +
    'them the answer adds `total`, the whole listing\'s count. Without a ' +
    'buildkit that can list, the extension\'s JavaScript port of the same rules ' +
    'lists them (filtered the same way), with `fallback` `{kind, reason, ' +
    'searched, hint}`. Cached 30 s. Where buildkit is looked for, and more: tomAi_describeTool.';

export const LIST_PROJECTS_TOOL: SharedToolDefinition<ListProjectsInput> = {
    name: 'tomAi_listProjects',
    displayName: 'List Projects',
    description: LIST_PROJECTS_DESCRIPTION,
    tags: ['workspace', 'projects', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            under: { type: 'string', description: 'Only projects at or below this workspace-relative path (whole segments).' },
            language: { type: 'string', description: 'Only projects of this language, e.g. `dart`, `typescript` (any case).' },
            type: { type: 'string', description: 'Only projects of this primary nature, e.g. `dart_package`, `flutter` (any case).' },
            name: { type: 'string', description: 'Only projects whose id, name or path contains this text (any case).' },
            compact: { type: 'boolean', description: 'Each entry only `{id, path, type}`. Default false.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_listDocuments`
// ===========================================================================

const CATEGORY_FOLDER_LABEL: Record<DocumentCategory, string> = {
    prompts:    '_ai/prompt',
    answers:    '_ai/answers/copilot',
    notes:      '_ai/notes',
    roles:      '_ai/roles',
    // The workspace folder's guidelines folder (else the root's), under either name.
    guidelines: '_agent_guidelines (or _copilot_guidelines)',
};

/**
 * Path-traversal guard: rejects sub-paths that, after normalisation,
 * escape the category folder.  Returns the normalised join, or
 * `undefined` when traversal is detected.
 */
function safeJoinSubPath(absoluteFolder: string, subPath: string): string | undefined {
    if (path.isAbsolute(subPath)) { return undefined; }
    const joined = path.normalize(path.join(absoluteFolder, subPath));
    // Both ends must share the absolute prefix.  We resolve both to
    // canonical form to handle `..`, `./`, trailing slashes, etc.
    const folderResolved = path.resolve(absoluteFolder);
    const joinedResolved = path.resolve(joined);
    if (joinedResolved !== folderResolved && !joinedResolved.startsWith(folderResolved + path.sep)) {
        return undefined;
    }
    return joinedResolved;
}

export async function listDocumentsImpl(docs: DocumentSource, input: ListDocumentsInput): Promise<string> {
    try {
        if (!input.category) {
            return err('`category` is required (one of: prompts, answers, notes, roles, guidelines).');
        }
        const resolved = docs.resolveCategoryFolder(input.category);
        if (!resolved) {
            return err('Workspace not open — no category folder to resolve.', { category: input.category, files: [] });
        }
        let target = resolved.absolute;
        let displayRelative = resolved.relative;
        const subPath = (input.subPath ?? '').trim();
        if (subPath) {
            const safe = safeJoinSubPath(resolved.absolute, subPath);
            if (!safe) {
                return err('`subPath` escapes the category folder (traversal rejected).', {
                    category: input.category,
                    subPath,
                });
            }
            target = safe;
            displayRelative = path.posix.join(resolved.relative, subPath.replace(/\\/g, '/'));
        }
        const walk = docs.listFilesRecursive(target);
        if (!walk.exists) {
            return ok({
                category: input.category,
                categoryFolder: CATEGORY_FOLDER_LABEL[input.category],
                resolvedFolder: displayRelative,
                exists: false,
                fileCount: 0,
                files: [],
            });
        }
        return ok({
            category: input.category,
            categoryFolder: CATEGORY_FOLDER_LABEL[input.category],
            resolvedFolder: displayRelative,
            exists: true,
            fileCount: walk.files.length,
            files: walk.files,
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_DOCUMENTS_DESCRIPTION =
    'Recursively list files in a workspace document category folder. ' +
    'Category → folder mapping: `prompts` → `_ai/prompt`, `answers` → ' +
    '`_ai/answers/copilot`, `notes` → `_ai/notes`, `roles` → `_ai/roles`, ' +
    '`guidelines` → the workspace folder\'s guidelines folder (`_agent_guidelines`, ' +
    'or the older `_copilot_guidelines`; else the root\'s; the global guideline ' +
    'tools read both levels). The walk returns **every** file ' +
    '(not only `.md`) under the resolved folder; hidden entries (`.foo`) ' +
    'are skipped. Paths in the response are relative to the category root ' +
    'and posix-style. Optional `subPath` narrows the walk to a sub-folder ' +
    '— traversal-guarded, so `subPath: "../etc"` is rejected with a clear ' +
    'error instead of leaking out of the workspace. When the resolved ' +
    'folder doesn\'t exist on disk, `exists: false` + `files: []` (this is ' +
    'NOT an error). Caller filters by extension client-side if needed.';

export const LIST_DOCUMENTS_TOOL: SharedToolDefinition<ListDocumentsInput> = {
    name: 'tomAi_listDocuments',
    displayName: 'List Documents',
    description: LIST_DOCUMENTS_DESCRIPTION,
    tags: ['documents', 'files', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['category'],
        properties: {
            category: {
                type: 'string',
                enum: ['prompts', 'answers', 'notes', 'roles', 'guidelines'],
                description: 'prompts → _ai/prompt; answers → _ai/answers/copilot; notes → _ai/notes; roles → _ai/roles; guidelines → the workspace folder\'s guidelines folder (_agent_guidelines or _copilot_guidelines).',
            },
            subPath: {
                type: 'string',
                description: 'Optional sub-path inside the category folder. Traversal-guarded — paths escaping the category root are rejected.',
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};
