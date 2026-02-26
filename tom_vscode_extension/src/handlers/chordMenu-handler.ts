/**
 * Chord Menu Handler
 *
 * Implements a which-key style system for keyboard shortcuts.
 * The first key press (Ctrl+Shift+<letter>) shows a QuickPick with available
 * second-key options. The user then types a plain letter (no modifiers) to
 * auto-execute the matching command.
 *
 * Groups:
 *   Ctrl+Shift+C → Conversation Control
 *   Ctrl+Shift+L → Local LLM
 *   Ctrl+Shift+A → Send to Copilot Chat
 *   Ctrl+Shift+T → Tom AI Chat
 *   Ctrl+Shift+E → Execute Commandline
 *   Ctrl+Shift+V → Favorites (configurable via tom_vscode_extension.json)
 *
 * All groups include a "?" item that opens the Quick Reference document.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfigPath } from './handler_shared';
import { FsUtils } from '../utils/fsUtils';

// ============================================================================
// Types
// ============================================================================

interface ChordMenuItem {
    /** The shortcut key letter (lowercase) displayed and matched */
    key: string;
    /** Human-readable label for the command */
    label: string;
    /** The VS Code command ID to execute (single command) */
    commandId: string;
    /** Multiple VS Code command IDs to execute sequentially (overrides commandId if set) */
    commandIds?: string[];
    /** Optional: only show this item when a condition is met */
    when?: () => boolean;
}

interface ChordGroup {
    /** Group title shown at the top of the QuickPick */
    title: string;
    /** The first-key chord prefix for display, e.g. "Ctrl+Shift+C" */
    prefix: string;
    /** Available commands in this group */
    items: ChordMenuItem[];
}

// ============================================================================
// Quick Reference Helper
// ============================================================================

const QUICK_REFERENCE_COMMAND = 'dartscript.showQuickReference';

/**
 * Opens the quick_reference.md file from the extension's doc/ folder.
 */
async function openQuickReference(): Promise<void> {
    // Find the extension by its ID
    const ext = vscode.extensions.getExtension('tom.dartscript-vscode');
    if (!ext) {
        vscode.window.showErrorMessage('DartScript extension not found.');
        return;
    }
    const refPath = path.join(ext.extensionPath, 'doc', 'quick_reference.md');
    try {
        const uri = vscode.Uri.file(refPath);
        await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
        // Fallback: open as plain text if markdown preview fails
        try {
            const uri = vscode.Uri.file(refPath);
            await vscode.window.showTextDocument(uri, { preview: true });
        } catch (e) {
            vscode.window.showErrorMessage(`Could not open quick reference: ${e}`);
        }
    }
}

// The "?" help item appended to every group
const HELP_ITEM: ChordMenuItem = {
    key: '?',
    label: 'Quick Reference',
    commandId: QUICK_REFERENCE_COMMAND,
};

// ============================================================================
// Chord Group Definitions
// ============================================================================

const CHORD_GROUPS: Record<string, ChordGroup> = {
    conversation: {
        title: 'Bot Conversation',
        prefix: 'Ctrl+Shift+C',
        items: [
            { key: 'b', label: 'Start Conversation', commandId: 'dartscript.startBotConversation' },
            { key: 's', label: 'Stop Conversation', commandId: 'dartscript.stopBotConversation' },
            { key: 'h', label: 'Halt Conversation', commandId: 'dartscript.haltBotConversation' },
            { key: 'c', label: 'Continue Conversation', commandId: 'dartscript.continueBotConversation' },
            { key: 'a', label: 'Add Info to Conversation', commandId: 'dartscript.addToBotConversation' },
            HELP_ITEM,
        ]
    },
    llm: {
        title: 'Local LLM (Ollama)',
        prefix: 'Ctrl+Shift+L',
        items: [
            { key: 'x', label: 'Expand Prompt', commandId: 'dartscript.expandPrompt' },
            { key: 'c', label: 'Change Ollama Model', commandId: 'dartscript.switchLocalModel' },
            { key: 's', label: 'Send to LLM (Standard)', commandId: 'dartscript.sendToLocalLlmStandard' },
            { key: 't', label: 'Send to LLM (Template)', commandId: 'dartscript.sendToLocalLlmAdvanced' },
            HELP_ITEM,
        ]
    },
    chat: {
        title: 'Send to Copilot Chat',
        prefix: 'Ctrl+Shift+A',
        items: [
            { key: 'c', label: 'Send to Chat', commandId: 'dartscript.sendToChat' },
            { key: 's', label: 'Send to Chat (Standard)', commandId: 'dartscript.sendToChatStandard' },
            { key: 't', label: 'Send to Chat (Template)', commandId: 'dartscript.sendToChatAdvanced' },
            { key: 'r', label: 'Reload Chat Config', commandId: 'dartscript.reloadSendToChatConfig' },
            HELP_ITEM,
        ]
    },
    tomAiChat: {
        title: 'Tom AI Chat',
        prefix: 'Ctrl+Shift+T',
        items: [
            { key: 'n', label: 'Start Chat', commandId: 'dartscript.startTomAIChat' },
            { key: 's', label: 'Send Chat Prompt', commandId: 'dartscript.sendToTomAIChat' },
            { key: 'i', label: 'Interrupt Chat', commandId: 'dartscript.interruptTomAIChat' },
            HELP_ITEM,
        ]
    },
    execute: {
        title: 'Execute Commandline',
        prefix: 'Ctrl+Shift+E',
        items: [
            { key: 'e', label: 'Execute Commandline', commandId: 'dartscript.executeCommandline' },
            { key: 'a', label: 'Add Commandline', commandId: 'dartscript.defineCommandline' },
            { key: 'd', label: 'Delete Commandline', commandId: 'dartscript.deleteCommandline' },
            { key: 'o', label: 'Open Config File', commandId: 'dartscript.openConfig' },
            HELP_ITEM,
        ]
    }
};

