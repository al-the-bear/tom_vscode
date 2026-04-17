/**
 * Diagnostics tools — Problems panel access.
 *
 * Earlier revisions also exposed `tomAi_getOutputChannel` and
 * `tomAi_getTerminalOutput`. Both were removed: VS Code has no API to read
 * third-party output channels and no terminal scrollback API, so the tools
 * couldn't provide useful output. For captured command output, use
 * `tomAi_runCommand` (fire-and-forget) or `tomAi_runCommandStream` + `tomAi_readCommandOutput`.
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
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DIAGNOSTICS_TOOLS: SharedToolDefinition<any>[] = [
    GET_PROBLEMS_TOOL,
];
