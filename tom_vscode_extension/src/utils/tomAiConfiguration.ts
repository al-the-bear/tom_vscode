import * as fs from 'fs';
import { getLayout, layoutWorkspaceFolder } from './workspaceLayout';
import { applyMergePatch, deepMerge, mergePatch, readConfigLayers } from './configLayers';
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
 * **The layers** (workspace layout convention § 5): compiled defaults <
 * this user-global file < the root's `.tom/tom_vscode_extension.json` < the
 * workspace folder's `.tom/tom_vscode_extension.json`, deep-merged (objects
 * merged key by key, arrays and scalars replace; `configLayers.ts`). So the
 * user-global file fills in what the shared files leave out, down to single
 * keys inside a section. A missing file is an empty layer.
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
    /** What readers see: defaults < user-global < root layer (the target) < workspace layer. */
    private config: Record<string, unknown> = {};
    /**
     * The target file's own content, as parsed: the root layer
     * (`configPath`), the one file saves write. A save applies only what
     * changed to it, so it never gains a default or a key of another layer.
     */
    private target: Record<string, unknown> = {};
    /** The target file exists but did not parse; a save would overwrite it. */
    private targetUnreadable = false;
    /**
     * The layers above the target, lowest first: the workspace folder's
     * `tom_vscode_extension.json` when it is another file than the root's
     * (a symlink to it is read once). Read only, never written.
     */
    private upperLayers: Record<string, unknown>[] = [];
    /**
     * Raw user-global overlay as parsed from
     * `<homedir>/.tom/vscode/tom_vscode_extension.user.yaml`. Empty
     * object when the file is absent.
     */
    private userGlobal: Record<string, unknown> = {};
    /**
     * What the layer files looked like when `config` was built (path, mtime,
     * ctime, size of each; see `filesStamp`). Every read compares it with the
     * files as they are now and rebuilds `config` when they differ, so a hand
     * edit — or an agent's text edit — reaches every reader without a reload.
     * Unchanged files cost one stat each and are not parsed again.
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
            copilot: {},
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

        const wsRoot = layoutWorkspaceFolder();
        return wsRoot
            ? { path: path.join(wsRoot, '.tom', WsPaths.configFileName), branch: 'workspace root fallback' }
            : { path: path.join(os.homedir(), '.tom', 'vscode', WsPaths.configFileName), branch: 'home fallback (no workspace)' };
    }

    /**
     * The layer files, lowest first: the target (the root's file, or the
     * `tomAi.configPath` file), then the workspace folder's file when the
     * target is the root layer's and the workspace folder is another level.
     */
    layerPaths(): string[] {
        const resolved = this.resolveConfigPath();
        const paths = [resolved.path];
        if (resolved.branch.startsWith('workspace .tom')) {
            for (const layer of getLayout()?.configLayers.slice(1) ?? []) {
                paths.push(path.join(layer, WsPaths.configFileName));
            }
        }
        return paths;
    }

    /** The state of the layer files and the user-global overlay, as one comparable string. */
    private filesStamp(): string {
        return [...this.layerPaths(), userGlobalConfigPath()].map((filePath) => {
            try {
                const st = fs.statSync(filePath);
                return `${filePath}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
            } catch {
                return `${filePath}:-`;
            }
        }).join('|');
    }

    /** Rebuild `config` when a file changed since it was built. */
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

    /**
     * Save one section: only what differs from the merged view goes into the
     * target file (a merge patch of `key`), applied to the file as it is on
     * disk. Keys that come only from another layer or the defaults are never
     * written into it; an unchanged section writes nothing.
     */
    async updateSection(key: string, value: unknown): Promise<void> {
        // Why: a hand edit not read yet would otherwise be overwritten with the copy from before it.
        this.refreshIfChanged();
        if (this.targetUnreadable) {
            throw new Error(`Not saved: ${this.configPath} does not parse; fix the file first, then save again.`);
        }
        const patch = mergePatch(this.config[key], value);
        if (patch === undefined) { return; }
        this.target = applyMergePatch(this.target, { [key]: patch }) as Record<string, unknown>;
        this.config = this.mergeConfig(this.target);
        await this.persistConfig();
    }

    /**
     * The shared files merged — user-global < root < workspace layer, no
     * compiled defaults: what `loadSendToChatConfig()` answers. A copy.
     */
    sharedView(): Record<string, unknown> {
        this.refreshIfChanged();
        return deepMerge(this.userGlobal, this.target, ...this.upperLayers);
    }

    /**
     * Save a whole configuration read with `sharedView()`: what differs from
     * the shared view now is applied to the target file as a merge patch.
     * False when the target does not parse (nothing written).
     */
    saveSharedView(next: Record<string, unknown>): boolean {
        const base = this.sharedView();
        if (this.targetUnreadable) { return false; }
        const patch = mergePatch(base, next);
        if (patch === undefined) { return true; }
        this.target = applyMergePatch(this.target, patch) as Record<string, unknown>;
        this.config = this.mergeConfig(this.target);
        this.writeTarget();
        return true;
    }

    reload(): void {
        // Taken before the reads: a change while they run makes the next read reload again.
        this.stamp = this.filesStamp();
        this.userGlobal = this.loadUserGlobal();
        this.target = {};
        this.targetUnreadable = false;
        this.upperLayers = [];

        const filePath = this.configPath;
        const [targetLayer, ...upper] = readConfigLayers(this.layerPaths(), (raw, p) => this.parseConfig(raw, p), undefined, (p) => FsUtils.safeReadFile(p));
        for (const layer of upper) {
            if (layer.unreadable) {
                logConfigAccess('TomAiConfiguration.reload', layer.path, {
                    action: 'parse-failed',
                    note: 'workspace layer does not parse — left out',
                });
            } else if (layer.content) {
                this.upperLayers.push(layer.content);
            }
        }

        if (!targetLayer?.exists) {
            logConfigAccess('TomAiConfiguration.reload', filePath, {
                action: 'missing',
                note: 'file does not exist — using defaults',
            });
            this.config = this.mergeConfig({});
            return;
        }
        if (targetLayer.unreadable) {
            logConfigAccess('TomAiConfiguration.reload', filePath, {
                action: 'parse-failed',
                note: 'file does not parse — using defaults; saves are refused until it does',
            });
            this.targetUnreadable = true;
            this.config = this.mergeConfig({});
            return;
        }
        if (!targetLayer.content) {
            logConfigAccess('TomAiConfiguration.reload', filePath, {
                action: 'read-failed',
                note: 'file present but unreadable/empty — using defaults',
            });
            this.config = this.mergeConfig({});
            return;
        }
        logConfigAccess('TomAiConfiguration.reload', filePath, {
            action: 'loaded',
            note: `${upper.length + 1} layer(s)`,
        });
        this.target = targetLayer.content;
        this.config = this.mergeConfig(this.target);
    }

    /**
     * Layer the sources — `defaults < user-global < target (root) < workspace
     * layer` — deep: objects merged key by key, arrays and scalars replace.
     */
    private mergeConfig(target: Record<string, unknown>): Record<string, unknown> {
        return deepMerge(TomAiConfiguration.defaults, this.userGlobal, target, ...this.upperLayers);
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
        this.target = { ...TomAiConfiguration.defaults };
        this.targetUnreadable = false;
        this.config = this.mergeConfig(this.target);
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
        this.writeTarget();
    }

    /** Write `target` to the target file (synchronously). */
    private writeTarget(): void {
        const filePath = this.configPath;
        FsUtils.ensureDir(path.dirname(filePath));

        if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
            FsUtils.safeWriteYaml(filePath, this.target);
        } else {
            FsUtils.safeWriteJson(filePath, this.target, 2);
        }
        // The file now holds `target` and `config` is built from it: no need to parse it back.
        this.stamp = this.filesStamp();
    }

    private resolveConfiguredPath(configuredPath: string): string {
        const workspaceRoot = layoutWorkspaceFolder();
        const expandedHome = configuredPath.replace(/^~(?=$|[\\/])/, os.homedir());
        const withWorkspace = workspaceRoot
            ? expandedHome.replace(/\$\{workspaceFolder\}/g, workspaceRoot)
            : expandedHome;

        const tomRoot = getLayout()?.root;
        const withRoot = tomRoot ? withWorkspace.replace(/\$\{tomRoot\}/g, tomRoot) : withWorkspace;
        return withRoot.replace(/\$\{home\}/g, os.homedir());
    }
}
