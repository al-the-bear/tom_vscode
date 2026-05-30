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
import { exec } from 'child_process';
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

// --- File primitives -----------------------------------------------
//
// Definitions, input shapes, and pure impls live in `file-primitives.ts`.
// Here we just clone the tool def with a live executor that injects
// `getWorkspaceRoot()` (and the vscode-backed walker for findFiles, so
// production keeps benefiting from VS Code's `search.exclude` integration).
// `findTextInFiles` uses the file-primitives Node-native scanner — the
// old `grep` shell-out had an unfixed injection vulnerability
// (`searchText` was regex-escaped but never shell-escaped).

import {
    READ_FILE_TOOL as READ_FILE_DEF,
    LIST_DIRECTORY_TOOL as LIST_DIRECTORY_DEF,
    FIND_FILES_TOOL as FIND_FILES_DEF,
    FIND_TEXT_IN_FILES_TOOL as FIND_TEXT_IN_FILES_DEF,
    ReadFileInput,
    ListDirectoryInput,
    FindFilesInput,
    FindTextInFilesInput,
    readFileImpl,
    listDirectoryImpl,
    findFilesImpl,
    findTextInFilesImpl,
} from './file-primitives';

export type { ReadFileInput, ListDirectoryInput, FindFilesInput, FindTextInFilesInput };

export const READ_FILE_TOOL: SharedToolDefinition<ReadFileInput> = {
    ...READ_FILE_DEF,
    execute: (input) => readFileImpl(getWorkspaceRoot(), input),
};

export const LIST_DIRECTORY_TOOL: SharedToolDefinition<ListDirectoryInput> = {
    ...LIST_DIRECTORY_DEF,
    execute: (input) => listDirectoryImpl(getWorkspaceRoot(), input),
};

export const FIND_FILES_TOOL: SharedToolDefinition<FindFilesInput> = {
    ...FIND_FILES_DEF,
    execute: (input) => findFilesImpl({
        wsRoot: getWorkspaceRoot(),
        walk: async (pattern, exclude, limit) => {
            const files = await vscode.workspace.findFiles(pattern, exclude, limit);
            return files.map((f) => vscode.workspace.asRelativePath(f));
        },
    }, input),
};

export const FIND_TEXT_IN_FILES_TOOL: SharedToolDefinition<FindTextInFilesInput> = {
    ...FIND_TEXT_IN_FILES_DEF,
    execute: (input) => findTextInFilesImpl({ wsRoot: getWorkspaceRoot() }, input),
};

// --- Web tools (fetch + search) ---------------------------------------------
//
// Definitions + impls live in `web-tools.ts` (vscode-free, no shell).
// The previous `executeFetchWebpage` interpolated the user URL into a
// `curl` shell command — a critical shell-injection vector. The
// rewrite uses Node's http/https directly so there is no shell on the
// path. `webSearch` now goes through a `SearchProvider` interface so
// tests don't have to hit DDG.

import {
    FETCH_WEBPAGE_TOOL as FETCH_WEBPAGE_DEF,
    WEB_SEARCH_TOOL as WEB_SEARCH_DEF,
    FetchWebpageInput,
    WebSearchInput,
    fetchWebpageImpl,
    webSearchImpl,
    buildDuckDuckGoLiteProvider,
} from './web-tools';

export type { FetchWebpageInput, WebSearchInput };

export const FETCH_WEBPAGE_TOOL: SharedToolDefinition<FetchWebpageInput> = {
    ...FETCH_WEBPAGE_DEF,
    execute: (input) => fetchWebpageImpl({}, input),
};

// Production search provider is constructed once at module load; the
// impl re-uses it for every call. Switching engines later is a single
// line — point this at a different factory.
const productionSearchProvider = buildDuckDuckGoLiteProvider();

export const WEB_SEARCH_TOOL: SharedToolDefinition<WebSearchInput> = {
    ...WEB_SEARCH_DEF,
    execute: (input) => webSearchImpl({ provider: productionSearchProvider }, input),
};

// --- get_errors (relocated to diagnostics-tools.ts) -------------------------
//
// The legacy text-format diagnostics tool now lives alongside its sibling
// `tomAi_getProblems` in `diagnostics-tools.ts`. The two share a narrow
// `DiagnosticsSource` dep; live deps are installed by the DIAGNOSTICS_TOOLS
// wiring block further down. Re-exported here for ALL_SHARED_TOOLS-via-name
// references (the bare `GET_ERRORS_TOOL` token is no longer in the array;
// the DIAGNOSTICS_TOOLS spread carries both).

import {
    GET_ERRORS_TOOL as GET_ERRORS_DEF,
    GetErrorsInput,
} from './diagnostics-tools';

