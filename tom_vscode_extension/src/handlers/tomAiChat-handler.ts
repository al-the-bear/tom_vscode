import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    TOOL_SEPARATOR,
    CHAT_HEADER_REGEX,
    buildMetadataBlock,
    buildPromptTemplate,
    buildSystemPrompt,
    buildSummaryPrompt,
    parseChatText,
    formatLogTimestamp
} from './tomAiChat-utils';
import { TodoManager, TodoOperationResult } from '../managers/todoManager';
import { setActiveTodoManager } from '../tools/tomAiChat-tools';
import { WsPaths } from '../utils/workspacePaths';
import {
    clearTrail, logPrompt, logResponse, logToolRequest, logToolResult,
    isTrailEnabled, loadTrailConfig, writeTrailFile,
} from './trailLogger-handler';

const logChannel = vscode.window.createOutputChannel('Tom AI Chat Log');
const toolLogChannel = vscode.window.createOutputChannel('Tom Tool Log');
const responseChannel = vscode.window.createOutputChannel('Tom AI Chat Responses');
const EXTENSION_MESSAGE_PREFIX = '[Tom AI] ';

// Cancellation support
let activeCancellationTokenSource: vscode.CancellationTokenSource | null = null;

/**
 * Interrupt the currently running Tom AI Chat request
 */
export function interruptTomAiChatHandler(): void {
    logChannel.appendLine('[Tom AI] interruptTomAIChat command invoked');
    try {
        if (activeCancellationTokenSource) {
            activeCancellationTokenSource.cancel();
            logChannel.appendLine('[Tom AI] ⚠️ Chat interrupted by user');
            vscode.window.showWarningMessage('Tom AI Chat interrupted');
        } else {
            logChannel.appendLine('[Tom AI] No active request to interrupt');
            vscode.window.showInformationMessage('No Tom AI Chat request is currently running');
        }
    } catch (error) {
        logChannel.appendLine(`[Tom AI] interruptTomAIChat FAILED: ${error}`);
        vscode.window.showErrorMessage(`Interrupt Tom AI Chat failed: ${error}`);
    }
}

// Pre-processing tools: limited set for cheap model to gather context
const PRE_PROCESSING_ALLOWED_TOOLS = new Set<string>([
    'tom_readFile',
    'tom_listDirectory',
    'tom_findFiles',
    'tom_findTextInFiles',
    'tom_readGuideline',
    'copilot_readFile',
    'copilot_listDirectory',
    'copilot_findFiles',
    'copilot_findTextInFiles',
    'copilot_searchCodebase',
    'copilot_searchWorkspaceSymbols',
    'copilot_getDocInfo',
]);

const TOM_AI_CHAT_ALLOWED_TOOLS = new Set<string>([
    // Tom AI Chat custom tools (work without chat participant token)
    'tom_createFile',
    'tom_readFile',
    'tom_editFile',
    'tom_multiEditFile',
    'tom_listDirectory',
    'tom_findFiles',
    'tom_findTextInFiles',
    'tom_runCommand',
    'tom_runVscodeCommand',
    'tom_getErrors',
    'tom_fetchWebpage',
    'tom_readGuideline',
    'addToPromptQueue',
    'addFollowUpPrompt',
    'sendQueuedPrompt',
    'addTimedRequest',
    'tom_queue_list',
    'tom_queue_update_item',
    'tom_queue_set_status',
    'tom_queue_send_now',
    'tom_queue_remove_item',
    'tom_queue_update_followup',
    'tom_queue_remove_followup',
    'tom_timed_list',
    'tom_timed_update_entry',
    'tom_timed_remove_entry',
    'tom_timed_set_engine_state',
    'tom_prompt_template_manage',
    'tom_reminder_template_manage',

    // Copilot read-only tools (work without chat participant token)
    'copilot_readFile',
    'copilot_listDirectory',
    'copilot_findFiles',
    'copilot_findTestFiles',
    'copilot_findTextInFiles',
    'copilot_searchCodebase',
    'copilot_searchWorkspaceSymbols',
    'copilot_listCodeUsages',
    'copilot_getChangedFiles',
    'copilot_getErrors',
    'copilot_getSearchResults',
    'copilot_getDocInfo',
    'copilot_getVSCodeAPI',
    'copilot_githubRepo',
    'copilot_fetchWebPage',
    'copilot_testFailure',
    'copilot_openSimpleBrowser',

    // Terminal tools
    'run_in_terminal',
    'get_terminal_output',
    'terminal_last_command',
    'terminal_selection',

    // Task and test tools
    'create_and_run_task',
    'runTests',
    'runSubagent',
    // Note: manage_todo_list removed - using tom_manageTodo instead
    'tom_manageTodo',

    // Dart/Flutter tools
    'dart_format',
    'get_dart_tooling_daemon_dtd_uri',

    // Debug tools
    'get_debug_session_info',
    'get_debug_stack_trace',
    'get_debug_threads',
    'get_debug_variables',

    // MCP Dart SDK tools
    'mcp_dart_sdk_mcp__connect_dart_tooling_daemon',
    'mcp_dart_sdk_mcp__create_project',
    'mcp_dart_sdk_mcp__flutter_driver',
    'mcp_dart_sdk_mcp__get_app_logs',
    'mcp_dart_sdk_mcp__get_runtime_errors',
    'mcp_dart_sdk_mcp__get_widget_tree',
    'mcp_dart_sdk_mcp__hot_reload',
    'mcp_dart_sdk_mcp__hot_restart',
    'mcp_dart_sdk_mcp__hover',
    'mcp_dart_sdk_mcp__launch_app',
    'mcp_dart_sdk_mcp__pub',
    'mcp_dart_sdk_mcp__pub_dev_search',
    'mcp_dart_sdk_mcp__resolve_workspace_symbol',
    'mcp_dart_sdk_mcp__set_widget_selection_mode',
    'mcp_dart_sdk_mcp__signature_help',
    'mcp_dart_sdk_mcp__stop_app',

    // Confirmation tools
    'vscode_get_confirmation',
    'vscode_get_terminal_confirmation'
]);

