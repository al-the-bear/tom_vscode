/**
 * Shared tool executors + SharedToolDefinition instances.
 *
 * Each tool is defined *once* here and consumed by:
 *   - tomAiChat-tools.ts  → VS Code LM registration
 *   - localLlm-handler.ts → Ollama tool-call loop
 *
 * All executors return a plain string result.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { resolvePathVariables } from '../handlers/handler_shared.js';
import { SharedToolDefinition } from './shared-tool-registry';
import { ChatTodoSessionManager, TodoOperationResult } from '../managers/chatTodoSessionManager';
import {
    loadLocalLlmToolsConfig,
    buildAskBigBrotherDescription,
    buildAskCopilotDescription,
    generateModelList,
} from './local-llm-tools-config';
import { updateChatResponseValues, loadSendToChatConfig, DEFAULT_ANSWER_FILE_TEMPLATE } from '../handlers/handler_shared';
import { expandTemplate } from '../handlers/promptTemplate';
import { debugLog } from '../utils/debugLogger.js';
import { logPrompt, logResponse } from '../services/trailLogging';
import { ChatVariablesStore } from '../managers/chatVariablesStore.js';
import { getCurrentToolContext } from '../services/tool-execution-context';
import { TwoTierMemoryService, MemoryScope, MemoryReadScope } from '../services/memory-service';
import { WsPaths } from '../utils/workspacePaths';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ============================================================================
// Helpers
// ============================================================================

function getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function resolvePath(filePath: string): string {
    // Resolve any ${...} variables first
    const expanded = resolvePathVariables(filePath, { silent: true }) ?? filePath;
    const root = getWorkspaceRoot();
    if (path.isAbsolute(expanded)) { return expanded; }
    return path.join(root, expanded);
}

/** Guard against path-traversal outside workspace. */
function isInsideWorkspace(resolvedPath: string): boolean {
    const root = getWorkspaceRoot();
    if (!root) { return true; } // no workspace → allow anything
    const rel = path.relative(root, resolvedPath);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ============================================================================
// READ-ONLY executors
// ============================================================================

// --- read_file ---------------------------------------------------------------

export interface ReadFileInput {
    filePath: string;
    startLine?: number;
    endLine?: number;
}

async function executeReadFile(input: ReadFileInput): Promise<string> {
    const resolved = resolvePath(input.filePath);
    if (!isInsideWorkspace(resolved)) {
        return `Error: path is outside workspace.`;
    }
    if (!fs.existsSync(resolved)) {
        return `File not found: ${resolved}`;
    }
    const content = fs.readFileSync(resolved, 'utf8');
    const lines = content.split('\n');
    const start = (input.startLine ?? 1) - 1;
    const end = input.endLine ?? lines.length;
    return lines.slice(start, end).join('\n');
}

export const READ_FILE_TOOL: SharedToolDefinition<ReadFileInput> = {
    name: 'tomAi_readFile',
    displayName: 'Read File',
    description: 'Read the contents of a file. Optionally specify line range.',
    tags: ['files', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'Path to the file to read (relative to workspace root or absolute).' },
            startLine: { type: 'number', description: 'Optional 1-based start line number.' },
            endLine: { type: 'number', description: 'Optional 1-based end line number.' },
        },
        required: ['filePath'],
    },
    execute: executeReadFile,
};

// --- list_directory ----------------------------------------------------------

export interface ListDirectoryInput { dirPath: string }

async function executeListDirectory(input: ListDirectoryInput): Promise<string> {
    const resolved = resolvePath(input.dirPath);
    if (!isInsideWorkspace(resolved)) {
        return `Error: path is outside workspace.`;
    }
    if (!fs.existsSync(resolved)) {
        return `Directory not found: ${resolved}`;
    }
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return entries.map(e => `${e.name}${e.isDirectory() ? '/' : ''}`).join('\n');
}

export const LIST_DIRECTORY_TOOL: SharedToolDefinition<ListDirectoryInput> = {
    name: 'tomAi_listDirectory',
    displayName: 'List Directory',
    description: 'List the contents of a directory. Directories have a trailing slash.',
    tags: ['files', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            dirPath: { type: 'string', description: 'Path to the directory to list.' },
        },
        required: ['dirPath'],
    },
    execute: executeListDirectory,
};

// --- find_files --------------------------------------------------------------

export interface FindFilesInput { pattern: string; maxResults?: number }

async function executeFindFiles(input: FindFilesInput): Promise<string> {
    const limit = input.maxResults ?? 100;
    try {
        const files = await vscode.workspace.findFiles(input.pattern, '**/node_modules/**', limit);
        const paths = files.map(f => vscode.workspace.asRelativePath(f));
        return paths.length > 0 ? paths.join('\n') : `No files found matching: ${input.pattern}`;
    } catch (error) {
        return `Error finding files: ${error}`;
    }
}

export const FIND_FILES_TOOL: SharedToolDefinition<FindFilesInput> = {
    name: 'tomAi_findFiles',
    displayName: 'Find Files',
    description: 'Find files matching a glob pattern in the workspace.',
    tags: ['files', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: "Glob pattern to match files, e.g. '**/*.ts' or 'src/**/*.dart'" },
            maxResults: { type: 'number', description: 'Maximum number of results to return. Default 100.' },
        },
        required: ['pattern'],
    },
    execute: executeFindFiles,
};

// --- find_text_in_files ------------------------------------------------------

export interface FindTextInFilesInput {
    searchText: string;
    filePattern?: string;
    isRegex?: boolean;
    maxResults?: number;
}

async function executeFindTextInFiles(input: FindTextInFilesInput): Promise<string> {
    const workspaceRoot = getWorkspaceRoot();
    const limit = input.maxResults ?? 50;
    const grepPattern = input.isRegex ? input.searchText : input.searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const includePattern = input.filePattern ?? '*';
    try {
        const { stdout } = await execAsync(
            `grep -rn --include="${includePattern}" -E "${grepPattern}" . 2>/dev/null | head -${limit}`,
            { cwd: workspaceRoot, maxBuffer: 1024 * 1024 },
        );
        return stdout.trim() || `No matches found for: ${input.searchText}`;
    } catch (error: any) {
        if (error.code === 1) { return `No matches found for: ${input.searchText}`; }
        return `Error searching: ${error.message}`;
    }
}

export const FIND_TEXT_IN_FILES_TOOL: SharedToolDefinition<FindTextInFilesInput> = {
    name: 'tomAi_findTextInFiles',
    displayName: 'Find Text in Files',
    description: 'Search for text in files using grep. Returns matching lines with file paths and line numbers.',
    tags: ['files', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            searchText: { type: 'string', description: 'The text or regex pattern to search for.' },
            filePattern: { type: 'string', description: "Optional glob pattern to filter files, e.g. '*.dart'" },
            isRegex: { type: 'boolean', description: 'Whether searchText is a regex pattern. Default false.' },
            maxResults: { type: 'number', description: 'Maximum number of matching lines to return. Default 50.' },
        },
        required: ['searchText'],
    },
    execute: executeFindTextInFiles,
};

// --- fetch_webpage -----------------------------------------------------------

export interface FetchWebpageInput { url: string }