export type { GetErrorsInput };
export const GET_ERRORS_TOOL = GET_ERRORS_DEF;

// Guideline tools — global (`_copilot_guidelines/`) + project
// (`{project}/_copilot_guidelines/`) — plus initializeToolDescriptions()
// live in `./guideline-tools.ts`.

// ============================================================================
// WRITE executors (VS Code LM only — never sent to Ollama by default)
// ============================================================================

// --- File mutations ----------------------------------------------------------
//
// Definitions, input shapes, and pure impls live in `file-mutations.ts`.
// Here we just clone each tool def with a live executor that injects
// `getWorkspaceRoot()`. Same pattern as the file primitives above; see
// `file-mutations.ts` for the safer-by-default redesign (createFile
// no longer silently overwrites, editFile requires unique match by
// default, multiEditFile is atomic by default, moveFile handles EXDEV).

import {
    CREATE_FILE_TOOL as CREATE_FILE_DEF,
    EDIT_FILE_TOOL as EDIT_FILE_DEF,
    MULTI_EDIT_FILE_TOOL as MULTI_EDIT_FILE_DEF,
    DELETE_FILE_TOOL as DELETE_FILE_DEF,
    MOVE_FILE_TOOL as MOVE_FILE_DEF,
    CreateFileInput,
    EditFileInput,
    MultiEditFileInput,
    DeleteFileInput,
    MoveFileInput,
    createFileImpl,
    editFileImpl,
    multiEditFileImpl,
    deleteFileImpl,
    moveFileImpl,
} from './file-mutations';

export type { CreateFileInput, EditFileInput, MultiEditFileInput, DeleteFileInput, MoveFileInput };

export const CREATE_FILE_TOOL: SharedToolDefinition<CreateFileInput> = {
    ...CREATE_FILE_DEF,
    execute: (input) => createFileImpl(getWorkspaceRoot(), input),
};

export const EDIT_FILE_TOOL: SharedToolDefinition<EditFileInput> = {
    ...EDIT_FILE_DEF,
    execute: (input) => editFileImpl(getWorkspaceRoot(), input),
};

export const MULTI_EDIT_FILE_TOOL: SharedToolDefinition<MultiEditFileInput> = {
    ...MULTI_EDIT_FILE_DEF,
    execute: (input) => multiEditFileImpl(getWorkspaceRoot(), input),
};

// --- run_command --------------------------------------------------------------
//
// Definition + impl live in `run-command.ts`. Here we just clone the def
// with a live executor that injects `getWorkspaceRoot()`. See run-command.ts
// for the rewrite (explicit timeout/exit-code/truncation, SIGTERM→SIGKILL
// kill escalation, 10 MB buffer cap).

import { RUN_COMMAND_TOOL as RUN_COMMAND_DEF, RunCommandInput, runCommandImpl } from './run-command';

export type { RunCommandInput };

export const RUN_COMMAND_TOOL: SharedToolDefinition<RunCommandInput> = {
    ...RUN_COMMAND_DEF,
    execute: (input) => runCommandImpl({ wsRoot: getWorkspaceRoot() }, input),
};

// --- run_vscode_command ------------------------------------------------------
//
// Relocated to `vscode-command-tools.ts` alongside its sibling tools
// (runVscodeCommandTyped, listCommands, openFile) so all four share one
// vscode-free impl + one set of tests. Re-exported here for the existing
// ALL_SHARED_TOOLS spread; live executor is installed by the
// VSCODE_COMMAND_TOOLS wiring block below.

import {
    RUN_VSCODE_COMMAND_TOOL as RUN_VSCODE_COMMAND_DEF,
    RunVscodeCommandInput,
} from './vscode-command-tools';

export type { RunVscodeCommandInput };
export const RUN_VSCODE_COMMAND_TOOL = RUN_VSCODE_COMMAND_DEF;

// Git tools (tomAi_gitRead, tomAi_gitShow, tomAi_gitWrite) live in `./git-tools.ts`.

// delete_file and move_file are defined alongside the other mutation
// primitives near the top of this file (imported from `file-mutations.ts`).
// They live here so they're co-located with their `requiresApproval` siblings
// and the ALL_SHARED_TOOLS array, but the implementation is in the carved-out
// module for testability.

export const DELETE_FILE_TOOL: SharedToolDefinition<DeleteFileInput> = {
    ...DELETE_FILE_DEF,
    execute: (input) => deleteFileImpl(getWorkspaceRoot(), input),
};

