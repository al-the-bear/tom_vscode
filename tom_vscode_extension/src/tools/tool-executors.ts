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

// manageTodo bridged to cross-cutting-todo-tools.ts (the legacy chat-session
// todo manager — kept for back-compat with prompts that depend on it).

import {
    MANAGE_TODO_TOOL as MANAGE_TODO_DEF,
    ManageTodoInput,
    type ChatTodoSession,
    type ChatTodoSessionResolver,
    type LegacyChatTodoItem,
    type LegacyTodoResult,
    manageTodoImpl,
} from './cross-cutting-todo-tools';

export type { ManageTodoInput };

const liveChatTodoSessionResolver: ChatTodoSessionResolver = {
    current(): ChatTodoSession | null {
        if (!activeTodoManager) { return null; }
        const mgr = activeTodoManager;
        return {
            async list(filter): Promise<LegacyTodoResult> {
                const r = await mgr.list(filter);
                return { message: r.message, todos: r.todos as LegacyChatTodoItem[] | undefined };
            },
            async add(title, description): Promise<LegacyTodoResult> {
                const r = await mgr.add(title, description);
                return { message: r.message, todos: r.todos as LegacyChatTodoItem[] | undefined };
            },
            async update(id, updates): Promise<LegacyTodoResult> {
                const r = await mgr.update(id, updates);
                return { message: r.message, todos: r.todos as LegacyChatTodoItem[] | undefined };
            },
            async remove(id): Promise<LegacyTodoResult> {
                const r = await mgr.remove(id);
                return { message: r.message, todos: r.todos as LegacyChatTodoItem[] | undefined };
            },
            async clear(): Promise<LegacyTodoResult> {
                const r = await mgr.clear();
                return { message: r.message, todos: r.todos as LegacyChatTodoItem[] | undefined };
            },
        };
    },
};

export const MANAGE_TODO_TOOL: SharedToolDefinition<ManageTodoInput> = {
    ...MANAGE_TODO_DEF,
    execute: (input) => manageTodoImpl(liveChatTodoSessionResolver, input),
};

// ============================================================================
// Ask Big Brother — relocated to `ask-big-brother-tool.ts` (vscode-free
// impl + narrow LanguageModelBridge dep) by the entry #25 coverage refactor.
// The live bridge below wires vscode.lm.* + the local-llm-tools-config into
// the interface; the orchestration (model selection chain, tool loop bounds,
// timeout unwinding, summarisation gating) lives in the impl file.
// ============================================================================

import {
    ASK_BIG_BROTHER_TOOL as ASK_BIG_BROTHER_DEF,
    AskBigBrotherInput as BBInput,
    type LanguageModelBridge as BBBridge,
    type BigBrotherModel as BBModel,
    type BigBrotherToolDef as BBToolDef,
    type BigBrotherConfig as BBConfig,
    type ChatTurn as BBChatTurn,
    type ResponsePart as BBResponsePart,
    type CancelSignal as BBSignal,
    askBigBrotherImpl,
} from './ask-big-brother-tool';

export type AskBigBrotherInput = BBInput;

// Live LanguageModelBridge — wraps vscode.lm.* + local-llm-tools-config.
// Heavy: each `query` operation spends a long-lived timeout window
// streaming text + tool-call parts from a real model. The impl in
// `ask-big-brother-tool.ts` orchestrates the loop; this bridge is just
// the wire-up.

function toolResultToTextBigBrother(result: vscode.LanguageModelToolResult): string {
    const config = loadLocalLlmToolsConfig();
    const maxChars = config.askBigBrother.maxToolResultChars;
    const parts: string[] = [];
    for (const part of result.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            parts.push(part.value);
        } else if (typeof part === 'object' && part !== null) {
            if ('value' in part) {
                parts.push(String((part as { value: unknown }).value));
            } else {
                parts.push(JSON.stringify(part));
            }
        }
    }
    const text = parts.join('\n');
    if (text.length > maxChars) { return text.substring(0, maxChars) + '\n... [truncated]'; }
    return text;
}

function toBBModel(m: vscode.LanguageModelChat): BBModel {
    return { id: m.id, name: m.name, family: m.family, vendor: m.vendor, maxInputTokens: m.maxInputTokens };
}

