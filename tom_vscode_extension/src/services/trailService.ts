import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { FsUtils } from '../utils/fsUtils';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';
import { WsPaths } from '../utils/workspacePaths';

export type TrailSubsystem =
    | { type: 'localLlm'; configName: string }
    | { type: 'copilot' }
    | { type: 'lmApi'; model: string }
    | { type: 'anthropic' };

export interface TrailMetadata {
    requestId?: string;
    model?: string;
    [key: string]: unknown;
}

interface RawTrailConfig {
    enabled?: boolean;
    maxEntries?: number;
    stripThinking?: boolean;
    paths?: {
        localLlm?: string;
        copilot?: string;
        lmApi?: string;
        anthropic?: string;
    };
}

interface SummaryTrailConfig {
    enabled?: boolean;
    promptsFilePattern?: string;
    answersFilePattern?: string;
}

export class TrailService {
    private static _instance: TrailService | undefined;
    private readonly context: vscode.ExtensionContext;

    static init(context: vscode.ExtensionContext): void {
        if (!TrailService._instance) {
            TrailService._instance = new TrailService(context);
        }
    }

    static get instance(): TrailService {
        if (!TrailService._instance) {
            throw new Error('TrailService not initialized. Call TrailService.init(context) first.');
        }
        return TrailService._instance;
    }

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    writeRawPrompt(subsystem: TrailSubsystem, prompt: string, windowId: string, requestId?: string, questId?: string): void {
        this.writeRaw(subsystem, 'prompt', prompt, windowId, 'md', requestId, questId);
    }

    writeRawAnswer(subsystem: TrailSubsystem, answer: string, windowId: string, requestId?: string, questId?: string): void {
        this.writeRaw(subsystem, 'answer', answer, windowId, 'json', requestId, questId);
    }

    writeRawToolRequest(subsystem: TrailSubsystem, request: object, windowId: string, questId?: string): void {
        this.writeRaw(subsystem, 'tool_request', JSON.stringify(request, null, 2), windowId, 'json', undefined, questId);
    }

    writeRawToolAnswer(subsystem: TrailSubsystem, response: object, windowId: string, questId?: string): void {
        this.writeRaw(subsystem, 'tool_answer', JSON.stringify(response, null, 2), windowId, 'json', undefined, questId);
    }

    writeSummaryPrompt(subsystem: TrailSubsystem, corePrompt: string, questId?: string): void {
        if (!this.getSummaryConfig().enabled) {
            return;
        }
        const target = this.resolveSummaryFile('prompts', subsystem, questId);
        if (!target) {
            return;
        }
        FsUtils.ensureDir(path.dirname(target));

        const metadata = this.extractPromptMetadata(corePrompt);
        const requestId = metadata.requestId || this.generateRequestId();
        const sequence = this.parseSequenceFromFile(target) + 1;
        const timestamp = new Date().toISOString();
        const entry =
            `=== PROMPT ${requestId} ${timestamp} ${sequence} ===\n\n` +
            `${metadata.prompt}\n\n` +
            `TEMPLATE: ${metadata.templateName || '(none)'}\n` +
            `ANSWER-WRAPPER: ${metadata.answerWrapper || 'no'}\n\n`;
        this.prependEntry(target, entry);
        this.trimTrailFile(target, this.getMaxSummaryEntries());
    }

    writeSummaryAnswer(subsystem: TrailSubsystem, answer: string, metadata?: TrailMetadata, questId?: string): void {
        if (!this.getSummaryConfig().enabled) {
            return;
        }
        const target = this.resolveSummaryFile('answers', subsystem, questId);
        if (!target) {
            return;
        }
        FsUtils.ensureDir(path.dirname(target));

        const requestId = typeof metadata?.requestId === 'string' && metadata.requestId.trim().length > 0
            ? metadata.requestId.trim()
            : this.generateRequestId();
        const sequence = this.parseSequenceFromFile(target) + 1;
        const timestamp = new Date().toISOString();

        let payload = answer;
        if (subsystem.type === 'copilot') {
            const metadataBlock: string[] = [];

            const comments = metadata && typeof metadata.comments === 'string' ? metadata.comments : undefined;
            if (comments && comments.trim().length > 0) {
                metadataBlock.push(`comments: ${comments.trim()}`);
            }

            const references = metadata?.references;
            if (Array.isArray(references) && references.length > 0) {
                metadataBlock.push(`references:\n${references.map((r) => ` - ${String(r)}`).join('\n')}`);
            }

            const attachments = metadata?.requestedAttachments;
            if (Array.isArray(attachments) && attachments.length > 0) {
                metadataBlock.push(`requestFileAttachments:\n${attachments.map((a) => ` - ${String(a)}`).join('\n')}`);
            }

            const responseValues = metadata?.responseValues;
            if (responseValues && typeof responseValues === 'object') {
                const pairs = Object.entries(responseValues as Record<string, unknown>)
                    .filter(([k, v]) => k && v !== undefined && v !== null)
                    .map(([k, v]) => ` - ${k} = ${String(v)}`);
                if (pairs.length > 0) {
                    metadataBlock.push(`variables:\n${pairs.join('\n')}`);
                }
            }

            if (metadataBlock.length > 0) {
                payload = `${answer}\n\n${metadataBlock.join('\n\n')}`;
            }
        } else if (metadata && Object.keys(metadata).length > 0) {
            payload = `### metadata\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n${answer}`;
        }

        const entry =
            `=== ANSWER ${requestId} ${timestamp} ${sequence} ===\n\n` +
            `${payload}\n\n`;
        this.prependEntry(target, entry);
        this.trimTrailFile(target, this.getMaxSummaryEntries());
    }

