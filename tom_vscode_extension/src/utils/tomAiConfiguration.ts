import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { parseDocument } from 'yaml';
import { FsUtils } from './fsUtils';
import { WsPaths } from './workspacePaths';
import {
    BRIDGE_MAX_RESTARTS,
    BRIDGE_REQUEST_TIMEOUT,
    BRIDGE_RESTART_DELAY,
    REMINDER_CHECK_INTERVAL,
    REMINDER_DEFAULT_TIMEOUT,
    TRAIL_DEFAULT_CLEANUP_DAYS,
    TRAIL_DEFAULT_MAX_ENTRIES,
} from './constants';

export type LocalLlmConfig = Record<string, unknown>;
export type AiConversationConfig = Record<string, unknown>;
export type CopilotConfig = Record<string, unknown>;
export type TomAiChatConfig = Record<string, unknown>;
export type TrailConfig = Record<string, unknown>;
export type BridgeConfig = Record<string, unknown>;
export type TodoConfig = Record<string, unknown>;
export type RemindersConfig = Record<string, unknown>;
export type FavoriteEntry = Record<string, unknown>;

export interface TomAiConfigDefaults {
    userName: string;
    localLlm: LocalLlmConfig;
    aiConversation: AiConversationConfig;
    copilot: CopilotConfig;
    tomAiChat: TomAiChatConfig;
    trail: TrailConfig;
    bridge: BridgeConfig;
    todo: TodoConfig;
    reminders: RemindersConfig;
    favorites: FavoriteEntry[];
}

export class TomAiConfiguration {
    private static _instance: TomAiConfiguration | undefined;
    private readonly context: vscode.ExtensionContext;
    private config: Record<string, unknown> = {};

    static init(context: vscode.ExtensionContext): void {
        if (!TomAiConfiguration._instance) {
            TomAiConfiguration._instance = new TomAiConfiguration(context);
        }
    }

    static get instance(): TomAiConfiguration {
        if (!TomAiConfiguration._instance) {
            throw new Error('TomAiConfiguration not initialized. Call TomAiConfiguration.init(context) first.');
        }
        return TomAiConfiguration._instance;
    }