async function bbSummarise(text: string): Promise<string> {
    const config = loadLocalLlmToolsConfig();
    const summaryConfig = config.askBigBrother;
    let models = await vscode.lm.selectChatModels({ family: summaryConfig.summarizationModel });
    if (models.length === 0) { models = await vscode.lm.selectChatModels({ id: summaryConfig.summarizationModel }); }
    if (models.length === 0) { return text; }
    const prompt = summaryConfig.summarizationPromptTemplate.replace('${response}', text);
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const tokenSource = new vscode.CancellationTokenSource();
    const timeoutId = setTimeout(() => tokenSource.cancel(), 30000);
    try {
        const result = await models[0].sendRequest(messages, {}, tokenSource.token);
        let summary = '';
        for await (const chunk of result.text) { summary += chunk; }
        return `[Summarized from ${text.length} chars]\n\n${summary.trim()}`;
    } finally {
        clearTimeout(timeoutId);
    }
}

const liveBigBrotherBridge: BBBridge = {
    async listAllModels(): Promise<BBModel[]> {
        const all = await vscode.lm.selectChatModels();
        return all.map(toBBModel);
    },
    async selectModels(filter): Promise<BBModel[]> {
        const all = await vscode.lm.selectChatModels(filter);
        return all.map(toBBModel);
    },
    listAvailableTools(): BBToolDef[] {
        return Array.from(vscode.lm.tools).map((t) => ({
            name: t.name,
            description: t.description,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            inputSchema: (t as any).inputSchema,
        }));
    },
    async sendRequest(modelId, messages, tools, signal): Promise<BBResponsePart[]> {
        const models = await vscode.lm.selectChatModels({ id: modelId });
        if (models.length === 0) { throw new Error(`Model ${modelId} disappeared between selection and send.`); }
        const model = models[0];
        const lmMessages: vscode.LanguageModelChatMessage[] = messages.map((m): vscode.LanguageModelChatMessage => {
            if (m.role === 'user') { return vscode.LanguageModelChatMessage.User(m.content); }
            if (m.role === 'assistant') {
                const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
                for (const p of m.parts) {
                    if (p.kind === 'text') { parts.push(new vscode.LanguageModelTextPart(p.text)); }
                    else { parts.push(new vscode.LanguageModelToolCallPart(p.callId, p.name, p.input)); }
                }
                return vscode.LanguageModelChatMessage.Assistant(parts);
            }
            // tool_result
            const resultParts = m.results.map((r) =>
                new vscode.LanguageModelToolResultPart(r.callId, [new vscode.LanguageModelTextPart(r.text)]),
            );
            return vscode.LanguageModelChatMessage.User(resultParts);
        });
        const requestOptions = tools.length > 0
            ? { tools: tools as unknown as vscode.LanguageModelChatTool[] }
            : {};
        const tokenSource = new vscode.CancellationTokenSource();
        const pollId = setInterval(() => { if (signal.cancelled) { tokenSource.cancel(); } }, 100);
        try {
            const response = await model.sendRequest(lmMessages, requestOptions, tokenSource.token);
            const out: BBResponsePart[] = [];
            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    out.push({ kind: 'text', text: part.value });
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    out.push({ kind: 'tool_call', callId: part.callId, name: part.name, input: part.input as object });
                }
            }
            return out;
        } finally {
            clearInterval(pollId);
        }
    },
    async invokeTool(name, input): Promise<string> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolInvocationOptions: any = { input: input as object, toolInvocationToken: undefined };
        const toolResult = await vscode.lm.invokeTool(name, toolInvocationOptions);
        return toolResultToTextBigBrother(toolResult);
    },
    summarise: bbSummarise,
    getConfig(): BBConfig {
        const c = loadLocalLlmToolsConfig().askBigBrother;
        return {
            enabled: c.enabled,
            defaultModel: c.defaultModel,
            enableToolsByDefault: c.enableToolsByDefault,
            maxIterations: c.maxIterations,
            responseTimeoutMs: c.responseTimeout,
            summarisation: {
                enabled: c.summarizationEnabled,
                thresholdChars: c.maxResponseChars,
            },
            modelRecommendations: c.modelRecommendations,
        };
    },
};