    isEnabled(): boolean {
        return this.getRawConfig().enabled !== false;
    }

    toggle(): void {
        const cfg = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
        const raw = ((cfg.raw ?? {}) as Record<string, unknown>);
        const current = raw.enabled !== false;
        raw.enabled = !current;
        cfg.raw = raw;
        void TomAiConfiguration.instance.saveTrail(cfg);
    }

    getSubsystemPath(subsystem: TrailSubsystem, questId?: string): string {
        const base = this.resolveRawBasePath(subsystem);
        const quest = questId || WsPaths.getWorkspaceQuestId();
        return this.resolvePathTokens(base, {
            subsystem: this.getSubsystemName(subsystem),
            quest,
        });
    }

    private writeRaw(subsystem: TrailSubsystem, kind: string, content: string, windowId: string, ext: 'md' | 'json', requestId?: string, questId?: string): void {
        const raw = this.getRawConfig();
        if (raw.enabled === false) {
            return;
        }

        const base = this.getSubsystemPath(subsystem, questId);
        FsUtils.ensureDir(base);

        const safeContent = raw.stripThinking
            ? content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim()
            : content;

        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}${String(now.getMilliseconds()).padStart(3, '0')}`;
        const exchangeId = requestId && requestId.trim().length > 0 ? requestId : windowId;
        const fileName = kind === 'prompt'
            ? `${ts}_prompt_${exchangeId}.userprompt.md`
            : kind === 'answer'
                ? `${ts}_answer_${exchangeId}.answer.json`
                : `${ts}_${kind}_${windowId}.${ext}`;
        const filePath = path.join(base, fileName);
        FsUtils.ensureDir(path.dirname(filePath));
        if (ext === 'json') {
            const parsed = kind === 'answer'
                ? { requestId: exchangeId, generatedMarkdown: safeContent }
                : (() => {
                    try {
                        return JSON.parse(safeContent);
                    } catch {
                        return { content: safeContent };
                    }
                })();
            FsUtils.safeWriteJson(filePath, parsed);
        } else {
            fs.writeFileSync(filePath, safeContent, 'utf-8');
        }
    }

    private getRawConfig(): RawTrailConfig {
        const trail = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
        const raw = (trail.raw ?? trail) as RawTrailConfig;
        return {
            enabled: raw.enabled !== false,
            maxEntries: typeof raw.maxEntries === 'number' && raw.maxEntries > 0 ? raw.maxEntries : 1000,
            stripThinking: raw.stripThinking === true,
            paths: {
                localLlm: raw.paths?.localLlm ?? '${ai}/trail/localllm/${quest}',
                copilot: raw.paths?.copilot ?? '${ai}/trail/copilot/${quest}',
                lmApi: raw.paths?.lmApi ?? '${ai}/trail/lm-api/${quest}',
                anthropic: raw.paths?.anthropic ?? '${ai}/trail/anthropic/${quest}',
            },
        };
    }

    private getSummaryConfig(): SummaryTrailConfig {
        const trail = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
        const summary = (trail.summary ?? {}) as SummaryTrailConfig;
        return {
            enabled: summary.enabled !== false,
            promptsFilePattern: summary.promptsFilePattern ?? '${ai}/quests/${quest}/${quest}.${subsystem}.prompts.md',
            answersFilePattern: summary.answersFilePattern ?? '${ai}/quests/${quest}/${quest}.${subsystem}.answers.md',
        };
    }

    private resolveRawBasePath(subsystem: TrailSubsystem): string {
        const raw = this.getRawConfig();
        // Raw trail paths now include ${quest} for quest-scoped isolation
        let base: string;
        switch (subsystem.type) {
            case 'localLlm':
                base = raw.paths?.localLlm ?? '${ai}/trail/localllm/${quest}';
                break;
            case 'copilot':
                base = raw.paths?.copilot ?? '${ai}/trail/copilot/${quest}';
                break;
            case 'anthropic':
                base = raw.paths?.anthropic ?? '${ai}/trail/anthropic/${quest}';
                break;
            case 'lmApi':
            default:
                base = raw.paths?.lmApi ?? '${ai}/trail/lm-api/${quest}';
                break;
        }

        const suffix = subsystem.type === 'localLlm'
            ? `-${subsystem.configName}`
            : subsystem.type === 'lmApi'
                ? `-${subsystem.model}`
                : '';

        return `${base}${suffix}`;
    }

    /** Resolve the summary file path for external callers. */
    getSummaryFilePath(kind: 'prompts' | 'answers', subsystem: TrailSubsystem, questId?: string): string | undefined {
        return this.resolveSummaryFile(kind, subsystem, questId);
    }

    private resolveSummaryFile(kind: 'prompts' | 'answers', subsystem: TrailSubsystem, questId?: string): string | undefined {
        const cfg = this.getSummaryConfig();
        const pattern = kind === 'prompts' ? cfg.promptsFilePattern : cfg.answersFilePattern;
        if (!pattern) {
            return undefined;
        }

        return this.resolvePathTokens(pattern, {
            subsystem: this.getSubsystemName(subsystem),
            quest: questId ?? 'default',
        });
    }

    private resolvePathTokens(input: string, vars: Record<string, string>): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const aiFolder = vscode.workspace.getConfiguration('tomAi').get<string>('aiFolder')
            || vscode.workspace.getConfiguration('tomAi').get<string>('aiFolder')
            || '_ai';

        const replaced = input
            .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
            .replace(/\$\{ai\}/g, path.join(workspaceRoot, aiFolder))
            .replace(/\$\{username\}/g, process.env.USER ?? process.env.USERNAME ?? 'user')
            .replace(/\$\{home\}/g, process.env.HOME ?? '')
            .replace(/\$\{quest\}/g, vars.quest ?? 'default')
            .replace(/\$\{subsystem\}/g, vars.subsystem ?? 'copilot');

        if (path.isAbsolute(replaced)) {
            return replaced;
        }

        return path.join(workspaceRoot, replaced);
    }

    private prependEntry(filePath: string, entry: string): void {
        const previous = FsUtils.safeReadFile(filePath);
        fs.writeFileSync(filePath, entry + (previous || ''), 'utf-8');
    }

    private parseSequenceFromFile(filePath: string): number {
        if (!fs.existsSync(filePath)) {
            return 0;
        }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const firstLine = content.split('\n')[0] || '';
            const match = firstLine.match(/===\s+(?:PROMPT|ANSWER)\s+\S+\s+\S+\s+(\d+)\s+===/);
            return match ? parseInt(match[1], 10) : 0;
        } catch {
            return 0;
        }
    }

    private trimTrailFile(filePath: string, maxEntries: number): void {
        if (!fs.existsSync(filePath)) {
            return;
        }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const firstLine = content.split('\n')[0] || '';
            const match = firstLine.match(/===\s+(?:PROMPT|ANSWER)\s+\S+\s+\S+\s+(\d+)\s+===/);
            const currentSeq = match ? parseInt(match[1], 10) : 0;
            if (currentSeq <= maxEntries) {
                return;
            }
            const lines = content.split('\n');
            let lastEntryStart = -1;
            for (let i = lines.length - 1; i >= 0; i--) {
                if (/^===\s+(?:PROMPT|ANSWER)/.test(lines[i])) {
                    lastEntryStart = i;
                    break;
                }
            }
            if (lastEntryStart > 0) {
                const trimmed = lines.slice(0, lastEntryStart).join('\n').trimEnd() + '\n';
                fs.writeFileSync(filePath, trimmed, 'utf-8');
            }
        } catch {
            // ignore trim failures
        }
    }

    private getMaxSummaryEntries(): number {
        return this.getRawConfig().maxEntries ?? 1000;
    }

    private generateRequestId(): string {
        const hex = () => Math.random().toString(16).substring(2, 10);
        return `${hex()}_${hex()}`;
    }

    private extractPromptMetadata(corePrompt: string): { prompt: string; templateName: string; answerWrapper: string; requestId?: string } {
        const lines = corePrompt.split('\n');
        let templateName = '(none)';
        let answerWrapper = 'no';
        let requestId: string | undefined;
        let promptEnd = lines.length;

        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('REQUEST-ID:')) {
                requestId = line.substring('REQUEST-ID:'.length).trim();
                promptEnd = i;
                continue;
            }
            if (line.startsWith('ANSWER-WRAPPER:')) {
                answerWrapper = line.substring('ANSWER-WRAPPER:'.length).trim() || 'no';
                promptEnd = i;
                continue;
            }
            if (line.startsWith('TEMPLATE:')) {
                templateName = line.substring('TEMPLATE:'.length).trim() || '(none)';
                promptEnd = i;
                continue;
            }
            if (line.length === 0 && promptEnd !== lines.length) {
                promptEnd = i;
                continue;
            }
            if (promptEnd !== lines.length) {
                break;
            }
        }

        const prompt = lines.slice(0, promptEnd).join('\n').trimEnd();
        return { prompt, templateName, answerWrapper, requestId };
    }

    private getSubsystemName(subsystem: TrailSubsystem): string {
        if (subsystem.type === 'copilot') {
            return 'copilot';
        }
        if (subsystem.type === 'localLlm') {
            return `localllm-${subsystem.configName}`;
        }
        if (subsystem.type === 'anthropic') {
            return 'anthropic';
        }
        return `lm-api-${subsystem.model}`;
    }
}
