import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { FsUtils } from '../utils/fsUtils';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';

export type TrailSubsystem =
    | { type: 'localLlm'; profile: string }
    | { type: 'copilot' }
    | { type: 'lmApi'; model: string };

export interface TrailMetadata {
    requestId?: string;
    model?: string;
    [key: string]: unknown;
}

interface RawTrailConfig {
    enabled?: boolean;
    stripThinking?: boolean;
    paths?: {
        localLlm?: string;
        copilot?: string;
        lmApi?: string;
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

    writeRawPrompt(subsystem: TrailSubsystem, prompt: string, windowId: string): void {
        this.writeRaw(subsystem, 'prompt', prompt, windowId, 'md');
    }

    writeRawAnswer(subsystem: TrailSubsystem, answer: string, windowId: string): void {
        this.writeRaw(subsystem, 'answer', answer, windowId, 'md');
    }

    writeRawToolRequest(subsystem: TrailSubsystem, request: object, windowId: string): void {
        this.writeRaw(subsystem, 'tool_request', JSON.stringify(request, null, 2), windowId, 'json');
    }

    writeRawToolAnswer(subsystem: TrailSubsystem, response: object, windowId: string): void {
        this.writeRaw(subsystem, 'tool_answer', JSON.stringify(response, null, 2), windowId, 'json');
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
        this.appendWithSeparator(target, corePrompt);
    }

    writeSummaryAnswer(subsystem: TrailSubsystem, answer: string, metadata?: TrailMetadata, questId?: string): void {
        if (!this.getSummaryConfig().enabled) {
            return;
        }
        const target = this.resolveSummaryFile('answers', subsystem, questId);
        if (!target) {
            return;
        }
        const payload = metadata && Object.keys(metadata).length > 0
            ? `### metadata\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n${answer}`
            : answer;
        FsUtils.ensureDir(path.dirname(target));
        this.appendWithSeparator(target, payload);
    }

    isEnabled(): boolean {
        return this.getRawConfig().enabled === true;
    }

    toggle(): void {
        const cfg = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
        const raw = ((cfg.raw ?? {}) as Record<string, unknown>);
        const current = raw.enabled === true;
        raw.enabled = !current;
        cfg.raw = raw;
        void TomAiConfiguration.instance.saveTrail(cfg);
    }

    getSubsystemPath(subsystem: TrailSubsystem): string {
        const base = this.resolveRawBasePath(subsystem);
        return this.resolvePathTokens(base, {
            subsystem: this.getSubsystemName(subsystem),
        });
    }

    private writeRaw(subsystem: TrailSubsystem, kind: string, content: string, windowId: string, ext: 'md' | 'json'): void {
        const raw = this.getRawConfig();
        if (raw.enabled !== true) {
            return;
        }

        const base = this.getSubsystemPath(subsystem);
        FsUtils.ensureDir(base);

        const safeContent = raw.stripThinking
            ? content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim()
            : content;

        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        const fileName = `${ts}_${kind}_${windowId}.${ext}`;
        const filePath = path.join(base, fileName);
        FsUtils.ensureDir(path.dirname(filePath));
        if (ext === 'json') {
            const parsed = (() => {
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
            enabled: raw.enabled === true,
            stripThinking: raw.stripThinking === true,
            paths: {
                localLlm: raw.paths?.localLlm ?? '${ai}/trail/localllm',
                copilot: raw.paths?.copilot ?? '${ai}/trail/copilot',
                lmApi: raw.paths?.lmApi ?? '${ai}/trail/lm-api',
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
        const base = subsystem.type === 'localLlm'
            ? raw.paths?.localLlm ?? '${ai}/trail/localllm'
            : subsystem.type === 'copilot'
                ? raw.paths?.copilot ?? '${ai}/trail/copilot'
                : raw.paths?.lmApi ?? '${ai}/trail/lm-api';

        const suffix = subsystem.type === 'localLlm'
            ? `-${subsystem.profile}`
            : subsystem.type === 'lmApi'
                ? `-${subsystem.model}`
                : '';

        return this.resolvePathTokens(`${base}${suffix}`, {
            subsystem: this.getSubsystemName(subsystem),
        });
    }

    private resolveSummaryFile(kind: 'prompts' | 'answers', subsystem: TrailSubsystem, questId?: string): string | undefined {
        const cfg = this.getSummaryConfig();
        const pattern = kind === 'prompts' ? cfg.promptsFilePattern : cfg.answersFilePattern;
        if (!pattern) {
            return undefined;
        }

        return this.resolvePathTokens(pattern, {
            subsystem: this.getSubsystemName(subsystem),
            quest: questId ?? 'incidents',
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
            .replace(/\$\{quest\}/g, vars.quest ?? 'incidents')
            .replace(/\$\{subsystem\}/g, vars.subsystem ?? 'copilot');

        if (path.isAbsolute(replaced)) {
            return replaced;
        }

        return path.join(workspaceRoot, replaced);
    }

    private appendWithSeparator(filePath: string, content: string): void {
        const previous = FsUtils.safeReadFile(filePath);
        const next = previous && previous.trim().length > 0
            ? `${previous.trimEnd()}\n\n---\n\n${content}\n`
            : `${content}\n`;
        fs.writeFileSync(filePath, next, 'utf-8');
    }

    private getSubsystemName(subsystem: TrailSubsystem): string {
        if (subsystem.type === 'copilot') {
            return 'copilot';
        }
        if (subsystem.type === 'localLlm') {
            return `localllm-${subsystem.profile}`;
        }
        return `lm-api-${subsystem.model}`;
    }
}
