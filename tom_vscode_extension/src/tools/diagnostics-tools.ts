/**
 * Diagnostics tools — Problems panel, Output channels, Terminal state.
 *
 * Two tools (`tomAi_getOutputChannel`, `tomAi_getTerminalOutput`) are limited
 * by VS Code APIs: output channels from other extensions are not readable,
 * and there is no terminal scrollback API. The descriptions steer callers to
 * `tomAi_runCommand` / `tomAi_runCommandStream` when captured output is
 * actually needed.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toRelative(uri: vscode.Uri): string {
    const root = wsRoot();
    if (!root) { return uri.fsPath; }
    const rel = path.relative(root, uri.fsPath);
    return rel.startsWith('..') ? uri.fsPath : rel;
}

function severityName(s: vscode.DiagnosticSeverity): string {
    switch (s) {
        case vscode.DiagnosticSeverity.Error: return 'error';
        case vscode.DiagnosticSeverity.Warning: return 'warning';
        case vscode.DiagnosticSeverity.Information: return 'information';
        case vscode.DiagnosticSeverity.Hint: return 'hint';
        default: return 'unknown';
    }
}

function severityFromName(name: string | undefined): vscode.DiagnosticSeverity | undefined {
    switch ((name || '').toLowerCase()) {
        case 'error': return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'information':
        case 'info': return vscode.DiagnosticSeverity.Information;
        case 'hint': return vscode.DiagnosticSeverity.Hint;
        default: return undefined;
    }
}

// ---------------------------------------------------------------------------
// tomAi_getProblems
// ---------------------------------------------------------------------------

interface GetProblemsInput {
    filePath?: string;
    severity?: 'error' | 'warning' | 'information' | 'hint';
    source?: string;
    maxResults?: number;
}

async function executeGetProblems(input: GetProblemsInput): Promise<string> {
    const minSeverity = severityFromName(input.severity);
    const maxResults = Math.max(1, input.maxResults ?? 500);

    const allDiags: Array<[vscode.Uri, vscode.Diagnostic[]]> = input.filePath
        ? (() => {
            const root = wsRoot();
            const abs = path.isAbsolute(input.filePath!)
                ? input.filePath!
                : (root ? path.join(root, input.filePath!) : input.filePath!);
            const uri = vscode.Uri.file(abs);
            return [[uri, vscode.languages.getDiagnostics(uri)]];
        })()
        : vscode.languages.getDiagnostics();

    const items: Array<Record<string, unknown>> = [];
    let truncated = false;
    for (const [uri, diags] of allDiags) {
        for (const d of diags) {
            if (minSeverity !== undefined && d.severity > minSeverity) { continue; }
            if (input.source && d.source !== input.source) { continue; }
            if (items.length >= maxResults) { truncated = true; break; }
            items.push({
                file: toRelative(uri),
                absolutePath: uri.fsPath,
                severity: severityName(d.severity),
                line: d.range.start.line,
                character: d.range.start.character,
                endLine: d.range.end.line,
                endCharacter: d.range.end.character,
                message: d.message,
                source: d.source,
                code: typeof d.code === 'object' ? (d.code as any).value : d.code,
            });
        }
        if (truncated) { break; }
    }

    return JSON.stringify({ count: items.length, truncated, problems: items }, null, 2);
}

export const GET_PROBLEMS_TOOL: SharedToolDefinition<GetProblemsInput> = {
    name: 'tomAi_getProblems',
    displayName: 'Get Problems',
    description:
        'Return VS Code Problems panel entries with severity/source filtering. ' +
        'Extends tomAi_getErrors with structured output and filters.',
    tags: ['diagnostics', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'Optional file to limit to. Workspace-relative or absolute.' },
            severity: { type: 'string', enum: ['error', 'warning', 'information', 'hint'], description: 'Minimum severity (inclusive).' },
            source: { type: 'string', description: 'Filter by diagnostic source (e.g. "eslint", "ts", "dart").' },
            maxResults: { type: 'number', description: 'Cap on number of returned items. Default 500.' },
        },
    },
    execute: executeGetProblems,
};

// ---------------------------------------------------------------------------
// tomAi_getOutputChannel — minimal (third-party channels aren't readable via API)
// ---------------------------------------------------------------------------

interface GetOutputChannelInput { channel?: string; maxLines?: number }

async function executeGetOutputChannel(input: GetOutputChannelInput): Promise<string> {
    const registry: Record<string, string[]> = (globalThis as any).__tomAiOutputChannelRegistry ?? {};
    const names = Object.keys(registry).sort();
    if (!input.channel) {
        return JSON.stringify({
            channels: names,
            note: 'VS Code does not expose third-party output channels to other extensions. Only channels tracked by this extension are readable here.',
        }, null, 2);
    }
    const lines = registry[input.channel];
    if (!lines) {
        return JSON.stringify({
            error: `Output channel not tracked: "${input.channel}"`,
            available: names,
        }, null, 2);
    }
    const max = Math.max(1, input.maxLines ?? 500);
    const slice = lines.slice(-max);
    return JSON.stringify({ channel: input.channel, lineCount: slice.length, lines: slice }, null, 2);
}

export const GET_OUTPUT_CHANNEL_TOOL: SharedToolDefinition<GetOutputChannelInput> = {
    name: 'tomAi_getOutputChannel',
    displayName: 'Get Output Channel',
    description:
        'Read recent lines from an extension-tracked Output panel channel. ' +
        'Without a channel parameter, lists available tracked channels. ' +
        'Note: VS Code does not expose third-party output channels across extensions; only channels the Tom extension tracks are accessible.',
    tags: ['output', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            channel: { type: 'string', description: 'Name of a tracked output channel. Omit to list available channels.' },
            maxLines: { type: 'number', description: 'Max trailing lines to return. Default 500.' },
        },
    },
    execute: executeGetOutputChannel,
};

// ---------------------------------------------------------------------------
// tomAi_getTerminalOutput — limited (VS Code has no scrollback API)
// ---------------------------------------------------------------------------

interface GetTerminalOutputInput { name?: string }

async function executeGetTerminalOutput(input: GetTerminalOutputInput): Promise<string> {
    const terminals = vscode.window.terminals.map((t) => {
        const anyT: any = t;
        return {
            name: t.name,
            active: t === vscode.window.activeTerminal,
            processId: undefined as number | undefined,
            exitStatus: anyT.exitStatus ? { code: anyT.exitStatus.code } : undefined,
            hasShellIntegration: !!anyT.shellIntegration,
        };
    });

    await Promise.all(
        vscode.window.terminals.map(async (t, idx) => {
            try { terminals[idx].processId = await t.processId; } catch { /* ignore */ }
        }),
    );

    if (input.name) {
        const match = terminals.find((t) => t.name === input.name);
        if (!match) {
            return JSON.stringify({ error: `Terminal not found: "${input.name}"`, available: terminals.map((t) => t.name) });
        }
        return JSON.stringify({
            terminal: match,
            note: 'VS Code exposes terminal metadata but not scrollback. Use shell integration or tomAi_runCommand for command output capture.',
        }, null, 2);
    }

    return JSON.stringify({
        count: terminals.length,
        terminals,
        note: 'VS Code exposes terminal metadata but not scrollback. To capture command output, use tomAi_runCommand (captures stdout/stderr directly).',
    }, null, 2);
}

export const GET_TERMINAL_OUTPUT_TOOL: SharedToolDefinition<GetTerminalOutputInput> = {
    name: 'tomAi_getTerminalOutput',
    displayName: 'Get Terminal Output',
    description:
        'List open terminals and their exit status / shell integration state. ' +
        'Note: VS Code has no API for terminal scrollback. Use tomAi_runCommand when you need captured command output.',
    tags: ['terminal', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Optional terminal name to focus on.' },
        },
    },
    execute: executeGetTerminalOutput,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DIAGNOSTICS_TOOLS: SharedToolDefinition<any>[] = [
    GET_PROBLEMS_TOOL,
    GET_OUTPUT_CHANNEL_TOOL,
    GET_TERMINAL_OUTPUT_TOOL,
];
