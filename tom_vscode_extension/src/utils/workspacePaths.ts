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
 * All workspace-relative paths are resolved lazily against the first
 * workspace folder. Home-relative paths expand `~` / `$HOME`.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Configurable folder names (the ONLY place these strings appear)
// ============================================================================

/**
 * Top-level workspace folder that holds AI / automation artefacts.
 * Currently `_ai`.  Change this single value to rename everywhere.
 */
const AI_FOLDER = '_ai';

/**
 * Workspace folder for copilot / AI guidelines documents.
 * Currently `_copilot_guidelines`.
 */
const GUIDELINES_FOLDER = '_copilot_guidelines';

/**
 * Workspace folder for Tom metadata.
 * Currently `.tom_metadata`.
 */
const TOM_METADATA_FOLDER = '.tom_metadata';

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
    notes:               'notes',
    local:               'local',
    schemas:             'schemas/yaml',
    copilot:             'copilot',
    tomAiChat:           'tom_ai_chat',
    chatReplies:         'chat_replies',
    botConversations:    'bot_conversations',
    attachments:         'attachments',
    answersCopilot:      'answers/copilot',
    // Trail sub-folders (inside local/ etc.)
    trailLocal:          'local/trail',
    trailConversation:   'conversation/trail',
    trailTomai:          'tomai/trail',
    trailCopilot:        'copilot/trail',
};

/** Map of logical names → relative paths inside HOME_TOM_FOLDER. */
const HOME_SUBPATHS: Record<string, string> = {
    vscodeConfig:               'vscode/tom_vscode_extension.json',
    copilotChatAnswers:         'copilot-chat-answers',
    chatReplies:                'chat_replies',
    botConversations:           'bot_conversations',
    botConversationAnswers:     'bot-conversation-answers',
    copilotAnswers:             'copilot-answers',
    copilotPrompts:             'copilot-prompts',
};

// ============================================================================
// Public API
// ============================================================================

export class WsPaths {
    // ── Raw folder names (for pattern matching, glob, display) ──────
    /** The AI folder name, e.g. `_ai` */
    static get aiFolder(): string { return AI_FOLDER; }
    /** The guidelines folder name, e.g. `_copilot_guidelines` */
    static get guidelinesFolder(): string { return GUIDELINES_FOLDER; }
    /** The Tom metadata folder name, e.g. `.tom_metadata` */
    static get metadataFolder(): string { return TOM_METADATA_FOLDER; }
    /** The GitHub folder name, e.g. `.github` */
    static get githubFolder(): string { return GITHUB_FOLDER; }
    /** The home-level Tom folder name, e.g. `.tom` */
    static get homeTomFolder(): string { return HOME_TOM_FOLDER; }
    /** The workspace config folder name, e.g. `.tom` (workspace-level) */
    static get wsConfigFolder(): string { return WORKSPACE_CONFIG_FOLDER; }
    /** The extension config filename, e.g. `tom_vscode_extension.json` */
    static get configFileName(): string { return CONFIG_FILE_NAME; }

    // ── Workspace root helper ───────────────────────────────────────

    /** First workspace folder path, or undefined. */
    static get wsRoot(): string | undefined {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri) {
            const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
            if (activeWorkspaceFolder) {
                return activeWorkspaceFolder.uri.fsPath;
            }
        }
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
        const ws = this.wsRoot;
        if (!ws) return undefined;
        const sub = AI_SUBPATHS[key];
        if (sub) return path.join(ws, AI_FOLDER, sub, ...extra);
        // Fallback: treat key itself as a sub-path
        return path.join(ws, AI_FOLDER, key, ...extra);
    }

    /**
     * Build a workspace-relative path string (not absolute) for use in
     * glob patterns, config defaults, etc.
     *
     * @param key  Logical name from AI_SUBPATHS
     * @returns Relative path like `_ai/quests`
     */
    static aiRelative(key: string): string {
        const sub = AI_SUBPATHS[key];
        return sub ? `${AI_FOLDER}/${sub}` : `${AI_FOLDER}/${key}`;
    }

    /**
     * The AI folder as an absolute path inside the workspace.
     */
    static get aiRoot(): string | undefined {
        const ws = this.wsRoot;
        return ws ? path.join(ws, AI_FOLDER) : undefined;
    }

    /**
     * Resolve the guidelines directory.
     * @param projectRelPath  If given, resolves inside a project sub-folder
     */
    static guidelines(projectRelPath?: string): string | undefined {
        const ws = this.wsRoot;
        if (!ws) return undefined;
        if (projectRelPath) {
            return path.join(ws, projectRelPath, GUIDELINES_FOLDER);
        }
        return path.join(ws, GUIDELINES_FOLDER);
    }

    /** Resolve the `.tom_metadata` directory. */
    static metadata(...extra: string[]): string | undefined {
        const ws = this.wsRoot;
        return ws ? path.join(ws, TOM_METADATA_FOLDER, ...extra) : undefined;
    }

    /** Resolve the `.github` directory. */
    static github(...extra: string[]): string | undefined {
        const ws = this.wsRoot;
        return ws ? path.join(ws, GITHUB_FOLDER, ...extra) : undefined;
    }

    /** Resolve the workspace-level `.tom` configuration directory. */
    static wsConfig(...extra: string[]): string | undefined {
        const ws = this.wsRoot;
        return ws ? path.join(ws, WORKSPACE_CONFIG_FOLDER, ...extra) : undefined;
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
        return `${AI_FOLDER}/quests/**/*.todo.yaml`;
    }

    /** Glob pattern for all guidelines markdown files (global). */
    static get guidelinesGlob(): string {
        return `${GUIDELINES_FOLDER}/**/*.md`;
    }

    // ── Variable resolver integration ───────────────────────────────

    /**
     * Return a map of folder-related variables for the variable resolver.
     * These are added to the `buildVariableMap()` output.
     */
    static getResolverVariables(): Record<string, string> {
        const ws = this.wsRoot || '';
        return {
            aiFolder:            AI_FOLDER,
            guidelinesFolder:    GUIDELINES_FOLDER,
            metadataFolder:      TOM_METADATA_FOLDER,
            githubFolder:        GITHUB_FOLDER,
            homeTomFolder:       HOME_TOM_FOLDER,
            // Absolute paths
            aiPath:              ws ? path.join(ws, AI_FOLDER) : '',
            guidelinesPath:      ws ? path.join(ws, GUIDELINES_FOLDER) : '',
            metadataPath:        ws ? path.join(ws, TOM_METADATA_FOLDER) : '',
            questsPath:          ws ? path.join(ws, AI_FOLDER, 'quests') : '',
            rolesPath:           ws ? path.join(ws, AI_FOLDER, 'roles') : '',
            wsConfigPath:        ws ? path.join(ws, WORKSPACE_CONFIG_FOLDER) : '',
            wsConfigFolder:      WORKSPACE_CONFIG_FOLDER,
            // Copilot answer file folder (workspace-relative and absolute)
            copilotAnswerFolder: `${AI_FOLDER}/${AI_SUBPATHS['answersCopilot']}`,
            copilotAnswerPath:   ws ? path.join(ws, AI_FOLDER, AI_SUBPATHS['answersCopilot']) : '',
        };
    }
}