export const MOVE_FILE_TOOL: SharedToolDefinition<MoveFileInput> = {
    ...MOVE_FILE_DEF,
    execute: (input) => moveFileImpl(getWorkspaceRoot(), input),
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
    name: 'tomAi_readChatVariable',
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
    name: 'tomAi_writeChatVariable',
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
    name: 'tomAi_saveMemory',
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
    name: 'tomAi_updateMemory',
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
    name: 'tomAi_forgetMemory',
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
    name: 'tomAi_readMemory',
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
    name: 'tomAi_listMemory',
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
import {
    EDITOR_CONTEXT_TOOLS,
    GET_WORKSPACE_INFO_TOOL as GET_WORKSPACE_INFO_DEF,
    GET_ACTIVE_EDITOR_TOOL as GET_ACTIVE_EDITOR_DEF,
    GET_OPEN_EDITORS_TOOL as GET_OPEN_EDITORS_DEF,
    GetWorkspaceInfoInput,
    GetActiveEditorInput,
    GetOpenEditorsInput,
    type EditorSnapshot,
    type TabKind,
    type TabSnapshot,
    type WorkspaceInfoSnapshot,
    getActiveEditorImpl,
    getOpenEditorsImpl,
    getWorkspaceInfoImpl,
} from './editor-context-tools';
import { execFile } from 'child_process';
import { WsPaths as EditorWsPaths } from '../utils/workspacePaths';

const editorExecFileAsync = promisify(execFile);

// --- Live deps for the editor-context tools. The bridges live here so the
//     impl file stays vscode-free + testable.

async function buildLiveWorkspaceInfoSnapshot(opts: { includeGit: boolean }): Promise<WorkspaceInfoSnapshot> {
    const wsFile = vscode.workspace.workspaceFile?.fsPath ?? '';
    const wsName = vscode.workspace.name ?? '';
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
    const questId = EditorWsPaths.getWorkspaceQuestId();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    let projects: WorkspaceInfoSnapshot['projects'] = null;
    let projectsSource: string | null = null;
    if (root) {
        try {
            const masterPath = EditorWsPaths.metadata('tom_master.yaml');
            if (masterPath && fs.existsSync(masterPath)) {
                const yaml = await import('yaml');
                const doc = yaml.parse(fs.readFileSync(masterPath, 'utf8'));
                if (doc?.projects && Array.isArray(doc.projects)) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    projects = (doc.projects as Array<Record<string, any>>).map((p) => ({
                        id: String(p.id ?? p.name ?? ''),
                        name: String(p.name ?? p.id ?? ''),
                        path: p.path ? String(p.path) : undefined,
                        type: p.type ? String(p.type) : undefined,
                    }));
                    projectsSource = masterPath;
                }
            }
        } catch { /* leave projects null, projectsSource null */ }
    }

    let git: WorkspaceInfoSnapshot['git'] = null;
    if (opts.includeGit && root) {
        const runGit = async (args: string[]): Promise<string> => {
            try {
                const { stdout } = await editorExecFileAsync('git', args, { cwd: root, timeout: 3000 });
                return stdout.trim();
            } catch { return ''; }
        };
        const [branch, commit, statusOut, remote] = await Promise.all([
            runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
            runGit(['rev-parse', '--short', 'HEAD']),
            runGit(['status', '--porcelain']),
            runGit(['remote', 'get-url', 'origin']),
        ]);
        // If every git call failed, this is not a git repo at all → null.
        if (branch || commit || statusOut || remote) {
            git = {
                branch: branch || undefined,
                commit: commit || undefined,
                dirty: statusOut.length > 0,
                remote: remote || undefined,
            };
        }
    }

    return {
        workspaceName: wsName,
        workspaceFile: wsFile,
        workspaceFolders: folders,
        questId,
        projects,
        projectsSource,
        git,
    };
}

function vscodeRangeTo1Based(start: vscode.Position, end: vscode.Position) {
    return {
        startLine: start.line + 1,
        startCharacter: start.character + 1,
        endLine: end.line + 1,
        endCharacter: end.character + 1,
    };
}

function liveActiveEditorSnapshot(opts: { includeSelectionText: boolean; maxSelectionChars: number }): EditorSnapshot | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return null; }
    const doc = editor.document;
    const sel = editor.selection;
    const wsRoot = getWorkspaceRoot();
    const rel = vscode.workspace.asRelativePath(doc.uri);
    let selectionText: string | undefined;
    if (opts.includeSelectionText) {
        const text = doc.getText(sel);
        selectionText = text.length > opts.maxSelectionChars
            ? text.slice(0, opts.maxSelectionChars) + '…'
            : text;
    }
    const visible = editor.visibleRanges[0];
    return {
        file: wsRoot ? rel : doc.uri.fsPath,
        absolutePath: doc.uri.fsPath,
        scheme: doc.uri.scheme,
        language: doc.languageId,
        lineCount: doc.lineCount,
        dirty: doc.isDirty,
        untitled: doc.isUntitled,
        selection: {
            ...vscodeRangeTo1Based(sel.start, sel.end),
            isEmpty: sel.isEmpty,
            text: selectionText,
        },
        cursor: { line: sel.active.line + 1, character: sel.active.character + 1 },
        visibleRange: visible
            ? { startLine: visible.start.line + 1, endLine: visible.end.line + 1 }
            : null,
    };
}

