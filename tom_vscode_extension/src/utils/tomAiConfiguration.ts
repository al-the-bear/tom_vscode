import * as fs from 'fs';
import { getLayout, layoutWorkspaceFolder } from './workspaceLayout';
import { applyMergePatch, deepMerge, mergePatch, readConfigLayers } from './configLayers';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { parseDocument, stringify as stringifyYaml } from 'yaml';
import { CONFIG_PARSE_RETRY_MS, updateConfigFileLocked, type ConfigFileFormat } from './lockedConfigWrite';
import { FsUtils } from './fsUtils';
import { WsPaths } from './workspacePaths';
import { logConfigAccess } from './toolLog';
import { osLoginName } from './osUserName';
import {
    BRIDGE_MAX_RESTARTS,
    BRIDGE_REQUEST_TIMEOUT,
    BRIDGE_RESTART_DELAY,
} from './constants';
import { COMPACT_TRAIL_DEFAULT_MAX_ENTRIES } from './compactTrailTrim';

export type CopilotConfig = Record<string, unknown>;
export type TrailConfig = Record<string, unknown>;
export type BridgeConfig = Record<string, unknown>;
export type TodoConfig = Record<string, unknown>;
export type FavoriteEntry = Record<string, unknown>;

export interface TomAiConfigDefaults {
    userName: string;
    copilot: CopilotConfig;
    trail: TrailConfig;
    bridge: BridgeConfig;
    todo: TodoConfig;
    favorites: FavoriteEntry[];
    /** Where the user-global overlay is: placeholders `${home}`, `~`, `${tomRoot}`, `${workspaceFolder}`. */
    userConfigPath: string;
}

