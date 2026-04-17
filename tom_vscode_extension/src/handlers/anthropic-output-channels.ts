/**
 * Output channels for the Anthropic handler.
 *
 * Two channels surface what's happening inside the handler so the user can
 * see progress in real time (the trail files are written only at turn end):
 *
 *   - **Tom AI Anthropic Chat** — internal operations: tool invocations with
 *     structured per-tool summaries, memory / history compaction details,
 *     approval gate events, turn lifecycle.
 *   - **Tom AI Anthropic Chat Responses** — what the model produced: the
 *     user prompt we sent, assistant text, thinking blocks, and a compact
 *     entry for each tool call (name + short input preview).
 *
 * The operations channel is intended for diagnostics / debugging. The
 * responses channel mirrors the conversation flow.
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Lazy-init channels (avoid creating until first use)
// ---------------------------------------------------------------------------

let _operations: vscode.OutputChannel | undefined;
let _responses: vscode.OutputChannel | undefined;

function operations(): vscode.OutputChannel {
    if (!_operations) {
        _operations = vscode.window.createOutputChannel('Tom AI Anthropic Chat');
    }
    return _operations;
}

function responses(): vscode.OutputChannel {
    if (!_responses) {
        _responses = vscode.window.createOutputChannel('Tom AI Anthropic Chat Responses');
    }
    return _responses;
}

function timestamp(): string {
    return new Date().toISOString().slice(11, 19);
}

function sep(line = '─'.repeat(70)): string { return line; }

// ---------------------------------------------------------------------------
// Per-tool structured summaries
// ---------------------------------------------------------------------------

function countOccurrences(text: string | undefined, re: RegExp): number {
    if (!text) { return 0; }
    const m = text.match(re);
    return m ? m.length : 0;
}

function safeJson(v: unknown, max = 200): string {
    try {
        const s = JSON.stringify(v);
        return s.length > max ? s.slice(0, max) + '…' : s;
    } catch {
        return '(unserializable)';
    }
}

function truncate(s: string | undefined, n = 500): string {
    if (!s) { return ''; }
    return s.length > n ? s.slice(0, n) + `… [truncated, ${s.length} chars total]` : s;
}

/**
 * Format a tool invocation — called both on request (no result) and on
 * completion (with result). Per-tool cases produce structured one-line
 * summaries; fallback shows truncated JSON input + truncated result.
 */