function liveOpenEditorsSnapshot(): TabSnapshot[] {
    const groups = vscode.window.tabGroups.all;
    return groups.flatMap((g) =>
        g.tabs.map((t) => {
            const { file, absolutePath, kind } = describeTab(t.input);
            return {
                group: g.viewColumn,
                label: t.label,
                file: file ? (vscode.workspace.asRelativePath(vscode.Uri.file(absolutePath!))) : null,
                absolutePath,
                kind,
                active: t.isActive,
                dirty: t.isDirty,
                pinned: t.isPinned,
                preview: t.isPreview,
            };
        }),
    );
}

function describeTab(input: unknown): { file: boolean; absolutePath: string | null; kind: TabKind } {
    if (input instanceof vscode.TabInputText) {
        return { file: true, absolutePath: input.uri.fsPath, kind: 'text' };
    }
    if (input instanceof vscode.TabInputTextDiff) {
        return { file: true, absolutePath: input.modified.fsPath, kind: 'text-diff' };
    }
    if (input instanceof vscode.TabInputNotebook) {
        return { file: true, absolutePath: input.uri.fsPath, kind: 'notebook' };
    }
    if (input instanceof vscode.TabInputNotebookDiff) {
        return { file: true, absolutePath: input.modified.fsPath, kind: 'notebook-diff' };
    }
    if (input instanceof vscode.TabInputCustom) {
        return { file: true, absolutePath: input.uri.fsPath, kind: 'custom' };
    }
    if (input instanceof vscode.TabInputWebview) {
        return { file: false, absolutePath: null, kind: 'webview' };
    }
    if (input instanceof vscode.TabInputTerminal) {
        return { file: false, absolutePath: null, kind: 'terminal' };
    }
    return { file: false, absolutePath: null, kind: 'unknown' };
}

// Install live executors on the three imported defs.
(GET_WORKSPACE_INFO_DEF as { execute: (input: GetWorkspaceInfoInput) => Promise<string> }).execute =
    (input) => getWorkspaceInfoImpl({ source: { snapshot: (o) => buildLiveWorkspaceInfoSnapshot(o) } }, input);
(GET_ACTIVE_EDITOR_DEF as { execute: (input: GetActiveEditorInput) => Promise<string> }).execute =
    (input) => getActiveEditorImpl({ source: { snapshot: liveActiveEditorSnapshot } }, input);
(GET_OPEN_EDITORS_DEF as { execute: (input: GetOpenEditorsInput) => Promise<string> }).execute =
    (input) => getOpenEditorsImpl({ source: { snapshot: liveOpenEditorsSnapshot } }, input);
import {
    DIAGNOSTICS_TOOLS,
    GET_ERRORS_TOOL as GET_ERRORS_DEF_INSTALL,
    GET_PROBLEMS_TOOL as GET_PROBLEMS_DEF,
    GetProblemsInput,
    type DiagnosticInfo,
    type DiagnosticsSource,
    type DiagnosticSeverityName,
    getErrorsImpl,
    getProblemsImpl,
} from './diagnostics-tools';

// --- Live DiagnosticsSource bridging vscode.languages.getDiagnostics → DiagnosticInfo[].

function vscodeSeverityToName(s: vscode.DiagnosticSeverity): DiagnosticSeverityName {
    switch (s) {
        case vscode.DiagnosticSeverity.Error: return 'error';
        case vscode.DiagnosticSeverity.Warning: return 'warning';
        case vscode.DiagnosticSeverity.Information: return 'information';
        case vscode.DiagnosticSeverity.Hint: return 'hint';
        default: return 'hint';
    }
}

function diagToInfo(uri: vscode.Uri, d: vscode.Diagnostic): DiagnosticInfo {
    const rel = vscode.workspace.asRelativePath(uri);
    return {
        file: rel,
        absolutePath: uri.fsPath,
        severity: vscodeSeverityToName(d.severity),
        line: d.range.start.line,
        character: d.range.start.character,
        endLine: d.range.end.line,
        endCharacter: d.range.end.character,
        message: d.message,
        source: d.source,
        code: typeof d.code === 'object' && d.code !== null && 'value' in d.code
            ? ((d.code as { value: string | number }).value)
            : (d.code as string | number | undefined),
    };
}