// ============================================================================
// Favorites (loaded from tom_vscode_extension.json → "favorites" section)
// ============================================================================

// getConfigPath() is imported from handler_shared

/**
 * Reads the `favorites` array from tom_vscode_extension.json.
 * Each entry: `{ key, label, commandId }`.
 * Returns an empty array if the file or section doesn't exist.
 */
function loadFavorites(): ChordMenuItem[] {
    const configPath = getConfigPath();
    if (!configPath || !FsUtils.fileExists(configPath)) { return []; }
    try {
        const config = FsUtils.safeReadJson<Record<string, unknown>>(configPath);
        const favs = config?.favorites;
        if (!Array.isArray(favs)) { return []; }
        return favs
            .filter((f: any) => f.key && f.label && (f.commandId || f.commandIds))
            .map((f: any) => {
                const item: ChordMenuItem = {
                    key: String(f.key).toLowerCase(),
                    label: String(f.label),
                    commandId: f.commandId ? String(f.commandId) : '',
                };
                if (Array.isArray(f.commandIds) && f.commandIds.length > 0) {
                    const mappedIds = f.commandIds.map((id: any) => String(id));
                    item.commandIds = mappedIds;
                    // Use first commandId as fallback if commandId not set
                    if (!item.commandId && mappedIds.length > 0) {
                        item.commandId = mappedIds[0];
                    }
                }
                return item;
            });
    } catch (e) {
        console.error(`[ChordMenu] Failed to load favorites from ${configPath}:`, e);
        return [];
    }
}

// ============================================================================
// Active Menu State
// ============================================================================

/** The currently open chord group ID, or null if no menu is showing */
let activeGroupId: string | null = null;

/** Reference to the active QuickPick so we can dismiss it from keybindings */
let activeQuickPick: vscode.QuickPick<vscode.QuickPickItem & { _chordItem?: ChordMenuItem }> | null = null;

/** Timestamp when the menu was opened (for diagnostic logging) */
let menuOpenTimestamp: number = 0;

// ============================================================================
// Show Chord Menu
// ============================================================================

/**
 * Shows a QuickPick for a chord group. Auto-executes on single unique keypress.
 * Also sets the `dartscript.chordMenuOpen` context key so that Ctrl+Shift+<letter>
 * keybindings work while the menu is visible.
 */
