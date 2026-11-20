/**
 * Guideline tools — read, list, and search workspace guideline markdown.
 *
 * Two scopes:
 *
 *   - **Global guidelines** are two levels (`utils/guidelineFolders.ts`):
 *     the root's guidelines, then the workspace folder's; a file of the same
 *     relative path in the workspace folder wins. Each level is read under
 *     both folder names, `_agent_guidelines/` first, then `_copilot_guidelines/`.
 *     The root's own `*.md` documents come after them: a rule heading's bare
 *     file name (`## [repo_skills_userguide.md § 5] …`) is looked up in the
 *     workspace folder's guidelines, the root's, then those (`filesNamed`).
 *   - **Project guidelines** live inside each project folder at
 *     `{projectPath}/_agent_guidelines/` and/or `_copilot_guidelines/` (not layered).
 *
 * Smart path handling (see guideline-paths.ts for the pure logic):
 *
 *   The model often sees workspace-relative paths from prior tool
 *   results (e.g. `tomAi_findFiles` returns `tom_ai/.../local_llm.md`)
 *   and naturally passes those back to `tomAi_readGlobalGuideline`. We
 *   classify the input and auto-delegate when it clearly refers to a
 *   project-scope file, so the model doesn't get trapped in a "file
 *   not found" loop chasing a path the tool refuses to resolve.
 *
 * `initializeToolDescriptions()` is called at extension activation to
 * embed the levels' indexes (`index_root.md`, `index_workspace.md`, else each
 * level's `index.md`) into the global-read tool's description so the model
 * sees the inventory without a lookup.
 */

import { getLayout, layoutWorkspaceFolder } from '../utils/workspaceLayout';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import {
    GUIDELINE_FOLDER,
    classifyGuidelinePath,
    escapeRegex,
} from './guideline-paths';
import {
    GUIDELINE_FOLDER_NAMES,
    type GuidelineFile,
    type GuidelineLevel,
    extractSection,
    filesNamed,
    guidelineLevels,
    levelIndexes,
    listRootDocuments,
    markdownHeadings,
    splitSectionRef,
    listLevelFiles,
    listProjectFiles,
    projectGuidelineDirs,
    resolveInFiles,
    subfoldersOf,
} from '../utils/guidelineFolders';

/** The folder names as a reader sees them: `_agent_guidelines/` (or `_copilot_guidelines/`). */
const FOLDER_LABEL = `${GUIDELINE_FOLDER}/ (or ${GUIDELINE_FOLDER_NAMES[1]}/)`;

// ---------------------------------------------------------------------------
// Helpers (vscode-aware wrappers around the pure path logic)
// ---------------------------------------------------------------------------

function wsRoot(): string | undefined {
    return layoutWorkspaceFolder();
}

function readFileSafe(filePath: string): string | undefined {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }
}

/**
 * Where the guideline tools look: the workspace folder (project paths are
 * relative to it), the global levels, and who is told when a requested path
 * was found only by its file name elsewhere.
 */
export interface GuidelineScope {
    wsRoot?: string;
    levels: GuidelineLevel[];
    /**
     * The root (found by `.tom/tom_root.yaml`): its own `*.md` documents are the
     * last place a bare name is looked up. Unset: none.
     */
    root?: string;
    /** A guideline asked for by a path that does not exist was found by its name at `found`. */
    onFoundByName?: (requested: string, found: string) => void;
}

/** A bare workspace root (tests, callers without a layout): one level, its own guidelines folder. */
function scopeOf(root: string | undefined | GuidelineScope): GuidelineScope {
    if (root && typeof root === 'object') { return root; }
    return { wsRoot: root, levels: root ? guidelineLevels([path.join(root, GUIDELINE_FOLDER)]) : [] };
}

/** The window's scope: the layout's levels, a toast for a path found only by name. */
function windowScope(): GuidelineScope {
    const layout = getLayout();
    return {
        wsRoot: wsRoot(),
        levels: guidelineLevels(layout?.guidelineDirs ?? []),
        root: layout?.root,
        onFoundByName: (requested, found) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const vscode = require('vscode') as typeof import('vscode');
                void vscode.window.showWarningMessage(
                    `Guideline path not found: '${requested}'. Read '${found}' instead (found by its file name); correct the path where it came from.`,
                );
            } catch { /* no VS Code */ }
        },
    };
}