const liveDiagnosticsSource: DiagnosticsSource = {
    getAll(): DiagnosticInfo[] {
        const out: DiagnosticInfo[] = [];
        for (const [uri, diags] of vscode.languages.getDiagnostics()) {
            for (const d of diags) { out.push(diagToInfo(uri, d)); }
        }
        return out;
    },
    getForFile(absPath: string): DiagnosticInfo[] {
        const uri = vscode.Uri.file(absPath);
        return vscode.languages.getDiagnostics(uri).map((d) => diagToInfo(uri, d));
    },
};

(GET_ERRORS_DEF_INSTALL as { execute: (input: import('./diagnostics-tools').GetErrorsInput) => Promise<string> }).execute =
    (input) => getErrorsImpl({ source: liveDiagnosticsSource, wsRoot: getWorkspaceRoot() }, input);
(GET_PROBLEMS_DEF as { execute: (input: GetProblemsInput) => Promise<string> }).execute =
    (input) => getProblemsImpl({ source: liveDiagnosticsSource, wsRoot: getWorkspaceRoot() }, input);
import { LANGUAGE_SERVICE_TOOLS } from './language-service-tools';
import {
    FIND_SYMBOL_TOOL as FIND_SYMBOL_DEF,
    GOTO_DEFINITION_TOOL as GOTO_DEFINITION_DEF,
    FIND_REFERENCES_TOOL as FIND_REFERENCES_DEF,
    FindSymbolInput,
    GotoDefinitionInput,
    FindReferencesInput,
    type LanguageNavigator,
    type LocationInfo,
    type SymbolInfo,
    findReferencesImpl,
    findSymbolImpl,
    gotoDefinitionImpl,
} from './language-navigation';

// --- Live LanguageNavigator bridging vscode.commands.executeXxxProvider →
//     SymbolInfo[] / LocationInfo[]. 0-based throughout (the impl handles
//     the 1-based ↔ 0-based conversion at its own boundary).

function vscodeLocationsToInfo(uri: vscode.Uri, range: vscode.Range): LocationInfo {
    return {
        file: vscode.workspace.asRelativePath(uri),
        absolutePath: uri.fsPath,
        startLine: range.start.line,
        startCharacter: range.start.character,
        endLine: range.end.line,
        endCharacter: range.end.character,
    };
}

const liveLanguageNavigator: LanguageNavigator = {
    resolveFile(filePath: string): string | null {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(getWorkspaceRoot() || process.cwd(), filePath);
        return fs.existsSync(abs) ? abs : null;
    },
    async findSymbol(query: string): Promise<SymbolInfo[]> {
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            query,
        );
        return (symbols ?? []).map((s) => ({
            name: s.name,
            kind: vscode.SymbolKind[s.kind],
            containerName: s.containerName || undefined,
            file: vscode.workspace.asRelativePath(s.location.uri),
            absolutePath: s.location.uri.fsPath,
            line: s.location.range.start.line,
            character: s.location.range.start.character,
        }));
    },
    async gotoDefinition(absPath, line, character): Promise<LocationInfo[]> {
        const uri = vscode.Uri.file(absPath);
        await vscode.workspace.openTextDocument(uri);   // hint the language server
        const pos = new vscode.Position(line, character);
        const locs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
            'vscode.executeDefinitionProvider', uri, pos,
        );
        return (locs ?? []).map((l) => {
            const loc = l as vscode.Location;
            const link = l as vscode.LocationLink;
            const u = loc.uri ?? link.targetUri;
            const range = loc.range ?? link.targetRange;
            return vscodeLocationsToInfo(u, range);
        });
    },
    async findReferences(absPath, line, character): Promise<LocationInfo[]> {
        const uri = vscode.Uri.file(absPath);
        await vscode.workspace.openTextDocument(uri);
        const pos = new vscode.Position(line, character);
        const locs = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider', uri, pos,
        );
        return (locs ?? []).map((l) => vscodeLocationsToInfo(l.uri, l.range));
    },
};

// Install live executors on the three nav defs.
(FIND_SYMBOL_DEF as { execute: (input: FindSymbolInput) => Promise<string> }).execute =
    (input) => findSymbolImpl(liveLanguageNavigator, input);
(GOTO_DEFINITION_DEF as { execute: (input: GotoDefinitionInput) => Promise<string> }).execute =
    (input) => gotoDefinitionImpl(liveLanguageNavigator, input);