async function showChordMenu(groupId: string): Promise<void> {
    const group = CHORD_GROUPS[groupId];
    if (!group) {
        vscode.window.showErrorMessage(`Unknown chord group: ${groupId}`);
        return;
    }

    // Filter items by their `when` condition (if any)
    const activeItems = group.items.filter(item => !item.when || item.when());

    // Set context for keybinding dispatch
    activeGroupId = groupId;
    menuOpenTimestamp = Date.now();
    console.log(`[ChordMenu] === OPEN group '${groupId}' (${group.prefix}) at ${menuOpenTimestamp} ===`);

    await vscode.commands.executeCommand('setContext', 'dartscript.chordMenuOpen', true);
    console.log(`[ChordMenu] setContext complete (+${Date.now() - menuOpenTimestamp}ms)`);

    // Build QuickPick items
    const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { _chordItem?: ChordMenuItem }>();
    activeQuickPick = quickPick;
    quickPick.title = `${group.title}  (${group.prefix} → ...)`;
    quickPick.placeholder = 'Type a letter to execute, or select with arrow keys';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = false;

    quickPick.items = activeItems.map(item => ({
        label: `$(key) ${item.key.toUpperCase()}`,
        description: item.label,
        detail: undefined,
        _chordItem: item
    }));

    let executed = false;

    const executeItem = async (item: ChordMenuItem) => {
        if (executed) { return; }
        executed = true;
        console.log(`[ChordMenu] executeItem: '${item.key}' → '${item.label}' (${item.commandIds ? item.commandIds.join(', ') : item.commandId})`);
        quickPick.hide();

        // Execute multiple commands sequentially if commandIds is set
        const commands = item.commandIds && item.commandIds.length > 0
            ? item.commandIds
            : [item.commandId];
        for (const cmdId of commands) {
            await vscode.commands.executeCommand(cmdId);
        }
    };

    // Auto-execute on single character match (plain key, no modifiers).
    quickPick.onDidChangeValue((value) => {
        if (executed) { return; }
        if (value.length !== 1) { return; }

        const key = value.toLowerCase();
        console.log(`[ChordMenu] onDidChangeValue: '${value}' → key '${key}' (group=${groupId})`);

        const match = activeItems.filter(item => item.key === key);
        if (match.length === 1) {
            executeItem(match[0]);
        } else {
            console.log(`[ChordMenu] onDidChangeValue: no unique match for key '${key}' in group '${groupId}' (${match.length} candidates)`);
        }
    });

    // Handle explicit selection (click or Enter)
    quickPick.onDidAccept(() => {
        console.log(`[ChordMenu] onDidAccept: group=${groupId} executed=${executed}`);
        if (executed) { return; }
        const selected = quickPick.selectedItems[0];
        if (selected?._chordItem) {
            executeItem(selected._chordItem);
        }
    });

    // Clean up on hide
    quickPick.onDidHide(() => {
        console.log(`[ChordMenu] === HIDE group '${groupId}' (was open ${Date.now() - menuOpenTimestamp}ms, executed=${executed}) ===`);
        activeGroupId = null;
        activeQuickPick = null;
        menuOpenTimestamp = 0;
        vscode.commands.executeCommand('setContext', 'dartscript.chordMenuOpen', false);
        quickPick.dispose();
    });

    quickPick.show();
    console.log(`[ChordMenu] QuickPick.show() called (+${Date.now() - menuOpenTimestamp}ms)`);
}

// ============================================================================
// Command Handlers (exported for extension.ts)
// ============================================================================

export function chordMenuConversationHandler(): void {
    showChordMenu('conversation');
}

export function chordMenuLlmHandler(): void {
    showChordMenu('llm');
}

export function chordMenuChatHandler(): void {
    showChordMenu('chat');
}

export function chordMenuTomAiChatHandler(): void {
    showChordMenu('tomAiChat');
}

export function chordMenuExecuteHandler(): void {
    showChordMenu('execute');
}

/**
 * Shows the Favorites menu. Items are read from tom_vscode_extension.json → "favorites".
 * Uses the same QuickPick UI as other chord groups but loads dynamically.
 */
export async function chordMenuFavoritesHandler(): Promise<void> {
    console.log('[ChordMenu] === FAVORITES HANDLER CALLED ===');
    const items = loadFavorites();
    if (items.length === 0) {
        vscode.window.showWarningMessage(
            'No favorites configured. Add a "favorites" array to tom_vscode_extension.json.'
        );
        return;
    }

    // Temporarily inject as a dynamic chord group so showChordMenu() works
    CHORD_GROUPS['favorites'] = {
        title: 'Favorites',
        prefix: 'Ctrl+Shift+X',
        items,
    };
    await showChordMenu('favorites');
}

/**
 * Registers all chord menu commands, the key dispatcher, and the quick reference command.
 */
export function registerChordMenuCommands(context: vscode.ExtensionContext): void {
    const cmds = [
        vscode.commands.registerCommand('dartscript.chordMenu.conversation', chordMenuConversationHandler),
        vscode.commands.registerCommand('dartscript.chordMenu.llm', chordMenuLlmHandler),
        vscode.commands.registerCommand('dartscript.chordMenu.chat', chordMenuChatHandler),
        vscode.commands.registerCommand('dartscript.chordMenu.tomAiChat', chordMenuTomAiChatHandler),
        vscode.commands.registerCommand('dartscript.chordMenu.execute', chordMenuExecuteHandler),
        vscode.commands.registerCommand('dartscript.chordMenu.favorites', chordMenuFavoritesHandler),
        vscode.commands.registerCommand(QUICK_REFERENCE_COMMAND, openQuickReference),
    ];
    context.subscriptions.push(...cmds);
}