/**
 * User-global preferences file — overlaid on top of the workspace
 * config for values that are the same across every workspace on this
 * machine (user identity, preferred model/profile defaults, bridge
 * binary paths, reusable personal templates).
 *
 * Resolution: the key `userConfigPath` of the root or workspace layer, else
 * its default {@link DEFAULT_USER_CONFIG_PATH}
 * (`~/.tom/vscode/tom_vscode_extension.user.yaml`; `%USERPROFILE%\.tom\vscode\...`
 * on Windows), with the placeholders of `tomAi.configPath` resolved
 * (`${home}`, `~`, `${tomRoot}`, `${workspaceFolder}`). It is read from those
 * layers before the user-global file is loaded; setting it in the user-global
 * file itself has no effect.
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
export const DEFAULT_USER_CONFIG_PATH = '${home}/.tom/vscode/tom_vscode_extension.user.yaml';

/** One file's part of a stamp: path, mtime, ctime and size, or `-` when it is not there. */
function statEntry(filePath: string): string {
    try {
        const st = fs.statSync(filePath);
        return `${filePath}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
    } catch {
        return `${filePath}:-`;
    }
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
    /** The user-global overlay's file, resolved at the last reload (from `userConfigPath`). */
    private userConfigFile: string | undefined;

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
                compact: {
                    maxEntries: COMPACT_TRAIL_DEFAULT_MAX_ENTRIES,
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
            favorites: [],
            userConfigPath: DEFAULT_USER_CONFIG_PATH,
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
        return [...this.layerPaths(), this.userGlobalConfigPath].map(statEntry).join('|');
    }

    /** Rebuild `config` when a file changed since it was built. */
    private refreshIfChanged(): void {
        if (this.filesStamp() !== this.stamp) { this.reload(); }
    }

    getCopilot(): CopilotConfig { return this.getSection<CopilotConfig>('copilot') ?? {}; }
    getTrail(): TrailConfig { return this.getSection<TrailConfig>('trail') ?? {}; }
    getBridge(): BridgeConfig { return this.getSection<BridgeConfig>('bridge') ?? {}; }
    getTodo(): TodoConfig { return this.getSection<TodoConfig>('todo') ?? {}; }
    getFavorites(): FavoriteEntry[] { return this.getSection<FavoriteEntry[]>('favorites') ?? []; }

    async saveCopilot(config: CopilotConfig): Promise<void> { await this.updateSection('copilot', config); }
    async saveTrail(config: TrailConfig): Promise<void> { await this.updateSection('trail', config); }
    async saveBridge(config: BridgeConfig): Promise<void> { await this.updateSection('bridge', config); }
    async saveTodo(config: TodoConfig): Promise<void> { await this.updateSection('todo', config); }
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
     * target file (a merge patch of `key`), applied under the file's lock to
     * the file as it is on disk then (another window's save or a hand edit of
     * another key in between is kept). Keys that come only from another layer
     * or the defaults are never written into it; an unchanged section writes
     * nothing. A failed save is shown to the user and rejects.
     */
    async updateSection(key: string, value: unknown): Promise<void> {
        // Why: a hand edit not read yet would otherwise be overwritten with the copy from before it.
        this.refreshIfChanged();
        if (this.targetUnreadable) {
            throw this.reportSaveFailure(new Error(`Not saved: ${this.configPath} does not parse; fix the file first, then save again.`));
        }
        const patch = mergePatch(this.config[key], value);
        if (patch === undefined) { return; }
        this.writePatch({ [key]: patch });
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
        try { this.writePatch(patch as Record<string, unknown>); } catch { return false; }
        return true;
    }

    reload(): void {
        // Taken before the reads: a change while they run makes the next read reload again.
        this.stamp = this.filesStamp();
        this.target = {};
        this.targetUnreadable = false;
        this.upperLayers = [];

        const filePath = this.configPath;
        const readLayers = () => readConfigLayers(this.layerPaths(), (raw, p) => this.parseConfig(raw, p), undefined, (p) => FsUtils.safeReadFile(p));
        let layers = readLayers();
        if (layers[0]?.unreadable) {
            // A hand edit may be in progress (saves are atomic, so it is no torn write): read once more.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CONFIG_PARSE_RETRY_MS);
            layers = readLayers();
        }
        const [targetLayer, ...upper] = layers;
        // The user-global file's place comes from the shared layers (workspace over root), before it is read.
        const named = [...upper].reverse().map((l) => l.content?.userConfigPath).find((v) => typeof v === 'string' && v.trim())
            ?? (typeof targetLayer?.content?.userConfigPath === 'string' && targetLayer.content.userConfigPath.trim() ? targetLayer.content.userConfigPath : undefined);
        const userFile = path.normalize(this.resolveConfiguredPath(String(named ?? DEFAULT_USER_CONFIG_PATH).trim()));
        if (userFile !== this.userConfigFile) {
            this.userConfigFile = userFile;
            const parts = (this.stamp ?? '').split('|');
            parts[parts.length - 1] = statEntry(userFile);
            this.stamp = parts.join('|');
        }
        this.userGlobal = this.loadUserGlobal();
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
        const filePath = this.userGlobalConfigPath;
        if (!FsUtils.fileExists(filePath)) { return {}; }
        const raw = FsUtils.safeReadFile(filePath);
        if (!raw) { return {}; }
        return this.parseConfig(raw, filePath) ?? {};
    }

    /** Absolute path to the user-global overlay file (whether it exists or not). */
    get userGlobalConfigPath(): string {
        return this.userConfigFile ?? path.normalize(this.resolveConfiguredPath(DEFAULT_USER_CONFIG_PATH));
    }

    /** `true` iff the user-global overlay file is present on disk. */
    hasUserGlobalConfig(): boolean {
        return FsUtils.fileExists(this.userGlobalConfigPath);
    }

    async createDefaultConfig(): Promise<void> {
        const defaults = { ...TomAiConfiguration.defaults } as Record<string, unknown>;
        this.writeContent(() => defaults);
        this.targetUnreadable = false;
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

    /** Apply the merge patch `patch` to the target file under its lock (see {@link writeContent}). */
    private writePatch(patch: Record<string, unknown>): void {
        this.writeContent((current) => applyMergePatch(current, patch) as Record<string, unknown>);
    }

    /**
     * Change the target file (lib: utils/lockedConfigWrite.ts): through its
     * real path (a workspace folder's link onto the root's file stays a link),
     * under its lock, re-read there and `apply`'d to what it holds then,
     * written atomically. `target` and `config` are rebuilt from what was
     * written. A failure is shown to the user and thrown.
     */
    private writeContent(apply: (current: Record<string, unknown>) => Record<string, unknown>): void {
        const filePath = this.configPath;
        let result: { content: Record<string, unknown> };
        try {
            result = updateConfigFileLocked(filePath, apply, this.formatOf(filePath));
        } catch (err) {
            throw this.reportSaveFailure(err, filePath);
        }
        this.target = result.content;
        this.targetUnreadable = false;
        this.config = this.mergeConfig(this.target);
        // Only the target's part of the stamp is renewed: a change of another layer still reloads at the next read.
        const previous = (this.stamp ?? '').split('|');
        const now = this.filesStamp().split('|');
        previous[0] = now[0];
        this.stamp = previous.length === now.length ? previous.join('|') : now.join('|');
    }

    /** How the target file is read and written: YAML by its extension, else JSON (two-space indent). */
    private formatOf(filePath: string): ConfigFileFormat {
        const yaml = /\.ya?ml$/i.test(filePath);
        return {
            parse: (raw) => this.parseConfig(raw, filePath),
            stringify: (content) => yaml ? stringifyYaml(content) : JSON.stringify(content, null, 2),
        };
    }

    /** Show a failed save (the file and the reason) and answer the error to throw. */
    private reportSaveFailure(err: unknown, filePath = this.configPath): Error {
        const reason = err instanceof Error ? err.message : String(err);
        const error = reason.startsWith('Not saved:') ? new Error(reason) : new Error(`Not saved: ${filePath}: ${reason}`);
        logConfigAccess('TomAiConfiguration.save', filePath, { action: 'save-failed', note: reason });
        try { void vscode.window.showErrorMessage(`Tom AI: the configuration was not saved. ${error.message}`); } catch { /* no window */ }
        return error;
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
