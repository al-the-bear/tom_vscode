/**
 * Combined Command Handler
 *
 * Provides configurable "combined commands" — extension commands that
 * execute a sequence of VS Code commands read from `tom_vscode_extension.json`.
 *
 * Each combined command is registered once in package.json with a fixed
 * command ID (e.g. `dartscript.combined.maximizeExplorer`), but the actual
 * VS Code commands it executes are read from the `combinedCommands` section
 * of the config file at runtime.  This means the behaviour can be changed
 * without reinstalling the extension.
 *
 * Config format in tom_vscode_extension.json:
 *
 * ```json
 * "combinedCommands": {
 *   "maximizeExplorer": {
 *     "label": "Maximize Explorer",
 *     "commands": [
 *       "workbench.action.closeSidebar",
 *       "workbench.action.closeAuxiliaryBar",
 *       "workbench.action.focusSideBar"
 *     ]
 *   }
 * }
 * ```
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfigPath } from './handler_shared';
import { FsUtils } from '../utils/fsUtils';

// ============================================================================
// Types
// ============================================================================

interface CombinedCommandConfig {
    /** Human-readable label (for logging / status bar) */
    label?: string;
    /** The VS Code command IDs to execute in order */
    commands: string[];
}

/** The full map keyed by the short name used in the command ID */
type CombinedCommandsMap = Record<string, CombinedCommandConfig>;

// ============================================================================
// Config Loading
// ============================================================================

// getConfigPath() is imported from handler_shared

/**
 * Read the `combinedCommands` map from the config file.
 * Returns an empty object when the file or section doesn't exist.
 */
function loadCombinedCommands(): CombinedCommandsMap {
    const configPath = getConfigPath();
    if (!configPath || !FsUtils.fileExists(configPath)) {
        return {};
    }
    try {
        const config = FsUtils.safeReadJson<Record<string, unknown>>(configPath);
        const section = config?.combinedCommands;
        if (!section || typeof section !== 'object') {
            return {};
        }
        // Validate each entry
        const result: CombinedCommandsMap = {};
        for (const [key, value] of Object.entries(section)) {
            const entry = value as any;
            if (Array.isArray(entry?.commands) && entry.commands.length > 0) {
                result[key] = {
                    label: entry.label ? String(entry.label) : key,
                    commands: entry.commands.map((c: any) => String(c)),
                };
            }
        }
        return result;
    } catch (e) {
        console.error('[CombinedCommand] Failed to load config:', e);
        return {};
    }
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute a combined command by its short name.
 * Reads the command list from config each time so changes take effect
 * immediately without reload.
 */
async function executeCombinedCommand(name: string): Promise<void> {
    console.log(`[CombinedCommand] Executing "${name}"...`);
    const allCommands = loadCombinedCommands();
    const entry = allCommands[name];

    if (!entry) {
        const msg = `Combined command "${name}" is not configured in tom_vscode_extension.json → combinedCommands.`;
        console.error(`[CombinedCommand] ${msg}`);
        vscode.window.showWarningMessage(msg);
        return;
    }

    console.log(`[CombinedCommand] "${name}" → executing ${entry.commands.length} command(s): ${entry.commands.join(', ')}`);

    for (const cmdId of entry.commands) {
        try {
            await vscode.commands.executeCommand(cmdId);
            console.log(`[CombinedCommand] ✓ "${cmdId}"`);
        } catch (err) {
            console.error(
                `[CombinedCommand] Error executing "${cmdId}" in "${name}":`,
                err,
            );
        }
    }
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Creates a command handler function for a given combined command name.
 */
export function createCombinedCommandHandler(
    name: string,
): () => Promise<void> {
    return () => executeCombinedCommand(name);
}

/**
 * Register all combined command entries.
 * Call this from extension.ts during activation.
 *
 * Each registered command has the ID `dartscript.combined.<name>`.
 * The names must match entries declared in package.json → contributes.commands.
 */
export function registerCombinedCommands(
    context: vscode.ExtensionContext,
): void {
    // These are the statically registered command names in package.json.
    // Add new entries here when adding new combined commands.
    const registeredNames = [
        'maximizeToggle',
        'maximizeExplorer',
        'maximizeEditor',
        'maximizeChat',
        'showSideNotes',
    ];

    for (const name of registeredNames) {
        const cmd = vscode.commands.registerCommand(
            `dartscript.combined.${name}`,
            createCombinedCommandHandler(name),
        );
        context.subscriptions.push(cmd);
    }
}