const DEFAULT_MAX_CONTEXT_CHARS = 50000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 50000;
const DEFAULT_MAX_DRAFT_CHARS = 8000;
const MAX_LOG_LINES = 6;

// ============================================================================
// Chat Log Manager - Tracks exact prompts/responses for review
// ============================================================================

class ChatLogManager {
    private chatId: string;
    private dir: string;
    private logPath: string;
    private historyPath: string;
    private promptTimestamp: string;
    private requestCount: number = 0;
    private content: string[] = [];

    constructor(chatId: string, dir: string) {
        this.chatId = chatId;
        this.dir = dir;
        this.logPath = path.join(dir, `${chatId}.chat-log.md`);
        this.historyPath = path.join(dir, `${chatId}.chat-history.md`);
        this.promptTimestamp = formatLogTimestamp();
    }

    /**
     * Start a new user prompt section. Also moves previous log to history.
     */
    startUserPrompt(promptText: string): void {
        // Move current log to history if it exists
        this.archiveCurrentLog();
        
        // Reset for new prompt
        this.requestCount = 0;
        this.content = [
            `# Chat Log: ${this.chatId}`,
            '',
            `## User Prompt ${this.promptTimestamp}`,
            '',
            promptText,
            ''
        ];
        this.writeLog();
    }

    /**
     * Log model information
     */
    logModelInfo(modelId: string, tokenModelId: string, maxIterations: number): void {
        const timestamp = formatLogTimestamp();
        this.content.push(
            `### ${timestamp} Model Configuration`,
            '',
            `- **Model**: ${modelId}`,
            `- **Token Model**: ${tokenModelId}`,
            `- **Max Iterations**: ${maxIterations}`,
            ''
        );
        this.writeLog();
    }

    /**
     * Log pre-processing start
     */
    logPreProcessingStart(preProcessingModelId: string, tools: string[]): void {
        const timestamp = formatLogTimestamp();
        this.content.push(
            `### ${timestamp} Pre-processing Started`,
            '',
            `- **Pre-processing Model**: ${preProcessingModelId}`,
            `- **Tools Available**: ${tools.length}`,
            `- **Tool List**: ${tools.join(', ')}`,
            ''
        );
        this.writeLog();
    }

    /**
     * Log pre-processing result
     */
    logPreProcessingResult(
        toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>,
        summaryOutput: string
    ): void {
        const timestamp = formatLogTimestamp();
        this.content.push(
            `### ${timestamp} Pre-processing Result`,
            '',
            `- **Tool Calls**: ${toolCalls.length}`,
            ''
        );

        if (toolCalls.length > 0) {
            this.content.push('#### Pre-processing Tool Calls', '');
            for (const call of toolCalls) {
                this.content.push(
                    `##### ${call.tool}`,
                    '',
                    '**Arguments:**',
                    '```json',
                    JSON.stringify(call.args, null, 2),
                    '```',
                    '',
                    '**Result:**',
                    '```',
                    call.result,
                    '```',
                    ''
                );
            }
        }

        this.content.push(
            '#### Pre-processing Summary',
            '',
            summaryOutput || '(no summary)',
            ''
        );
        this.writeLog();
    }

    /**
     * Log response history trimming
     */
    logResponseTrimming(originalSize: number, trimmedSize: number, tokenLimit: number): void {
        const timestamp = formatLogTimestamp();
        const wasTrimmed = originalSize !== trimmedSize;
        this.content.push(
            `### ${timestamp} Response History ${wasTrimmed ? 'Trimmed' : 'Updated'}`,
            '',
            `- Original size: ${originalSize} chars`,
            wasTrimmed ? `- Trimmed to: ${trimmedSize} chars` : '- No trimming needed',
            `- Token limit: ${tokenLimit}`,
            ''
        );
        this.writeLog();
    }

    /**
     * Log a request sent to the model
     */
    logRequest(requestNumber: number, prompt: string, tools: string[]): void {
        const timestamp = formatLogTimestamp();
        this.requestCount = requestNumber;
        
        this.content.push(
            `### ${timestamp} Request ${requestNumber}`,
            '',
            '#### Prompt',
            '',
            '```',
            prompt,
            '```',
            '',
            '#### Tools Provided',
            '',
            `${tools.length} tools: ${tools.join(', ')}`,
            ''
        );
        this.writeLog();
    }

    /**
     * Log a reply received from the model
     */
    logReply(requestNumber: number, textResponse: string, toolCalls: Array<{ name: string; input: unknown }>): void {
        const timestamp = formatLogTimestamp();
        
        this.content.push(
            `### ${timestamp} Reply ${requestNumber}`,
            '',
            '#### Text Response',
            '',
            textResponse || '(no text response)',
            ''
        );
        
        if (toolCalls.length > 0) {
            this.content.push('#### Tool Calls', '');
            for (const call of toolCalls) {
                this.content.push(
                    `- **${call.name}**`,
                    '  ```json',
                    `  ${JSON.stringify(call.input, null, 2).split('\n').join('\n  ')}`,
                    '  ```',
                    ''
                );
            }
        }
        
        this.writeLog();
    }

