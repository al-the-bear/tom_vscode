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
 * `initializeToolDescriptions()` is called at extension activation to embed
 * the global `_copilot_guidelines/index.md` into the global-read tool's
 * description so the model sees the inventory without a lookup.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function globalGuidelinesRoot(): string | undefined {
    const root = wsRoot();
    if (!root) { return undefined; }
    const p = path.join(root, '_copilot_guidelines');
    return fs.existsSync(p) ? p : undefined;
}

/**
 * Resolve a project's guidelines folder. `projectPath` may be an absolute
 * path or relative to the workspace root. Returns the `_copilot_guidelines`
 * subfolder if it exists, else undefined.
 */
function projectGuidelinesRoot(projectPath: string): string | undefined {
    if (!projectPath) { return undefined; }
    const root = wsRoot();
    const abs = path.isAbsolute(projectPath)
        ? projectPath
        : (root ? path.join(root, projectPath) : projectPath);
    const candidate = path.join(abs, '_copilot_guidelines');
    return fs.existsSync(candidate) ? candidate : undefined;
}

function walkMarkdown(dir: string, baseDir: string): Array<{ path: string; size: number }> {
    const out: Array<{ path: string; size: number }> = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name.startsWith('.')) { continue; }
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...walkMarkdown(abs, baseDir));
        } else if (e.name.endsWith('.md')) {
            try {
                const stat = fs.statSync(abs);
                out.push({ path: path.relative(baseDir, abs), size: stat.size });
            } catch { /* ignore */ }
        }
    }
    return out;
}

function resolveMdFile(baseDir: string, fileName: string): string | undefined {
    const target = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
    // Direct hit at root.
    const direct = path.join(baseDir, target);
    if (fs.existsSync(direct)) { return direct; }
    // Try any subdirectory match (one level + recursive) — walk looking for exact filename.
    const found = walkMarkdown(baseDir, baseDir).find((f) => path.basename(f.path) === target);
    return found ? path.join(baseDir, found.path) : undefined;
}

function readFileSafe(filePath: string): string | undefined {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runSearch(
    baseDir: string,
    query: string,
    caseSensitive: boolean,
    maxMatches: number,
): Array<{ file: string; line: number; text: string }> {
    const flags = caseSensitive ? 'g' : 'gi';
    const pattern = new RegExp(escapeRegex(query), flags);
    const files = walkMarkdown(baseDir, baseDir);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    for (const f of files) {
        if (matches.length >= maxMatches) { break; }
        const content = readFileSafe(path.join(baseDir, f.path));
        if (!content) { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
                matches.push({ file: f.path, line: i + 1, text: lines[i].slice(0, 200) });
                if (matches.length >= maxMatches) { break; }
            }
            pattern.lastIndex = 0;
        }
    }
    return matches;
}

// ---------------------------------------------------------------------------
// Global guidelines — read / list / search
// ---------------------------------------------------------------------------

interface ReadGlobalGuidelineInput { fileName?: string }

async function executeReadGlobalGuideline(input: ReadGlobalGuidelineInput): Promise<string> {
    const root = globalGuidelinesRoot();
    if (!root) { return 'Global `_copilot_guidelines/` folder not found in workspace root.'; }
    if (!input.fileName) {
        const files = walkMarkdown(root, root).sort((a, b) => a.path.localeCompare(b.path));
        let result = 'Available global guideline files under `_copilot_guidelines/`:\n\n';
        result += files.map((f) => `- ${f.path}`).join('\n');
        const indexPath = path.join(root, 'index.md');
        if (fs.existsSync(indexPath)) {
            result += '\n\n---\n\nindex.md:\n\n';
            result += fs.readFileSync(indexPath, 'utf8');
        }
        return result;
    }
    const resolved = resolveMdFile(root, input.fileName);
    if (!resolved) { return `Guideline file not found: ${input.fileName}`; }
    return readFileSafe(resolved) ?? `Read error: ${resolved}`;
}

