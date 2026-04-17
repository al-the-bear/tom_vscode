/**
 * Guideline tools — read and search `_copilot_*` / `_copilot_guidelines` folders.
 *
 * Three surfaces:
 *   - `_copilot_tomai/` — workspace-specific guidelines consumed by Tom AI Chat.
 *   - `_copilot_local/` — guidelines specific to the local-LLM transport.
 *   - `_copilot_guidelines/` — newer canonical workspace guidelines folder
 *     (recursive). Also holds `pattern_prompts/` — see `pattern-prompts-tools.ts`.
 *
 * `initializeToolDescriptions()` is called from extension activation to embed
 * each folder's `index.md` into the corresponding tool description, so the
 * model sees the inventory without a first lookup.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// ---------------------------------------------------------------------------
// Legacy readers (_copilot_tomai/, _copilot_local/)
// ---------------------------------------------------------------------------

export interface ReadGuidelineInput { fileName?: string }

function createGuidelineExecutor(baseDir: string): (input: ReadGuidelineInput) => Promise<string> {
    return async (input: ReadGuidelineInput): Promise<string> => {
        const workspaceRoot = wsRoot() ?? '';
        const guidelinesDir = path.join(workspaceRoot, baseDir);
        if (!fs.existsSync(guidelinesDir)) {
            return `Guidelines directory not found: ${guidelinesDir}`;
        }
        if (!input.fileName) {
            const files = fs.readdirSync(guidelinesDir).filter((f) => f.endsWith('.md')).sort();
            let result = `Available guideline files in ${baseDir}/:\n\n`;
            result += files.map((f) => `- ${f}`).join('\n');
            const indexPath = path.join(guidelinesDir, 'index.md');
            if (fs.existsSync(indexPath)) {
                result += '\n\n---\n\nindex.md content:\n\n';
                result += fs.readFileSync(indexPath, 'utf8');
            }
            return result;
        }
        const targetFile = input.fileName.endsWith('.md') ? input.fileName : `${input.fileName}.md`;
        const filePath = path.join(guidelinesDir, targetFile);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8');
        }
        const subDirs = fs.readdirSync(guidelinesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const sd of subDirs) {
            const subPath = path.join(guidelinesDir, sd.name, targetFile);
            if (fs.existsSync(subPath)) { return fs.readFileSync(subPath, 'utf8'); }
        }
        return `Guideline file not found: ${targetFile}`;
    };
}

const guidelineInputSchema = {
    type: 'object',
    properties: {
        fileName: {
            type: 'string',
            description: "Optional specific guideline file to read (e.g., 'coding_guidelines.md' or 'coding_guidelines'). If not specified, returns index.md with list of available files.",
        },
    },
};

export const READ_GUIDELINE_TOOL: SharedToolDefinition<ReadGuidelineInput> = {
    name: 'tomAi_readGuideline',
    displayName: 'Read Guideline',
    description:
        'Read workspace guidelines from _copilot_tomai/ folder. Without a fileName, returns the list of available files and the content of index.md (the main guideline index). Key guidelines: coding_guidelines.md (code structure, naming), documentation_guidelines.md (docs format), tests.md (test creation), project_structure.md (project patterns), bug_fixing.md (debugging workflow). Use this tool to understand workspace conventions before making changes.',
    tags: ['guidelines', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: guidelineInputSchema,
    execute: createGuidelineExecutor('_copilot_tomai'),
};

export const READ_LOCAL_GUIDELINE_TOOL: SharedToolDefinition<ReadGuidelineInput> = {
    name: 'tomAi_readLocalGuideline',
    displayName: 'Read Local Guideline',
    description:
        'Read local LLM guidelines from _copilot_local/ folder. Without a fileName, returns the list of available files and the content of index.md. Use this tool to understand workspace conventions before making changes.',
    tags: ['guidelines', 'local-llm'],
    readOnly: true,
    inputSchema: guidelineInputSchema,
    execute: createGuidelineExecutor('_copilot_local'),
};

/**
 * Patch guideline tool descriptions at activation time by embedding the
 * target folder's `index.md`. Extension activation calls this.
 */