    /**
     * Log a tool result (size only, not full content)
     */
    logToolResult(toolName: string, resultSize: number, success: boolean, errorMessage?: string): void {
        if (success) {
            this.content.push(`- Tool **${toolName}**: Result size was ${resultSize} chars`);
        } else {
            this.content.push(`- Tool **${toolName}**: ERROR - ${errorMessage}`);
        }
        this.writeLog();
    }

    /**
     * Log todo operation
     */
    logTodoOperation(result: TodoOperationResult): void {
        const timestamp = formatLogTimestamp();
        const opIcon = result.success ? '✅' : '❌';
        this.content.push(`- ${timestamp} Todo ${opIcon} **${result.operation}**: ${result.message}`);
        
        // Log affected todo details if any
        if (result.affectedTodo) {
            this.content.push(`  - #${result.affectedTodo.id}: ${result.affectedTodo.title} (${result.affectedTodo.status})`);
        }
        
        this.writeLog();
    }

    /**
     * Log final response
     */
    logFinalResponse(responseText: string): void {
        const timestamp = formatLogTimestamp();
        this.content.push(
            '',
            `### ${timestamp} Final Response`,
            '',
            responseText,
            ''
        );
        this.writeLog();
    }

    private writeLog(): void {
        fs.writeFileSync(this.logPath, this.content.join('\n'), 'utf8');
    }

    private archiveCurrentLog(): void {
        if (!fs.existsSync(this.logPath)) {
            return;
        }
        
        const currentLog = fs.readFileSync(this.logPath, 'utf8');
        if (!currentLog.trim()) {
            return;
        }
        
        // Extract just the user prompt section (skip the # Chat Log header)
        const lines = currentLog.split('\n');
        const promptIndex = lines.findIndex(line => line.startsWith('## User Prompt'));
        if (promptIndex === -1) {
            return;
        }
        
        const promptContent = lines.slice(promptIndex).join('\n');
        
        // Prepend to history file
        let historyContent = '';
        if (fs.existsSync(this.historyPath)) {
            historyContent = fs.readFileSync(this.historyPath, 'utf8');
        }
        
        // If history doesn't have a header, add one
        if (!historyContent.startsWith('# Chat History:')) {
            historyContent = `# Chat History: ${this.chatId}\n\n${historyContent}`;
        }
        
        // Insert new prompt after the header
        const headerEndIndex = historyContent.indexOf('\n\n');
        if (headerEndIndex !== -1) {
            historyContent = historyContent.slice(0, headerEndIndex + 2) + promptContent + '\n\n' + historyContent.slice(headerEndIndex + 2);
        } else {
            historyContent = historyContent + '\n\n' + promptContent;
        }
        
        fs.writeFileSync(this.historyPath, historyContent.trim(), 'utf8');
    }
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (text.length <= maxChars) {
        return { text, truncated: false };
    }
    return { text: `${text.slice(0, Math.max(0, maxChars))}\n...[truncated]`, truncated: true };
}
function truncateLines(text: string, maxLines: number): string {
    const lines = text.split(/\r?\n/);
    if (lines.length <= maxLines) {
        return text;
    }
    return [...lines.slice(0, maxLines), '...[truncated]'].join('\n');
}

function getFileName(filePath: string): string {
    return path.basename(filePath);
}

function formatToolInputForLog(input: unknown): string {
    if (!input || typeof input !== 'object') {
        return String(input);
    }
    const value = input as Record<string, unknown>;
    const summary: Record<string, unknown> = { ...value };
    if (typeof summary.filePath === 'string') {
        summary.filePath = getFileName(summary.filePath);
    }
    return JSON.stringify(summary);
}

function getConfig() {
    const config = vscode.workspace.getConfiguration('dartscript');
    return {
        modelId: config.get<string>('tomAiChat.modelId') ?? config.get<string>('copilotModel') ?? 'gpt-5.2',
        tokenModelId: config.get<string>('tomAiChat.tokenModelId') ?? 'gpt-4o',
        preProcessingModelId: config.get<string>('tomAiChat.preProcessingModelId') ?? 'gpt-5-mini',
        enablePromptOptimization: config.get<boolean>('tomAiChat.enablePromptOptimization') ?? false,
        responsesTokenLimit: config.get<number>('tomAiChat.responsesTokenLimit') ?? 50000,
        responseSummaryTokenLimit: config.get<number>('tomAiChat.responseSummaryTokenLimit') ?? 8000,
        maxIterations: config.get<number>('tomAiChat.maxIterations') ?? 100,
        maxContextChars: config.get<number>('tomAiChat.maxContextChars') ?? DEFAULT_MAX_CONTEXT_CHARS,
        maxToolResultChars: config.get<number>('tomAiChat.maxToolResultChars') ?? DEFAULT_MAX_TOOL_RESULT_CHARS,
        maxDraftChars: config.get<number>('tomAiChat.maxDraftChars') ?? DEFAULT_MAX_DRAFT_CHARS
    };
}

function ensureChatFileActive(): vscode.TextEditor {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new Error('No active editor. Open a .chat.md file first.');
    }
    const filePath = editor.document.uri.fsPath;
    if (!filePath.endsWith('.chat.md')) {
        throw new Error('Active file is not a .chat.md file.');
    }
    return editor;
}

function parseChatDocument(document: vscode.TextDocument) {
    return parseChatText(document.getText(), document.uri.fsPath);
}

async function writeDocument(editor: vscode.TextEditor, content: string): Promise<void> {
    const fullRange = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(editor.document.getText().length)
    );

    await editor.edit((editBuilder) => {
        editBuilder.replace(fullRange, content);
    });

    await editor.document.save();
}