async function executeFetchWebpage(input: FetchWebpageInput): Promise<string> {
    try {
        const { stdout } = await execAsync(
            `curl -sL --max-time 15 "${input.url}" | head -c 50000`,
            { maxBuffer: 1024 * 1024 },
        );
        return stdout || '(empty response)';
    } catch (error: any) {
        return `Error fetching URL: ${error.message}`;
    }
}

export const FETCH_WEBPAGE_TOOL: SharedToolDefinition<FetchWebpageInput> = {
    name: 'tomAi_fetchWebpage',
    displayName: 'Fetch Webpage',
    description: 'Fetch the content of a URL. Returns the raw HTML. Useful for reading documentation or web resources.',
    tags: ['web', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'The URL to fetch.' },
        },
        required: ['url'],
    },
    execute: executeFetchWebpage,
};

// --- web_search (new) --------------------------------------------------------

export interface WebSearchInput { query: string; maxResults?: number }

/**
 * Web search via DuckDuckGo Lite. No API key required.
 * Parses the HTML result page and extracts titles + URLs.
 */
async function executeWebSearch(input: WebSearchInput): Promise<string> {
    const maxResults = input.maxResults ?? 8;

    return new Promise<string>((resolve) => {
        const postData = `q=${encodeURIComponent(input.query)}`;

        const req = https.request(
            {
                hostname: 'lite.duckduckgo.com',
                path: '/lite/',
                method: 'POST',
                headers: {
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    'Content-Type': 'application/x-www-form-urlencoded',
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    'Content-Length': Buffer.byteLength(postData),
                },
                timeout: 15000,
            },
            (res) => {
                let body = '';
                res.on('data', (c: Buffer) => { body += c.toString(); });
                res.on('end', () => {
                    try {
                        const results = parseDuckDuckGoLite(body, maxResults);
                        if (results.length === 0) {
                            resolve(`No results found for: ${input.query}`);
                        } else {
                            resolve(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n'));
                        }
                    } catch {
                        resolve(`Error parsing search results for: ${input.query}`);
                    }
                });
                res.on('error', (e) => resolve(`Error: ${e.message}`));
            },
        );
        req.on('error', (e) => resolve(`Error: ${e.message}`));
        req.on('timeout', () => { req.destroy(); resolve('Error: search request timed out'); });
        req.write(postData);
        req.end();
    });
}

interface SearchResult { title: string; url: string; snippet: string }

/**
 * Parse DuckDuckGo Lite HTML response.
 * The lite page uses simple HTML tables with result links and snippets.
 */
function parseDuckDuckGoLite(html: string, max: number): SearchResult[] {
    const results: SearchResult[] = [];

    // DDG Lite puts results in table rows. Links are in <a> tags with class "result-link".
    // Snippets follow in nearby <td> with class "result-snippet".
    const linkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

    const links: { url: string; title: string }[] = [];
    let m: RegExpExecArray | null;

    while ((m = linkRegex.exec(html)) !== null) {
        const url = m[1].trim();
        const title = m[2].replace(/<[^>]*>/g, '').trim();
        if (url && title) { links.push({ url, title }); }
    }

    const snippets: string[] = [];
    while ((m = snippetRegex.exec(html)) !== null) {
        snippets.push(m[1].replace(/<[^>]*>/g, '').trim());
    }

    for (let i = 0; i < Math.min(links.length, max); i++) {
        results.push({
            title: links[i].title,
            url: links[i].url,
            snippet: snippets[i] ?? '',
        });
    }

    return results;
}

export const WEB_SEARCH_TOOL: SharedToolDefinition<WebSearchInput> = {
    name: 'tomAi_webSearch',
    displayName: 'Web Search',
    description: 'Search the web using DuckDuckGo. Returns titles, URLs, and snippets of the top results. Use this to research topics, find documentation, or discover solutions.',
    tags: ['web', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The search query.' },
            maxResults: { type: 'number', description: 'Maximum number of results to return. Default 8.' },
        },
        required: ['query'],
    },
    execute: executeWebSearch,
};

// --- get_errors --------------------------------------------------------------

export interface GetErrorsInput { filePath?: string }

async function executeGetErrors(input: GetErrorsInput): Promise<string> {
    let diagnostics: [vscode.Uri, readonly vscode.Diagnostic[]][];
    if (input.filePath) {
        const resolved = resolvePath(input.filePath);
        const uri = vscode.Uri.file(resolved);
        diagnostics = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
        diagnostics = vscode.languages.getDiagnostics();
    }
    const errors: string[] = [];
    for (const [uri, diags] of diagnostics) {
        for (const d of diags) {
            if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) { continue; }
            const sev = d.severity === vscode.DiagnosticSeverity.Error ? '❌' : '⚠️';
            errors.push(`${sev} ${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}: ${d.message}`);
        }
    }
    return errors.length > 0 ? errors.slice(0, 100).join('\n') : 'No errors or warnings found.';
}

export const GET_ERRORS_TOOL: SharedToolDefinition<GetErrorsInput> = {
    name: 'tomAi_getErrors',
    displayName: 'Get Errors',
    description: 'Get errors and warnings from VS Code diagnostics.',
    tags: ['diagnostics', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'Optional file path to get errors for. If not specified, returns all errors.' },
        },
    },
    execute: executeGetErrors,
};

// --- read_guideline ----------------------------------------------------------

export interface ReadGuidelineInput { fileName?: string }

/**
 * Generic guideline reader for any base directory.
 * Used by both tom_readGuideline (_copilot_tomai/) and tom_readLocalGuideline (_copilot_local/).
 */