export function initializeToolDescriptions(): void {
    const workspaceRoot = wsRoot();
    if (!workspaceRoot) { return; }

    const patchDescription = (tool: SharedToolDefinition<ReadGuidelineInput>, baseDir: string, intro: string) => {
        const indexPath = path.join(workspaceRoot, baseDir, 'index.md');
        if (fs.existsSync(indexPath)) {
            try {
                const indexContent = fs.readFileSync(indexPath, 'utf8');
                tool.description = `${intro}\n\nGuideline index:\n\n${indexContent}`;
            } catch { /* keep static description */ }
        }
    };

    patchDescription(
        READ_GUIDELINE_TOOL,
        '_copilot_tomai',
        'Read workspace guidelines from _copilot_tomai/ folder. Provide a fileName parameter to read a specific guideline. Without fileName, returns the full index and file list. Use this tool to understand workspace conventions before making changes.',
    );

    patchDescription(
        READ_LOCAL_GUIDELINE_TOOL,
        '_copilot_local',
        'Read local LLM guidelines from _copilot_local/ folder. Provide a fileName parameter to read a specific guideline. Without fileName, returns the full index and file list. Use this tool to understand workspace conventions before making changes.',
    );
}

// ---------------------------------------------------------------------------
// _copilot_guidelines/ tools
// ---------------------------------------------------------------------------

interface ListGuidelinesInput { subfolder?: string }

function guidelinesRoot(): string | undefined {
    const root = wsRoot();
    if (!root) { return undefined; }
    const p = path.join(root, '_copilot_guidelines');
    return fs.existsSync(p) ? p : undefined;
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

async function executeListGuidelines(input: ListGuidelinesInput): Promise<string> {
    const root = guidelinesRoot();
    if (!root) { return JSON.stringify({ error: '_copilot_guidelines folder not found' }); }
    const target = input.subfolder ? path.join(root, input.subfolder) : root;
    if (!fs.existsSync(target)) { return JSON.stringify({ error: `Subfolder not found: ${input.subfolder}` }); }
    const files = walkMarkdown(target, root).sort((a, b) => a.path.localeCompare(b.path));
    return JSON.stringify({ folder: path.relative(root, target) || '.', count: files.length, files }, null, 2);
}

export const LIST_GUIDELINES_TOOL: SharedToolDefinition<ListGuidelinesInput> = {
    name: 'tomAi_listGuidelines',
    displayName: 'List Guidelines',
    description:
        'List all guideline markdown files under _copilot_guidelines/ (recursively). ' +
        'Optionally scope to a subfolder (e.g. "dart", "cloud").',
    tags: ['guidelines', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            subfolder: { type: 'string', description: 'Optional subfolder name (e.g. "dart", "cloud", "d4rt").' },
        },
    },
    execute: executeListGuidelines,
};

interface SearchGuidelinesInput { query: string; caseSensitive?: boolean; maxMatches?: number }

async function executeSearchGuidelines(input: SearchGuidelinesInput): Promise<string> {
    const root = guidelinesRoot();
    if (!root) { return JSON.stringify({ error: '_copilot_guidelines folder not found' }); }
    if (!input.query) { return JSON.stringify({ error: 'query is required' }); }
    const flags = input.caseSensitive ? 'g' : 'gi';
    const pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const max = Math.max(1, input.maxMatches ?? 100);

    const files = walkMarkdown(root, root);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    for (const f of files) {
        if (matches.length >= max) { break; }
        let content: string;
        try { content = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
                matches.push({ file: f.path, line: i + 1, text: lines[i].slice(0, 200) });
                if (matches.length >= max) { break; }
            }
            pattern.lastIndex = 0;
        }
    }

    return JSON.stringify({
        query: input.query,
        count: matches.length,
        truncated: matches.length >= max,
        matches,
    }, null, 2);
}

export const SEARCH_GUIDELINES_TOOL: SharedToolDefinition<SearchGuidelinesInput> = {
    name: 'tomAi_searchGuidelines',
    displayName: 'Search Guidelines',
    description:
        'Search the _copilot_guidelines/ folder for a substring/regex and return file+line matches. ' +
        'Use to find conventions before writing code (e.g. query="test naming").',
    tags: ['guidelines', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: { type: 'string', description: 'Substring to match. Regex special chars are escaped.' },
            caseSensitive: { type: 'boolean', description: 'Default false.' },
            maxMatches: { type: 'number', description: 'Max matches. Default 100.' },
        },
    },
    execute: executeSearchGuidelines,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const GUIDELINE_TOOLS: SharedToolDefinition<any>[] = [
    READ_GUIDELINE_TOOL,
    READ_LOCAL_GUIDELINE_TOOL,
    LIST_GUIDELINES_TOOL,
    SEARCH_GUIDELINES_TOOL,
];