async function selectModel(modelId: string): Promise<vscode.LanguageModelChat> {
    let models = await vscode.lm.selectChatModels({ id: modelId });
    if (models.length === 0) {
        models = await vscode.lm.selectChatModels({ family: modelId });
    }
    if (models.length === 0) {
        models = await vscode.lm.selectChatModels();
    }
    if (models.length === 0) {
        throw new Error('No language models available.');
    }
    return models[0];
}

function buildPromptTemplateWithSummary(summaryPath: string, promptText: string): string {
    return buildPromptTemplate(summaryPath, promptText);
}

function buildAdditionalContextBlock(contextPath: string, contextText: string): string {
    return [
        'Additional context file (read this to understand user statements):',
        `Path: ${contextPath}`,
        '',
        contextText.trim()
    ].join('\n');
}

function stringifyToolResult(result: unknown): string {
    try {
        if (typeof result === 'string') {
            return result;
        }
        return JSON.stringify(result);
    } catch (error) {
        return String(result);
    }
}

function toolPartToText(part: unknown): string {
    const value = part as { text?: unknown; value?: unknown } | null | undefined;
    if (typeof value?.text === 'string') {
        return value.text;
    }
    if (typeof value?.value === 'string') {
        return value.value;
    }
    return stringifyToolResult(part);
}

function toolResultToText(result: vscode.LanguageModelToolResult): string {
    if (Array.isArray(result)) {
        const chunks = result.map((part) => toolPartToText(part));
        return chunks.join('\n').trim();
    }
    return toolPartToText(result).trim();
}

function isToolSchemaValid(tool: vscode.LanguageModelChatTool): boolean {
    const schema = (tool as { inputSchema?: { type?: string; properties?: Record<string, unknown> } })
        .inputSchema;
    if (!schema) {
        return true;
    }
    if (schema.type === 'object' && !schema.properties) {
        return false;
    }
    return true;
}

async function trimToTokenLimit(text: string, limit: number, model: vscode.LanguageModelChat): Promise<string> {
    let current = text;
    const count = await model.countTokens(current);
    if (count <= limit) {
        return current;
    }

    const blocks = current.split(new RegExp(`^${TOOL_SEPARATOR}$`, 'm')).filter((b) => b.trim().length > 0);
    while (blocks.length > 1) {
        blocks.pop();
        current = blocks.join(`\n${TOOL_SEPARATOR}\n`).trim();
        const newCount = await model.countTokens(current);
        if (newCount <= limit) {
            return current;
        }
    }

    while ((await model.countTokens(current)) > limit && current.length > 0) {
        current = current.slice(0, Math.max(0, current.length - 500));
    }

    return current.trim();
}

export async function startTomAiChatHandler(): Promise<void> {
    logChannel.appendLine('[Tom AI] startTomAIChat command invoked');
    try {
    const editor = ensureChatFileActive();
    const document = editor.document;
    const { 
        modelId, 
        tokenModelId, 
        responsesTokenLimit, 
        responseSummaryTokenLimit,
        maxIterations,
        preProcessingModelId,
        enablePromptOptimization,
        maxContextChars,
        maxToolResultChars,
        maxDraftChars
    } = getConfig();

    const filePath = document.uri.fsPath;
    const chatId = path.basename(filePath, '.chat.md');
    const dir = path.dirname(filePath);
    const responsesPath = path.join(dir, `${chatId}.responses.md`);
    const summaryPath = path.join(dir, `${chatId}.response-summary.md`);

    const existing = document.getText();
    const hasHeader = CHAT_HEADER_REGEX.test(existing);
    const metadataBlock = buildMetadataBlock(
        chatId,
        modelId,
        tokenModelId,
        responsesTokenLimit,
        responseSummaryTokenLimit,
        maxIterations,
        preProcessingModelId,
        enablePromptOptimization,
        maxContextChars,
        maxToolResultChars,
        maxDraftChars
    );

    const content = hasHeader ? existing : `${metadataBlock}${existing ? `\n${existing}` : ''}`;
    await writeDocument(editor, content.trimEnd());

    fs.writeFileSync(responsesPath, '');
    fs.writeFileSync(summaryPath, '');

    logChannel.appendLine(`[Tom AI] startTomAIChat completed for ${chatId}`);
    vscode.window.showInformationMessage(`Tom AI chat initialized for ${chatId}`);
    } catch (error) {
        logChannel.appendLine(`[Tom AI] startTomAIChat FAILED: ${error}`);
        vscode.window.showErrorMessage(`Start Tom AI Chat failed: ${error}`);
    }
}