async function executeAskBigBrother(input: AskBigBrotherInput): Promise<string> {
    await ensureLocalLlmBridgeToolsInitialized();
    const questId = WsPaths.getWorkspaceQuestId();
    if (input.operation === 'query' && input.prompt) {
        logPrompt('tomai', input.modelId || 'default', input.prompt, undefined, {
            questId,
            source: 'localLlmTool',
            tool: 'tomAi_askBigBrother',
            enableTools: input.enableTools,
        });
    }
    const config = loadLocalLlmToolsConfig();
    const signal: BBSignal = { cancelled: false };
    const timer = setTimeout(() => { signal.cancelled = true; }, config.askBigBrother.responseTimeout);
    try {
        const raw = await askBigBrotherImpl(liveBigBrotherBridge, input, signal);
        if (input.operation === 'query') {
            try {
                const parsed = JSON.parse(raw) as { response?: string; model?: { id?: string } };
                if (parsed.response) {
                    logResponse('tomai', parsed.model?.id || 'default', parsed.response, true, {
                        questId,
                        source: 'localLlmTool',
                        tool: 'tomAi_askBigBrother',
                        enableTools: input.enableTools,
                    });
                }
            } catch { /* ignore log-only parse failure */ }
        }
        return raw;
    } finally {
        clearTimeout(timer);
    }
}

export const ASK_BIG_BROTHER_TOOL: SharedToolDefinition<AskBigBrotherInput> = {
    ...ASK_BIG_BROTHER_DEF,
    execute: executeAskBigBrother,
};


// ============================================================================
// Ask Copilot — relocated to `ask-copilot-tool.ts` (vscode-free impl +
// narrow CopilotChatOpener / AnswerFileSink / TemplateExpander deps) by
// the entry #25 coverage refactor.  The live bridge below wires
// vscode.commands.executeCommand, fs, and the template expander.
// ============================================================================

import {
    ASK_COPILOT_TOOL as ASK_COPILOT_DEF,
    AskCopilotInput,
    type CopilotConfigSnapshot,
    type CopilotChatOpener,
    type AnswerFileSink,
    type TemplateExpander,
    type AskCopilotDeps,
    askCopilotImpl,
} from './ask-copilot-tool';

export type { AskCopilotInput };

function liveCopilotConfig(): CopilotConfigSnapshot {
    const config = loadLocalLlmToolsConfig();
    const sendToChatConfig = loadSendToChatConfig();
    const copilotTemplates = sendToChatConfig?.copilot?.templates;
    const answerFileTpl = copilotTemplates?.['__answer_file__'];
    const selectedId = config.askCopilot.promptTemplate;
    const selectedBody = selectedId && selectedId !== '__none__' && selectedId !== '__answer_file__'
        ? copilotTemplates?.[selectedId]?.template
        : undefined;
    return {
        enabled: config.askCopilot.enabled,
        answerFileTimeoutMs: config.askCopilot.answerFileTimeout,
        pollIntervalMs: config.askCopilot.pollInterval,
        answerFolder: config.askCopilot.answerFolder,
        answerFilename: `${vscode.env.sessionId}_${vscode.env.machineId}_answer.json`,
        selectedTemplateId: selectedId || '__none__',
        selectedTemplateBody: selectedBody,
        answerFileTemplate: answerFileTpl?.template || DEFAULT_ANSWER_FILE_TEMPLATE,
    };
}

function answerFilePath(config: CopilotConfigSnapshot): string {
    const wsRoot = getWorkspaceRoot();
    return path.join(wsRoot, config.answerFolder, config.answerFilename);
}

const liveCopilotChatOpener: CopilotChatOpener = {
    async open(query) {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query });
    },
};

function buildLiveAnswerFileSink(config: CopilotConfigSnapshot): AnswerFileSink {
    const absPath = answerFilePath(config);
    const folder = path.dirname(absPath);
    return {
        absolutePath() { return absPath; },
        clear() {
            if (!fs.existsSync(folder)) { fs.mkdirSync(folder, { recursive: true }); }
            if (fs.existsSync(absPath)) { fs.unlinkSync(absPath); }
        },
        read() {
            if (!fs.existsSync(absPath)) { return null; }
            const content = fs.readFileSync(absPath, 'utf-8').trim();
            return content ? content : null;
        },
    };
}