export const READ_GLOBAL_GUIDELINE_TOOL: SharedToolDefinition<ReadGlobalGuidelineInput> = {
    name: 'tomAi_readGlobalGuideline',
    displayName: 'Read Global Guideline',
    description:
        'Read a workspace-level guideline from `_copilot_guidelines/`. Without a fileName, returns the file list and the index.md content.',
    tags: ['guidelines', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            fileName: {
                type: 'string',
                description: "Optional guideline file (e.g. 'coding_guidelines.md' or 'coding_guidelines'). Without it, returns the index + file list.",
            },
        },
    },
    execute: executeReadGlobalGuideline,
};

interface ListGlobalGuidelinesInput { subfolder?: string }

async function executeListGlobalGuidelines(input: ListGlobalGuidelinesInput): Promise<string> {
    const root = globalGuidelinesRoot();
    if (!root) { return JSON.stringify({ error: '_copilot_guidelines folder not found in workspace root' }); }
    const target = input.subfolder ? path.join(root, input.subfolder) : root;
    if (!fs.existsSync(target)) { return JSON.stringify({ error: `Subfolder not found: ${input.subfolder}` }); }
    const files = walkMarkdown(target, root).sort((a, b) => a.path.localeCompare(b.path));
    return JSON.stringify({
        folder: path.relative(root, target) || '.',
        count: files.length,
        files,
    }, null, 2);
}

export const LIST_GLOBAL_GUIDELINES_TOOL: SharedToolDefinition<ListGlobalGuidelinesInput> = {
    name: 'tomAi_listGlobalGuidelines',
    displayName: 'List Global Guidelines',
    description:
        'List all global guideline markdown files under `_copilot_guidelines/` (recursively). Optionally scope to a subfolder (e.g. "dart", "cloud").',
    tags: ['guidelines', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            subfolder: { type: 'string', description: 'Optional subfolder (e.g. "dart", "cloud", "d4rt").' },
        },
    },
    execute: executeListGlobalGuidelines,
};

interface SearchGlobalGuidelinesInput { query: string; caseSensitive?: boolean; maxMatches?: number }

async function executeSearchGlobalGuidelines(input: SearchGlobalGuidelinesInput): Promise<string> {
    const root = globalGuidelinesRoot();
    if (!root) { return JSON.stringify({ error: '_copilot_guidelines folder not found in workspace root' }); }
    if (!input.query) { return JSON.stringify({ error: 'query is required' }); }
    const max = Math.max(1, input.maxMatches ?? 100);
    const matches = runSearch(root, input.query, !!input.caseSensitive, max);
    return JSON.stringify({
        query: input.query,
        count: matches.length,
        truncated: matches.length >= max,
        matches,
    }, null, 2);
}