(FIND_REFERENCES_DEF as { execute: (input: FindReferencesInput) => Promise<string> }).execute =
    (input) => findReferencesImpl(liveLanguageNavigator, input);
import { GUIDELINE_TOOLS } from './guideline-tools';
import {
    VSCODE_COMMAND_TOOLS,
    RUN_VSCODE_COMMAND_TYPED_TOOL as RUN_VSCODE_COMMAND_TYPED_DEF,
    LIST_COMMANDS_TOOL as LIST_COMMANDS_DEF,
    OPEN_FILE_TOOL as OPEN_FILE_DEF,
    ListCommandsInput,
    OpenFileInput,
    type CommandRunner,
    type FileOpener,
    type OpenFileShowOptions,
    listCommandsImpl,
    openFileImpl,
    runVscodeCommandImpl,
} from './vscode-command-tools';

// --- Live deps bridging vscode.commands / vscode.window to the narrow
//     interfaces in vscode-command-tools.ts (kept vscode-free for tests).

const liveCommandRunner: CommandRunner = {
    async executeCommand(commandId, args) {
        return vscode.commands.executeCommand(commandId, ...args);
    },
    async listCommands(filterInternal) {
        return vscode.commands.getCommands(filterInternal);
    },
};

const liveFileOpener: FileOpener = {
    get wsRoot() { return getWorkspaceRoot(); },
    exists(absPath) {
        try { return fs.existsSync(absPath); } catch { return false; }
    },
    async openInEditor(absPath, opts: OpenFileShowOptions) {
        try {
            const uri = vscode.Uri.file(absPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const showOptions: vscode.TextDocumentShowOptions = {
                preview: opts.preview,
                preserveFocus: opts.preserveFocus,
                viewColumn: opts.viewColumn as vscode.ViewColumn | undefined,
            };
            if (opts.selection) {
                showOptions.selection = new vscode.Range(
                    new vscode.Position(opts.selection.startLine, opts.selection.startCol),
                    new vscode.Position(opts.selection.endLine, opts.selection.endCol),
                );
            }
            await vscode.window.showTextDocument(doc, showOptions);
            return { ok: true as const, languageId: doc.languageId, lineCount: doc.lineCount };
        } catch (err) {
            return { ok: false as const, reason: (err as Error).message };
        }
    },
};

// Install live executors on the imported defs. RUN_VSCODE_COMMAND_DEF
// was re-exported above so this installs for both names that point at it.
(RUN_VSCODE_COMMAND_DEF as { execute: (input: RunVscodeCommandInput) => Promise<string> }).execute =
    (input) => runVscodeCommandImpl(liveCommandRunner, input);
(RUN_VSCODE_COMMAND_TYPED_DEF as { execute: (input: RunVscodeCommandInput) => Promise<string> }).execute =
    (input) => runVscodeCommandImpl(liveCommandRunner, input);
(LIST_COMMANDS_DEF as { execute: (input: ListCommandsInput) => Promise<string> }).execute =
    (input) => listCommandsImpl(liveCommandRunner, input);
(OPEN_FILE_DEF as { execute: (input: OpenFileInput) => Promise<string> }).execute =
    (input) => openFileImpl(liveFileOpener, input);
import { USER_INTERACTION_TOOLS } from './user-interaction-tools';
import { WORKSPACE_EDIT_TOOLS } from './workspace-edit-tools';
import {
    TASK_DEBUG_TOOLS,
    RUN_TASK_TOOL as RUN_TASK_DEF,
    RUN_DEBUG_CONFIG_TOOL as RUN_DEBUG_CONFIG_DEF,
    RunTaskInput,
    RunDebugConfigInput,
    runTaskImpl,
    runDebugConfigImpl,
    TaskRunner,
    DebugRunner,
    TaskInfo,
} from './task-debug-tools';

// --- Live bridges from vscode.tasks / vscode.debug to the narrow dep
//     interfaces in task-debug-tools.ts (kept vscode-free for testability).

const liveTaskRunner: TaskRunner = {
    async listTasks(): Promise<TaskInfo[]> {
        const tasks = await vscode.tasks.fetchTasks();
        return tasks.map(taskToInfo);
    },
    async runTask(info, { waitForExit, timeoutMs }) {
        // Re-fetch and find the matching task by name + scope hint.
        // We can't pass our `TaskInfo` back to vscode.tasks.executeTask;
        // we need the real `vscode.Task`. Re-fetching is cheap and
        // ensures we operate on a fresh definition.
        const tasks = await vscode.tasks.fetchTasks();
        const task = tasks.find((t) => taskToInfo(t).name === info.name && taskToInfo(t).scopeName === info.scopeName)
                  ?? tasks.find((t) => t.name === info.name);
        if (!task) { throw new Error(`Task "${info.name}" disappeared between list and run.`); }
        const execution = await vscode.tasks.executeTask(task);
        if (!waitForExit) { return { started: true as const }; }
        return new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve) => {
            const timer = setTimeout(() => {
                disposable.dispose();
                resolve({ exitCode: null, timedOut: true });
            }, timeoutMs);
            const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
                if (e.execution === execution) {
                    clearTimeout(timer);
                    disposable.dispose();
                    resolve({ exitCode: e.exitCode ?? null, timedOut: false });
                }
            });
        });
    },
};

