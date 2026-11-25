/**
 * Workspace Paths — Central registry of all well-known folder paths.
 *
 * Every hardcoded workspace-relative or home-relative path used by the
 * extension should be routed through this module so that folder names can
 * be changed in **one** place.
 *
 * Usage:
 *   import { WsPaths } from '../utils/workspacePaths';
 *   const questsDir = WsPaths.resolve('quests');
 *
 * Every place comes from the window's layout (`workspaceLayout.ts`): the
 * workspace folder is the window's first folder, `_ai` the layout's `aiRoot`,
 * the configuration folder its root layer. Home-relative paths expand `~` /
 * `$HOME`.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { hostSlugOf } from './hostSlug';
import { getLayout, questIdOf } from './workspaceLayout';
import { GUIDELINE_FOLDER, GUIDELINES_GLOB, LEGACY_GUIDELINE_FOLDER, type GuidelineLevel, guidelineLevels, projectGuidelineDirs } from './guidelineFolders';

// ============================================================================
// Configurable folder names (the ONLY place these strings appear)
// ============================================================================

/**
 * Top-level workspace folder that holds AI / automation artefacts.
 * Currently `_ai`.  Change this single value to rename everywhere.
 */
const DEFAULT_AI_FOLDER = '_ai';

/**
 * The name `_ai` is looked up by (the layout's `aiName`: `tomAi.layout.aiFolder`,
 * the deprecated `tomAi.aiFolder`, or the `defaults: ai` of the marker files).
 * For glob patterns and display; the folder itself is `WsPaths.aiRoot`.
 */
function getAiFolderName(): string {
    const name = getLayout()?.aiName?.trim();
    return name ? name : DEFAULT_AI_FOLDER;
}

/**
 * The guidelines folder names: `_agent_guidelines`, and the older
 * `_copilot_guidelines`, both read (`utils/guidelineFolders.ts`).
 */
const GUIDELINES_FOLDER = GUIDELINE_FOLDER;
// legacy name, removed by 06a_wslayout-8 (if it goes: both names may stay readable)
const LEGACY_GUIDELINES_FOLDER = LEGACY_GUIDELINE_FOLDER;

/**
 * Home-directory base for Tom user-level data.
 * Currently `.tom` (i.e. `~/.tom/`).
 */
const HOME_TOM_FOLDER = '.tom';

/**
 * GitHub-specific folder.
 * Currently `.github`.
 */
const GITHUB_FOLDER = '.github';

/**
 * Workspace-level configuration folder.
 * Currently `.tom` (distinct from home `~/.tom/`).
 */
const WORKSPACE_CONFIG_FOLDER = '.tom';

/**
 * The extension configuration filename (without directory prefix).
 */
const CONFIG_FILE_NAME = 'tom_vscode_extension.json';

// ============================================================================
// Sub-paths inside AI_FOLDER
// ============================================================================

/** Map of logical names → relative paths inside the AI folder. */
const AI_SUBPATHS: Record<string, string> = {
    quests:              'quests',
    roles:               'roles',
    processes:           'processes',
    local:               'local',
    schemas:             'schemas/yaml',
    copilot:             'copilot',
    chatReplies:         'chat_replies',
    attachments:         'attachments',
    answersCopilot:      'answers/copilot',
    queue:               'queue',
    prompt:              'prompt',
    memory:              'memory',
    trail:               'trail',
    // Trail sub-folders (inside local/ etc.)
    trailCopilot:        'copilot/trail',
};

/** Map of logical names → relative paths inside HOME_TOM_FOLDER. */
const HOME_SUBPATHS: Record<string, string> = {
    vscodeConfig:               'vscode/tom_vscode_extension.json',
    copilotChatAnswers:         'copilot-chat-answers',
    chatReplies:                'chat_replies',
    copilotAnswers:             'copilot-answers',
    copilotPrompts:             'copilot-prompts',
};

// ============================================================================
// Public API
// ============================================================================

export class WsPaths {
    // ── Raw folder names (for pattern matching, glob, display) ──────
    /** The AI folder name, e.g. `_ai` */
    static get aiFolder(): string { return getAiFolderName(); }
    /** The guidelines folder name, `_agent_guidelines` (the older `_copilot_guidelines` is read too). */
    static get guidelinesFolder(): string { return GUIDELINES_FOLDER; }
    /** The older guidelines folder name, `_copilot_guidelines`, still read. */
    static get legacyGuidelinesFolder(): string { return LEGACY_GUIDELINES_FOLDER; }
    /** The GitHub folder name, e.g. `.github` */
    static get githubFolder(): string { return GITHUB_FOLDER; }
    /** The home-level Tom folder name, e.g. `.tom` */
    static get homeTomFolder(): string { return HOME_TOM_FOLDER; }
    /** The workspace config folder name, e.g. `.tom` (workspace-level) */
    static get wsConfigFolder(): string { return WORKSPACE_CONFIG_FOLDER; }
    /** The extension config filename, e.g. `tom_vscode_extension.json` */
    static get configFileName(): string { return CONFIG_FILE_NAME; }