export async function sendToTomAiChatHandler(): Promise<void> {
    logChannel.appendLine('[Tom AI] sendToTomAIChat command invoked');
    try {

    const editor = ensureChatFileActive();
    const document = editor.document;
    const config = getConfig();

    const parsed = parseChatDocument(document);
    const modelId = parsed.modelId ?? config.modelId;
    const tokenModelId = parsed.tokenModelId ?? config.tokenModelId;
    const responsesTokenLimit = parsed.responsesTokenLimit ?? config.responsesTokenLimit;
    const responseSummaryTokenLimit = parsed.responseSummaryTokenLimit ?? config.responseSummaryTokenLimit;
    const maxIterations = parsed.maxIterations ?? config.maxIterations;
    const preProcessingModelId = parsed.preProcessingModelId ?? config.preProcessingModelId;
    const enablePromptOptimization = parsed.enablePromptOptimization ?? config.enablePromptOptimization;
    const maxContextChars = parsed.maxContextChars ?? config.maxContextChars;
    const maxToolResultChars = parsed.maxToolResultChars ?? config.maxToolResultChars;
    const maxDraftChars = parsed.maxDraftChars ?? config.maxDraftChars;
    const chatId = parsed.chatId;
    const dir = path.dirname(document.uri.fsPath);
    const responsesPath = path.join(dir, `${chatId}.responses.md`);
    const summaryPath = path.join(dir, `${chatId}.response-summary.md`);

    // Setup cancellation token for this request
    if (activeCancellationTokenSource) {
        activeCancellationTokenSource.dispose();
    }
    activeCancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = activeCancellationTokenSource.token;

    // Initialize chat log manager for exact logging
    const chatLog = new ChatLogManager(chatId, dir);
    chatLog.startUserPrompt(parsed.promptText);

    // Initialize todo manager for this chat session
    const todoDir = WsPaths.ai('tomAiChat') || path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? dir, '_ai', 'tom_ai_chat');
    if (!fs.existsSync(todoDir)) {
        fs.mkdirSync(todoDir, { recursive: true });
    }
    const todoManager = new TodoManager(chatId, todoDir);
    todoManager.setOperationCallback((result) => chatLog.logTodoOperation(result));
    setActiveTodoManager(todoManager);

    // Switch to Tom AI Chat Log and log the user prompt immediately
    logChannel.show(true);
    logChannel.appendLine(`New user prompt:\n\n${parsed.promptText}\n`);

    toolLogChannel.appendLine(`[Tom AI] Tool log started for chat ${chatId}`);

    if (parsed.toolInvocationTokenText) {
        logChannel.appendLine('[Tom AI] toolInvocationToken text present in file; tool invocation will use it when available.');
    }

    const model = await selectModel(modelId);
    let tokenModel = model;
    if (tokenModelId && tokenModelId !== modelId) {
        try {
            tokenModel = await selectModel(tokenModelId);
        } catch (error) {
            logChannel.appendLine(`[Tom AI] Failed to load token model ${tokenModelId}; using ${modelId} instead.`);
        }
    }

    // Log model configuration
    logChannel.appendLine(`[Tom AI] Model: ${modelId}, Token Model: ${tokenModelId}, Max Iterations: ${maxIterations}`);
    chatLog.logModelInfo(modelId, tokenModelId, maxIterations);

    let summaryText = '';
    if (fs.existsSync(responsesPath)) {
        const responsesContent = fs.readFileSync(responsesPath, 'utf8').trim();
        if (responsesContent.length > 0) {
            const summaryPrompt = buildSummaryPrompt(responsesContent);
            const summaryResponse = await model.sendRequest(
                [vscode.LanguageModelChatMessage.User(summaryPrompt)],
                {}
            );

            let summaryOutput = '';
            for await (const part of summaryResponse.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    summaryOutput += part.value;
                }
            }
            summaryText = summaryOutput.trim();
            summaryText = await trimToTokenLimit(summaryText, responseSummaryTokenLimit, tokenModel);
            fs.writeFileSync(summaryPath, summaryText);
            logChannel.appendLine(`[Tom AI] Generated response summary (${summaryText.length} chars)`);
        }
    }

    const promptTemplate = buildPromptTemplateWithSummary(summaryPath, parsed.promptText);
    
    // Context file can be specified in the header; otherwise no additional context is added
    const contextFilePath = parsed.contextFilePath ?? '';
    let contextBlock = '';
    if (contextFilePath && fs.existsSync(contextFilePath)) {
        const contextText = fs.readFileSync(contextFilePath, 'utf8');
        if (contextText.trim().length > 0) {
            const truncated = truncateText(contextText, maxContextChars);
            if (truncated.truncated) {
                logChannel.appendLine(`[Tom AI] Context file truncated to ${maxContextChars} chars.`);
            }
            contextBlock = buildAdditionalContextBlock(contextFilePath, truncated.text);
        }
    }
    const fullPromptTemplate = contextBlock
        ? [promptTemplate, '', contextBlock].join('\n')
        : promptTemplate;

    logChannel.appendLine(`[Tom AI] Preparing prompt for chat ${chatId}`);
    if (contextBlock) {
        logChannel.appendLine(`[Tom AI] Added context file: ${getFileName(contextFilePath)}`);
        logChannel.appendLine(`[Tom AI] Context preview:\n${truncateLines(contextBlock, MAX_LOG_LINES)}`);
    } else if (contextFilePath) {
        logChannel.appendLine(`[Tom AI] Context file missing or empty: ${getFileName(contextFilePath)}`);
    }
    logChannel.appendLine(`[Tom AI] Prompt preview:\n${truncateLines(fullPromptTemplate, MAX_LOG_LINES)}`);

    const allTools = Array.from(vscode.lm.tools) as unknown as vscode.LanguageModelChatTool[];
    const sortedTools = [...allTools].sort((a, b) => a.name.localeCompare(b.name));
    const invalidSchemaTools = sortedTools.filter((tool) => !isToolSchemaValid(tool));
    const validTools = sortedTools.filter((tool) => isToolSchemaValid(tool));
    const allowedTools = validTools.filter((tool) => TOM_AI_CHAT_ALLOWED_TOOLS.has(tool.name));
    const maxTools = 128;
    const tools = allowedTools.slice(0, maxTools);
    if (allTools.length > 0) {
        logChannel.appendLine(`[Tom AI] Tools registered: ${allTools.length}`);
        if (invalidSchemaTools.length > 0) {
            logChannel.appendLine(
                `[Tom AI] Tools skipped due to invalid schema: ${invalidSchemaTools
                    .map((tool) => tool.name)
                    .join(', ')}`
            );
        }
        logChannel.appendLine(`[Tom AI] Tools requested: ${tools.length}`);
        logChannel.appendLine(`[Tom AI] Tool names: ${tools.map((tool) => tool.name).join(', ')}`);
        if (allowedTools.length > maxTools) {
            const skipped = allowedTools.slice(maxTools).map((tool) => tool.name).join(', ');
            logChannel.appendLine(`[Tom AI] Tools skipped due to cap (${maxTools}): ${skipped}`);
        }
        const missingAllowed = Array.from(TOM_AI_CHAT_ALLOWED_TOOLS).filter(
            (toolName) => !validTools.some((tool) => tool.name === toolName)
        );
        if (missingAllowed.length > 0) {
            logChannel.appendLine(`[Tom AI] Allowed tools not registered: ${missingAllowed.join(', ')}`);
        }
    }
    let responseText = '';
    let lastAssistantDraft = '';
    let currentPrompt = fullPromptTemplate;
    // maxIterations is now read from chat file or config (default 100)
    const systemPrompt = buildSystemPrompt();
    
    // Trail: Clear and log initial prompt
    loadTrailConfig();
    clearTrail('tomai');
    logPrompt('tomai', modelId, fullPromptTemplate, systemPrompt, {
        chatId,
        modelId,
        tokenModelId,
        maxIterations,
        preProcessingEnabled: enablePromptOptimization,
        contextFile: contextFilePath || null,
        registeredTools: tools.map(t => t.name),
    });
    
    // Track tool calls to detect loops
    const toolCallHistory: string[] = [];
    const MAX_DUPLICATE_TOOL_CALLS = 3;
    
    // Pre-processing step: use cheap model to gather context
    let preProcessingContext = '';
    if (enablePromptOptimization) {
        logChannel.appendLine(`[Tom AI] Pre-processing enabled with model: ${preProcessingModelId}`);
        
        try {
            const preProcessingTools = validTools.filter((tool) => PRE_PROCESSING_ALLOWED_TOOLS.has(tool.name));
            logChannel.appendLine(`[Tom AI] Pre-processing tools: ${preProcessingTools.map(t => t.name).join(', ')}`);
            
            const preProcessModel = await selectModel(preProcessingModelId);
            
            const preProcessPrompt = `You are a context-gathering assistant. Your task is to analyze the following user prompt and gather relevant context using the available tools.

IMPORTANT RULES:
1. Focus on reading/searching files that may contain relevant context
2. Look for guidelines, specifications, or related code
3. Do NOT make any edits or changes - only read/search
4. Maximum 5 tool calls
5. After gathering context, provide a brief summary of what you found

USER PROMPT:
${parsed.promptText}

Use the available tools to gather context, then respond with a summary of what you found.`;

            const preProcessMessages = [vscode.LanguageModelChatMessage.User(preProcessPrompt)];
            chatLog.logPreProcessingStart(preProcessingModelId, preProcessingTools.map(t => t.name));
            
            let preProcessOutput = '';
            const preToolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }> = [];
            let preIterations = 0;
            const maxPreIterations = 5;
            
            let preCurrentPrompt = preProcessPrompt;
            
            while (preIterations < maxPreIterations) {
                preIterations++;
                
                if (cancellationToken.isCancellationRequested) {
                    logChannel.appendLine('[Tom AI] Pre-processing cancelled');
                    break;
                }
                
                const preResponse = await preProcessModel.sendRequest(
                    [vscode.LanguageModelChatMessage.User(preCurrentPrompt)],
                    { tools: preProcessingTools }
                );
                
                let hasToolCalls = false;
                const toolResults: string[] = [];
                
                for await (const part of preResponse.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        preProcessOutput += part.value;
                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                        hasToolCalls = true;
                        const toolName = part.name;
                        const toolArgs = part.input as Record<string, unknown>;
                        
                        logChannel.appendLine(`[Tom AI] Pre-processing tool call: ${toolName}`);
                        
                        try {
                            const toolResult = await vscode.lm.invokeTool(toolName, {
                                input: toolArgs,
                                toolInvocationToken: undefined
                            }, cancellationToken);
                            
                            const resultText = toolResultToText(toolResult);
                            const truncatedResult = resultText.length > 2000 
                                ? resultText.slice(0, 2000) + '\n... [truncated]' 
                                : resultText;
                            
                            preToolCalls.push({
                                tool: toolName,
                                args: toolArgs,
                                result: truncatedResult
                            });
                            
                            toolResults.push(`Tool: ${toolName}\nResult:\n${truncatedResult}`);
                        } catch (error) {
                            const errorMsg = error instanceof Error ? error.message : String(error);
                            toolResults.push(`Tool: ${toolName}\nError: ${errorMsg}`);
                        }
                    }
                }
                
                if (!hasToolCalls) {
                    // No more tool calls, exit loop
                    break;
                }
                
                // Build continuation prompt with tool results
                preCurrentPrompt = `Previous context:\n${preProcessOutput}\n\nTool results:\n${toolResults.join('\n\n---\n\n')}\n\nContinue gathering context or provide your summary.`;
            }
            
            if (preProcessOutput.trim() || preToolCalls.length > 0) {
                const contextParts: string[] = [];
                
                if (preToolCalls.length > 0) {
                    contextParts.push('## Pre-loaded Context\n');
                    for (const call of preToolCalls) {
                        contextParts.push(`### ${call.tool}\n\`\`\`\n${call.result}\n\`\`\`\n`);
                    }
                }
                
                if (preProcessOutput.trim()) {
                    contextParts.push(`## Pre-processing Summary\n${preProcessOutput.trim()}\n`);
                }
                
                preProcessingContext = contextParts.join('\n');
                logChannel.appendLine(`[Tom AI] Pre-processing complete: ${preToolCalls.length} tool calls, ${preProcessOutput.length} chars output`);
                chatLog.logPreProcessingResult(preToolCalls, preProcessOutput);
            } else {
                logChannel.appendLine('[Tom AI] Pre-processing produced no context');
                chatLog.logPreProcessingResult([], 'No context gathered');
            }
            
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logChannel.appendLine(`[Tom AI] Pre-processing failed: ${errorMsg}`);
            chatLog.logPreProcessingResult([], `Error: ${errorMsg}`);
        }
    }
    
    // Combine system prompt and user prompt into a single message for the initial request
    const initialPrompt = preProcessingContext
        ? `${systemPrompt}\n\n---\n\n## Pre-loaded Context from Analysis\n\n${preProcessingContext}\n\n---\n\n${fullPromptTemplate}`
        : `${systemPrompt}\n\n---\n\n${fullPromptTemplate}`;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        // Check for cancellation at start of each iteration
        if (cancellationToken.isCancellationRequested) {
            logChannel.appendLine('[Tom AI] Request cancelled by user');
            chatLog.logFinalResponse('[INTERRUPTED] Request cancelled by user');
            activeCancellationTokenSource = null;
            setActiveTodoManager(null);
            return;
        }
        
        logChannel.appendLine(`[Tom AI] Request iteration ${iteration}/${maxIterations}`);
        const promptToSend = iteration === 1 ? initialPrompt : currentPrompt;
        const messages = [vscode.LanguageModelChatMessage.User(promptToSend)];
        
        // Log request to chat log file
        chatLog.logRequest(iteration, promptToSend, tools.map(t => t.name));
        
        const response = await model.sendRequest(messages, { tools }, cancellationToken);

        let iterationText = '';
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];

        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                iterationText += part.value;
                logChannel.append(part.value);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
                toolLogChannel.appendLine(`\n[Tool Call] ${part.name} ${formatToolInputForLog(part.input)}`);
            }
        }

        // Log reply to chat log file
        chatLog.logReply(iteration, iterationText, toolCalls.map(c => ({ name: c.name, input: c.input })));

        if (toolCalls.length === 0) {
            responseText = iterationText.trim();
            break;
        }

        const draftTrimmed = truncateText(iterationText.trim(), maxDraftChars);
        if (draftTrimmed.truncated) {
            logChannel.appendLine(`[Tom AI] Assistant draft truncated to ${maxDraftChars} chars.`);
        }
        lastAssistantDraft = draftTrimmed.text;
        logChannel.appendLine(`[Tom AI] Tool calls detected: ${toolCalls.length}`);
        logChannel.appendLine(`[Tom AI] Executing tool calls...`);

        // Track tool calls to detect loops
        const currentToolCallSignatures: string[] = [];
        for (const call of toolCalls) {
            const signature = `${call.name}:${JSON.stringify(call.input)}`;
            currentToolCallSignatures.push(signature);
            toolCallHistory.push(signature);
        }
        
        // Check for duplicate tool calls (same tool + args called too many times)
        let loopWarning = '';
        for (const sig of currentToolCallSignatures) {
            const count = toolCallHistory.filter(s => s === sig).length;
            if (count >= MAX_DUPLICATE_TOOL_CALLS) {
                loopWarning = `\n\nWARNING: You have called the same tool with the same arguments ${count} times. This appears to be a loop. Please try a different approach or provide your final response.`;
                logChannel.appendLine(`[Tom AI] Loop detected: ${sig.substring(0, 100)}... called ${count} times`);
                break;
            }
        }

        const toolResults: string[] = [];
        for (const call of toolCalls) {
            // Trail: Log tool request
            logToolRequest('tomai', call.name, call.input as Record<string, unknown>);
            
            const headerToken = parsed.toolInvocationTokenText?.trim();
            const resolvedToolInvocationToken = (call as { toolInvocationToken?: vscode.ChatParticipantToolToken })
                .toolInvocationToken
                ?? (headerToken ? (headerToken as unknown as vscode.ChatParticipantToolToken) : undefined);
            try {
                const toolInvocationOptions: any = {
                    input: call.input as object
                };
                if (resolvedToolInvocationToken) {
                    toolInvocationOptions.toolInvocationToken = resolvedToolInvocationToken;
                }
                const toolResult = await vscode.lm.invokeTool(call.name, toolInvocationOptions);
                toolLogChannel.appendLine(`[Tool Result] ${call.name}: ${truncateLines(stringifyToolResult(toolResult), MAX_LOG_LINES)}`);
                const toolTextRaw = toolResultToText(toolResult);
                const toolText = truncateText(toolTextRaw, maxToolResultChars);
                if (toolText.truncated) {
                    logChannel.appendLine(`[Tom AI] Tool result truncated for ${call.name}.`);
                }
                toolResults.push(`Tool ${call.name} result:\n${toolText.text}`);
                // Log tool result to chat log (size only)
                chatLog.logToolResult(call.name, toolTextRaw.length, true);
                // Trail: Log tool result
                logToolResult('tomai', call.name, toolText.text);
            } catch (error) {
                toolLogChannel.appendLine(`[Tool Error] ${call.name}: ${String(error)}`);
                logChannel.appendLine(`[Tom AI] Tool ${call.name} failed. Retrying without token...`);
                try {
                    const retryResult = await vscode.lm.invokeTool(call.name, {
                        input: call.input as object,
                        toolInvocationToken: undefined
                    });
                    toolLogChannel.appendLine(`[Tool Result Retry] ${call.name}: ${truncateLines(stringifyToolResult(retryResult), MAX_LOG_LINES)}`);
                    const retryTextRaw = toolResultToText(retryResult);
                    const retryText = truncateText(retryTextRaw, maxToolResultChars);
                    if (retryText.truncated) {
                        logChannel.appendLine(`[Tom AI] Tool result truncated for ${call.name} (retry).`);
                    }
                    toolResults.push(`Tool ${call.name} result (retry):\n${retryText.text}`);
                    // Log tool result to chat log (size only)
                    chatLog.logToolResult(call.name, retryTextRaw.length, true);
                    // Trail: Log tool result (retry)
                    logToolResult('tomai', call.name, retryText.text);
                } catch (retryError) {
                    const errorMessage = `Tool ${call.name} failed: ${retryError}`;
                    toolResults.push(errorMessage);
                    toolLogChannel.appendLine(errorMessage);
                    // Log tool error to chat log
                    chatLog.logToolResult(call.name, 0, false, String(retryError));
                    // Trail: Log tool error
                    logToolResult('tomai', call.name, '', String(retryError));
                }
            }
        }

        const followupParts: string[] = [
            '---',
            '',
            'Tool results from your previous request:',
            '',
            ...toolResults,
            '',
            '---',
            '',
            '=== ORIGINAL USER REQUEST (reminder) ===',
            '',
            parsed.promptText,
            '',
            '=== END ORIGINAL REQUEST ===',
            '',
            'Continue working on the user\'s original request above.',
            'If you need more information to complete the task, call the appropriate tools.',
            'If the task is complete OR if you cannot complete it (e.g., file not found, error occurred), provide your final text response to the user explaining the result.',
            'IMPORTANT: Do not repeat the same tool call if it already failed. Try a different approach or respond with what you found.',
        ];
        
        if (loopWarning) {
            followupParts.push(loopWarning);
        }
        
        if (lastAssistantDraft) {
            followupParts.push('', 'Your previous draft:', lastAssistantDraft);
        }
        
        const followupPrompt = followupParts.join('\n');

        logChannel.appendLine(`[Tom AI] Followup prompt preview:\n${truncateLines(followupPrompt, MAX_LOG_LINES)}`);
        currentPrompt = followupPrompt;
        if (iteration === maxIterations) {
            // If we have text from the model, use it even though it also called tools
            if (lastAssistantDraft && lastAssistantDraft.length > 20) {
                responseText = lastAssistantDraft;
                logChannel.appendLine(`[Tom AI] Max iterations reached, using last assistant draft as response.`);
            } else {
                responseText = `${EXTENSION_MESSAGE_PREFIX}No final text response received after tool execution. See Tom AI Chat Log for details.`;
            }
        }
    }

    if (!responseText.trim()) {
        responseText = `${EXTENSION_MESSAGE_PREFIX}No response text returned by the language model.`;
    }

    responseText = responseText.trim();
    
    // Log final response to chat log file
    chatLog.logFinalResponse(responseText);
    
    // Trail: Log final response
    logResponse('tomai', modelId, responseText, true, {
        chatId,
        iterations: maxIterations,
        responseLength: responseText.length,
    });
    
    // Switch to Tom AI Chat Responses output when logging the response
    responseChannel.show(true);
    responseChannel.appendLine(responseText);

    const responseBlock = `${TOOL_SEPARATOR}\n${responseText}\n\n`;
    const existingResponses = fs.existsSync(responsesPath) ? fs.readFileSync(responsesPath, 'utf8') : '';
    let updatedResponses = `${responseBlock}${existingResponses}`;
    const originalSize = updatedResponses.length;
    updatedResponses = await trimToTokenLimit(updatedResponses, responsesTokenLimit, tokenModel);
    const trimmedSize = updatedResponses.length;
    
    // Log response history trimming
    logChannel.appendLine(`[Tom AI] Response history: ${originalSize} -> ${trimmedSize} chars (limit: ${responsesTokenLimit} tokens)`);
    chatLog.logResponseTrimming(originalSize, trimmedSize, responsesTokenLimit);
    
    fs.writeFileSync(responsesPath, updatedResponses.trimEnd());

    // Check if editor is still open before trying to write
    if (editor.document.isClosed) {
        logChannel.appendLine('[Tom AI] ⚠️ Editor was closed during operation. Response saved to files but chat.md not updated.');
        vscode.window.showWarningMessage(`Tom AI response saved to files, but ${chatId}.chat.md was closed.`);
    } else {
        const newLines = [...parsed.lines];
        const insertIndex = parsed.headerLineIndex + 1;
        newLines.splice(insertIndex, 0, '', '', '', TOOL_SEPARATOR);
        const updatedDoc = newLines.join('\n');

        await writeDocument(editor, updatedDoc);

        const newPosition = new vscode.Position(insertIndex + 1, 0);
        editor.selection = new vscode.Selection(newPosition, newPosition);
        
        vscode.window.showInformationMessage(`Tom AI response saved for ${chatId}`);
    }

    // Clean up cancellation token
    activeCancellationTokenSource = null;

    // Clean up todo manager
    setActiveTodoManager(null);

    logChannel.appendLine('[Tom AI] sendToTomAIChat completed');
    } catch (error) {
        logChannel.appendLine(`[Tom AI] sendToTomAIChat FAILED: ${error}`);
        vscode.window.showErrorMessage(`Send to Tom AI Chat failed: ${error}`);
        // Ensure cleanup happens even on error
        activeCancellationTokenSource = null;
        setActiveTodoManager(null);
    }
}