function taskToInfo(t: vscode.Task): TaskInfo {
    let scopeName: string | undefined;
    if (t.scope && typeof t.scope === 'object' && 'name' in t.scope) {
        scopeName = (t.scope as { name: string }).name;
    } else if (t.scope === vscode.TaskScope.Workspace) {
        scopeName = 'Workspace';
    } else if (t.scope === vscode.TaskScope.Global) {
        scopeName = 'Global';
    }
    return { name: t.name, source: t.source, type: t.definition?.type, scopeName };
}

const liveDebugRunner: DebugRunner = {
    listFolders(): string[] {
        return (vscode.workspace.workspaceFolders ?? []).map((f) => f.name);
    },
    async startDebug(configName, folderName, { waitForExit, timeoutMs }) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const folder = folderName ? folders.find((f) => f.name === folderName) : folders[0];
        let started: boolean;
        try {
            started = await vscode.debug.startDebugging(folder, configName);
        } catch (err) {
            return { started: false as const, reason: (err as Error).message };
        }
        if (!started) {
            return { started: false as const, reason: 'vscode.debug.startDebugging returned false (config not found or validation failed)' };
        }
        if (!waitForExit) { return { started: true as const, sessionName: null, timedOut: false }; }
        return new Promise<{ started: true; sessionName: string | null; timedOut: boolean }>((resolve) => {
            const timer = setTimeout(() => {
                disposable.dispose();
                resolve({ started: true as const, sessionName: null, timedOut: true });
            }, timeoutMs);
            const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
                if (session.configuration.name === configName) {
                    clearTimeout(timer);
                    disposable.dispose();
                    resolve({ started: true as const, sessionName: session.name, timedOut: false });
                }
            });
        });
    },
};

// Install live executors on the imported defs.
(RUN_TASK_DEF as { execute: (input: RunTaskInput) => Promise<string> }).execute =
    (input) => runTaskImpl(liveTaskRunner, input);
(RUN_DEBUG_CONFIG_DEF as { execute: (input: RunDebugConfigInput) => Promise<string> }).execute =
    (input) => runDebugConfigImpl(liveDebugRunner, input);
import {
    PROCESS_TOOLS,
    RUN_COMMAND_STREAM_TOOL as RUN_COMMAND_STREAM_DEF,
    READ_COMMAND_OUTPUT_TOOL as READ_COMMAND_OUTPUT_DEF,
    KILL_COMMAND_TOOL as KILL_COMMAND_DEF,
    RunCommandStreamInput,
    ReadCommandOutputInput,
    KillCommandInput,
    runCommandStreamImpl,
    readCommandOutputImpl,
    killCommandImpl,
} from './process-tools';

// Install the live `execute()` closures on the process-tool defs at
// module load (so the PROCESS_TOOLS spread below picks them up).
// process-tools.ts is vscode-free for testability, so the closures
// that grab `vscode.workspace.workspaceFolders` have to be wired here.
(RUN_COMMAND_STREAM_DEF as { execute: (input: RunCommandStreamInput) => Promise<string> }).execute =
    (input) => runCommandStreamImpl({ wsRoot: getWorkspaceRoot() }, input);
(READ_COMMAND_OUTPUT_DEF as { execute: (input: ReadCommandOutputInput) => Promise<string> }).execute =
    (input) => readCommandOutputImpl({}, input);
(KILL_COMMAND_DEF as { execute: (input: KillCommandInput) => Promise<string> }).execute =
    (input) => killCommandImpl({}, input);
import { GIT_TOOLS } from './git-tools';
import { PLANNING_TOOLS } from './planning-tools';
import { NOTEBOOK_TOOLS } from './notebook-tools';
import { PATTERN_PROMPTS_TOOLS } from './pattern-prompts-tools';
import { ISSUE_TOOLS } from './issue-tools';
import { TEST_TOOLS } from './test-tools';
import { CONVERSATION_RESULT_TOOLS } from './conversation-result-tools';
import { PAST_TOOL_ACCESS_TOOLS } from './past-tool-access-tools';
import { PROMPT_HISTORY_TOOLS } from './prompt-history-tools';