const liveTemplateExpander: TemplateExpander = {
    expand(template, values) {
        return expandTemplate(template, { values });
    },
};

async function executeAskCopilot(input: AskCopilotInput): Promise<string> {
    const config = liveCopilotConfig();
    if (!getWorkspaceRoot()) {
        return JSON.stringify({ ok: false, error: 'No workspace folder open.' });
    }
    const questId = WsPaths.getWorkspaceQuestId();
    logPrompt('copilot', 'github_copilot', input.prompt, undefined, {
        questId,
        source: 'localLlmTool',
        tool: 'tomAi_askCopilot',
    });
    const deps: AskCopilotDeps = {
        config: () => config,
        opener: liveCopilotChatOpener,
        sink: buildLiveAnswerFileSink(config),
        expander: liveTemplateExpander,
        onResponseValues(values) { updateChatResponseValues(values); },
    };
    const raw = await askCopilotImpl(deps, input);
    try {
        const parsed = JSON.parse(raw) as { response?: string; requestId?: string };
        if (parsed.response) {
            logResponse('copilot', 'github_copilot', parsed.response, true, {
                questId,
                source: 'localLlmTool',
                tool: 'tomAi_askCopilot',
                requestId: parsed.requestId,
            });
        }
    } catch { /* ignore log-only parse failure */ }
    return raw;
}