function relForDisplay(scope: GuidelineScope, abs: string): string {
    return scope.wsRoot ? path.relative(scope.wsRoot, abs).split(path.sep).join('/') : abs;
}

function fileEntry(f: GuidelineFile): { path: string; size: number; level: string } {
    return { path: f.path, size: f.size, level: f.level };
}

/** Substring search over listed files. */
function searchFiles(files: readonly GuidelineFile[], query: string, caseSensitive: boolean, max: number):
    Array<{ file: string; level: string; line: number; text: string }> {
    const pattern = new RegExp(escapeRegex(query), caseSensitive ? '' : 'i');
    const matches: Array<{ file: string; level: string; line: number; text: string }> = [];
    for (const f of files) {
        if (matches.length >= max) { break; }
        const content = readFileSafe(f.abs);
        if (content === undefined) { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && matches.length < max; i++) {
            if (pattern.test(lines[i])) { matches.push({ file: f.path, level: f.level, line: i + 1, text: lines[i].slice(0, 200) }); }
        }
    }
    return matches;
}

/** An absolute path inside one of the levels' folders: its path relative to that folder. */
function relInLevels(scope: GuidelineScope, input: string): string | undefined {
    if (!path.isAbsolute(input)) { return undefined; }
    for (const l of scope.levels) {
        for (const d of l.dirs) {
            const rel = path.relative(d, input);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { return rel.split(path.sep).join('/'); }
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Global guidelines — read / list / search
//
// Each tool exposes a public `*Impl(wsRoot, input)` function that takes
// the workspace root explicitly. The vscode-aware `execute*` wrapper
// just discovers wsRoot via `vscode.workspace.workspaceFolders` and
// delegates. This split keeps the full logic testable without spinning
// up a vscode extension host — tests call the Impl directly against a
// temp on-disk fixture.
// ---------------------------------------------------------------------------

interface ReadGlobalGuidelineInput { fileName?: string }

export async function readGlobalGuidelineImpl(root: string | undefined | GuidelineScope, input: ReadGlobalGuidelineInput): Promise<string> {
    const scope = scopeOf(root);
    const rootDocuments = listRootDocuments(scope.root);
    if (scope.levels.length === 0 && rootDocuments.length === 0) {
        return `Global guidelines folder not found (\`${FOLDER_LABEL}\`, at the root or in the workspace folder).`;
    }
    const files = listLevelFiles(scope.levels);
    if (!input.fileName) {
        let result = `Available global guideline files (root, then workspace folder; a workspace file of the same path wins), then the root's own documents:\n\n`;
        result += [...files, ...rootDocuments].map((f) => `- ${f.path} (${f.level})`).join('\n');
        for (const ix of levelIndexes(scope.levels)) {
            result += `\n\n---\n\n${path.basename(ix.file)} (${ix.level}):\n\n${ix.content}`;
        }
        return result;
    }
    // A rule heading's reference: `name.md § 5`. A bare name is looked up on
    // every level in the convention's order; the others of that name are named.
    const ref = splitSectionRef(input.fileName);
    const bare = normaliseBare(ref.name);
    if (bare) {
        const named = filesNamed(scope.levels, rootDocuments, bare);
        if (named.length > 0) {
            return readWithSection(scope, named[0], ref.section, named.slice(1));
        }
    }
    // An absolute path inside a level's folder; else classify, so a
    // project-style path auto-delegates to the project handler.
    let relPath = relInLevels(scope, ref.name);
    if (relPath === undefined) {
        const classification = classifyGuidelinePath(ref.name, scope.wsRoot);
        if (classification.kind === 'project') {
            return readProjectGuidelineImpl(scope, {
                projectPath: classification.projectPath,
                fileName: classification.relPath,
            });
        }
        relPath = classification.relPath;
    }
    const resolved = resolveInFiles(files, relPath);
    if (!resolved) {
        const filesPreview = files.map((f) => f.path).slice(0, 30).join('\n  - ');
        return `Global guideline file not found: '${input.fileName}'.\n\n` +
            `Tried path relative to the guidelines folders: '${relPath}'` +
            (bare ? `, and the name on every level (the workspace folder's guidelines, the root's, the root's own documents)` : '') + `.\n\n` +
            `If this is a project-level guideline, use tomAi_readProjectGuideline with the correct projectPath. ` +
            `Available global guideline files (first 30):\n  - ${filesPreview}`;
    }
    if (resolved.byName) { scope.onFoundByName?.(ref.name, relForDisplay(scope, resolved.file.abs)); }
    return readWithSection(scope, resolved.file, ref.section, []);
}

/** A bare file name (no folder, not absolute), `.md` added; '' for anything else. */
function normaliseBare(name: string): string {
    const s = name.trim().replace(/\\/g, '/');
    if (!s || s.includes('/') || path.isAbsolute(s)) { return ''; }
    return s.endsWith('.md') ? s : `${s}.md`;
}

/**
 * The file's text, or its `§` section. A header says which file was read when
 * a section was asked for or the name is in more than one place (the others
 * listed: names are meant to be unique across the levels).
 */
function readWithSection(scope: GuidelineScope, file: GuidelineFile, section: string | undefined, others: readonly GuidelineFile[]): string {
    const content = readFileSafe(file.abs);
    if (content === undefined) { return `Read error: ${file.abs}`; }
    const where = (f: GuidelineFile) => `${relForDisplay(scope, f.abs)} (${f.level})`;
    const header: string[] = [];
    let body = content;
    if (section) {
        const hit = extractSection(content, section);
        if (hit) {
            header.push(`Read ${where(file)}, § ${section}: "${hit.heading}".`);
            body = hit.text;
        } else {
            const headings = markdownHeadings(content).filter((h) => h.level >= 2).map((h) => `  - ${h.text}`).join('\n');
            header.push(`Read ${where(file)}: it has no section § ${section}; the whole file follows. Its headings:\n${headings}`);
        }
    }
    if (others.length > 0) {
        if (!section) { header.push(`Read ${where(file)}.`); }
        header.push(`The name is also in: ${others.map(where).join(', ')} (file names are meant to be unique across the levels).`);
    }
    return header.length > 0 ? `${header.join('\n')}\n\n---\n\n${body}` : body;
}

async function executeReadGlobalGuideline(input: ReadGlobalGuidelineInput): Promise<string> {
    return readGlobalGuidelineImpl(windowScope(), input);
}

export const READ_GLOBAL_GUIDELINE_TOOL: SharedToolDefinition<ReadGlobalGuidelineInput> = {
    name: 'tomAi_readGlobalGuideline',
    displayName: 'Read Global Guideline',
    description:
        // Description is partially overwritten by `initializeToolDescriptions()`
        // at activation to embed the actual index.md; keep this static copy
        // sensible as a fallback.
        `Read a guideline or root document, in particular **the file a rule heading names**: ` +
        `\`## [repo_skills_userguide.md § 5] …\` → fileName \`"repo_skills_userguide.md § 5"\`. ` +
        `A bare name is looked up in the workspace folder's guidelines, the root's (\`${FOLDER_LABEL}\`, nested folders included), ` +
        `then the root's own \`*.md\` documents; the first match wins and the others of that name are named. ` +
        `\`§ <n>\` / \`§ <title>\` returns only that section. ` +
        `A path (\`dart/coding_guidelines.md\`, \`${GUIDELINE_FOLDER}/…\`) is read relative to the guidelines folders ` +
        `(the workspace folder's file of the same path wins); one that does not exist is looked up by its file name, and the user is told. ` +
        `A project path ("tom_ai/.../${GUIDELINE_FOLDER}/local_llm.md") is read with tomAi_readProjectGuideline. ` +
        `Omit fileName for the file list and the levels' indexes. Details: doc/llm_tools.md § 4.10.`,
    tags: ['guidelines', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            fileName: {
                type: 'string',
                description:
                    'A rule heading\'s reference (bare name, optionally `§ <n>` / `§ <title>`), bare filename, subfolder/filename, rooted form, or project-style path. Examples: ' +
                    '"repo_skills_userguide.md § 5", ' +
                    '"coding_guidelines.md", "dart/coding_guidelines.md", "_agent_guidelines/coding_guidelines.md", ' +
                    '"tom_ai/vscode/tom_vscode_extension/_copilot_guidelines/local_llm.md". Omit to list all global files.',
            },
        },
    },
    execute: executeReadGlobalGuideline,
};

interface ListGlobalGuidelinesInput { subfolder?: string }

export async function listGlobalGuidelinesImpl(root: string | undefined | GuidelineScope, input: ListGlobalGuidelinesInput): Promise<string> {
    const scope = scopeOf(root);
    const rootDocuments = listRootDocuments(scope.root);
    if (scope.levels.length === 0 && rootDocuments.length === 0) {
        return JSON.stringify({ error: `Global guidelines folder not found (${FOLDER_LABEL}, at the root or in the workspace folder)` });
    }
    const levels = scope.levels.map((l) => ({ level: l.level, dirs: l.dirs.map((d) => relForDisplay(scope, d)) }));
    if (!input.subfolder) {
        const files = [...listLevelFiles(scope.levels), ...rootDocuments].map(fileEntry);
        return JSON.stringify({ folder: '.', levels, count: files.length, files }, null, 2);
    }
    // Auto-delegate path-shape project requests (those naming a guidelines folder).
    const classification = classifyGuidelinePath(input.subfolder, scope.wsRoot);
    if (classification.kind === 'project') {
        return listProjectGuidelinesImpl(scope, {
            projectPath: classification.projectPath,
            subfolder: classification.relPath || undefined,
        });
    }
    const allDirs = scope.levels.flatMap((l) => l.dirs);
    const sub = classification.relPath;
    if (allDirs.some((d) => isDirectory(path.join(d, sub)))) {
        const files = listLevelFiles(scope.levels, sub).map(fileEntry);
        return JSON.stringify({ folder: sub || '.', levels, count: files.length, files }, null, 2);
    }
    // Filesystem-based fallback: a workspace-relative project path that owns
    // its own guidelines folder is delegated to the project handler.
    if (scope.wsRoot && projectGuidelineDirs(path.isAbsolute(sub) ? sub : path.join(scope.wsRoot, sub)).length > 0) {
        return listProjectGuidelinesImpl(scope, { projectPath: sub });
    }
    return JSON.stringify({
        error: `Subfolder not found inside global guidelines: '${input.subfolder}'`,
        availableSubfolders: subfoldersOf(allDirs),
    });
}

function isDirectory(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

async function executeListGlobalGuidelines(input: ListGlobalGuidelinesInput): Promise<string> {
    return listGlobalGuidelinesImpl(windowScope(), input);
}

export const LIST_GLOBAL_GUIDELINES_TOOL: SharedToolDefinition<ListGlobalGuidelinesInput> = {
    name: 'tomAi_listGlobalGuidelines',
    displayName: 'List Global Guidelines',
    description:
        `List the global guideline markdown files (recursive): the root's guidelines and the workspace folder's ` +
        `(\`${FOLDER_LABEL}\`), each path once with its \`level\` (\`root\` / \`workspace\`; a workspace file of the same path wins), ` +
        `then the root's own \`*.md\` documents (\`level: rootDocument\`) — every place a rule heading's file name is looked up.\n\n` +
        `**subfolder accepts:**\n` +
        `  - a direct subfolder name: "dart" or "cloud"\n` +
        `  - a project-style path: "tom_ai/vscode/tom_vscode_extension" — auto-delegates to tomAi_listProjectGuidelines\n\n` +
        `Omit subfolder to list everything under the global folder.`,
    tags: ['guidelines', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            subfolder: {
                type: 'string',
                description:
                    'Optional subfolder name within global guidelines (e.g. "dart", "cloud"), or a project path that contains a `_agent_guidelines/` or `_copilot_guidelines/` folder (auto-delegates).',
            },
        },
    },
    execute: executeListGlobalGuidelines,
};

interface SearchGlobalGuidelinesInput { query: string; caseSensitive?: boolean; maxMatches?: number }

export async function searchGlobalGuidelinesImpl(root: string | undefined | GuidelineScope, input: SearchGlobalGuidelinesInput): Promise<string> {
    const scope = scopeOf(root);
    const rootDocuments = listRootDocuments(scope.root);
    if (scope.levels.length === 0 && rootDocuments.length === 0) {
        return JSON.stringify({ error: `Global guidelines folder not found (${FOLDER_LABEL}, at the root or in the workspace folder)` });
    }
    if (!input.query) { return JSON.stringify({ error: 'query is required' }); }
    const max = Math.max(1, input.maxMatches ?? 100);
    const matches = searchFiles([...listLevelFiles(scope.levels), ...rootDocuments], input.query, !!input.caseSensitive, max);
    return JSON.stringify({
        query: input.query,
        count: matches.length,
        truncated: matches.length >= max,
        matches,
    }, null, 2);
}

async function executeSearchGlobalGuidelines(input: SearchGlobalGuidelinesInput): Promise<string> {
    return searchGlobalGuidelinesImpl(windowScope(), input);
}

export const SEARCH_GLOBAL_GUIDELINES_TOOL: SharedToolDefinition<SearchGlobalGuidelinesInput> = {
    name: 'tomAi_searchGlobalGuidelines',
    displayName: 'Search Global Guidelines',
    description:
        `Substring-search every global guideline \`.md\` file (the root's and the workspace folder's, \`${FOLDER_LABEL}\`; ` +
        `each path once, the workspace's winning) and the root's own \`*.md\` documents (\`level: rootDocument\`). Returns up to maxMatches \`{file, level, line, text}\` hits, ` +
        `where \`file\` is relative to its guidelines folder.`,
    tags: ['guidelines', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: { type: 'string', description: 'Substring (literal — not regex).' },
            caseSensitive: { type: 'boolean', description: 'Default false.' },
            maxMatches: { type: 'number', description: 'Default 100.' },
        },
    },
    execute: executeSearchGlobalGuidelines,
};

// ---------------------------------------------------------------------------
// Project guidelines — read / list / search
// ---------------------------------------------------------------------------

interface ReadProjectGuidelineInput { projectPath: string; fileName?: string }

/** A project's guideline folders (both names), from a workspace-relative or absolute project path. */
function projectDirs(scope: GuidelineScope, projectPath: string): string[] {
    const abs = path.isAbsolute(projectPath) ? projectPath : (scope.wsRoot ? path.join(scope.wsRoot, projectPath) : projectPath);
    return projectGuidelineDirs(abs);
}

export async function readProjectGuidelineImpl(root: string | undefined | GuidelineScope, input: ReadProjectGuidelineInput): Promise<string> {
    const scope = scopeOf(root);
    if (!input.projectPath) {
        return 'projectPath is required (workspace-relative or absolute). Example: "tom_ai/vscode/tom_vscode_extension".';
    }
    const dirs = projectDirs(scope, input.projectPath);
    if (dirs.length === 0) {
        return `No guidelines folder (\`${FOLDER_LABEL}\`) found at ${input.projectPath}/. ` +
            `Pass projectPath as the folder containing the guidelines folder, not the guidelines folder itself.`;
    }
    const files = listProjectFiles(dirs);
    if (!input.fileName) {
        let result = `Available project guideline files under \`${input.projectPath}/\` (${dirs.map((d) => path.basename(d) + '/').join(', ')}):\n\n`;
        result += files.map((f) => `- ${f.path}`).join('\n');
        const index = files.find((f) => f.path === 'index.md');
        if (index) {
            result += '\n\n---\n\nindex.md:\n\n';
            result += readFileSafe(index.abs) ?? '';
        }
        return result;
    }
    // Accept either a bare filename or a glued workspace path —
    // re-classify so callers can pass the same shape they got from
    // findFiles without thinking about which tool to use.
    const classification = classifyGuidelinePath(input.fileName, scope.wsRoot);
    const resolved = resolveInFiles(files, classification.relPath);
    if (!resolved) {
        const filesPreview = files.map((f) => f.path).slice(0, 30).join('\n  - ');
        return `Project guideline file not found: '${input.fileName}' under ${input.projectPath}/.\n\n` +
            `Available files (first 30):\n  - ${filesPreview}`;
    }
    if (resolved.byName) { scope.onFoundByName?.(input.fileName, relForDisplay(scope, resolved.file.abs)); }
    return readFileSafe(resolved.file.abs) ?? `Read error: ${resolved.file.abs}`;
}

async function executeReadProjectGuideline(input: ReadProjectGuidelineInput): Promise<string> {
    return readProjectGuidelineImpl(windowScope(), input);
}

export const READ_PROJECT_GUIDELINE_TOOL: SharedToolDefinition<ReadProjectGuidelineInput> = {
    name: 'tomAi_readProjectGuideline',
    displayName: 'Read Project Guideline',
    description:
        `Read a PROJECT-LEVEL guideline file from \`{projectPath}/${GUIDELINE_FOLDER}/\` or \`{projectPath}/${GUIDELINE_FOLDER_NAMES[1]}/\` (recursively; both are read, the first wins for a file in both).\n\n` +
        `**Example call shapes:**\n` +
        `  - {"projectPath": "tom_ai/vscode/tom_vscode_extension", "fileName": "local_llm.md"}\n` +
        `  - {"projectPath": "tom_ai/devops/tom_build", "fileName": "build_process.md"}\n` +
        `  - {"projectPath": "tom_ai/vscode/tom_vscode_extension"} → returns the file list + index.md\n\n` +
        `\`projectPath\` is the FOLDER CONTAINING the guidelines folder — not the guidelines folder itself. ` +
        `Use \`tomAi_listProjects\` (if available) or \`tomAi_findFiles\` to discover valid projectPath values.`,
    tags: ['guidelines', 'project', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['projectPath'],
        properties: {
            projectPath: {
                type: 'string',
                description:
                    'Workspace-relative folder path containing a `_agent_guidelines/` or `_copilot_guidelines/` subfolder. Example: "tom_ai/vscode/tom_vscode_extension".',
            },
            fileName: {
                type: 'string',
                description:
                    'Optional. Bare filename ("local_llm.md"), subfolder/filename, or the full glued path the model saw from a previous tool call (the tool re-extracts the file portion). Omit to get the file list + index.md.',
            },
        },
    },
    execute: executeReadProjectGuideline,
};

interface ListProjectGuidelinesInput { projectPath: string; subfolder?: string }

export async function listProjectGuidelinesImpl(root: string | undefined | GuidelineScope, input: ListProjectGuidelinesInput): Promise<string> {
    const scope = scopeOf(root);
    if (!input.projectPath) { return JSON.stringify({ error: 'projectPath is required' }); }
    const dirs = projectDirs(scope, input.projectPath);
    if (dirs.length === 0) {
        return JSON.stringify({ error: `No guidelines folder (${FOLDER_LABEL}) at ${input.projectPath}/` });
    }
    if (input.subfolder && !dirs.some((d) => isDirectory(path.join(d, input.subfolder!)))) {
        return JSON.stringify({
            error: `Subfolder not found inside ${input.projectPath}'s guidelines: '${input.subfolder}'`,
            availableSubfolders: subfoldersOf(dirs),
        });
    }
    const files = listProjectFiles(dirs, input.subfolder).map((f) => ({ path: f.path, size: f.size }));
    return JSON.stringify({
        projectPath: input.projectPath,
        folders: dirs.map((d) => path.basename(d)),
        folder: input.subfolder || '.',
        count: files.length,
        files,
    }, null, 2);
}

async function executeListProjectGuidelines(input: ListProjectGuidelinesInput): Promise<string> {
    return listProjectGuidelinesImpl(windowScope(), input);
}

export const LIST_PROJECT_GUIDELINES_TOOL: SharedToolDefinition<ListProjectGuidelinesInput> = {
    name: 'tomAi_listProjectGuidelines',
    displayName: 'List Project Guidelines',
    description:
        `List markdown files under \`{projectPath}/${GUIDELINE_FOLDER}/\` and \`{projectPath}/${GUIDELINE_FOLDER_NAMES[1]}/\` (each path once). Pass projectPath as the FOLDER ` +
        `CONTAINING the guidelines folder. Example: ` +
        `{"projectPath": "tom_ai/vscode/tom_vscode_extension"}.`,
    tags: ['guidelines', 'project', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['projectPath'],
        properties: {
            projectPath: {
                type: 'string',
                description:
                    'Workspace-relative folder path containing a `_agent_guidelines/` or `_copilot_guidelines/` subfolder.',
            },
            subfolder: {
                type: 'string',
                description: 'Optional subfolder inside the project guidelines folder.',
            },
        },
    },
    execute: executeListProjectGuidelines,
};

interface SearchProjectGuidelinesInput {
    projectPath: string;
    query: string;
    caseSensitive?: boolean;
    maxMatches?: number;
}

export async function searchProjectGuidelinesImpl(root: string | undefined | GuidelineScope, input: SearchProjectGuidelinesInput): Promise<string> {
    const scope = scopeOf(root);
    if (!input.projectPath) { return JSON.stringify({ error: 'projectPath is required' }); }
    const dirs = projectDirs(scope, input.projectPath);
    if (dirs.length === 0) {
        return JSON.stringify({ error: `No guidelines folder (${FOLDER_LABEL}) at ${input.projectPath}/` });
    }
    if (!input.query) { return JSON.stringify({ error: 'query is required' }); }
    const max = Math.max(1, input.maxMatches ?? 100);
    const matches = searchFiles(listProjectFiles(dirs), input.query, !!input.caseSensitive, max)
        .map(({ file, line, text }) => ({ file, line, text }));
    return JSON.stringify({
        projectPath: input.projectPath,
        query: input.query,
        count: matches.length,
        truncated: matches.length >= max,
        matches,
    }, null, 2);
}

async function executeSearchProjectGuidelines(input: SearchProjectGuidelinesInput): Promise<string> {
    return searchProjectGuidelinesImpl(windowScope(), input);
}

export const SEARCH_PROJECT_GUIDELINES_TOOL: SharedToolDefinition<SearchProjectGuidelinesInput> = {
    name: 'tomAi_searchProjectGuidelines',
    displayName: 'Search Project Guidelines',
    description:
        `Substring-search every \`.md\` file under \`{projectPath}/${GUIDELINE_FOLDER}/\` and \`${GUIDELINE_FOLDER_NAMES[1]}/\`. Returns up to ` +
        `maxMatches \`{file, line, text}\` hits, where \`file\` is relative to the project guidelines folder.`,
    tags: ['guidelines', 'project', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['projectPath', 'query'],
        properties: {
            projectPath: { type: 'string' },
            query: { type: 'string', description: 'Substring (literal — not regex).' },
            caseSensitive: { type: 'boolean', description: 'Default false.' },
            maxMatches: { type: 'number', description: 'Default 100.' },
        },
    },
    execute: executeSearchProjectGuidelines,
};

// ---------------------------------------------------------------------------
// Description patching at activation — embeds the global index.md
// ---------------------------------------------------------------------------

export function initializeToolDescriptions(): void {
    const indexes = levelIndexes(windowScope().levels);
    if (indexes.length === 0) { return; }
    const intro = READ_GLOBAL_GUIDELINE_TOOL.description ?? '';
    READ_GLOBAL_GUIDELINE_TOOL.description = intro + indexes.map((ix) =>
        `\n\n---\n\nGuideline index of the ${ix.level} (current contents of \`${path.basename(path.dirname(ix.file))}/${path.basename(ix.file)}\`):\n\n${ix.content}`,
    ).join('');
}

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const GUIDELINE_TOOLS: SharedToolDefinition<any>[] = [
    READ_GLOBAL_GUIDELINE_TOOL,
    LIST_GLOBAL_GUIDELINES_TOOL,
    SEARCH_GLOBAL_GUIDELINES_TOOL,
    READ_PROJECT_GUIDELINE_TOOL,
    LIST_PROJECT_GUIDELINES_TOOL,
    SEARCH_PROJECT_GUIDELINES_TOOL,
];