function createGuidelineExecutor(baseDir: string): (input: ReadGuidelineInput) => Promise<string> {
    return async (input: ReadGuidelineInput): Promise<string> => {
        const workspaceRoot = getWorkspaceRoot();
        const guidelinesDir = path.join(workspaceRoot, baseDir);
        if (!fs.existsSync(guidelinesDir)) {
            return `Guidelines directory not found: ${guidelinesDir}`;
        }
        if (!input.fileName) {
            const files = fs.readdirSync(guidelinesDir).filter(f => f.endsWith('.md')).sort();
            let result = `Available guideline files in ${baseDir}/:\n\n`;
            result += files.map(f => `- ${f}`).join('\n');
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
        // try subdirectories
        const subDirs = fs.readdirSync(guidelinesDir, { withFileTypes: true }).filter(d => d.isDirectory());
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
 * Patch tool descriptions at activation time by reading index.md from the
 * respective guideline folders. This embeds the full guideline index into
 * the tool description so the model knows what's available without an extra call.
 */
export function initializeToolDescriptions(): void {
    const workspaceRoot = getWorkspaceRoot();
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

// ============================================================================
// WRITE executors (VS Code LM only — never sent to Ollama by default)
// ============================================================================

// --- create_file -------------------------------------------------------------

export interface CreateFileInput { filePath: string; content: string }

async function executeCreateFile(input: CreateFileInput): Promise<string> {
    const resolved = resolvePath(input.filePath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(resolved, input.content, 'utf8');
    return `Created file: ${resolved}`;
}

export const CREATE_FILE_TOOL: SharedToolDefinition<CreateFileInput> = {
    name: 'tomAi_createFile',
    displayName: 'Create File',
    description: 'Create a new file with the specified content. Creates parent directories if needed.',
    tags: ['files', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'The path to the file to create. Can be absolute or relative to workspace root.' },
            content: { type: 'string', description: 'The content to write to the file.' },
        },
        required: ['filePath', 'content'],
    },
    execute: executeCreateFile,
};

// --- edit_file ---------------------------------------------------------------

export interface EditFileInput { filePath: string; oldText: string; newText: string }

async function executeEditFile(input: EditFileInput): Promise<string> {
    const resolved = resolvePath(input.filePath);
    if (!fs.existsSync(resolved)) { return `File not found: ${resolved}`; }
    const content = fs.readFileSync(resolved, 'utf8');
    if (!content.includes(input.oldText)) { return 'Text not found in file. Make sure oldText matches exactly.'; }
    fs.writeFileSync(resolved, content.replace(input.oldText, input.newText), 'utf8');
    return `Edited file: ${resolved}`;
}

export const EDIT_FILE_TOOL: SharedToolDefinition<EditFileInput> = {
    name: 'tomAi_editFile',
    displayName: 'Edit File',
    description: 'Edit a file by replacing oldText with newText. The oldText must match exactly.',
    tags: ['files', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'The path to the file to edit.' },
            oldText: { type: 'string', description: 'The exact text to find and replace.' },
            newText: { type: 'string', description: 'The text to replace oldText with.' },
        },
        required: ['filePath', 'oldText', 'newText'],
    },
    execute: executeEditFile,
};

// --- multi_edit_file ---------------------------------------------------------

export interface MultiEditFileInput { edits: Array<{ filePath: string; oldText: string; newText: string }> }

async function executeMultiEditFile(input: MultiEditFileInput): Promise<string> {
    const results: string[] = [];
    for (const edit of input.edits) {
        const resolved = resolvePath(edit.filePath);
        if (!fs.existsSync(resolved)) { results.push(`❌ File not found: ${resolved}`); continue; }
        const content = fs.readFileSync(resolved, 'utf8');
        if (!content.includes(edit.oldText)) { results.push(`❌ Text not found in: ${resolved}`); continue; }
        fs.writeFileSync(resolved, content.replace(edit.oldText, edit.newText), 'utf8');
        results.push(`✅ Edited: ${resolved}`);
    }
    return results.join('\n');
}

export const MULTI_EDIT_FILE_TOOL: SharedToolDefinition<MultiEditFileInput> = {
    name: 'tomAi_multiEditFile',
    displayName: 'Multi Edit File',
    description: 'Apply multiple find/replace edits across one or more files.',
    tags: ['files', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            edits: {
                type: 'array', description: 'Array of edit operations to apply.',
                items: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string' },
                        oldText: { type: 'string' },
                        newText: { type: 'string' },
                    },
                    required: ['filePath', 'oldText', 'newText'],
                },
            },
        },
        required: ['edits'],
    },
    execute: executeMultiEditFile,
};

// --- run_command --------------------------------------------------------------

export interface RunCommandInput { command: string; cwd?: string }

async function executeRunCommand(input: RunCommandInput): Promise<string> {
    const cwd = input.cwd ? resolvePath(input.cwd) : getWorkspaceRoot();
    try {
        const { stdout, stderr } = await execAsync(input.command, { cwd, maxBuffer: 1024 * 1024 });
        return stdout || stderr || '(no output)';
    } catch (error: any) {
        return `Error: ${error.message}\n${error.stderr || ''}`;
    }
}

export const RUN_COMMAND_TOOL: SharedToolDefinition<RunCommandInput> = {
    name: 'tomAi_runCommand',
    displayName: 'Run Command',
    description: 'Run a shell command and return the output.',
    tags: ['terminal', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The shell command to run.' },
            cwd: { type: 'string', description: 'Optional working directory for the command.' },
        },
        required: ['command'],
    },
    execute: executeRunCommand,
};

// --- run_vscode_command ------------------------------------------------------

export interface RunVscodeCommandInput { command: string; args?: unknown[] }

async function executeRunVscodeCommand(input: RunVscodeCommandInput): Promise<string> {
    try {
        const result = await vscode.commands.executeCommand(input.command, ...(input.args ?? []));
        return `Command executed: ${input.command}\nResult: ${JSON.stringify(result) ?? '(no result)'}`;
    } catch (error) {
        return `Error executing command: ${error}`;
    }
}

export const RUN_VSCODE_COMMAND_TOOL: SharedToolDefinition<RunVscodeCommandInput> = {
    name: 'tomAi_runVscodeCommand',
    displayName: 'Run VS Code Command',
    description: 'Execute a VS Code command by ID.',
    tags: ['vscode', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The VS Code command ID to execute.' },
            args: { type: 'array', description: 'Optional arguments to pass to the command.', items: { type: 'string' } },
        },
        required: ['command'],
    },
    execute: executeRunVscodeCommand,
};

// --- git ---------------------------------------------------------------------

export interface GitInput {
    subcommand: 'status' | 'diff' | 'log' | 'blame';
    args?: string[];
}

const ALLOWED_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'blame']);

async function executeGit(input: GitInput): Promise<string> {
    const sub = (input.subcommand || '').toString();
    if (!ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
        return `Error: subcommand must be one of status, diff, log, blame.`;
    }
    const args = Array.isArray(input.args)
        ? input.args.filter((a): a is string => typeof a === 'string')
        : [];
    const cwd = getWorkspaceRoot();
    try {
        const { stdout, stderr } = await execFileAsync('git', [sub, ...args], {
            cwd,
            maxBuffer: 4 * 1024 * 1024,
        });
        return stdout || stderr || '(no output)';
    } catch (error: any) {
        const stderr = error?.stderr ? `\n${error.stderr}` : '';
        return `Error: ${error?.message ?? String(error)}${stderr}`;
    }
}

export const GIT_TOOL: SharedToolDefinition<GitInput> = {
    name: 'tomAi_git',
    displayName: 'Git',
    description: 'Run a structured read-only git command (status, diff, log, blame) and return its output.',
    tags: ['git', 'tom-ai-chat'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            subcommand: {
                type: 'string',
                enum: ['status', 'diff', 'log', 'blame'],
                description: 'Git subcommand to run.',
            },
            args: {
                type: 'array',
                description: 'Optional arguments appended after the subcommand (e.g. ["--stat"], ["-n","20"]).',
                items: { type: 'string' },
            },
        },
        required: ['subcommand'],
    },
    execute: executeGit,
};

// --- delete_file -------------------------------------------------------------

export interface DeleteFileInput { path: string }

async function executeDeleteFile(input: DeleteFileInput): Promise<string> {
    if (!input?.path) { return 'Error: path is required.'; }
    const resolved = resolvePath(input.path);
    if (!isInsideWorkspace(resolved)) {
        return `Error: path is outside workspace.`;
    }
    try {
        await fs.promises.unlink(resolved);
        return `Deleted: ${resolved}`;
    } catch (error: any) {
        return `Error: ${error?.message ?? String(error)}`;
    }
}

