/**
 * Tom AI Compaction and Memory Extraction — output channel.
 *
 * Dedicated log for every history-compaction and memory-extraction call.
 * Writes compact, human-readable lines: which template was used, which LLM
 * configuration, turn counts + char totals before/after, memory write
 * targets. The corresponding raw prompts/answers live under
 * `_ai/trail/anthropic/<quest>/compaction/` and `.../memory/` — this channel
 * is the index, not the archive.
 *
 * Intentionally terse: one-call-per-line for overview, plus a few
 * multi-line blocks for settings when they matter. Avoids flooding the
 * channel during normal operation so a "dry run" diagnostic stays
 * readable.
 */

import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
    if (!_channel) {
        _channel = vscode.window.createOutputChannel('Tom AI Compaction and Memory Extraction');
    }
    return _channel;
}

function ts(): string {
    const d = new Date();
    return d.toISOString().slice(11, 23);
}

/** Show the channel, typically when the user presses "Dry run". */
export function showCompactionChannel(): void {
    channel().show(true);
}

/** Dispose on extension shutdown (rare path). */
export function disposeCompactionChannel(): void {
    _channel?.dispose();
    _channel = undefined;
}

// ============================================================================
// Structured events
// ============================================================================

export interface CompactionStartInfo {
    mode: string;
    provider: 'anthropic' | 'localLlm';
    configId: string;
    model?: string;
    templateId?: string;
    templateName?: string;
    turnCount: number;
    totalChars: number;
    /** ~ rough token estimate for the *input* history (chars/4). */
    estimatedTokens?: number;
    /** Optional rough percentage of the target model's context window
     *  that this history occupies, so the user can see whether to
     *  compact. Computed by caller when a model context limit is known. */
    contextWindowPct?: number;
    maxHistoryTokens?: number;
    maxRounds?: number;
    fullTrailMaxTurns?: number;
    questId?: string;
    source: string; // "post-exchange" | "dry-run" | other callers later
}

export interface CompactionEndInfo {
    keptTurnCount: number;
    droppedTurnCount: number;
    modeRun: string;
    outputChars?: number;
    /** ~ rough token estimate for the *output* history (chars/4). */
    outputTokens?: number;
    durationMs?: number;
}

export interface MemoryExtractionInfo {
    templateId?: string;
    templateName?: string;
    provider: 'anthropic' | 'localLlm';
    configId: string;
    model?: string;
    scope: 'quest' | 'shared' | 'both';
    targetFile: string;
    outputChars: number;
    questId?: string;
}

export function logCompactionStart(info: CompactionStartInfo): void {
    const ch = channel();
    const tokenBlurb = info.estimatedTokens !== undefined
        ? `  ~${info.estimatedTokens}tok` + (info.contextWindowPct !== undefined ? ` (${info.contextWindowPct.toFixed(1)}% of ctx)` : '')
        : '';
    ch.appendLine(
        `[${ts()}] compaction start  mode=${info.mode}  source=${info.source}  ` +
        `turns=${info.turnCount}  chars=${info.totalChars}${tokenBlurb}  ` +
        `provider=${info.provider}  config=${info.configId}` +
        (info.model ? ` (${info.model})` : '') +
        (info.templateId ? `  template=${info.templateId}` : '') +
        (info.questId ? `  quest=${info.questId}` : ''),
    );
    if (info.maxHistoryTokens !== undefined || info.maxRounds !== undefined || info.fullTrailMaxTurns !== undefined) {
        const parts: string[] = [];
        if (info.maxHistoryTokens !== undefined) { parts.push(`maxHistoryTokens=${info.maxHistoryTokens}`); }
        if (info.maxRounds !== undefined) { parts.push(`maxRounds=${info.maxRounds}`); }
        if (info.fullTrailMaxTurns !== undefined) { parts.push(`fullTrailMaxTurns=${info.fullTrailMaxTurns}`); }
        ch.appendLine(`[${ts()}]   settings: ${parts.join('  ')}`);
    }
    if (info.templateName && info.templateName !== info.templateId) {
        ch.appendLine(`[${ts()}]   template name: ${info.templateName}`);
    }
}

export function logCompactionEnd(info: CompactionEndInfo): void {
    channel().appendLine(
        `[${ts()}] compaction end    modeRun=${info.modeRun}  kept=${info.keptTurnCount}  dropped=${info.droppedTurnCount}` +
        (info.outputChars !== undefined ? `  outChars=${info.outputChars}` : '') +
        (info.outputTokens !== undefined ? `  ~${info.outputTokens}tok` : '') +
        (info.durationMs !== undefined ? `  ${info.durationMs}ms` : ''),
    );
}

export function logMemoryExtraction(info: MemoryExtractionInfo): void {
    channel().appendLine(
        `[${ts()}] memory extract    scope=${info.scope}  file=${info.targetFile}  ` +
        `outChars=${info.outputChars}  ` +
        `provider=${info.provider}  config=${info.configId}` +
        (info.model ? ` (${info.model})` : '') +
        (info.templateId ? `  template=${info.templateId}` : '') +
        (info.questId ? `  quest=${info.questId}` : ''),
    );
}

export function logMemoryWrite(file: string, bytes: number, mode: 'append' | 'write'): void {
    channel().appendLine(`[${ts()}]   memory ${mode}     ${file}  (${bytes} bytes)`);
}

export function logWarn(message: string): void {
    channel().appendLine(`[${ts()}] warn              ${message}`);
}

export function logInfo(message: string): void {
    channel().appendLine(`[${ts()}] info              ${message}`);
}

export function logError(message: string, err?: unknown): void {
    const detail = err instanceof Error ? err.message : (err !== undefined ? String(err) : '');
    channel().appendLine(`[${ts()}] ERROR             ${message}${detail ? ' — ' + detail : ''}`);
}

/**
 * Multi-line banner used by the "Dry run" action so the user can scroll
 * back and see exactly which run produced a given block of output.
 */
export function logRunBanner(title: string, lines: string[] = []): void {
    const ch = channel();
    ch.appendLine('');
    ch.appendLine(`=== ${title} @ ${ts()} ===`);
    for (const line of lines) {
        ch.appendLine(`    ${line}`);
    }
}