    // ── Host helper ─────────────────────────────────────────────────

    /**
     * Filename-safe segment identifying the current machine.
     *
     * The `_ai` layer is a single clone symlinked into every workspace and
     * synced across the fleet, so files like `quest-refresh.yaml` resolve to
     * the *same* physical file on every host. Embedding this slug in per-host
     * config filenames (`quest-refresh.<host>.<quest>.yaml`,
     * `telegram.<host>.<quest>.yaml`) keeps each machine's state separate
     * instead of clobbering it through the shared clone.
     *
     * Returns the short hostname (domain stripped), lower-cased, with any
     * character outside `[a-z0-9_-]` replaced by `_`.
     */
    static hostSlug(): string {
        return hostSlugOf();
    }

    // ── Workspace root helper ───────────────────────────────────────

    /**
     * The workspace folder: the window's first folder (`TomLayout.workspaceFolder`).
     * Further folders of a multi-root window and the active editor change nothing.
     */
    static get wsRoot(): string | undefined {
        return getLayout()?.workspaceFolder;
    }

    /**
     * The top `.tom`: the root's configuration folder (`TomLayout.configLayers[0]`),
     * a standalone workspace folder's own. The generated schemas live here
     * (utils/generatedSchemas.ts), and the `$schema` references the extension
     * writes point here.
     */
    static get topTom(): string | undefined {
        return getLayout()?.configLayers[0];
    }

    /** The root of the Tom workspace (`TomLayout.root`; the workspace folder when standalone). */
    static get tomRoot(): string | undefined {
        return getLayout()?.root;
    }

    // ── Workspace-relative path builders ────────────────────────────

    /**
     * Resolve a workspace-relative path for an AI sub-folder.
     *
     * @param key  Logical name from AI_SUBPATHS (e.g. 'quests', 'roles')
     * @param extra  Additional path segments to join
     * @returns Absolute path, or undefined if no workspace is open
     *
     * Examples:
     *   WsPaths.ai('quests')                  → /ws/_ai/quests
     *   WsPaths.ai('quests', 'my_quest')      → /ws/_ai/quests/my_quest
     *   WsPaths.ai('attachments', 'issue-42') → /ws/_ai/attachments/issue-42
     */
    static ai(key: string, ...extra: string[]): string | undefined {
        const ai = this.aiRoot;
        if (!ai) return undefined;
        const sub = AI_SUBPATHS[key];
        if (sub) return path.join(ai, sub, ...extra);
        // Fallback: treat key itself as a sub-path
        return path.join(ai, key, ...extra);
    }

    /**
     * Build a workspace-relative path string (not absolute) for use in
     * glob patterns, config defaults, etc.
     *
     * @param key  Logical name from AI_SUBPATHS
     * @returns Relative path like `_ai/quests`
     */
    static aiRelative(key: string): string {
        const aiFolder = this.aiFolder;
        const sub = AI_SUBPATHS[key];
        return sub ? `${aiFolder}/${sub}` : `${aiFolder}/${key}`;
    }

    /**
     * A configured path relative to the workspace folder, absolute: one under
     * `_ai/` (or `_ai` itself) goes to the `_ai` root, which may be the root's
     * when the workspace folder has none; an absolute path stays as it is.
     * Undefined without a workspace folder (or, for an `_ai` path, without an
     * `_ai` root).
     */
    static resolveWorkspaceRelative(rel: string): string | undefined {
        if (path.isAbsolute(rel)) return rel;
        const parts = rel.split(/[\\/]+/).filter((p) => p && p !== '.');
        if (parts[0] === this.aiFolder) {
            const ai = this.aiRoot;
            return ai ? path.join(ai, ...parts.slice(1)) : undefined;
        }
        const ws = this.wsRoot;
        return ws ? path.join(ws, rel) : undefined;
    }

    /**
     * The AI folder as an absolute path (`TomLayout.aiRoot`): the workspace
     * folder's `_ai` when it exists, else the root's. It may not exist
     * (`getLayout().aiMissing`).
     */
    static get aiRoot(): string | undefined {
        return getLayout()?.aiRoot;
    }

    /**
     * The global guideline levels: the root's guidelines, then the workspace
     * folder's, each with its existing folders under both names (new first).
     */
    static guidelineLevels(): GuidelineLevel[] {
        return guidelineLevels(getLayout()?.guidelineDirs ?? []);
    }

