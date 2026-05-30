/**
 * Quest + project introspection tools — carved out of
 * `chat-enhancement-tools.ts` for coverage entry #23.
 *
 *   - `tomAi_getActiveQuest`  — resolves the current quest from the
 *                               open .code-workspace filename.
 *   - `tomAi_listQuests`      — enumerates quest folders under
 *                               `_ai/quests/`.
 *   - `tomAi_listProjects`    — reads the projects array from
 *                               `.tom_metadata/tom_master.yaml`.
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
 * ## Audit notes (b-row asks of the coverage doc)
 *
 *   - Quest id format: free-form, must match the directory name under
 *     `_ai/quests/*`.  No regex enforced — whatever VS Code accepts as
 *     a folder name + whatever the user picks for the .code-workspace
 *     filename round-trips through these tools.
 *   - Project "path" format: workspace-relative, as recorded verbatim
 *     in `.tom_metadata/tom_master.yaml`.  No normalisation.
 *   - `listDocuments` returns *every* file in the resolved folder
 *     (recursive), not just markdown.  Filtering by extension would
 *     be a behaviour change; tools doing it can post-filter the array.
 *   - `subPath` on `listDocuments` is traversal-guarded — any
 *     normalised path that escapes the category folder is rejected.
 */

import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

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
}

/** `.tom_metadata/tom_master.yaml` reader for `tomAi_listProjects`. */
export interface ProjectSource {
    /**
     * Read the master metadata file.  Returns the absolute path the
     * read was attempted from + a parsed-projects list, or `found:
     * false` when the file is missing.
     */
    readProjects(): {
        found: boolean;
        masterPath: string;
        projects: ProjectInfo[];
    };
}

export interface ProjectInfo {
    /** Stable identifier; falls back to `name` if `id` is absent in YAML. */
    id: string;
    /** Display name; falls back to `id` if `name` is absent in YAML. */
    name: string;
    /** Workspace-relative path as recorded in the YAML (verbatim). */
    path: string;
    /** Project type when present in YAML (e.g. `dart-package`, `flutter-app`). */
    type?: string;
}

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
    /** When `true`, each entry becomes `{id, overviewFile, todoFileCount}` instead of a bare id. */
    includeOverview?: boolean;
}

export interface ListProjectsInput {
    // no parameters
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
    'exist.';

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
        const questIds = quests.listQuestIds();
        if (!input.includeOverview) {
            return ok({
                discoveredFrom: '_ai/quests/*',
                count: questIds.length,
                quests: questIds,
            });
        }
        const enriched = questIds.map((id) => ({
            id,
            overviewFile: quests.hasOverviewFile(id) ? `overview.${id}.md` : null,
            todoFileCount: quests.listTodoFiles(id).length,
        }));
        return ok({
            discoveredFrom: '_ai/quests/*',
            count: enriched.length,
            quests: enriched,
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_QUESTS_DESCRIPTION =
    'List every quest folder under `_ai/quests/`. Discovery is a ' +
    'filesystem walk of the `_ai/quests/` directory (NOT ' +
    '`.tom_metadata/tom_master.yaml`) — directory entries are returned in ' +
    'alphabetical order. Quest ids are free-form directory names; no format ' +
    'is enforced (the convention is snake_case but neither this tool nor ' +
    'the manager rejects other names). By default returns ' +
    '`{ok, discoveredFrom, count, quests: string[]}`. With `includeOverview: ' +
    'true`, each entry becomes `{id, overviewFile, todoFileCount}` — ' +
    '`overviewFile` is the conventional `overview.<id>.md` filename when ' +
    'present, `null` when absent; `todoFileCount` is the number of ' +
    '`*.todo.yaml` files in the quest folder.';

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
                description: 'When true, each entry becomes `{id, overviewFile, todoFileCount}` instead of a bare id string. Default false.',
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_listProjects`
// ===========================================================================

export async function listProjectsImpl(projectsSrc: ProjectSource, _input: ListProjectsInput): Promise<string> {
    try {
        const result = projectsSrc.readProjects();
        if (!result.found) {
            return err('tom_master.yaml not found', {
                discoveredFrom: '.tom_metadata/tom_master.yaml',
                masterPath: result.masterPath,
                projects: [],
            });
        }
        return ok({
            discoveredFrom: '.tom_metadata/tom_master.yaml',
            masterPath: result.masterPath,
            count: result.projects.length,
            projects: result.projects,
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_PROJECTS_DESCRIPTION =
    'List every project recorded in `.tom_metadata/tom_master.yaml` ' +
    '(the workspace analyzer\'s output). A "project" is a single entry in ' +
    'the YAML\'s top-level `projects` array — typically a Dart package, a ' +
    'Flutter app, or a TypeScript module. Each entry returns ' +
    '`{id, name, path, type?}`: `path` is workspace-relative *as recorded ' +
    'in the YAML* (no normalisation, no absolute conversion); `id` falls ' +
    'back to `name` when missing, and vice versa; `type` is omitted when ' +
    'absent in the YAML. When the master file is missing, the response is ' +
    '`{ok: false, error: "tom_master.yaml not found", masterPath, projects: ' +
    '[]}` so callers can detect "no metadata" vs "no projects" cleanly. To ' +
    'regenerate the metadata, run the workspace analyzer ' +
    '(`tom_ai_build`).';

export const LIST_PROJECTS_TOOL: SharedToolDefinition<ListProjectsInput> = {
    name: 'tomAi_listProjects',
    displayName: 'List Projects',
    description: LIST_PROJECTS_DESCRIPTION,
    tags: ['workspace', 'projects', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
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
    guidelines: '_copilot_guidelines',
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
    '`guidelines` → `_copilot_guidelines`. The walk returns **every** file ' +
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
                description: 'prompts → _ai/prompt; answers → _ai/answers/copilot; notes → _ai/notes; roles → _ai/roles; guidelines → _copilot_guidelines.',
            },
            subPath: {
                type: 'string',
                description: 'Optional sub-path inside the category folder. Traversal-guarded — paths escaping the category root are rejected.',
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};