export const ASK_COPILOT_TOOL: SharedToolDefinition<AskCopilotInput> = {
    ...ASK_COPILOT_DEF,
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
// Chat variable tools (spec §8.5) — relocated to `chatvar-tools.ts` by the
// entry #14 coverage refactor.
// ============================================================================

import {
    READ_CHATVAR_TOOL as READ_CHATVAR_DEF,
    WRITE_CHATVAR_TOOL as WRITE_CHATVAR_DEF,
    BUILT_IN_CHATVAR_KEYS,
    ChatvarReadInput,
    ChatvarWriteInput,
    type ChatVariablesAccess,
    type ChatVariablesPublicSnapshot,
    readChatVariableImpl,
    writeChatVariableImpl,
} from './chatvar-tools';

export type { ChatvarReadInput, ChatvarWriteInput };

// Live access bridge — wraps the singleton store, resolves the tool
// context (source + requestId) just before the `setCustomBulk` call
// per spec §8.5 so the change log records which handler triggered
// each write.
const liveChatvarAccess: ChatVariablesAccess = {
    getRaw(key) { return ChatVariablesStore.instance.getRaw(key); },
    has(key): boolean {
        if (BUILT_IN_CHATVAR_KEYS.has(key)) { return true; }
        const custom = ChatVariablesStore.instance.snapshot().custom;
        return Object.prototype.hasOwnProperty.call(custom, key);
    },
    snapshot(): ChatVariablesPublicSnapshot {
        const s = ChatVariablesStore.instance.snapshot();
        return {
            quest: s.quest,
            role: s.role,
            activeProjects: s.activeProjects,
            todo: s.todo,
            todoFile: s.todoFile,
            custom: s.custom,
        };
    },
    setCustomBulk(values) {
        const ctx = getCurrentToolContext();
        const source = ctx?.source ?? 'anthropic';
        ChatVariablesStore.instance.setCustomBulk(values, source, ctx?.requestId);
    },
};

export const CHATVAR_READ_TOOL: SharedToolDefinition<ChatvarReadInput> = {
    ...READ_CHATVAR_DEF,
    execute: (input) => readChatVariableImpl(liveChatvarAccess, input),
};

export const CHATVAR_WRITE_TOOL: SharedToolDefinition<ChatvarWriteInput> = {
    ...WRITE_CHATVAR_DEF,
    execute: (input) => writeChatVariableImpl(liveChatvarAccess, input),
};

// ============================================================================
// Memory tools (spec §8.2) — relocated to `memory-tools.ts` by the entry #12
// coverage refactor. The `parseWriteScope` / `parseReadScope` helpers moved
// there too (the originals here are dropped).
// ============================================================================

// --- Memory tools (5) -------------------------------------------------------
//
// Defs + impls live in `memory-tools.ts` (vscode-free, narrow `MemoryStore`
// dep). The bridge below wires the production `TwoTierMemoryService.instance`
// to that interface so the impls work against the real fs-backed store.

import {
    SAVE_MEMORY_TOOL as SAVE_MEMORY_DEF,
    UPDATE_MEMORY_TOOL as UPDATE_MEMORY_DEF,
    FORGET_MEMORY_TOOL as FORGET_MEMORY_DEF,
    READ_MEMORY_TOOL as READ_MEMORY_DEF,
    LIST_MEMORY_TOOL as LIST_MEMORY_DEF,
    MemorySaveInput,
    MemoryUpdateInput,
    MemoryForgetInput,
    MemoryReadInput,
    MemoryListInput,
    type MemoryScope as ToolMemoryScope,
    type MemoryStore,
    saveMemoryImpl,
    updateMemoryImpl,
    forgetMemoryImpl,
    readMemoryImpl,
    listMemoryImpl,
} from './memory-tools';

export type { MemorySaveInput, MemoryUpdateInput, MemoryForgetInput, MemoryReadInput, MemoryListInput };

const liveMemoryStore: MemoryStore = {
    list(scope: ToolMemoryScope): string[] { return TwoTierMemoryService.instance.list(scope); },
    read(scope: ToolMemoryScope, file: string): string { return TwoTierMemoryService.instance.read(scope, file); },
    append(scope: ToolMemoryScope, file: string, content: string): void {
        TwoTierMemoryService.instance.append(scope, file, content);
    },
    replaceSection(scope: ToolMemoryScope, file: string, heading: string, content: string): void {
        TwoTierMemoryService.instance.replaceSection(scope, file, heading, content);
    },
    delete(scope: ToolMemoryScope, file: string): void { TwoTierMemoryService.instance.delete(scope, file); },
};

export const MEMORY_SAVE_TOOL: SharedToolDefinition<MemorySaveInput> = {
    ...SAVE_MEMORY_DEF,
    execute: (input) => saveMemoryImpl(liveMemoryStore, input),
};
export const MEMORY_UPDATE_TOOL: SharedToolDefinition<MemoryUpdateInput> = {
    ...UPDATE_MEMORY_DEF,
    execute: (input) => updateMemoryImpl(liveMemoryStore, input),
};
export const MEMORY_FORGET_TOOL: SharedToolDefinition<MemoryForgetInput> = {
    ...FORGET_MEMORY_DEF,
    execute: (input) => forgetMemoryImpl(liveMemoryStore, input),
};
export const MEMORY_READ_TOOL: SharedToolDefinition<MemoryReadInput> = {
    ...READ_MEMORY_DEF,
    execute: (input) => readMemoryImpl(liveMemoryStore, input),
};
export const MEMORY_LIST_TOOL: SharedToolDefinition<MemoryListInput> = {
    ...LIST_MEMORY_DEF,
    execute: (input) => listMemoryImpl(liveMemoryStore, input),
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
import { ASK_USER_LIVE_TOOL } from '../handlers/askUser-handler';
import {
    WORKSPACE_EDIT_TOOLS,
    APPLY_EDIT_TOOL as APPLY_EDIT_DEF,
    ApplyEditInput,
    type WorkspaceEditService,
    type ResolvedApplyEditOp,
    applyEditImpl,
    relativeIfInWs,
} from './workspace-edit-tools';
import {
    GET_CODE_ACTIONS_TOOL as GET_CODE_ACTIONS_DEF,
    GET_CODE_ACTIONS_CACHED_TOOL as GET_CODE_ACTIONS_CACHED_DEF,
    APPLY_CODE_ACTION_TOOL as APPLY_CODE_ACTION_DEF,
    GetCodeActionsInput,
    GetCodeActionsCachedInput,
    ApplyCodeActionInput,
    type CodeActionService,
    type CodeActionRange0Based,
    type ListedCodeAction,
    type ApplyActionResult,
    getCodeActionsImpl,
    getCodeActionsCachedImpl,
    applyCodeActionImpl,
} from './code-action-tools';
import {
    RENAME_TOOL as RENAME_DEF,
    RenameInput,
    type RenameService,
    type RenameProviderResult,
    renameImpl,
} from './rename-tool';

// --- Live CodeActionService bridging vscode.commands.executeCodeActionProvider
//     + vscode.workspace.applyEdit / executeCommand for action.command.

const liveCodeActionService: CodeActionService = {
    resolveFile(filePath: string): string | null {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(getWorkspaceRoot() || process.cwd(), filePath);
        return fs.existsSync(abs) ? abs : null;
    },
    async list(absPath: string, range: CodeActionRange0Based, only?: string): Promise<ListedCodeAction[]> {
        const uri = vscode.Uri.file(absPath);
        await vscode.workspace.openTextDocument(uri);
        const vsRange = new vscode.Range(
            new vscode.Position(range.startLine, range.startCharacter),
            new vscode.Position(range.endLine, range.endCharacter),
        );
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider', uri, vsRange, only,
        );
        return (actions ?? []).map((a) => ({
            snapshot: {
                title: a.title,
                kind: a.kind?.value,
                isPreferred: a.isPreferred,
                hasEdit: !!a.edit,
                hasCommand: !!a.command,
                commandId: a.command?.command,
                diagnosticsCount: a.diagnostics?.length ?? 0,
            },
            token: a,    // The opaque token IS the CodeAction itself.
        }));
    },
    async apply(token: unknown): Promise<ApplyActionResult> {
        const action = token as vscode.CodeAction;
        let editApplied: boolean | null = null;
        if (action.edit) {
            editApplied = await vscode.workspace.applyEdit(action.edit);
        }
        let commandResult: unknown = null;
        if (action.command) {
            commandResult = await vscode.commands.executeCommand(
                action.command.command, ...(action.command.arguments ?? []),
            ) ?? null;
        }
        return { editApplied, commandResult };
    },
};

// --- Live RenameService bridging executeDocumentRenameProvider + applyEdit.

const liveRenameService: RenameService = {
    resolveFile(filePath: string): string | null {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(getWorkspaceRoot() || process.cwd(), filePath);
        return fs.existsSync(abs) ? abs : null;
    },
    async rename(absPath: string, line: number, character: number, newName: string): Promise<RenameProviderResult> {
        const uri = vscode.Uri.file(absPath);
        await vscode.workspace.openTextDocument(uri);
        const pos = new vscode.Position(line, character);
        let edit: vscode.WorkspaceEdit | undefined;
        try {
            edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
                'vscode.executeDocumentRenameProvider', uri, pos, newName,
            );
        } catch (err) {
            // Some language servers throw on "no rename provider here";
            // treat that case as no-provider rather than propagating.
            const msg = (err as Error).message;
            if (/no rename provider|cannot rename/i.test(msg)) {
                return { kind: 'no-provider' as const };
            }
            throw err;
        }
        if (!edit) { return { kind: 'no-provider' as const }; }
        const size = (edit as unknown as { size: number }).size;
        if (typeof size !== 'number' || size === 0) { return { kind: 'no-edits' as const }; }
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) { return { kind: 'no-edits' as const }; }
        const affected: string[] = [];
        const root = getWorkspaceRoot();
        for (const [u] of (edit as unknown as { entries(): Iterable<[vscode.Uri, unknown]> }).entries()) {
            const rel = root ? path.relative(root, u.fsPath) : u.fsPath;
            affected.push(rel.startsWith('..') ? u.fsPath : rel);
        }
        return { kind: 'ok' as const, affectedFiles: affected };
    },
};