export const DELETE_FILE_TOOL: SharedToolDefinition<DeleteFileInput> = {
    name: 'tomAi_deleteFile',
    displayName: 'Delete File',
    description: 'Delete a file from the workspace. Requires user approval.',
    tags: ['files', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute path of the file to delete.' },
        },
        required: ['path'],
    },
    execute: executeDeleteFile,
};

// --- move_file ---------------------------------------------------------------

export interface MoveFileInput { from: string; to: string }

async function executeMoveFile(input: MoveFileInput): Promise<string> {
    if (!input?.from || !input?.to) { return 'Error: from and to are required.'; }
    const fromResolved = resolvePath(input.from);
    const toResolved = resolvePath(input.to);
    if (!isInsideWorkspace(fromResolved) || !isInsideWorkspace(toResolved)) {
        return `Error: paths must be inside the workspace.`;
    }
    try {
        await fs.promises.mkdir(path.dirname(toResolved), { recursive: true });
        await fs.promises.rename(fromResolved, toResolved);
        return `Moved: ${fromResolved} → ${toResolved}`;
    } catch (error: any) {
        return `Error: ${error?.message ?? String(error)}`;
    }
}

export const MOVE_FILE_TOOL: SharedToolDefinition<MoveFileInput> = {
    name: 'tomAi_moveFile',
    displayName: 'Move/Rename File',
    description: 'Move or rename a file within the workspace. Requires user approval.',
    tags: ['files', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            from: { type: 'string', description: 'Source path (workspace-relative or absolute).' },
            to: { type: 'string', description: 'Destination path (workspace-relative or absolute).' },
        },
        required: ['from', 'to'],
    },
    execute: executeMoveFile,
};

// ============================================================================
// Todo tool — needs special wiring for the active chat todo session manager
// ============================================================================

let activeTodoManager: ChatTodoSessionManager | null = null;

export function setActiveTodoManager(manager: ChatTodoSessionManager | null): void {
    activeTodoManager = manager;
}

export function getActiveTodoManager(): ChatTodoSessionManager | null {
    return activeTodoManager;
}

export interface ManageTodoInput {
    operation: 'list' | 'add' | 'update' | 'remove' | 'clear';
    id?: number;
    title?: string;
    description?: string;
    status?: 'not-started' | 'in-progress' | 'completed';
    filterStatus?: 'not-started' | 'in-progress' | 'completed';
}

async function executeManageTodo(input: ManageTodoInput): Promise<string> {
    const todoManager = activeTodoManager;
    if (!todoManager) {
        return 'Error: No active todo manager. This tool only works during Tom AI Chat sessions.';
    }
    let result: TodoOperationResult;
    switch (input.operation) {
        case 'list': result = await todoManager.list(input.filterStatus); break;
        case 'add':
            if (!input.title) { return 'Error: "title" is required for add operation.'; }
            result = await todoManager.add(input.title, input.description || '');
            break;
        case 'update':
            if (input.id === undefined) { return 'Error: "id" is required for update operation.'; }
            result = await todoManager.update(input.id, { title: input.title, description: input.description, status: input.status });
            break;
        case 'remove':
            if (input.id === undefined) { return 'Error: "id" is required for remove operation.'; }
            result = await todoManager.remove(input.id);
            break;
        case 'clear': result = await todoManager.clear(); break;
        default: return `Error: Unknown operation "${input.operation}". Use: list, add, update, remove, or clear.`;
    }
    const lines: string[] = [result.message, ''];
    if (result.todos && result.todos.length > 0) {
        lines.push('**Current Todos:**');
        for (const todo of result.todos) {
            const icon = todo.status === 'completed' ? '✅' : todo.status === 'in-progress' ? '🔄' : '⬜';
            lines.push(`${icon} **#${todo.id}** ${todo.title} _(${todo.status})_`);
            if (todo.description) { lines.push(`   ${todo.description}`); }
        }
    } else if (result.todos && result.todos.length === 0) {
        lines.push('No todos.');
    }
    return lines.join('\n');
}

export const MANAGE_TODO_TOOL: SharedToolDefinition<ManageTodoInput> = {
    name: 'tomAi_manageTodo',
    displayName: 'Manage Todo List',
    description:
        "Optional: Manage a persistent todo list for complex multi-step tasks. Skip for simple tasks. Operations: 'list' (view todos), 'add' (create with title/description), 'update' (change status/title/description by id), 'remove' (delete by id), 'clear' (remove all). Status values: not-started, in-progress, completed. Use when you have 3+ distinct steps to track.",
    tags: ['todo', 'task-management', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['operation'],
        properties: {
            operation: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'clear'], description: 'The operation to perform.' },
            id: { type: 'number', description: "Todo ID. Required for 'update' and 'remove'." },
            title: { type: 'string', description: "Short headline for the todo. Required for 'add', optional for 'update'." },
            description: { type: 'string', description: 'Detailed description. Optional.' },
            status: { type: 'string', enum: ['not-started', 'in-progress', 'completed'], description: "Todo status. Used with 'update'." },
            filterStatus: { type: 'string', enum: ['not-started', 'in-progress', 'completed'], description: "Filter by status when using 'list'." },
        },
    },
    execute: executeManageTodo,
};

// ============================================================================
// Ask Big Brother — query VS Code language models from local LLM
// ============================================================================

export interface AskBigBrotherInput {
    operation: 'list' | 'query';
    modelId?: string;
    prompt?: string;
    enableTools?: boolean;
    maxIterations?: number;
}

/**
 * Cache for available models (refreshed on each list operation)
 */
let cachedModels: Array<{
    id: string;
    name: string;
    vendor: string;
    family: string;
    maxInputTokens: number;
}> = [];

/**
 * Convert tool result to text (simplified version for Big Brother tool)
 */
function toolResultToTextBigBrother(result: vscode.LanguageModelToolResult): string {
    const config = loadLocalLlmToolsConfig();
    const maxChars = config.askBigBrother.maxToolResultChars;
    
    const parts: string[] = [];
    for (const part of result.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            parts.push(part.value);
        } else if (typeof part === 'object' && part !== null) {
            if ('value' in part) {
                parts.push(String(part.value));
            } else {
                parts.push(JSON.stringify(part));
            }
        }
    }
    const text = parts.join('\n');
    if (text.length > maxChars) {
        return text.substring(0, maxChars) + '\n... [truncated]';
    }
    return text;
}