// Re-export initializeToolDescriptions so existing consumers continue to work
// without needing to update their import paths.
export { initializeToolDescriptions } from './guideline-tools';

/**
 * All shared tool definitions grouped by functional family. Each group is
 * self-contained in its own file under `src/tools/`. Add a new family by
 * creating a new file, exporting `export const {FAMILY}_TOOLS`, and adding it
 * to the spread below.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_SHARED_TOOLS: SharedToolDefinition<any>[] = [
    // --- Families defined in tool-executors.ts itself ---
    // Files (read + write primitives)
    READ_FILE_TOOL,
    LIST_DIRECTORY_TOOL,
    FIND_FILES_TOOL,
    FIND_TEXT_IN_FILES_TOOL,
    CREATE_FILE_TOOL,
    EDIT_FILE_TOOL,
    MULTI_EDIT_FILE_TOOL,
    DELETE_FILE_TOOL,
    MOVE_FILE_TOOL,
    // Shell (one-shot). `RUN_VSCODE_COMMAND_TOOL` is no longer listed
    // here — it's part of VSCODE_COMMAND_TOOLS below since the entry #6
    // refactor consolidated the four vscode-command tools into one file.
    RUN_COMMAND_TOOL,
    // Web
    FETCH_WEBPAGE_TOOL,
    WEB_SEARCH_TOOL,
    // Diagnostics tools (getErrors + getProblems) live in DIAGNOSTICS_TOOLS
    // below — relocated from this file by the entry #8 refactor.
    // Ask-AI delegation bridges
    ASK_BIG_BROTHER_TOOL,
    ASK_COPILOT_TOOL,
    // Chat todo (in-session)
    MANAGE_TODO_TOOL,
    // Chat variables
    CHATVAR_READ_TOOL,
    CHATVAR_WRITE_TOOL,
    // Memory
    MEMORY_SAVE_TOOL,
    MEMORY_UPDATE_TOOL,
    MEMORY_FORGET_TOOL,
    MEMORY_READ_TOOL,
    MEMORY_LIST_TOOL,

    // --- Families defined in dedicated files ---
    ...CHAT_ENHANCEMENT_TOOLS,  // quest/session todos, notify, queue, timed, templates, reminders
    ...EDITOR_CONTEXT_TOOLS,    // getWorkspaceInfoFull, getActiveEditor, getOpenEditors
    ...DIAGNOSTICS_TOOLS,       // getProblems, getOutputChannel, getTerminalOutput
    ...LANGUAGE_SERVICE_TOOLS,  // findSymbol, gotoDefinition, findReferences, getCodeActions(+Cached), applyCodeAction, rename
    ...GUIDELINE_TOOLS,         // readGuideline, readLocalGuideline, listGuidelines, searchGuidelines
    ...VSCODE_COMMAND_TOOLS,    // openFile, listCommands, vscode (meta)
    ...USER_INTERACTION_TOOLS,  // askUser, askUserPicker
    ...WORKSPACE_EDIT_TOOLS,    // applyEdit (transactional)
    ...TASK_DEBUG_TOOLS,        // runTask, runDebugConfig
    ...PROCESS_TOOLS,           // runCommandStream, readCommandOutput, killCommand
    ...GIT_TOOLS,               // git, gitShow, gitExec
    ...PLANNING_TOOLS,          // enterPlanMode, exitPlanMode, spawnSubagent
    ...NOTEBOOK_TOOLS,          // notebookEdit, notebookRun
    ...PATTERN_PROMPTS_TOOLS,   // listPatternPrompts, readPatternPrompt
    ...ISSUE_TOOLS,             // Issues subpanel: list/get/createIssue, addComment, setStatus, toggleLabel
    ...TEST_TOOLS,              // Tests subpanel (testkit): parallel to ISSUE_TOOLS against testkit repos
    ...CONVERSATION_RESULT_TOOLS, // AI Conversation outcome document — read/write result file
    ...PAST_TOOL_ACCESS_TOOLS,    // listPastToolCalls, searchPastToolResults, readPastToolResult
    ...PROMPT_HISTORY_TOOLS,      // listPromptPairs, getPromptPair — read past prompt+answer pairs from summary trail
];

/**
 * Read-only tools suitable for Ollama (local LLM).
 * Excludes tomAi_readGuideline (for VS Code LM only) — Ollama uses tomAi_readLocalGuideline instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const READ_ONLY_TOOLS: SharedToolDefinition<any>[] = ALL_SHARED_TOOLS.filter(
    t => t.readOnly && t.name !== 'tomAi_readGuideline',
);
