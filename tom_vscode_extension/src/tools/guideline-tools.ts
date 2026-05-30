/**
 * Guideline tools — read, list, and search workspace guideline markdown.
 *
 * Two scopes:
 *
 *   - **Global guidelines** live at the workspace root in
 *     `_copilot_guidelines/` (recursively).
 *   - **Project guidelines** live inside each project folder at
 *     `{projectPath}/_copilot_guidelines/` (recursively).
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
 * embed the global `_copilot_guidelines/index.md` into the global-read
 * tool's description so the model sees the inventory without a lookup.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import {
    GUIDELINE_FOLDER,
    classifyGuidelinePath,
    globalGuidelinesRoot,
    projectGuidelinesRoot,
    resolveGuidelineFile,
    searchMarkdown,
    walkMarkdown,
} from './guideline-paths';

// ---------------------------------------------------------------------------
// Helpers (vscode-aware wrappers around the pure path logic)
// ---------------------------------------------------------------------------

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function readFileSafe(filePath: string): string | undefined {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }
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

export async function readGlobalGuidelineImpl(root: string | undefined, input: ReadGlobalGuidelineInput): Promise<string> {
    const globalRoot = globalGuidelinesRoot(root);
    if (!globalRoot) {
        return `Global \`${GUIDELINE_FOLDER}/\` folder not found at workspace root.`;
    }
    if (!input.fileName) {
        const files = walkMarkdown(globalRoot, globalRoot).sort((a, b) => a.path.localeCompare(b.path));
        let result = `Available global guideline files under \`${GUIDELINE_FOLDER}/\`:\n\n`;
        result += files.map((f) => `- ${f.path}`).join('\n');
        const indexPath = path.join(globalRoot, 'index.md');
        if (fs.existsSync(indexPath)) {
            result += '\n\n---\n\nindex.md:\n\n';
            result += fs.readFileSync(indexPath, 'utf8');
        }
        return result;
    }
    // Classify the input so a project-style path auto-delegates to
    // the project handler instead of returning "not found".
    const classification = classifyGuidelinePath(input.fileName, root);
    if (classification.kind === 'project') {
        return readProjectGuidelineImpl(root, {
            projectPath: classification.projectPath,
            fileName: classification.relPath,
        });
    }
    const resolved = resolveGuidelineFile(globalRoot, classification.relPath);
    if (!resolved) {
        const filesPreview = walkMarkdown(globalRoot, globalRoot)
            .map((f) => f.path)
            .sort()
            .slice(0, 30)
            .join('\n  - ');
        return `Global guideline file not found: '${input.fileName}'.\n\n` +
            `Tried path relative to ${GUIDELINE_FOLDER}/: '${classification.relPath}'.\n\n` +
            `If this is a project-level guideline, use tomAi_readProjectGuideline with the correct projectPath. ` +
            `Available global guideline files (first 30):\n  - ${filesPreview}`;
    }
    return readFileSafe(resolved) ?? `Read error: ${resolved}`;
}

async function executeReadGlobalGuideline(input: ReadGlobalGuidelineInput): Promise<string> {
    return readGlobalGuidelineImpl(wsRoot(), input);
}

export const READ_GLOBAL_GUIDELINE_TOOL: SharedToolDefinition<ReadGlobalGuidelineInput> = {
    name: 'tomAi_readGlobalGuideline',
    displayName: 'Read Global Guideline',
    description:
        // Description is partially overwritten by `initializeToolDescriptions()`
        // at activation to embed the actual index.md; keep this static copy
        // sensible as a fallback.
        `Read a WORKSPACE-LEVEL guideline file from \`<workspaceRoot>/${GUIDELINE_FOLDER}/\` (recursively).\n\n` +
        `**fileName accepts any of these shapes:**\n` +
        `  - bare name (with or without .md): "documentation_guidelines" or "documentation_guidelines.md"\n` +
        `  - subfolder/basename: "dart/coding_guidelines.md"\n` +
        `  - rooted form: "${GUIDELINE_FOLDER}/dart/coding_guidelines.md"\n\n` +
        `If the path looks like a PROJECT guideline (e.g. "tom_ai/.../${GUIDELINE_FOLDER}/local_llm.md"), this tool ` +
        `auto-delegates to tomAi_readProjectGuideline — you don't need to switch tools manually.\n\n` +
        `Omit fileName to get the file list + index.md of the global folder.`,
    tags: ['guidelines', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            fileName: {
                type: 'string',
                description:
                    'Bare filename, subfolder/filename, rooted form, or project-style path. Examples: ' +
                    '"coding_guidelines.md", "dart/coding_guidelines.md", "_copilot_guidelines/coding_guidelines.md", ' +
                    '"tom_ai/vscode/tom_vscode_extension/_copilot_guidelines/local_llm.md". Omit to list all global files.',
            },
        },
    },
    execute: executeReadGlobalGuideline,
};

interface ListGlobalGuidelinesInput { subfolder?: string }

export async function listGlobalGuidelinesImpl(root: string | undefined, input: ListGlobalGuidelinesInput): Promise<string> {
    const globalRoot = globalGuidelinesRoot(root);
    if (!globalRoot) {
        return JSON.stringify({ error: `${GUIDELINE_FOLDER} folder not found at workspace root` });
    }
    if (!input.subfolder) {
        const files = walkMarkdown(globalRoot, globalRoot).sort((a, b) => a.path.localeCompare(b.path));
        return JSON.stringify({ folder: '.', count: files.length, files }, null, 2);
    }
    // Auto-delegate path-shape project requests (those containing
    // `_copilot_guidelines/`).
    const classification = classifyGuidelinePath(input.subfolder, root);
    if (classification.kind === 'project') {
        return listProjectGuidelinesImpl(root, {
            projectPath: classification.projectPath,
            subfolder: classification.relPath || undefined,
        });
    }
    const target = path.join(globalRoot, classification.relPath);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        const files = walkMarkdown(target, globalRoot).sort((a, b) => a.path.localeCompare(b.path));
        return JSON.stringify({ folder: classification.relPath || '.', count: files.length, files }, null, 2);
    }
    // Filesystem-based fallback: when the bare path doesn't resolve
    // as a global subfolder but DOES resolve as a project folder that
    // owns its own `_copilot_guidelines/`, delegate to the project
    // handler. This catches the common case where the model passes a
    // workspace-relative project path (e.g. `tom_ai/vscode/tom_vscode_extension`)
    // hoping the global tool will figure out where to look.
    if (projectGuidelinesRoot(root, classification.relPath)) {
        return listProjectGuidelinesImpl(root, { projectPath: classification.relPath });
    }
    return JSON.stringify({
        error: `Subfolder not found inside global guidelines: '${input.subfolder}'`,
        availableSubfolders: listSubdirectories(globalRoot),
    });
}

async function executeListGlobalGuidelines(input: ListGlobalGuidelinesInput): Promise<string> {
    return listGlobalGuidelinesImpl(wsRoot(), input);
}

function listSubdirectories(dir: string): string[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
            .map((d) => d.name)
            .sort();
    } catch { return []; }
}

export const LIST_GLOBAL_GUIDELINES_TOOL: SharedToolDefinition<ListGlobalGuidelinesInput> = {
    name: 'tomAi_listGlobalGuidelines',
    displayName: 'List Global Guidelines',
    description:
        `List markdown files under \`<workspaceRoot>/${GUIDELINE_FOLDER}/\` (recursive).\n\n` +
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
                    'Optional subfolder name within global guidelines (e.g. "dart", "cloud"), or a project path that contains a `_copilot_guidelines/` folder (auto-delegates).',
            },
        },
    },
    execute: executeListGlobalGuidelines,
};

interface SearchGlobalGuidelinesInput { query: string; caseSensitive?: boolean; maxMatches?: number }

export async function searchGlobalGuidelinesImpl(root: string | undefined, input: SearchGlobalGuidelinesInput): Promise<string> {
    const globalRoot = globalGuidelinesRoot(root);
    if (!globalRoot) {
        return JSON.stringify({ error: `${GUIDELINE_FOLDER} folder not found at workspace root` });
    }
    if (!input.query) { return JSON.stringify({ error: 'query is required' }); }
    const max = Math.max(1, input.maxMatches ?? 100);
    const matches = searchMarkdown(globalRoot, input.query, !!input.caseSensitive, max);
    return JSON.stringify({
        query: input.query,
        count: matches.length,
        truncated: matches.length >= max,
        matches,
    }, null, 2);
}

async function executeSearchGlobalGuidelines(input: SearchGlobalGuidelinesInput): Promise<string> {
    return searchGlobalGuidelinesImpl(wsRoot(), input);
}

export const SEARCH_GLOBAL_GUIDELINES_TOOL: SharedToolDefinition<SearchGlobalGuidelinesInput> = {
    name: 'tomAi_searchGlobalGuidelines',
    displayName: 'Search Global Guidelines',
    description:
        `Substring-search every \`.md\` file under \`<workspaceRoot>/${GUIDELINE_FOLDER}/\`. ` +
        `Returns up to maxMatches \`{file, line, text}\` hits, where \`file\` is relative to the global folder.`,
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

export async function readProjectGuidelineImpl(root: string | undefined, input: ReadProjectGuidelineInput): Promise<string> {
    if (!input.projectPath) {
        return 'projectPath is required (workspace-relative or absolute). Example: "tom_ai/vscode/tom_vscode_extension".';
    }
    const projRoot = projectGuidelinesRoot(root, input.projectPath);
    if (!projRoot) {
        return `No \`${GUIDELINE_FOLDER}/\` folder found at ${input.projectPath}/${GUIDELINE_FOLDER}/. ` +
            `Pass projectPath as the folder containing _copilot_guidelines/, not the guidelines folder itself.`;
    }
    if (!input.fileName) {
        const files = walkMarkdown(projRoot, projRoot).sort((a, b) => a.path.localeCompare(b.path));
        let result = `Available project guideline files under \`${input.projectPath}/${GUIDELINE_FOLDER}/\`:\n\n`;
        result += files.map((f) => `- ${f.path}`).join('\n');
        const indexPath = path.join(projRoot, 'index.md');
        if (fs.existsSync(indexPath)) {
            result += '\n\n---\n\nindex.md:\n\n';
            result += fs.readFileSync(indexPath, 'utf8');
        }
        return result;
    }
    // Accept either a bare filename or a glued workspace path —
    // re-classify so callers can pass the same shape they got from
    // findFiles without thinking about which tool to use.
    const classification = classifyGuidelinePath(input.fileName, root);
    const effectiveRelPath = classification.relPath;
    const resolved = resolveGuidelineFile(projRoot, effectiveRelPath);
    if (!resolved) {
        const filesPreview = walkMarkdown(projRoot, projRoot)
            .map((f) => f.path)
            .sort()
            .slice(0, 30)
            .join('\n  - ');
        return `Project guideline file not found: '${input.fileName}' under ${input.projectPath}/${GUIDELINE_FOLDER}/.\n\n` +
            `Available files (first 30):\n  - ${filesPreview}`;
    }
    return readFileSafe(resolved) ?? `Read error: ${resolved}`;
}

async function executeReadProjectGuideline(input: ReadProjectGuidelineInput): Promise<string> {
    return readProjectGuidelineImpl(wsRoot(), input);
}

export const READ_PROJECT_GUIDELINE_TOOL: SharedToolDefinition<ReadProjectGuidelineInput> = {
    name: 'tomAi_readProjectGuideline',
    displayName: 'Read Project Guideline',
    description:
        `Read a PROJECT-LEVEL guideline file from \`{projectPath}/${GUIDELINE_FOLDER}/\` (recursively).\n\n` +
        `**Example call shapes:**\n` +
        `  - {"projectPath": "tom_ai/vscode/tom_vscode_extension", "fileName": "local_llm.md"}\n` +
        `  - {"projectPath": "tom_ai/devops/tom_build", "fileName": "build_process.md"}\n` +
        `  - {"projectPath": "tom_ai/vscode/tom_vscode_extension"} → returns the file list + index.md\n\n` +
        `\`projectPath\` is the FOLDER CONTAINING \`${GUIDELINE_FOLDER}/\` — not the guidelines folder itself. ` +
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
                    'Workspace-relative folder path containing a `_copilot_guidelines/` subfolder. Example: "tom_ai/vscode/tom_vscode_extension".',
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

export async function listProjectGuidelinesImpl(root: string | undefined, input: ListProjectGuidelinesInput): Promise<string> {
    if (!input.projectPath) { return JSON.stringify({ error: 'projectPath is required' }); }
    const projRoot = projectGuidelinesRoot(root, input.projectPath);
    if (!projRoot) {
        return JSON.stringify({
            error: `No ${GUIDELINE_FOLDER}/ folder at ${input.projectPath}/${GUIDELINE_FOLDER}/`,
        });
    }
    const target = input.subfolder ? path.join(projRoot, input.subfolder) : projRoot;
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        return JSON.stringify({
            error: `Subfolder not found inside ${input.projectPath}/${GUIDELINE_FOLDER}/: '${input.subfolder}'`,
            availableSubfolders: listSubdirectories(projRoot),
        });
    }
    const files = walkMarkdown(target, projRoot).sort((a, b) => a.path.localeCompare(b.path));
    return JSON.stringify({
        projectPath: input.projectPath,
        folder: path.relative(projRoot, target) || '.',
        count: files.length,
        files,
    }, null, 2);
}

async function executeListProjectGuidelines(input: ListProjectGuidelinesInput): Promise<string> {
    return listProjectGuidelinesImpl(wsRoot(), input);
}

export const LIST_PROJECT_GUIDELINES_TOOL: SharedToolDefinition<ListProjectGuidelinesInput> = {
    name: 'tomAi_listProjectGuidelines',
    displayName: 'List Project Guidelines',
    description:
        `List markdown files under \`{projectPath}/${GUIDELINE_FOLDER}/\`. Pass projectPath as the FOLDER ` +
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
                    'Workspace-relative folder path containing a `_copilot_guidelines/` subfolder.',
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

export async function searchProjectGuidelinesImpl(root: string | undefined, input: SearchProjectGuidelinesInput): Promise<string> {
    if (!input.projectPath) { return JSON.stringify({ error: 'projectPath is required' }); }
    const projRoot = projectGuidelinesRoot(root, input.projectPath);
    if (!projRoot) {
        return JSON.stringify({
            error: `No ${GUIDELINE_FOLDER}/ folder at ${input.projectPath}/${GUIDELINE_FOLDER}/`,
        });
    }
    if (!input.query) { return JSON.stringify({ error: 'query is required' }); }
    const max = Math.max(1, input.maxMatches ?? 100);
    const matches = searchMarkdown(projRoot, input.query, !!input.caseSensitive, max);
    return JSON.stringify({
        projectPath: input.projectPath,
        query: input.query,
        count: matches.length,
        truncated: matches.length >= max,
        matches,
    }, null, 2);
}

async function executeSearchProjectGuidelines(input: SearchProjectGuidelinesInput): Promise<string> {
    return searchProjectGuidelinesImpl(wsRoot(), input);
}

export const SEARCH_PROJECT_GUIDELINES_TOOL: SharedToolDefinition<SearchProjectGuidelinesInput> = {
    name: 'tomAi_searchProjectGuidelines',
    displayName: 'Search Project Guidelines',
    description:
        `Substring-search every \`.md\` file under \`{projectPath}/${GUIDELINE_FOLDER}/\`. Returns up to ` +
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
    const workspaceRoot = wsRoot();
    if (!workspaceRoot) { return; }
    const globalIndexPath = path.join(workspaceRoot, GUIDELINE_FOLDER, 'index.md');
    if (fs.existsSync(globalIndexPath)) {
        try {
            const indexContent = fs.readFileSync(globalIndexPath, 'utf8');
            const intro = READ_GLOBAL_GUIDELINE_TOOL.description ?? '';
            READ_GLOBAL_GUIDELINE_TOOL.description =
                `${intro}\n\n---\n\nGlobal guideline index (current contents of \`${GUIDELINE_FOLDER}/index.md\`):\n\n${indexContent}`;
        } catch { /* keep static description */ }
    }
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