async function executeAskBigBrother(input: AskBigBrotherInput): Promise<string> {
    // Lazy-init: enrich tool description with model list on first use
    await ensureLocalLlmBridgeToolsInitialized();

    const config = loadLocalLlmToolsConfig();
    
    // Check if tool is enabled
    if (!config.askBigBrother.enabled) {
        return 'Error: Ask Big Brother tool is disabled. Enable it in the status page settings.';
    }
    
    if (input.operation === 'list') {
        const modelList = await generateModelList();
        return modelList + '\n\n' + config.askBigBrother.modelRecommendations;
    }

    if (input.operation === 'query') {
        if (!input.prompt) {
            return 'Error: "prompt" is required for query operation.';
        }

        try {
            // Select model based on modelId or default from config
            const targetModel = input.modelId || config.askBigBrother.defaultModel;
            let models: vscode.LanguageModelChat[];
            
            // Try exact ID match first
            models = await vscode.lm.selectChatModels({ id: targetModel });
            
            // Try family match
            if (models.length === 0) {
                models = await vscode.lm.selectChatModels({ family: targetModel });
            }
            
            // Try partial name match
            if (models.length === 0) {
                const allModels = await vscode.lm.selectChatModels();
                models = allModels.filter(m => 
                    m.name.toLowerCase().includes(targetModel.toLowerCase()) ||
                    m.id.toLowerCase().includes(targetModel.toLowerCase())
                );
            }

            if (models.length === 0) {
                return `No model found matching "${targetModel}". Use operation "list" to see available models.`;
            }

            const model = models[0];
            const questId = WsPaths.getWorkspaceQuestId();

            logPrompt('tomai', model.id, input.prompt, undefined, {
                questId,
                model: model.id,
                source: 'localLlmTool',
                tool: 'tomAi_askBigBrother',
                enableTools: input.enableTools,
            });
            
            const tokenSource = new vscode.CancellationTokenSource();
            const enableTools = input.enableTools ?? config.askBigBrother.enableToolsByDefault;
            const timeoutMs = config.askBigBrother.responseTimeout;
            const timeoutId = setTimeout(() => tokenSource.cancel(), timeoutMs);
            
            try {
                // Prepare tools if enabled
                let tools: vscode.LanguageModelChatTool[] = [];
                if (enableTools) {
                    tools = Array.from(vscode.lm.tools) as vscode.LanguageModelChatTool[];
                }
                
                const maxIter = enableTools ? (input.maxIterations ?? config.askBigBrother.maxIterations) : 1;
                let finalResponse = '';
                
                // Build conversation history with proper message types
                const messages: vscode.LanguageModelChatMessage[] = [
                    vscode.LanguageModelChatMessage.User(input.prompt),
                ];

                for (let iteration = 1; iteration <= maxIter; iteration++) {
                    if (tokenSource.token.isCancellationRequested) {
                        break;
                    }
                    
                    const requestOptions = tools.length > 0 ? { tools } : {};
                    const response = await model.sendRequest(messages, requestOptions, tokenSource.token);
                    
                    let iterationText = '';
                    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
                    
                    for await (const part of response.stream) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            iterationText += part.value;
                        } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            toolCalls.push(part);
                        }
                    }
                    
                    // No tool calls - we're done
                    if (toolCalls.length === 0) {
                        finalResponse = iterationText.trim();
                        break;
                    }
                    
                    // Build Assistant message from text + tool calls
                    const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
                    if (iterationText) {
                        assistantParts.push(new vscode.LanguageModelTextPart(iterationText));
                    }
                    assistantParts.push(...toolCalls);
                    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

                    // Execute tool calls and build proper LanguageModelToolResultPart messages
                    const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
                    for (const call of toolCalls) {
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const toolInvocationOptions: any = {
                                input: call.input as object,
                                toolInvocationToken: undefined
                            };
                            const toolResult = await vscode.lm.invokeTool(call.name, toolInvocationOptions);
                            const resultText = toolResultToTextBigBrother(toolResult);
                            toolResultParts.push(
                                new vscode.LanguageModelToolResultPart(call.callId, [
                                    new vscode.LanguageModelTextPart(resultText),
                                ])
                            );
                        } catch (error) {
                            toolResultParts.push(
                                new vscode.LanguageModelToolResultPart(call.callId, [
                                    new vscode.LanguageModelTextPart(`Tool ${call.name} error: ${error}`),
                                ])
                            );
                        }
                    }
                    
                    messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
                }
                
                clearTimeout(timeoutId);
                
                // Optionally summarize long responses
                if (config.askBigBrother.summarizationEnabled && 
                    finalResponse.length > config.askBigBrother.maxResponseChars) {
                    try {
                        finalResponse = await summarizeResponse(finalResponse, config);
                    } catch {
                        // Keep original if summarization fails
                    }
                }
                
                const toolsNote = enableTools ? ' (with tools)' : '';
                logResponse('tomai', model.id, finalResponse, true, {
                    questId,
                    model: model.id,
                    source: 'localLlmTool',
                    tool: 'tomAi_askBigBrother',
                    enableTools,
                });
                return `**Response from ${model.name}${toolsNote}:**\n\n${finalResponse}`;
            } catch (error: unknown) {
                clearTimeout(timeoutId);
                if (error instanceof vscode.LanguageModelError) {
                    return `Model error (${error.code}): ${error.message}`;
                }
                throw error;
            }
        } catch (error) {
            return `Error querying model: ${error}`;
        }
    }

    return `Unknown operation: ${input.operation}. Use "list" or "query".`;
}

/**
 * Summarize a long response using the configured summarization model
 */
async function summarizeResponse(response: string, config: ReturnType<typeof loadLocalLlmToolsConfig>): Promise<string> {
    const summaryConfig = config.askBigBrother;
    
    let models = await vscode.lm.selectChatModels({ family: summaryConfig.summarizationModel });
    if (models.length === 0) {
        models = await vscode.lm.selectChatModels({ id: summaryConfig.summarizationModel });
    }
    if (models.length === 0) {
        return response; // No summarization model available
    }
    
    const prompt = summaryConfig.summarizationPromptTemplate.replace('${response}', response);
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    
    const tokenSource = new vscode.CancellationTokenSource();
    const timeoutId = setTimeout(() => tokenSource.cancel(), 30000);
    
    try {
        const result = await models[0].sendRequest(messages, {}, tokenSource.token);
        let summary = '';
        for await (const chunk of result.text) {
            summary += chunk;
        }
        clearTimeout(timeoutId);
        return `[Summarized from ${response.length} chars]\n\n${summary.trim()}`;
    } finally {
        clearTimeout(timeoutId);
    }
}

export const ASK_BIG_BROTHER_TOOL: SharedToolDefinition<AskBigBrotherInput> = {
    name: 'tomAi_askBigBrother',
    displayName: 'Ask Big Brother',
    description: `Query VS Code language models (GitHub Copilot, Claude, GPT-4, etc.) from your local LLM. This is your fallback bridge for complex questions.

**Operations:**
- "list": Get available models with recommendations
- "query": Send a prompt to a model (specify modelId or use default)

**Tool Support:**
Set enableTools=true to let the model use VS Code tools to gather information before responding.

**When to use:**
- Complex reasoning, architecture decisions, code analysis
- Questions requiring broader knowledge than your training
- Verification of your answers on critical topics`,
    tags: ['ai', 'llm', 'local-llm', 'local-llm-bridge'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['operation'],
        properties: {
            operation: { 
                type: 'string', 
                enum: ['list', 'query'], 
                description: '"list" to see available models, "query" to ask a model.' 
            },
            modelId: { 
                type: 'string', 
                description: 'Model ID, family, or name to query. If omitted, uses configured default.' 
            },
            prompt: { 
                type: 'string', 
                description: 'The question or prompt to send to the model. Required for "query" operation.' 
            },
            enableTools: {
                type: 'boolean',
                description: 'Enable VS Code tools for the model. Default: from config.'
            },
            maxIterations: {
                type: 'number',
                description: 'Maximum tool iterations when enableTools=true. Default: from config.'
            },
        },
    },
    execute: executeAskBigBrother,
};