export function formatToolSummary(
    name: string,
    input: Record<string, unknown>,
    result?: string,
    error?: string,
): string {
    const arrow = ' → ';
    const i = input as Record<string, any>;
    const failedTag = error ? ` [error: ${error}]` : '';

    switch (name) {
        case 'tomAi_readFile': {
            const range = i.startLine !== undefined ? `:${i.startLine}-${i.endLine ?? ''}` : '';
            const lines = result !== undefined ? `${result.split('\n').length} lines` : 'reading';
            return `readFile(${i.filePath}${range})${arrow}${lines}${failedTag}`;
        }
        case 'tomAi_listDirectory':
            return `listDirectory(${i.path || '.'})${result ? arrow + countOccurrences(result, /\n/g) + ' entries' : ''}${failedTag}`;
        case 'tomAi_findFiles':
            return `findFiles("${i.pattern || i.glob || ''}")${result ? arrow + countOccurrences(result, /\n/g) + ' matches' : ''}${failedTag}`;
        case 'tomAi_findTextInFiles':
            return `findTextInFiles("${i.query || i.pattern || ''}")${result ? arrow + countOccurrences(result, /\n/g) + ' match lines' : ''}${failedTag}`;
        case 'tomAi_createFile':
            return `createFile(${i.filePath}, ${(i.content || '').length} chars)${result ? arrow + 'OK' : ''}${failedTag}`;
        case 'tomAi_editFile':
            return `editFile(${i.filePath})${result ? arrow + 'OK' : ''}${failedTag}`;
        case 'tomAi_multiEditFile':
            return `multiEditFile(${i.filePath}, ${Array.isArray(i.edits) ? i.edits.length : '?'} edits)${result ? arrow + 'OK' : ''}${failedTag}`;
        case 'tomAi_deleteFile':
            return `deleteFile(${i.filePath})${failedTag}`;
        case 'tomAi_moveFile':
            return `moveFile(${i.from || i.source}${arrow}${i.to || i.destination})${failedTag}`;
        case 'tomAi_applyEdit':
            return `applyEdit(${Array.isArray(i.operations) ? i.operations.length : 0} ops)${failedTag}`;
        case 'tomAi_getErrors':
        case 'tomAi_getProblems':
            return `${name.slice('tomAi_'.length)}()${result ? arrow + countOccurrences(result, /"file":/g) + ' problems' : ''}${failedTag}`;
        case 'tomAi_getActiveEditor':
        case 'tomAi_getOpenEditors':
        case 'tomAi_getWorkspaceInfo':
            return `${name.slice('tomAi_'.length)}()${result ? arrow + truncate(result, 120).replace(/\s+/g, ' ') : ''}${failedTag}`;
        case 'tomAi_runCommand':
            return `runCommand(\`${truncate(i.command, 60)}\`)${result ? arrow + truncate(result.replace(/\s+/g, ' '), 120) : ''}${failedTag}`;
        case 'tomAi_runVscodeCommand':
        case 'tomAi_vscode':
            return `${name.slice('tomAi_'.length)}(${i.command})${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_runCommandStream':
            return `runCommandStream(\`${truncate(i.command, 60)}\`)${result ? arrow + 'handle issued' : ''}${failedTag}`;
        case 'tomAi_readCommandOutput':
            return `readCommandOutput(${i.handle})${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_killCommand':
            return `killCommand(${i.handle}, ${i.signal ?? 'SIGTERM'})${failedTag}`;
        case 'tomAi_fetchWebpage':
            return `fetchWebpage(${i.url})${result ? arrow + result.length + ' chars' : ''}${failedTag}`;
        case 'tomAi_webSearch':
            return `webSearch("${truncate(i.query, 60)}")${result ? arrow + countOccurrences(result, /\n/g) + ' results' : ''}${failedTag}`;
        case 'tomAi_git':
            return `git ${i.subcommand}${Array.isArray(i.args) ? ' ' + i.args.join(' ') : ''}${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_gitShow':
            return `gitShow(${i.ref}${i.filePath ? ':' + i.filePath : ''})${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_gitExec':
            return `gitExec ${i.subcommand}${Array.isArray(i.args) ? ' ' + i.args.join(' ') : ''}${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_findSymbol':
            return `findSymbol("${i.query}")${result ? arrow + countOccurrences(result, /"name":/g) + ' symbols' : ''}${failedTag}`;
        case 'tomAi_gotoDefinition':
            return `gotoDefinition(${i.filePath}:${i.line}:${i.character})${result ? arrow + countOccurrences(result, /"file":/g) + ' locations' : ''}${failedTag}`;
        case 'tomAi_findReferences':
            return `findReferences(${i.filePath}:${i.line}:${i.character})${result ? arrow + countOccurrences(result, /"file":/g) + ' refs' : ''}${failedTag}`;
        case 'tomAi_getCodeActions':
        case 'tomAi_getCodeActionsCached':
            return `${name.slice('tomAi_'.length)}(${i.filePath}:${i.startLine}:${i.startCharacter})${result ? arrow + countOccurrences(result, /"title":/g) + ' actions' : ''}${failedTag}`;
        case 'tomAi_applyCodeAction':
            return `applyCodeAction(${i.actionId})${failedTag}`;
        case 'tomAi_rename':
            return `rename(${i.filePath}:${i.line}:${i.character}${arrow}"${i.newName}")${failedTag}`;
        case 'tomAi_runTask':
            return `runTask("${i.name}")${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_runDebugConfig':
            return `runDebugConfig("${i.configName}")${failedTag}`;
        case 'tomAi_memory_read':
        case 'tomAi_memory_list':
        case 'tomAi_memory_save':
        case 'tomAi_memory_update':
        case 'tomAi_memory_forget':
            return `${name.slice('tomAi_'.length)}(${safeJson(i, 80)})${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_chatvar_read':
            return `chatvar_read(${i.name || i.key})${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_chatvar_write':
            return `chatvar_write(${i.name || i.key}=${truncate(String(i.value), 60)})${failedTag}`;
        case 'tomAi_askBigBrother':
        case 'tomAi_askCopilot':
            return `${name.slice('tomAi_'.length)}(${truncate(i.prompt || i.question || '', 80)})${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_notifyUser':
            return `notifyUser(${i.urgency || 'info'}: "${truncate(i.message || '', 80)}")${failedTag}`;
        case 'tomAi_askUser':
            return `askUser("${truncate(i.prompt || '', 80)}")${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_askUserPicker':
            return `askUserPicker(${Array.isArray(i.items) ? i.items.length : 0} items)${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_listIssues':
        case 'tomAi_listTests':
            return `${name.slice('tomAi_'.length)}(${i.repoId})${result ? arrow + countOccurrences(result, /"number":/g) + ' items' : ''}${failedTag}`;
        case 'tomAi_getIssue':
        case 'tomAi_getTest':
            return `${name.slice('tomAi_'.length)}(${i.repoId} #${i.issueNumber})${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        case 'tomAi_listGuidelines':
        case 'tomAi_searchGuidelines':
        case 'tomAi_listPatternPrompts':
        case 'tomAi_readPatternPrompt':
            return `${name.slice('tomAi_'.length)}(${safeJson(i, 80)})${result ? arrow + truncate(result, 120) : ''}${failedTag}`;
        default: {
            // Fallback: JSON input + truncated result
            const head = `${name}(${safeJson(input, 200)})`;
            if (result === undefined) { return head; }
            return `${head}\n  → ${truncate(result, 500)}${failedTag}`;
        }
    }
}

// ---------------------------------------------------------------------------
// Public logging API — called from anthropic-handler.ts
// ---------------------------------------------------------------------------

export function logTurnStart(info: {
    requestId: string;
    transport: string;
    model: string;
    systemPromptLength: number;
    userText: string;
}): void {
    operations().appendLine('');
    operations().appendLine(sep('═'.repeat(70)));
    operations().appendLine(`[${timestamp()}] TURN START — request=${info.requestId} transport=${info.transport} model=${info.model}`);
    operations().appendLine(`  system prompt: ${info.systemPromptLength} chars`);
    operations().appendLine(sep());

    responses().appendLine('');
    responses().appendLine(sep('═'.repeat(70)));
    responses().appendLine(`[${timestamp()}] USER (request=${info.requestId} via ${info.transport}, model=${info.model})`);
    responses().appendLine(sep());
    responses().appendLine(info.userText);
}

export function logToolRequest(name: string, input: Record<string, unknown>): void {
    const line = formatToolSummary(name, input);
    operations().appendLine(`[${timestamp()}] 🛠  → ${line}`);
    responses().appendLine(`[${timestamp()}] 🛠  ${line}`);
}

export function logToolResult(
    name: string,
    input: Record<string, unknown>,
    result: string,
    durationMs: number,
    error?: string,
): void {
    const line = formatToolSummary(name, input, result, error);
    const status = error ? '✗' : '✓';
    operations().appendLine(`[${timestamp()}]   ${status} ${line} (${durationMs} ms)`);
    // Responses channel already logged the request — update with result/status inline
    responses().appendLine(`[${timestamp()}]   ${status} ${truncate(result, 500)}${error ? ' [error: ' + error + ']' : ''} (${durationMs} ms)`);
}

export function logAssistantText(text: string): void {
    responses().appendLine('');
    responses().appendLine(sep());
    responses().appendLine(`[${timestamp()}] ASSISTANT`);
    responses().appendLine(sep());
    responses().appendLine(text || '(empty response)');
}

export function logThinking(text: string): void {
    if (!text) { return; }
    responses().appendLine('');
    responses().appendLine(`[${timestamp()}] THINKING`);
    responses().appendLine(sep('┄'));
    responses().appendLine(text);
}

export function logTurnEnd(info: {
    requestId: string;
    rounds: number;
    toolCallCount: number;
    stopReason?: string;
}): void {
    operations().appendLine(sep());
    operations().appendLine(`[${timestamp()}] TURN END — request=${info.requestId} rounds=${info.rounds} toolCalls=${info.toolCallCount} stop=${info.stopReason ?? 'n/a'}`);
    operations().appendLine(sep('═'.repeat(70)));

    responses().appendLine('');
    responses().appendLine(`[${timestamp()}] (turn complete — ${info.toolCallCount} tool calls, ${info.rounds} rounds, stop=${info.stopReason ?? 'n/a'})`);
    responses().appendLine(sep('═'.repeat(70)));
}

export function logCompactionStart(info: { requestId: string; historyEntries: number }): void {
    operations().appendLine(`[${timestamp()}] compaction: start (request=${info.requestId}, history=${info.historyEntries} entries)`);
}

export function logCompactionEnd(info: { requestId: string; outcome: string }): void {
    operations().appendLine(`[${timestamp()}] compaction: end (request=${info.requestId}, outcome=${info.outcome})`);
}

export function logMemoryExtraction(info: { requestId: string; mode: string; outcome: string }): void {
    operations().appendLine(`[${timestamp()}] memory: ${info.mode} — ${info.outcome} (request=${info.requestId})`);
}

export function logApprovalGate(info: { toolName: string; decision: 'approved' | 'denied' | 'auto' | 'session'; }): void {
    operations().appendLine(`[${timestamp()}] approval: ${info.toolName} — ${info.decision}`);
}

export function logError(message: string, error?: unknown): void {
    const detail = error instanceof Error ? error.message : (error !== undefined ? String(error) : '');
    operations().appendLine(`[${timestamp()}] ERROR: ${message}${detail ? ' — ' + detail : ''}`);
    responses().appendLine(`[${timestamp()}] ERROR: ${message}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// Utility — programmatic access for tests / diagnostics
// ---------------------------------------------------------------------------

export function showOperationsChannel(): void { operations().show(); }
export function showResponsesChannel(): void { responses().show(); }