export const SEARCH_GLOBAL_GUIDELINES_TOOL: SharedToolDefinition<SearchGlobalGuidelinesInput> = {
    name: 'tomAi_searchGlobalGuidelines',
    displayName: 'Search Global Guidelines',
    description:
        'Search the global `_copilot_guidelines/` folder for a substring and return file+line matches.',
    tags: ['guidelines', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: { type: 'string' },
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

async function executeReadProjectGuideline(input: ReadProjectGuidelineInput): Promise<string> {
    if (!input.projectPath) { return 'projectPath is required (workspace-relative or absolute).'; }
    const root = projectGuidelinesRoot(input.projectPath);
    if (!root) {
        return `No \`_copilot_guidelines/\` folder found at ${input.projectPath}/_copilot_guidelines/`;
    }
    if (!input.fileName) {
        const files = walkMarkdown(root, root).sort((a, b) => a.path.localeCompare(b.path));
        let result = `Available project guideline files under \`${input.projectPath}/_copilot_guidelines/\`:\n\n`;
        result += files.map((f) => `- ${f.path}`).join('\n');
        const indexPath = path.join(root, 'index.md');
        if (fs.existsSync(indexPath)) {
            result += '\n\n---\n\nindex.md:\n\n';
            result += fs.readFileSync(indexPath, 'utf8');
        }
        return result;
    }
    const resolved = resolveMdFile(root, input.fileName);
    if (!resolved) { return `Guideline file not found: ${input.fileName}`; }
    return readFileSafe(resolved) ?? `Read error: ${resolved}`;
}

export const READ_PROJECT_GUIDELINE_TOOL: SharedToolDefinition<ReadProjectGuidelineInput> = {
    name: 'tomAi_readProjectGuideline',
    displayName: 'Read Project Guideline',
    description:
        'Read a project-level guideline from `{projectPath}/_copilot_guidelines/`. Without a fileName, returns the file list and the index.md for that project.',
    tags: ['guidelines', 'project', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['projectPath'],
        properties: {
            projectPath: { type: 'string', description: 'Project folder path (workspace-relative or absolute).' },
            fileName: {
                type: 'string',
                description: "Optional guideline file (e.g. 'setup.md' or 'setup'). Without it, returns the index + file list.",
            },
        },
    },
    execute: executeReadProjectGuideline,
};

interface ListProjectGuidelinesInput { projectPath: string; subfolder?: string }

async function executeListProjectGuidelines(input: ListProjectGuidelinesInput): Promise<string> {
    if (!input.projectPath) { return JSON.stringify({ error: 'projectPath is required' }); }
    const root = projectGuidelinesRoot(input.projectPath);
    if (!root) {
        return JSON.stringify({
            error: `No _copilot_guidelines folder under ${input.projectPath}/_copilot_guidelines/`,
        });
    }
    const target = input.subfolder ? path.join(root, input.subfolder) : root;
    if (!fs.existsSync(target)) { return JSON.stringify({ error: `Subfolder not found: ${input.subfolder}` }); }
    const files = walkMarkdown(target, root).sort((a, b) => a.path.localeCompare(b.path));
    return JSON.stringify({
        projectPath: input.projectPath,
        folder: path.relative(root, target) || '.',
        count: files.length,
        files,
    }, null, 2);
}

export const LIST_PROJECT_GUIDELINES_TOOL: SharedToolDefinition<ListProjectGuidelinesInput> = {
    name: 'tomAi_listProjectGuidelines',
    displayName: 'List Project Guidelines',
    description:
        'List all guideline markdown files under `{projectPath}/_copilot_guidelines/` (recursively). Use tomAi_listProjects to discover projectPath values.',
    tags: ['guidelines', 'project', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['projectPath'],
        properties: {
            projectPath: { type: 'string', description: 'Project folder path (workspace-relative or absolute).' },
            subfolder: { type: 'string', description: 'Optional subfolder inside the project guidelines.' },
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

async function executeSearchProjectGuidelines(input: SearchProjectGuidelinesInput): Promise<string> {
    if (!input.projectPath) { return JSON.stringify({ error: 'projectPath is required' }); }
    const root = projectGuidelinesRoot(input.projectPath);
    if (!root) {
        return JSON.stringify({
            error: `No _copilot_guidelines folder under ${input.projectPath}/_copilot_guidelines/`,
        });
    }
    if (!input.query) { return JSON.stringify({ error: 'query is required' }); }
    const max = Math.max(1, input.maxMatches ?? 100);
    const matches = runSearch(root, input.query, !!input.caseSensitive, max);
    return JSON.stringify({
        projectPath: input.projectPath,
        query: input.query,
        count: matches.length,
        truncated: matches.length >= max,
        matches,
    }, null, 2);
}

export const SEARCH_PROJECT_GUIDELINES_TOOL: SharedToolDefinition<SearchProjectGuidelinesInput> = {
    name: 'tomAi_searchProjectGuidelines',
    displayName: 'Search Project Guidelines',
    description:
        'Search a project\'s `_copilot_guidelines/` folder for a substring and return file+line matches.',
    tags: ['guidelines', 'project', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['projectPath', 'query'],
        properties: {
            projectPath: { type: 'string' },
            query: { type: 'string' },
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
    const globalIndexPath = path.join(workspaceRoot, '_copilot_guidelines', 'index.md');
    if (fs.existsSync(globalIndexPath)) {
        try {
            const indexContent = fs.readFileSync(globalIndexPath, 'utf8');
            const intro =
                'Read a workspace-level guideline from `_copilot_guidelines/`. Provide a fileName to read a specific file; without it, returns the index + file list. Use this to understand workspace conventions before making changes.';
            READ_GLOBAL_GUIDELINE_TOOL.description = `${intro}\n\nGlobal guideline index:\n\n${indexContent}`;
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