// ============================================================================
// Ask Copilot — send to Copilot Chat window and wait for answer file
// ============================================================================

export interface AskCopilotInput {
    prompt: string;
    waitForAnswer?: boolean;
    timeoutMs?: number;
}

async function executeAskCopilot(input: AskCopilotInput): Promise<string> {
    const config = loadLocalLlmToolsConfig();
    const questId = WsPaths.getWorkspaceQuestId();
    
    // Check if tool is enabled
    if (!config.askCopilot.enabled) {
        return 'Error: Ask Copilot tool is disabled. Enable it in the status page settings.';
    }
    
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return 'Error: No workspace folder open.';
    }
    
    const waitForAnswer = input.waitForAnswer ?? true;
    const timeoutMs = input.timeoutMs ?? config.askCopilot.answerFileTimeout;

    logPrompt('copilot', 'github_copilot', input.prompt, undefined, {
        questId,
        source: 'localLlmTool',
        tool: 'tomAi_askCopilot',
    });
    
    // Load send-to-chat config for templates
    const sendToChatConfig = loadSendToChatConfig();
    const selectedTemplate = config.askCopilot.promptTemplate;
    const copilotTemplates = sendToChatConfig?.copilot?.templates;
    
    // Get answer file template (always used)
    const answerFileTpl = copilotTemplates?.['__answer_file__'];
    const answerFileTemplate = answerFileTpl?.template || DEFAULT_ANSWER_FILE_TEMPLATE;
    
    let expanded: string;
    
    if (selectedTemplate && selectedTemplate !== '__answer_file__' && selectedTemplate !== '__none__') {
        // Has a selected template: expand template with prompt, then wrap with answer file
        const templateObj = copilotTemplates?.[selectedTemplate];
        if (templateObj?.template) {
            const templateExpanded = await expandTemplate(templateObj.template, { values: { originalPrompt: input.prompt } });
            expanded = await expandTemplate(answerFileTemplate, { values: { originalPrompt: templateExpanded } });
        } else {
            // Template not found, fall back to answer wrapper directly
            expanded = await expandTemplate(answerFileTemplate, { values: { originalPrompt: input.prompt } });
        }
    } else {
        // No template or answer wrapper template: wrap directly with answer file
        expanded = await expandTemplate(answerFileTemplate, { values: { originalPrompt: input.prompt } });
    }
    
    // Clear answer file before sending
    const answerFolder = path.join(workspaceRoot, config.askCopilot.answerFolder);
    const sessionId = vscode.env.sessionId;
    const machineId = vscode.env.machineId;
    const answerFilePath = path.join(answerFolder, `${sessionId}_${machineId}_answer.json`);
    
    if (!fs.existsSync(answerFolder)) {
        fs.mkdirSync(answerFolder, { recursive: true });
    }
    if (fs.existsSync(answerFilePath)) {
        fs.unlinkSync(answerFilePath);
    }
    
    // Send to Copilot Chat
    try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: expanded
        });
    } catch (error) {
        return `Error opening Copilot Chat: ${error}`;
    }
    
    if (!waitForAnswer) {
        return 'Prompt sent to Copilot Chat. Not waiting for answer file.';
    }
    
    // Wait for answer file
    const pollInterval = config.askCopilot.pollInterval;
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        
        if (fs.existsSync(answerFilePath)) {
            try {
                const content = fs.readFileSync(answerFilePath, 'utf-8').trim();
                if (content) {
                    // Try to parse as JSON
                    try {
                        const parsed = JSON.parse(content);
                        // Propagate responseValues to shared store
                        if (parsed.responseValues && typeof parsed.responseValues === 'object') {
                            updateChatResponseValues(parsed.responseValues);
                        }
                        if (parsed.response) {
                            logResponse('copilot', 'github_copilot', String(parsed.response), true, {
                                questId,
                                source: 'localLlmTool',
                                tool: 'tomAi_askCopilot',
                                requestId: parsed.requestId,
                            });
                            return `**Copilot Response:**\n\n${parsed.response}`;
                        }
                        logResponse('copilot', 'github_copilot', JSON.stringify(parsed, null, 2), true, {
                            questId,
                            source: 'localLlmTool',
                            tool: 'tomAi_askCopilot',
                            requestId: parsed.requestId,
                        });
                        return `**Copilot Response:**\n\n${JSON.stringify(parsed, null, 2)}`;
                    } catch {
                        // Plain text fallback
                        logResponse('copilot', 'github_copilot', content, true, {
                            questId,
                            source: 'localLlmTool',
                            tool: 'tomAi_askCopilot',
                        });
                        return `**Copilot Response:**\n\n${content}`;
                    }
                }
            } catch (error) {
                return `Error reading answer file: ${error}`;
            }
        }
    }
    
    return `Timeout waiting for Copilot response after ${timeoutMs / 1000}s. The answer file was not created. Copilot may still be processing - check the chat window.`;
}

export const ASK_COPILOT_TOOL: SharedToolDefinition<AskCopilotInput> = {
    name: 'tomAi_askCopilot',
    displayName: 'Ask Copilot',
    description: `Send a question to GitHub Copilot via the chat window and wait for a response via answer file.

**How it works:**
- Opens Copilot Chat with your prompt
- Watches for an answer file written by Copilot
- Returns the response content

**When to use:**
- Questions that benefit from Copilot's full context (open files, workspace)
- Tasks where Copilot can use its native tools (edit files, run commands)
- Complex coding tasks requiring iterative refinement`,
    tags: ['ai', 'copilot', 'local-llm', 'local-llm-bridge'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
            prompt: { 
                type: 'string', 
                description: 'Your question for Copilot.' 
            },
            waitForAnswer: { 
                type: 'boolean', 
                description: 'Whether to wait for answer file. Default: true.' 
            },
            timeoutMs: { 
                type: 'number', 
                description: 'Max time to wait for answer in milliseconds. Default: from config.' 
            },
        },
    },
    execute: executeAskCopilot,
};

// ============================================================================
// Initialize local-LLM bridge tool descriptions with dynamic model list
// ============================================================================

/**
 * Whether the Ask Big Brother tool description has been enriched
 * with the dynamic model list from selectChatModels().
 */
let localLlmBridgeToolsInitialized = false;

/**
 * Lazy-initialize the Ask Big Brother tool description with the
 * dynamic model list. Called on first executeAskBigBrother() invocation.
 *
 * The heavy part is vscode.lm.selectChatModels() which takes 20–30s
 * during the activation rush due to event loop contention. By deferring
 * to first use, it runs when the event loop is idle (<1s).
 */
async function ensureLocalLlmBridgeToolsInitialized(): Promise<void> {
    if (localLlmBridgeToolsInitialized) return;
    localLlmBridgeToolsInitialized = true;
    try {
        const sub = performance.now();
        const bigBrotherDesc = await buildAskBigBrotherDescription();
        ASK_BIG_BROTHER_TOOL.description = bigBrotherDesc;
        debugLog(`initLocalLlmBridgeTools.buildBigBrotherDesc (first-use): ${Math.round((performance.now() - sub) * 100) / 100}ms`, 'INFO', 'localLlmTools');

        const copilotDesc = buildAskCopilotDescription();
        ASK_COPILOT_TOOL.description = copilotDesc;
    } catch (error) {
        console.error('Error initializing local-LLM bridge tools:', error);
    }
}

