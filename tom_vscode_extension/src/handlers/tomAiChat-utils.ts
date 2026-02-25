import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { WsPaths } from '../utils/workspacePaths';

export const TOOL_SEPARATOR = '_'.repeat(30);
export const CHAT_HEADER_REGEX = /CHAT\s+(.+?)_*/i;
export const SEPARATOR_REGEX = /^(-{3,}|_{3,})\s*$/;

/**
 * Get the workspace root path
 */
function getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

/**
 * Read the copilot-instructions.md file from the workspace
 */
function readCopilotInstructions(): string {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return '';
    }
    
    const instructionsPath = WsPaths.github('copilot-instructions.md') || path.join(workspaceRoot, '.github', 'copilot-instructions.md');
    if (!fs.existsSync(instructionsPath)) {
        return '';
    }
    
    try {
        return fs.readFileSync(instructionsPath, 'utf8');
    } catch {
        return '';
    }
}

/**
 * Format a timestamp for log entries (MMDD-HHMMSS)
 */
export function formatLogTimestamp(date: Date = new Date()): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${month}${day}-${hours}${minutes}${seconds}`;
}

export interface ChatParseResult {
    chatId: string;
    headerLineIndex: number;
    promptStartLine: number;
    promptEndLine: number;
    promptText: string;
    toolInvocationTokenText?: string;
    modelId?: string;
    tokenModelId?: string;
    preProcessingModelId?: string;
    enablePromptOptimization?: boolean;
    responsesTokenLimit?: number;
    responseSummaryTokenLimit?: number;
    maxIterations?: number;
    maxContextChars?: number;
    maxToolResultChars?: number;
    maxDraftChars?: number;
    contextFilePath?: string;
    lines: string[];
}

export function buildMetadataBlock(
    chatId: string,
    modelId: string,
    tokenModelId: string,
    responsesTokenLimit: number,
    responseSummaryTokenLimit: number,
    maxIterations: number = 100,
    preProcessingModelId: string = '',
    enablePromptOptimization: boolean = false,
    maxContextChars: number = 50000,
    maxToolResultChars: number = 50000,
    maxDraftChars: number = 8000
): string {
    return [
        `toolInvocationToken:`,
        `modelId: ${modelId}`,
        `tokenModelId: ${tokenModelId}`,
        `preProcessingModelId: ${preProcessingModelId}`,
        `enablePromptOptimization: ${enablePromptOptimization}`,
        `responsesTokenLimit: ${responsesTokenLimit}`,
        `responseSummaryTokenLimit: ${responseSummaryTokenLimit}`,
        `maxIterations: ${maxIterations}`,
        `maxContextChars: ${maxContextChars}`,
        `maxToolResultChars: ${maxToolResultChars}`,
        `maxDraftChars: ${maxDraftChars}`,
        `contextFilePath:`,
        '',
        `${'_'.repeat(9)} CHAT ${chatId} ${'_'.repeat(12)}`,
        '',
        ''
    ].join('\n');
}

export function buildSystemPrompt(): string {
    const copilotInstructions = readCopilotInstructions();
    
    const basePrompt = [
        'You are an expert AI programming assistant working in VS Code.',
        'You have access to tools for reading/writing files, running terminal commands, and searching code.',
        '',
        'PRIMARY OBJECTIVE: Complete the user\'s request. Focus on the task first.',
        '',
        'Permissions:',
        '- You have full permission to read any file in the workspace without asking the user.',
        '- This includes .tom_metadata/tom_master.yaml and any other workspace files.',
        '- Simply read files when you need information - no confirmation required.',
        '',
        'Guidelines:',
        '- Follow the user\'s requirements carefully and to the letter.',
        '- Use tools when needed to gather context or make changes.',
        '- When editing files, use the appropriate edit tools rather than printing code blocks.',
        '- When running commands, use run_in_terminal rather than printing commands.',
        '- Keep responses concise and actionable.',
        '- Use proper Markdown formatting in your final response.',
        '- If you need to read files or gather context, do so before answering.',
        '',
        'Todo list (optional - use tom_manageTodo for complex multi-step tasks):',
        '- For simple tasks: Skip todos and just do the work.',
        '- For complex tasks with 3+ steps: Consider using tom_manageTodo to track progress.',
        '- Check existing todos at start only if resuming previous work.',
        '',
        'IMPORTANT: After successfully completing a tool operation (like creating or editing a file):',
        '- DO NOT call additional tools to verify the result unless the user explicitly asked for verification.',
        '- DO NOT read back the file you just created or edited.',
        '- Simply provide a brief text response confirming what you did.',
        '- Example: "I created the file `path/to/file.md` with the requested content."',
    ];
    
    if (copilotInstructions) {
        basePrompt.push(
            '',
            '---',
            '',
            'WORKSPACE COPILOT INSTRUCTIONS (from .github/copilot-instructions.md):',
            '',
            copilotInstructions
        );
    }
    
    return basePrompt.join('\n');
}

export function buildPromptTemplate(summaryPath: string, promptText: string): string {
    const parts: string[] = [];
    
    if (summaryPath) {
        parts.push(
            'Previous conversation summary (for context):',
            `See: ${summaryPath}`,
            ''
        );
    }
    
    parts.push(
        '=== USER REQUEST (focus on this) ===',
        '',
        promptText,
        '',
        '=== END USER REQUEST ===',
        '',
        'Complete this task using available tools as needed. Focus on the user\'s request above. Provide a final response when done.'
    );
    
    return parts.join('\n');
}

export function buildSummaryPrompt(responsesContent: string): string {
    return [
        'Summarize the key information from this conversation history.',
        'Focus on:',
        '- What tasks were requested and completed',
        '- Any important decisions or constraints mentioned',
        '- Current state of work in progress',
        '',
        'Keep the summary concise (under 500 words) and factual.',
        '',
        '---',
        responsesContent
    ].join('\n');
}

export function parseChatText(text: string, filePath: string): ChatParseResult {
    const chatId = path.basename(filePath, '.chat.md');
    const lines = text.split(/\r?\n/);

    const getLineValue = (key: string): string | undefined => {
        const line = lines.find((entry) => entry.startsWith(`${key}:`));
        if (!line) {
            return undefined;
        }
        const value = line.split(':').slice(1).join(':').trim();
        return value.length > 0 ? value : undefined;
    };

    const parseNumberValue = (key: string): number | undefined => {
        const value = getLineValue(key);
        if (!value) {
            return undefined;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    };

    const headerLineIndex = lines.findIndex((line) => CHAT_HEADER_REGEX.test(line));
    if (headerLineIndex === -1) {
        throw new Error('CHAT header not found. Run Tom AI: Start Chat to initialize the file.');
    }

    let promptStartLine = headerLineIndex + 1;
    let promptEndLine = lines.length;

    for (let i = promptStartLine; i < lines.length; i += 1) {
        if (SEPARATOR_REGEX.test(lines[i])) {
            promptEndLine = i;
            break;
        }
    }

    const promptLines = lines.slice(promptStartLine, promptEndLine);
    const promptText = promptLines.join('\n').trim();
    if (!promptText) {
        throw new Error('No prompt found below the CHAT header.');
    }

    const toolInvocationTokenText = getLineValue('toolInvocationToken');
    const modelId = getLineValue('modelId');
    const tokenModelId = getLineValue('tokenModelId');
    const preProcessingModelId = getLineValue('preProcessingModelId');
    const enablePromptOptimizationStr = getLineValue('enablePromptOptimization');
    const enablePromptOptimization = enablePromptOptimizationStr === 'true';
    const responsesTokenLimit = parseNumberValue('responsesTokenLimit');
    const responseSummaryTokenLimit = parseNumberValue('responseSummaryTokenLimit');
    const maxIterations = parseNumberValue('maxIterations');
    const maxContextChars = parseNumberValue('maxContextChars');
    const maxToolResultChars = parseNumberValue('maxToolResultChars');
    const maxDraftChars = parseNumberValue('maxDraftChars');
    const contextFilePath = getLineValue('contextFilePath');

    return {
        chatId,
        headerLineIndex,
        promptStartLine,
        promptEndLine,
        promptText,
        toolInvocationTokenText,
        modelId,
        tokenModelId,
        preProcessingModelId,
        enablePromptOptimization,
        responsesTokenLimit,
        responseSummaryTokenLimit,
        maxIterations,
        maxContextChars,
        maxToolResultChars,
        maxDraftChars,
        contextFilePath,
        lines
    };
}