// --- Live WorkspaceEditService bridging vscode.WorkspaceEdit + applyEdit.

const liveWorkspaceEditService: WorkspaceEditService = {
    get wsRoot() { return getWorkspaceRoot(); },
    async applyOps(ops: ResolvedApplyEditOp[]): Promise<{ applied: boolean; affectedFiles: string[] }> {
        const edit = new vscode.WorkspaceEdit();
        const affected = new Set<string>();
        const rootForRel = getWorkspaceRoot();
        for (const op of ops) {
            switch (op.op) {
                case 'createFile':
                    edit.createFile(vscode.Uri.file(op.absPath!), {
                        overwrite: op.overwrite,
                        ignoreIfExists: op.ignoreIfExists,
                    });
                    affected.add(relativeIfInWs(op.absPath!, rootForRel));
                    break;
                case 'deleteFile':
                    edit.deleteFile(vscode.Uri.file(op.absPath!), {
                        ignoreIfNotExists: op.ignoreIfNotExists,
                    });
                    affected.add(relativeIfInWs(op.absPath!, rootForRel));
                    break;
                case 'renameFile':
                    edit.renameFile(
                        vscode.Uri.file(op.fromAbs!),
                        vscode.Uri.file(op.toAbs!),
                        { overwrite: op.overwrite, ignoreIfExists: op.ignoreIfExists },
                    );
                    affected.add(relativeIfInWs(op.fromAbs!, rootForRel));
                    affected.add(relativeIfInWs(op.toAbs!, rootForRel));
                    break;
                case 'insert':
                    edit.insert(
                        vscode.Uri.file(op.absPath!),
                        new vscode.Position(op.position!.line, op.position!.character),
                        op.text!,
                    );
                    affected.add(relativeIfInWs(op.absPath!, rootForRel));
                    break;
                case 'delete':
                    edit.delete(vscode.Uri.file(op.absPath!), new vscode.Range(
                        new vscode.Position(op.range!.startLine, op.range!.startCharacter),
                        new vscode.Position(op.range!.endLine, op.range!.endCharacter),
                    ));
                    affected.add(relativeIfInWs(op.absPath!, rootForRel));
                    break;
                case 'replace':
                    edit.replace(vscode.Uri.file(op.absPath!), new vscode.Range(
                        new vscode.Position(op.range!.startLine, op.range!.startCharacter),
                        new vscode.Position(op.range!.endLine, op.range!.endCharacter),
                    ), op.text!);
                    affected.add(relativeIfInWs(op.absPath!, rootForRel));
                    break;
            }
        }
        const applied = await vscode.workspace.applyEdit(edit);
        return { applied, affectedFiles: Array.from(affected) };
    },
};