    /**
     * Resolve one guidelines directory.
     * @param projectRelPath  If given, the project's guidelines folder: its
     *   `_agent_guidelines`, else its `_copilot_guidelines`, else the new
     *   name's path (to create).
     * Without it: the workspace folder's guidelines folder (the higher level),
     * else the root's — for a single folder; readers of every guideline use
     * `guidelineLevels()`.
     */
    static guidelines(projectRelPath?: string): string | undefined {
        const ws = this.wsRoot;
        if (!ws) return undefined;
        if (projectRelPath) {
            const abs = path.join(ws, projectRelPath);
            return projectGuidelineDirs(abs)[0] ?? path.join(abs, GUIDELINES_FOLDER);
        }
        const levels = this.guidelineLevels();
        const top = levels[levels.length - 1];
        return top?.dirs[0] ?? getLayout()?.guidelineDirs.at(-1) ?? path.join(ws, GUIDELINES_FOLDER);
    }

    /** Resolve the `.github` directory. */
    static github(...extra: string[]): string | undefined {
        const ws = this.wsRoot;
        return ws ? path.join(ws, GITHUB_FOLDER, ...extra) : undefined;
    }

    /**
     * Resolve the `.tom` configuration directory the extension reads and
     * writes: the root layer (`TomLayout.configLayers[0]`), the only writable
     * layer for now (BP-18). In a standalone workspace it is the workspace
     * folder's `.tom`.
     */
    static wsConfig(...extra: string[]): string | undefined {
        const layer = getLayout()?.configLayers[0];
        return layer ? path.join(layer, ...extra) : undefined;
    }

    // ── Home-directory path builders ────────────────────────────────

    /**
     * Resolve a path under `~/.tom/`.
     *
     * @param key  Logical name from HOME_SUBPATHS, or a raw sub-path
     * @param extra  Additional path segments
     */
    static home(key: string, ...extra: string[]): string {
        const sub = HOME_SUBPATHS[key];
        if (sub) return path.join(os.homedir(), HOME_TOM_FOLDER, sub, ...extra);
        return path.join(os.homedir(), HOME_TOM_FOLDER, key, ...extra);
    }

    /** The home-level Tom folder as an absolute path (`~/.tom`). */
    static get homeRoot(): string {
        return path.join(os.homedir(), HOME_TOM_FOLDER);
    }

    // ── Glob patterns ───────────────────────────────────────────────

    /** Glob pattern for all quest todo YAML files. */
    static get questTodoGlob(): string {
        return `${this.aiFolder}/quests/**/*.todo.yaml`;
    }

    /** Glob pattern for all guidelines markdown files (global), under both names. */
    static get guidelinesGlob(): string {
        return GUIDELINES_GLOB;
    }

    // ── Variable resolver integration ───────────────────────────────

    /**
     * Return a map of folder-related variables for the variable resolver.
     * These are added to the `buildVariableMap()` output.
     */
    static getResolverVariables(): Record<string, string> {
        const ws = this.wsRoot || '';
        const aiFolder = this.aiFolder;
        const ai = this.aiRoot || '';
        const config = this.wsConfig() || '';
        return {
            // The root of the Tom workspace (the workspace folder when standalone).
            tomRoot:             this.tomRoot || '',
            aiFolder:            aiFolder,
            guidelinesFolder:    GUIDELINES_FOLDER,
            githubFolder:        GITHUB_FOLDER,
            homeTomFolder:       HOME_TOM_FOLDER,
            // Absolute paths
            aiPath:              ai,
            // Alias for ${aiPath} — `${ai}` was the token used by the
            // legacy trail-path resolvers (pre-unification); keeping it
            // as an alias means existing trail patterns in user config
            // files keep resolving without a migration step.
            ai:                  ai,
            guidelinesPath:      ws ? (this.guidelines() ?? '') : '',
            questsPath:          ai ? path.join(ai, 'quests') : '',
            rolesPath:           ai ? path.join(ai, 'roles') : '',
            wsConfigPath:        config,
            wsConfigFolder:      WORKSPACE_CONFIG_FOLDER,
            // Copilot answer file folder (workspace-relative)
            copilotAnswerFolder: `${aiFolder}/${AI_SUBPATHS['answersCopilot']}`,
        };
    }

    /**
     * Get the current quest ID from the open .code-workspace filename.
     * This is the ONLY source of truth for the current quest.
     * Returns 'default' if no workspace file is open or the name is empty.
     */
    static getWorkspaceQuestId(): string {
        return questIdOf(vscode.workspace.workspaceFile?.fsPath);
    }
}
