import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { parseDocument } from 'yaml';
import { FsUtils } from './fsUtils';
import { WsPaths } from './workspacePaths';
import { logConfigAccess } from './toolLog';
import { osLoginName } from './osUserName';
import {
    BRIDGE_MAX_RESTARTS,
    BRIDGE_REQUEST_TIMEOUT,
    BRIDGE_RESTART_DELAY,
    REMINDER_CHECK_INTERVAL,
    REMINDER_DEFAULT_TIMEOUT,
    TRAIL_DEFAULT_MAX_ENTRIES,
} from './constants';

export type CopilotConfig = Record<string, unknown>;
export type TrailConfig = Record<string, unknown>;
export type BridgeConfig = Record<string, unknown>;
export type TodoConfig = Record<string, unknown>;
export type RemindersConfig = Record<string, unknown>;
export type FavoriteEntry = Record<string, unknown>;

export interface TomAiConfigDefaults {
    userName: string;
    copilot: CopilotConfig;
    trail: TrailConfig;
    bridge: BridgeConfig;
    todo: TodoConfig;
    reminders: RemindersConfig;
    favorites: FavoriteEntry[];
}

/**
 * User-global preferences file — overlaid on top of the workspace
 * config for values that are the same across every workspace on this
 * machine (user identity, preferred model/profile defaults, bridge
 * binary paths, reusable personal templates).
 *
 * Resolution: `<homedir>/.tom/vscode/tom_vscode_extension.user.yaml`.
 * Path built via `path.join(os.homedir(), ...)` so it resolves to
 * `~/.tom/vscode/...` on Linux/macOS and `%USERPROFILE%\.tom\vscode\...`
 * on Windows without any extra handling.
 *
 * **Fallback-compatible by design** — if the file is missing, the
 * extension falls back to the existing single-file workspace config
 * and behaves exactly as before. Section keys present in the workspace
 * config still "win" (workspace > user-global); the user-global file
 * only contributes keys that the workspace config does not define.
 * This shape means the current "everything in one file" workspace
 * setup keeps working without migration.
 *
 * A documented `*.sample.yaml` file at the same path ships as part of
 * the extension examples — users rename it to `.yaml` to activate the
 * overlay. See `doc/example_user_config.yaml` for the reference copy.
 */
const USER_GLOBAL_CONFIG_REL = path.join('.tom', 'vscode', 'tom_vscode_extension.user.yaml');

function userGlobalConfigPath(): string {
    return path.join(os.homedir(), USER_GLOBAL_CONFIG_REL);
}

export class TomAiConfiguration {
    private static _instance: TomAiConfiguration | undefined;
    /** What readers see: defaults < user-global overlay < workspace file. */
    private config: Record<string, unknown> = {};
    /**
     * The workspace file's own sections, as parsed. Saves write this and
     * nothing else, so the file never gains a default or an overlay section it
     * did not have — which would then shadow the overlay for good.
     */
    private workspace: Record<string, unknown> = {};
    /** The workspace file exists but did not parse; a save would overwrite it. */
    private workspaceUnreadable = false;
    /**
     * Raw user-global overlay as parsed from
     * `<homedir>/.tom/vscode/tom_vscode_extension.user.yaml`. Empty
     * object when the file is absent. Kept separate from `config` so
     * the overlay is re-applied on every workspace reload without
     * conflating the two sources on disk.
     */
    private userGlobal: Record<string, unknown> = {};
    /**
     * What both files looked like when `config` was built (path, mtime, ctime,
     * size of each; see `filesStamp`). Every read compares it with the files as
     * they are now and rebuilds `config` when they differ, so a hand edit — or
     * an agent's text edit — reaches every reader without a reload. Unchanged
     * files cost one stat each and are not parsed again.
     */
    private stamp: string | undefined;