    static get defaults(): Readonly<TomAiConfigDefaults> {
        return {
            userName: os.userInfo().username,
            localLlm: {
                ollamaUrl: 'http://localhost:11434',
            },
            aiConversation: {
                profiles: [],
                setups: [],
                selfTalk: [],
            },
            copilot: {
                answerFolder: '${ai}/chat_replies',
                showNotifications: true,
            },
            tomAiChat: {},
            trail: {
                raw: {
                    enabled: true,
                    cleanupDays: TRAIL_DEFAULT_CLEANUP_DAYS,
                    maxEntries: TRAIL_DEFAULT_MAX_ENTRIES,
                    stripThinking: true,
                    paths: {
                        localLlm: '${ai}/trail/localllm',
                        copilot: '${ai}/trail/copilot',
                        lmApi: '${ai}/trail/lm-api',
                    },
                },
                summary: {
                    enabled: true,
                    promptsFilePattern: '${ai}/quests/${quest}/${quest}.${subsystem}.prompts.md',
                    answersFilePattern: '${ai}/quests/${quest}/${quest}.${subsystem}.answers.md',
                },
            },
            bridge: {
                requestTimeout: BRIDGE_REQUEST_TIMEOUT,
                restartDelay: BRIDGE_RESTART_DELAY,
                maxRestarts: BRIDGE_MAX_RESTARTS,
            },
            todo: {
                defaultColumns: ['backlog', 'in-progress', 'done'],
            },
            reminders: {
                templates: [],
                config: {
                    checkInterval: REMINDER_CHECK_INTERVAL,
                    defaultTimeout: REMINDER_DEFAULT_TIMEOUT,
                },
            },
            favorites: [],
        };
    }

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.reload();
    }

    get configPath(): string {
        const wsConfigPath = WsPaths.wsConfig(WsPaths.configFileName);
        if (wsConfigPath && fs.existsSync(wsConfigPath)) {
            return wsConfigPath;
        }

        const configuredPath =
            vscode.workspace.getConfiguration('tomAi').get<string>('configPath')
            || vscode.workspace.getConfiguration('dartscript').get<string>('configPath');

        if (configuredPath && configuredPath.trim()) {
            return this.resolveConfiguredPath(configuredPath.trim());
        }

        if (wsConfigPath) {
            return wsConfigPath;
        }

        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return wsRoot
            ? path.join(wsRoot, '.tom', WsPaths.configFileName)
            : path.join(os.homedir(), '.tom', 'vscode', WsPaths.configFileName);
    }

    getLocalLlm(): LocalLlmConfig { return this.getSection<LocalLlmConfig>('localLlm') ?? {}; }
    getAiConversation(): AiConversationConfig { return this.getSection<AiConversationConfig>('aiConversation') ?? {}; }
    getCopilot(): CopilotConfig { return this.getSection<CopilotConfig>('copilot') ?? {}; }
    getTomAiChat(): TomAiChatConfig { return this.getSection<TomAiChatConfig>('tomAiChat') ?? {}; }
    getTrail(): TrailConfig { return this.getSection<TrailConfig>('trail') ?? {}; }
    getBridge(): BridgeConfig { return this.getSection<BridgeConfig>('bridge') ?? {}; }
    getTodo(): TodoConfig { return this.getSection<TodoConfig>('todo') ?? {}; }
    getReminders(): RemindersConfig { return this.getSection<RemindersConfig>('reminders') ?? {}; }
    getFavorites(): FavoriteEntry[] { return this.getSection<FavoriteEntry[]>('favorites') ?? []; }

    async saveLocalLlm(config: LocalLlmConfig): Promise<void> { await this.updateSection('localLlm', config); }
    async saveAiConversation(config: AiConversationConfig): Promise<void> { await this.updateSection('aiConversation', config); }
    async saveCopilot(config: CopilotConfig): Promise<void> { await this.updateSection('copilot', config); }
    async saveTomAiChat(config: TomAiChatConfig): Promise<void> { await this.updateSection('tomAiChat', config); }
    async saveTrail(config: TrailConfig): Promise<void> { await this.updateSection('trail', config); }
    async saveBridge(config: BridgeConfig): Promise<void> { await this.updateSection('bridge', config); }
    async saveTodo(config: TodoConfig): Promise<void> { await this.updateSection('todo', config); }
    async saveReminders(config: RemindersConfig): Promise<void> { await this.updateSection('reminders', config); }
    async saveFavorites(favorites: FavoriteEntry[]): Promise<void> { await this.updateSection('favorites', favorites); }

    getSection<T>(key: string): T | undefined {
        return this.config[key] as T | undefined;
    }

    getSectionOrThrow<T>(key: string): T {
        const value = this.getSection<T>(key);
        if (value === undefined) {
            throw new Error(`Configuration section not found: ${key}`);
        }
        return value;
    }

    async updateSection(key: string, value: unknown): Promise<void> {
        this.config[key] = value;
        await this.persistConfig();
    }

    reload(): void {
        const filePath = this.configPath;
        if (!FsUtils.fileExists(filePath)) {
            this.config = { ...TomAiConfiguration.defaults };
            return;
        }

        const raw = FsUtils.safeReadFile(filePath);
        if (!raw) {
            this.config = { ...TomAiConfiguration.defaults };
            return;
        }

        const parsed = this.parseConfig(raw, filePath);
        this.config = {
            ...TomAiConfiguration.defaults,
            ...(parsed ?? {}),
        };
    }

    async createDefaultConfig(): Promise<void> {
        this.config = { ...TomAiConfiguration.defaults };
        await this.persistConfig();
    }

    private parseConfig(raw: string, filePath: string): Record<string, unknown> | undefined {
        const lower = filePath.toLowerCase();
        try {
            if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
                const doc = parseDocument(raw);
                const parsed = doc.toJSON();
                if (parsed && typeof parsed === 'object') {
                    return parsed as Record<string, unknown>;
                }
                return undefined;
            }
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return undefined;
        }
    }

    private async persistConfig(): Promise<void> {
        const filePath = this.configPath;
        FsUtils.ensureDir(path.dirname(filePath));

        if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
            FsUtils.safeWriteYaml(filePath, this.config);
            return;
        }

        FsUtils.safeWriteJson(filePath, this.config, 2);
    }

    private resolveConfiguredPath(configuredPath: string): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const expandedHome = configuredPath.replace(/^~(?=$|[\\/])/, os.homedir());
        const withWorkspace = workspaceRoot
            ? expandedHome.replace(/\$\{workspaceFolder\}/g, workspaceRoot)
            : expandedHome;

        return withWorkspace.replace(/\$\{home\}/g, os.homedir());
    }
}
