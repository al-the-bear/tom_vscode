import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TrailService, TrailMetadata, TrailSubsystem } from './trailService';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';

export type TrailType = 'local' | 'copilot' | 'conversation' | 'tomai';

function sanitizeSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getWindowId(): string {
    const session = vscode.env.sessionId.substring(0, 8);
    const machine = vscode.env.machineId.substring(0, 8);
    return `${session}_${machine}`;
}

function mapTypeToSubsystem(type: string, target?: string, metadata: TrailMetadata = {}): TrailSubsystem {
    const targetLower = (target ?? '').toLowerCase();

    if (type === 'copilot' || targetLower.includes('copilot')) {
        return { type: 'copilot' };
    }

    if (type === 'local') {
        return {
            type: 'localLlm',
            configName: sanitizeSegment(String(metadata.llmConfigKey ?? metadata.profile ?? target ?? 'default')),
        };
    }

    return {
        type: 'lmApi',
        model: sanitizeSegment(String(metadata.model ?? target ?? 'default')),
    };
}

function getQuestId(metadata?: TrailMetadata): string | undefined {
    const value = metadata?.questId;
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function toMetadataObject(systemPrompt?: string, metadata?: TrailMetadata): TrailMetadata | undefined {
    const result: TrailMetadata = {
        ...(metadata ?? {}),
    };
    if (systemPrompt && systemPrompt.trim().length > 0) {
        result.systemPrompt = systemPrompt;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function getTrailRootPath(): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        return path.join(process.env.HOME ?? '', '_ai', 'trail');
    }

    const aiFolder = vscode.workspace.getConfiguration('tomAi').get<string>('aiFolder') || '_ai';
    return path.join(workspaceRoot, aiFolder, 'trail');
}

export function isTrailEnabled(): boolean {
    return TrailService.instance.isEnabled();
}

export function setTrailEnabled(enabled: boolean): void {
    const trail = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
    const raw = ((trail.raw ?? {}) as Record<string, unknown>);
    raw.enabled = enabled;
    trail.raw = raw;
    void TomAiConfiguration.instance.saveTrail(trail);
}

export function toggleTrail(): void {
    TrailService.instance.toggle();
}

export function toggleTrailLogging(): void {
    toggleTrail();
}

export function loadTrailConfig(): { trailEnabled: boolean } {
    return {
        trailEnabled: isTrailEnabled(),
    };
}

export function logPrompt(
    type: TrailType | string,
    target: string,
    prompt: string,
    systemPrompt?: string,
    metadata: TrailMetadata = {}
): void {
    const trailService = TrailService.instance;
    const subsystem = mapTypeToSubsystem(type, target, metadata);
    const questId = getQuestId(metadata);
    const summaryPrompt = systemPrompt && systemPrompt.trim().length > 0
        ? `${prompt}\n\n### system\n${systemPrompt}`
        : prompt;

    trailService.writeSummaryPrompt(subsystem, summaryPrompt, questId);
    const requestId = typeof metadata.requestId === 'string' ? metadata.requestId : undefined;
    trailService.writeRawPrompt(subsystem, prompt, getWindowId(), requestId);
}

export function logResponse(
    type: TrailType | string,
    target: string,
    response: string,
    _isFinal?: boolean,
    metadata: TrailMetadata = {}
): void {
    const trailService = TrailService.instance;
    const subsystem = mapTypeToSubsystem(type, target, metadata);
    const questId = getQuestId(metadata);

    trailService.writeSummaryAnswer(subsystem, response, metadata, questId);
    const requestId = typeof metadata.requestId === 'string' ? metadata.requestId : undefined;
    trailService.writeRawAnswer(subsystem, response, getWindowId(), requestId);
}

export function logContinuationPrompt(
    type: TrailType | string,
    target: string,
    messages: unknown[],
    metadata: TrailMetadata = {}
): void {
    const rendered = JSON.stringify(messages, null, 2);
    logPrompt(type, target, rendered, undefined, {
        ...metadata,
        continuation: true,
    });
}

export function logToolRequest(type: TrailType | string, toolName: string, input: unknown): void {
    const subsystem = mapTypeToSubsystem(type, toolName, { model: toolName });
    TrailService.instance.writeRawToolRequest(subsystem, {
        tool: toolName,
        input,
    }, getWindowId());
}

export function logToolResult(type: TrailType | string, toolName: string, output: unknown, error?: string): void {
    const subsystem = mapTypeToSubsystem(type, toolName, { model: toolName });
    TrailService.instance.writeRawToolAnswer(subsystem, {
        tool: toolName,
        output,
        error,
    }, getWindowId());
}

export function logCopilotAnswer(answerPath: string, data: unknown): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const metadata: TrailMetadata = { sourcePath: answerPath };
    logResponse('copilot', 'github_copilot', payload, true, metadata);
}

export async function writeTrailFile(
    filename: string,
    content: string,
    type: TrailType | string = 'local',
    target: string = '',
    metadata: TrailMetadata = {}
): Promise<void> {
    const subsystem = mapTypeToSubsystem(type, target, metadata);
    const lower = filename.toLowerCase();
    const questId = getQuestId(metadata);

    if (lower.includes('prompt')) {
        TrailService.instance.writeSummaryPrompt(subsystem, content, questId);
        return;
    }

    if (lower.includes('answer') || lower.includes('response')) {
        TrailService.instance.writeSummaryAnswer(subsystem, content, metadata, questId);
        return;
    }

    const composed = toMetadataObject(undefined, metadata);
    TrailService.instance.writeSummaryAnswer(subsystem, content, composed, questId);
}

export function openTrailFolder(): void {
    const root = getTrailRootPath();
    if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true });
    }
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(root));
}