    static init(context: vscode.ExtensionContext): void {
        if (!TomAiConfiguration._instance) {
            TomAiConfiguration._instance = new TomAiConfiguration();
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
            userName: osLoginName(),
            // Copilot's answer folder defaults to _ai/answers/copilot (getCopilotChatAnswerFolder) when unset.
            copilot: {
                showNotifications: true,
            },
            trail: {
                raw: {
                    enabled: true,
                    maxRawFiles: 1000,
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
                    promptsFilePattern: '${ai}/quests/${quest}/history/${quest}.${subsystem}.prompts.md',
                    answersFilePattern: '${ai}/quests/${quest}/history/${quest}.${subsystem}.answers.md',
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

    private constructor() {
        this.reload();
    }

    get configPath(): string {
        const r = this.resolveConfigPath();
        logConfigAccess('TomAiConfiguration.configPath', r.path, {
            action: 'resolve',
            branch: r.branch,
            ...(r.setting !== undefined ? { setting: r.setting } : {}),
        });
        return r.path;
    }

    /** Where the workspace config is, and why; no logging (it runs on every read). */
    private resolveConfigPath(): { path: string; branch: string; setting?: string } {
        const wsConfigPath = WsPaths.wsConfig(WsPaths.configFileName);
        if (wsConfigPath && fs.existsSync(wsConfigPath)) {
            return { path: wsConfigPath, branch: 'workspace .tom (exists)' };
        }

        const configuredPath = vscode.workspace
            .getConfiguration('tomAi')
            .get<string>('configPath');

        if (configuredPath && configuredPath.trim()) {
            return {
                path: this.resolveConfiguredPath(configuredPath.trim()),
                branch: 'tomAi.configPath setting',
                setting: configuredPath,
            };
        }

        if (wsConfigPath) {
            return { path: wsConfigPath, branch: 'workspace .tom (default target)' };
        }

        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return wsRoot
            ? { path: path.join(wsRoot, '.tom', WsPaths.configFileName), branch: 'workspace root fallback' }
            : { path: path.join(os.homedir(), '.tom', 'vscode', WsPaths.configFileName), branch: 'home fallback (no workspace)' };
    }

    /** The state of the workspace config and the user-global overlay, as one comparable string. */
    private filesStamp(): string {
        return [this.resolveConfigPath().path, userGlobalConfigPath()].map((filePath) => {
            try {
                const st = fs.statSync(filePath);
                return `${filePath}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
            } catch {
                return `${filePath}:-`;
            }
        }).join('|');
    }

    /** Rebuild `config` when either file changed since it was built. */
    private refreshIfChanged(): void {
        if (this.filesStamp() !== this.stamp) { this.reload(); }
    }

    getCopilot(): CopilotConfig { return this.getSection<CopilotConfig>('copilot') ?? {}; }
    getTrail(): TrailConfig { return this.getSection<TrailConfig>('trail') ?? {}; }
    getBridge(): BridgeConfig { return this.getSection<BridgeConfig>('bridge') ?? {}; }
    getTodo(): TodoConfig { return this.getSection<TodoConfig>('todo') ?? {}; }
    getReminders(): RemindersConfig { return this.getSection<RemindersConfig>('reminders') ?? {}; }
    getFavorites(): FavoriteEntry[] { return this.getSection<FavoriteEntry[]>('favorites') ?? []; }

    async saveCopilot(config: CopilotConfig): Promise<void> { await this.updateSection('copilot', config); }
    async saveTrail(config: TrailConfig): Promise<void> { await this.updateSection('trail', config); }
    async saveBridge(config: BridgeConfig): Promise<void> { await this.updateSection('bridge', config); }
    async saveTodo(config: TodoConfig): Promise<void> { await this.updateSection('todo', config); }
    async saveReminders(config: RemindersConfig): Promise<void> { await this.updateSection('reminders', config); }
    async saveFavorites(favorites: FavoriteEntry[]): Promise<void> { await this.updateSection('favorites', favorites); }

    getSection<T>(key: string): T | undefined {
        this.refreshIfChanged();
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
        // Why: the workspace file is written back whole, so a hand edit not read
        // yet would otherwise be overwritten with the copy from before it.
        this.refreshIfChanged();
        if (this.workspaceUnreadable) {
            throw new Error(`Not saved: ${this.configPath} does not parse; fix the file first, then save again.`);
        }
        this.workspace = { ...this.workspace, [key]: value };
        this.config = this.mergeConfig(this.workspace);
        await this.persistConfig();
    }

    reload(): void {
        // Taken before the reads: a change while they run makes the next read reload again.
        this.stamp = this.filesStamp();
        this.userGlobal = this.loadUserGlobal();
        this.workspace = {};
        this.workspaceUnreadable = false;

        const filePath = this.configPath;
        if (!FsUtils.fileExists(filePath)) {
            logConfigAccess('TomAiConfiguration.reload', filePath, {
                action: 'missing',
                note: 'file does not exist — using defaults',
            });
            this.config = this.mergeConfig({});
            return;
        }

        const raw = FsUtils.safeReadFile(filePath);
        if (!raw) {
            logConfigAccess('TomAiConfiguration.reload', filePath, {
                action: 'read-failed',
                note: 'file present but unreadable/empty — using defaults',
            });
            this.config = this.mergeConfig({});
            return;
        }

        const parsed = this.parseConfig(raw, filePath);
        if (!parsed) {
            logConfigAccess('TomAiConfiguration.reload', filePath, {
                action: 'parse-failed',
                note: 'file does not parse — using defaults; saves are refused until it does',
            });
            this.workspaceUnreadable = true;
            this.config = this.mergeConfig({});
            return;
        }
        logConfigAccess('TomAiConfiguration.reload', filePath, {
            action: 'loaded',
            note: `${raw.length} bytes`,
        });
        this.workspace = parsed;
        this.config = this.mergeConfig(parsed);
    }

    /**
     * Layer the three sources — `defaults < user-global < workspace` —
     * at the section level. Per-section values from the workspace
     * config win because they reflect an explicit choice for *this*
     * project; the user-global file only contributes sections the
     * workspace config leaves unset. This keeps the existing
     * single-file workspace setup working as-is: everything in one
     * workspace file behaves identically whether the user-global file
     * is present or not.
     */
    private mergeConfig(workspace: Record<string, unknown>): Record<string, unknown> {
        const merged: Record<string, unknown> = { ...TomAiConfiguration.defaults };
        for (const [key, value] of Object.entries(this.userGlobal)) {
            if (value !== undefined) { merged[key] = value; }
        }
        for (const [key, value] of Object.entries(workspace)) {
            if (value !== undefined) { merged[key] = value; }
        }
        return merged;
    }

    /** Read the user-global overlay file. Returns `{}` when absent. */
    private loadUserGlobal(): Record<string, unknown> {
        const filePath = userGlobalConfigPath();
        if (!FsUtils.fileExists(filePath)) { return {}; }
        const raw = FsUtils.safeReadFile(filePath);
        if (!raw) { return {}; }
        return this.parseConfig(raw, filePath) ?? {};
    }

    /** Absolute path to the user-global overlay file (whether it exists or not). */
    get userGlobalConfigPath(): string {
        return userGlobalConfigPath();
    }

    /** `true` iff the user-global overlay file is present on disk. */
    hasUserGlobalConfig(): boolean {
        return FsUtils.fileExists(userGlobalConfigPath());
    }

    async createDefaultConfig(): Promise<void> {
        this.workspace = { ...TomAiConfiguration.defaults };
        this.workspaceUnreadable = false;
        this.config = this.mergeConfig(this.workspace);
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
            FsUtils.safeWriteYaml(filePath, this.workspace);
        } else {
            FsUtils.safeWriteJson(filePath, this.workspace, 2);
        }
        // The file now holds `workspace` and `config` is built from it: no need to parse it back.
        this.stamp = this.filesStamp();
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