// ============================================================================
// Chat variable tools (spec §8.5)
// ============================================================================

const BUILT_IN_CHATVAR_KEYS = new Set(['quest', 'role', 'activeProjects', 'todo', 'todoFile']);

export interface ChatvarReadInput { key?: string }

async function executeChatvarRead(input: ChatvarReadInput): Promise<string> {
    try {
        const store = ChatVariablesStore.instance;
        if (input.key) {
            // Spec §8.5: custom values are addressable both as
            // `${custom.myKey}` and `${myKey}`. Mirror that here so the
            // model can pass either form.
            const key = input.key.startsWith('custom.')
                ? input.key.slice('custom.'.length)
                : input.key;
            const raw = store.getRaw(key);
            return JSON.stringify(raw, null, 2);
        }
        // Spec §8.5 output shape — change log is intentionally omitted.
        const snap = store.snapshot();
        return JSON.stringify({
            quest: snap.quest,
            role: snap.role,
            activeProjects: snap.activeProjects,
            todo: snap.todo,
            todoFile: snap.todoFile,
            custom: snap.custom,
        }, null, 2);
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export const CHATVAR_READ_TOOL: SharedToolDefinition<ChatvarReadInput> = {
    name: 'tomAi_chatvar_read',
    displayName: 'Chat Variable — Read',
    description: 'Read the current chat variables. Omit `key` to return all variables (built-ins + custom.*). Pass a `key` to return just that variable\'s current value.',
    tags: ['chat-variables', 'tom-ai-chat'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            key: { type: 'string', description: 'Optional variable name (built-in or custom). Omit to return everything.' },
        },
    },
    execute: executeChatvarRead,
};

export interface ChatvarWriteInput {
    variables: Record<string, string>;
}

async function executeChatvarWrite(input: ChatvarWriteInput): Promise<string> {
    try {
        const store = ChatVariablesStore.instance;
        const entries = Object.entries(input.variables ?? {});
        const rejected: string[] = [];
        const accepted: Record<string, string> = {};

        for (const [rawKey, rawValue] of entries) {
            // Normalise: strip any accidental "custom." prefix the model may send.
            const key = rawKey.startsWith('custom.') ? rawKey.slice('custom.'.length) : rawKey;
            if (!key) {
                rejected.push(`"${rawKey}" (empty name)`);
                continue;
            }
            if (BUILT_IN_CHATVAR_KEYS.has(key)) {
                rejected.push(key);
                continue;
            }
            accepted[key] = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
        }

        if (Object.keys(accepted).length > 0) {
            // Spec §8.5: log with the calling handler's source and request
            // ID when available. Falls back to 'anthropic' when called
            // without an ambient context (e.g. manual invocation).
            const ctx = getCurrentToolContext();
            const source = ctx?.source ?? 'anthropic';
            store.setCustomBulk(accepted, source, ctx?.requestId);
        }

        const parts: string[] = [];
        if (Object.keys(accepted).length > 0) {
            parts.push(`Updated: ${Object.keys(accepted).map(k => `custom.${k}`).join(', ')}`);
        }
        if (rejected.length > 0) {
            parts.push(`Rejected (built-in or invalid): ${rejected.join(', ')}`);
        }
        if (parts.length === 0) {
            parts.push('No variables provided.');
        }
        return parts.join('\n');
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export const CHATVAR_WRITE_TOOL: SharedToolDefinition<ChatvarWriteInput> = {
    name: 'tomAi_chatvar_write',
    displayName: 'Chat Variable — Write',
    description: 'Update one or more custom chat variables. Keys are stored under the `custom.*` namespace. Built-in keys (quest, role, activeProjects, todo, todoFile) are rejected — those are user-only fields. Every change is visible live in the Chat Variables Editor.',
    tags: ['chat-variables', 'tom-ai-chat'],
    readOnly: false,
    // Intentionally false: spec §8.5 — the Chat Variables panel shows every
    // write in real time, so the approval dialog would be redundant friction.
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            variables: {
                type: 'object',
                description: 'Map of variable names to string values. Plain names only — the tool prepends "custom." automatically. Built-in names are rejected.',
                additionalProperties: { type: 'string' },
            },
        },
        required: ['variables'],
    },
    execute: executeChatvarWrite,
};

// ============================================================================
// Memory tools (spec §8.2)
// ============================================================================

function parseWriteScope(scope: unknown): MemoryScope {
    return scope === 'shared' ? 'shared' : 'quest';
}

function parseReadScope(scope: unknown): MemoryReadScope {
    if (scope === 'shared' || scope === 'all') {
        return scope;
    }
    return 'quest';
}

export interface MemorySaveInput {
    scope?: 'quest' | 'shared';
    file?: string;
    content: string;
    heading?: string;
}

async function executeMemorySave(input: MemorySaveInput): Promise<string> {
    try {
        const svc = TwoTierMemoryService.instance;
        const scope = parseWriteScope(input.scope);
        const file = (input.file || 'facts.md').trim() || 'facts.md';
        if (!input.content || !input.content.trim()) {
            return 'Error: content is empty.';
        }
        if (input.heading) {
            svc.replaceSection(scope, file, input.heading, input.content);
            return `Memory (${scope}/${file}) — section "${input.heading}" replaced.`;
        }
        svc.append(scope, file, input.content);
        return `Memory (${scope}/${file}) — appended ${input.content.length} chars.`;
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export const MEMORY_SAVE_TOOL: SharedToolDefinition<MemorySaveInput> = {
    name: 'tomAi_memory_save',
    displayName: 'Memory — Save',
    description: 'Append a fact to a memory file (or replace a named markdown section when `heading` is provided). Default file is `facts.md`. Scope is `quest` (default) or `shared`.',
    tags: ['memory', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            scope: { type: 'string', enum: ['quest', 'shared'], description: 'Memory tier — quest (default) or shared.' },
            file: { type: 'string', description: 'Memory file name within the scope (default: facts.md).' },
            content: { type: 'string', description: 'Fact or section body to persist.' },
            heading: { type: 'string', description: 'Optional markdown heading to replace. Omit to append at end.' },
        },
        required: ['content'],
    },
    execute: executeMemorySave,
};

export interface MemoryUpdateInput {
    scope?: 'quest' | 'shared';
    file: string;
    heading: string;
    content: string;
}

async function executeMemoryUpdate(input: MemoryUpdateInput): Promise<string> {
    try {
        const svc = TwoTierMemoryService.instance;
        const scope = parseWriteScope(input.scope);
        if (!input.file || !input.heading) {
            return 'Error: file and heading are required.';
        }
        svc.replaceSection(scope, input.file, input.heading, input.content ?? '');
        return `Memory (${scope}/${input.file}) — section "${input.heading}" updated.`;
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export const MEMORY_UPDATE_TOOL: SharedToolDefinition<MemoryUpdateInput> = {
    name: 'tomAi_memory_update',
    displayName: 'Memory — Update section',
    description: 'Replace the content under a named markdown heading in a memory file. If the heading does not exist yet it is appended.',
    tags: ['memory', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            scope: { type: 'string', enum: ['quest', 'shared'] },
            file: { type: 'string', description: 'Memory file name within the scope.' },
            heading: { type: 'string', description: 'Markdown heading text to target (without the leading #).' },
            content: { type: 'string', description: 'New content for the section.' },
        },
        required: ['file', 'heading', 'content'],
    },
    execute: executeMemoryUpdate,
};

export interface MemoryForgetInput {
    scope?: 'quest' | 'shared';
    file: string;
    heading?: string;
}

async function executeMemoryForget(input: MemoryForgetInput): Promise<string> {
    try {
        const svc = TwoTierMemoryService.instance;
        const scope = parseWriteScope(input.scope);
        if (!input.file) {
            return 'Error: file is required.';
        }
        if (input.heading) {
            svc.replaceSection(scope, input.file, input.heading, '');
            return `Memory (${scope}/${input.file}) — section "${input.heading}" cleared.`;
        }
        svc.delete(scope, input.file);
        return `Memory (${scope}/${input.file}) — file deleted.`;
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export const MEMORY_FORGET_TOOL: SharedToolDefinition<MemoryForgetInput> = {
    name: 'tomAi_memory_forget',
    displayName: 'Memory — Forget',
    description: 'Delete an entire memory file, or clear the content under a named markdown heading when `heading` is provided.',
    tags: ['memory', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            scope: { type: 'string', enum: ['quest', 'shared'] },
            file: { type: 'string', description: 'Memory file name within the scope.' },
            heading: { type: 'string', description: 'Optional heading to clear instead of deleting the whole file.' },
        },
        required: ['file'],
    },
    execute: executeMemoryForget,
};

export interface MemoryReadInput {
    scope?: 'quest' | 'shared' | 'all';
    file?: string;
}

async function executeMemoryRead(input: MemoryReadInput): Promise<string> {
    try {
        const svc = TwoTierMemoryService.instance;
        const scope = parseReadScope(input.scope);
        if (input.file) {
            if (scope === 'all') {
                const shared = svc.read('shared', input.file);
                const quest = svc.read('quest', input.file);
                const parts: string[] = [];
                if (shared) parts.push(`### shared/${input.file}\n${shared.trimEnd()}`);
                if (quest)  parts.push(`### quest/${input.file}\n${quest.trimEnd()}`);
                return parts.length > 0 ? parts.join('\n\n') : '(empty)';
            }
            const body = svc.read(scope, input.file);
            return body ? body : '(empty)';
        }
        const body = svc.readAll(scope);
        return body || '(no memory files in scope)';
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export const MEMORY_READ_TOOL: SharedToolDefinition<MemoryReadInput> = {
    name: 'tomAi_memory_read',
    displayName: 'Memory — Read',
    description: 'Read memory contents. Omit `file` to get the concatenated contents of all files in the scope. Scope is `quest` (default), `shared`, or `all`.',
    tags: ['memory', 'tom-ai-chat'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            scope: { type: 'string', enum: ['quest', 'shared', 'all'] },
            file: { type: 'string', description: 'Optional file name within the scope.' },
        },
    },
    execute: executeMemoryRead,
};

export interface MemoryListInput {
    scope?: 'quest' | 'shared' | 'all';
}

async function executeMemoryList(input: MemoryListInput): Promise<string> {
    try {
        const svc = TwoTierMemoryService.instance;
        const scope = parseReadScope(input.scope);
        const scopes: MemoryScope[] = scope === 'all' ? ['shared', 'quest'] : [scope];
        const lines: string[] = [];
        for (const tier of scopes) {
            const files = svc.list(tier);
            if (files.length === 0) {
                lines.push(`(${tier}) (empty)`);
            } else {
                for (const f of files) {
                    lines.push(`${tier}/${f}`);
                }
            }
        }
        return lines.join('\n');
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export const MEMORY_LIST_TOOL: SharedToolDefinition<MemoryListInput> = {
    name: 'tomAi_memory_list',
    displayName: 'Memory — List',
    description: 'List memory files in the given scope. Scope is `quest` (default), `shared`, or `all`.',
    tags: ['memory', 'tom-ai-chat'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            scope: { type: 'string', enum: ['quest', 'shared', 'all'] },
        },
    },
    execute: executeMemoryList,
};

// ============================================================================
// Master registry — all shared tools in one array
// ============================================================================

import { CHAT_ENHANCEMENT_TOOLS } from './chat-enhancement-tools';
import { WAVE_A_TOOLS } from './workspace-awareness-tools';
import { WAVE_B_TOOLS } from './ide-navigation-tools';

/** All shared tool definitions (registered with VS Code LM API). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_SHARED_TOOLS: SharedToolDefinition<any>[] = [
    // Read-only tools (available to both Ollama and VS Code LM)
    READ_FILE_TOOL,
    LIST_DIRECTORY_TOOL,
    FIND_FILES_TOOL,
    FIND_TEXT_IN_FILES_TOOL,
    FETCH_WEBPAGE_TOOL,
    WEB_SEARCH_TOOL,
    GET_ERRORS_TOOL,
    READ_GUIDELINE_TOOL,        // VS Code LM only — reads from _copilot_tomai/
    READ_LOCAL_GUIDELINE_TOOL,   // Ollama only — reads from _copilot_local/
    ASK_BIG_BROTHER_TOOL,        // Local LLM only — escalate to VS Code LM API
    ASK_COPILOT_TOOL,            // Local LLM only — escalate to Copilot Chat window
    // Write tools (VS Code LM only by default)
    CREATE_FILE_TOOL,
    EDIT_FILE_TOOL,
    MULTI_EDIT_FILE_TOOL,
    RUN_COMMAND_TOOL,
    RUN_VSCODE_COMMAND_TOOL,
    GIT_TOOL,
    DELETE_FILE_TOOL,
    MOVE_FILE_TOOL,
    MANAGE_TODO_TOOL,
    // Chat-enhancement tools (§1.1–§1.4)
    ...CHAT_ENHANCEMENT_TOOLS,
    // Chat variable tools (anthropic_sdk_integration §8.5)
    CHATVAR_READ_TOOL,
    CHATVAR_WRITE_TOOL,
    // Memory tools (anthropic_sdk_integration §8.2)
    MEMORY_SAVE_TOOL,
    MEMORY_UPDATE_TOOL,
    MEMORY_FORGET_TOOL,
    MEMORY_READ_TOOL,
    MEMORY_LIST_TOOL,
    // Wave A — workspace awareness (llm_tools.md §6.3)
    ...WAVE_A_TOOLS,
    // Wave B — IDE navigation (llm_tools.md §6.3)
    ...WAVE_B_TOOLS,
];

/**
 * Read-only tools suitable for Ollama (local LLM).
 * Excludes tomAi_readGuideline (for VS Code LM only) — Ollama uses tomAi_readLocalGuideline instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const READ_ONLY_TOOLS: SharedToolDefinition<any>[] = ALL_SHARED_TOOLS.filter(
    t => t.readOnly && t.name !== 'tomAi_readGuideline',
);