// Install live executors on the imported defs.
(GET_CODE_ACTIONS_DEF as { execute: (input: GetCodeActionsInput) => Promise<string> }).execute =
    (input) => getCodeActionsImpl(liveCodeActionService, input);
(GET_CODE_ACTIONS_CACHED_DEF as { execute: (input: GetCodeActionsCachedInput) => Promise<string> }).execute =
    (input) => getCodeActionsCachedImpl(liveCodeActionService, input);
(APPLY_CODE_ACTION_DEF as { execute: (input: ApplyCodeActionInput) => Promise<string> }).execute =
    (input) => applyCodeActionImpl(liveCodeActionService, input);
(RENAME_DEF as { execute: (input: RenameInput) => Promise<string> }).execute =
    (input) => renameImpl(liveRenameService, input);
(APPLY_EDIT_DEF as { execute: (input: ApplyEditInput) => Promise<string> }).execute =
    (input) => applyEditImpl(liveWorkspaceEditService, input);
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
    ...USER_INTERACTION_TOOLS,  // askUserPicker
    ASK_USER_LIVE_TOOL,         // askUser — blocking multi-question ask (webview + Telegram)
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

/**
 * Resolve the tool set enabled for an Anthropic profile.
 *
 * The profile is the single source of truth (matching `_handleSendAnthropic`
 * in chatPanel-handler.ts and the `anthropicProfiles` case in
 * globalTemplateEditor-handler.ts):
 *
 *  1. `toolsEnabled !== false`  → ALL tools (`ALL_SHARED_TOOLS`)
 *  2. `toolsEnabled === false`  → the `enabledTools` allow-list subset
 *     (an empty/missing list → no tools)
 *
 * Extracted here so both the chat panel and the scripting-API bridge apply
 * identical filtering.
 */
export function resolveProfileTools(
    profile: { toolsEnabled?: boolean; enabledTools?: string[] } | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): SharedToolDefinition<any>[] {
    const allToolsEnabled = profile?.toolsEnabled !== false;
    if (allToolsEnabled) {
        return [...ALL_SHARED_TOOLS];
    }
    const enabledIds = Array.isArray(profile?.enabledTools) ? profile!.enabledTools! : [];
    return enabledIds.length > 0
        ? ALL_SHARED_TOOLS.filter((t) => enabledIds.includes(t.name))
        : [];
}
