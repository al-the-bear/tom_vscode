/**
 * Telegram standalone command handlers.
 *
 * Provides two VS Code commands:
 *  - tomAi.telegram.testConnection   — Send a test message to verify bot token & chat ID
 *  - tomAi.telegram.toggle — Start/stop Telegram polling independent of bot conversations
 *
 * Configuration is read from aiConversation.telegram in tom_vscode_extension.json.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { bridgeLog, getWorkspaceRoot } from './handler_shared';
import { TelegramNotifier, TelegramConfig, TelegramCommand, TelegramApiResult, TELEGRAM_DEFAULTS } from './telegram-notifier';
import {
    loadTelegramConfig,
    getQuestTelegramConfigPath,
    readEffectiveTelegramRaw,
    writeQuestTelegramRaw,
} from './telegram-config';
import { TelegramCommandRegistry, ParsedTelegramCommand } from './telegram-cmd-parser';
import { TelegramResponseFormatter } from './telegram-cmd-response';
import { createCommandRegistry, type CommandRegistryDeps } from './telegram-cmd-handlers';
import { TelegramLiveConversationForwarder } from './telegramTrailForwarder';
import { TelegramChannel } from './chat';
import { isChatPanelOpen } from './chatPanel-handler';
import { runAnthropicSend } from './sendToChatRouter';
import { WsPaths } from '../utils/workspacePaths';

// ============================================================================
// State
// ============================================================================

/** Singleton channel + notifier for standalone polling mode. */
let standaloneChannel: TelegramChannel | null = null;
let standaloneTelegram: TelegramNotifier | null = null;
let isPollingActive = false;

/** Command infrastructure for rich command handling. */
let commandRegistry: TelegramCommandRegistry | null = null;
let responseFormatter: TelegramResponseFormatter | null = null;

/**
 * Persistent forwarder that streams this window's live conversation to Telegram
 * for the whole polling session. Subscribes to every live-trail event (so
 * VS-Code-initiated prompts are forwarded too, not just `send_prompt` ones) and
 * owns the listening/silent mode the chat_* commands toggle.
 */
let liveConversationForwarder: TelegramLiveConversationForwarder | null = null;

/**
 * Extension context, captured at activation. Needed to build the command
 * registry's `send_prompt` dependencies (Anthropic send path). Stored at module
 * scope because the toggle handler that builds the registry is a parameterless
 * VS Code command callback.
 */
let extensionContext: vscode.ExtensionContext | null = null;

/** Capture the extension context so `send_prompt` can drive the Anthropic panel. */
export function initTelegramCommands(context: vscode.ExtensionContext): void {
    extensionContext = context;
}

// ============================================================================
// Config loading
// ============================================================================

// Per-quest Telegram settings live in telegram-config.ts (the single source of
// truth shared by every consumer). This file imports the loader/readers/writers
// it needs from there.

// ============================================================================
// Test Connection command
// ============================================================================

/**
 * Send a test message to the configured Telegram chat to verify
 * the bot token and chat ID are correct.
 */
export async function telegramTestHandler(): Promise<void> {
    bridgeLog('[Telegram] Test connection command invoked');

    const config = loadTelegramConfig();
    if (!config) { return; }

    if (!config.botTokenEnv) {
        vscode.window.showWarningMessage('Telegram botTokenEnv is not configured. Run "Configure Telegram" to set it in this quest\'s settings.');
        return;
    }
    if (!config.botToken) {
        vscode.window.showWarningMessage(`Environment variable '${config.botTokenEnv}' is not set. Export it before starting VS Code.`);
        return;
    }
    if (!config.defaultChatId) {
        vscode.window.showWarningMessage('Telegram defaultChatId is not configured. Run "Configure Telegram" to set it in this quest\'s settings.');
        return;
    }

    // Log configuration details for debugging
    const botId = config.botToken.includes(':') ? config.botToken.split(':')[0] : '(unknown format)';
    bridgeLog(`[Telegram] Using token from env var: ${config.botTokenEnv}`);
    bridgeLog(`[Telegram] Bot ID: ${botId}`);
    bridgeLog(`[Telegram] Target chat ID: ${config.defaultChatId}`);
    bridgeLog(`[Telegram] Token length: ${config.botToken.length} chars`);

    // Create a temporary channel and notifier with enabled forced to true for the test
    const testConfig: TelegramConfig = {
        ...config,
        enabled: true,
        // For the test, we need at least one allowed user — use a dummy if empty
        allowedUserIds: config.allowedUserIds.length > 0 ? config.allowedUserIds : [0],
    };
    const testChannel = new TelegramChannel(testConfig);
    const notifier = new TelegramNotifier(testChannel, testConfig);

    const timestamp = new Date().toLocaleString();
    const testMsg = `🔔 *Telegram Test*\n\nConnection successful!\n_Sent from Tom AI VS Code Extension_\n_${timestamp}_`;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Testing Telegram connection...' },
        async () => {
            const result: TelegramApiResult = await notifier.sendMessageWithDetails(testMsg);
            if (result.ok) {
                vscode.window.showInformationMessage('✅ Telegram test message sent successfully!');
                bridgeLog('[Telegram] Test message sent successfully');
            } else {
                const errorDetail = result.error ?? 'Unknown error';
                vscode.window.showErrorMessage(`❌ Telegram test failed (chatId: ${config.defaultChatId}): ${errorDetail}`);
                bridgeLog(`[Telegram] Test message FAILED to chatId ${config.defaultChatId}: ${errorDetail}`, 'ERROR');
            }
        }
    );
}

// ============================================================================
// Toggle Polling command
// ============================================================================

/**
 * Toggle Telegram polling on/off. When active, incoming commands are shown
 * as VS Code notifications and can trigger extension actions.
 */
export async function telegramToggleHandler(): Promise<void> {
    bridgeLog('[Telegram] Toggle polling command invoked');

    if (isPollingActive && standaloneTelegram) {
        // Stop polling
        liveConversationForwarder?.stop();
        liveConversationForwarder = null;
        standaloneTelegram.dispose();
        standaloneChannel?.dispose();
        standaloneTelegram = null;
        standaloneChannel = null;
        isPollingActive = false;
        vscode.window.showInformationMessage('⏹ Telegram polling stopped.');
        bridgeLog('[Telegram] Standalone polling stopped');
        return;
    }

    // Start polling
    const config = loadTelegramConfig();
    if (!config) { return; }

    if (!config.botTokenEnv) {
        vscode.window.showWarningMessage('Telegram botTokenEnv is not configured. Run "Configure Telegram" to set it in this quest\'s settings.');
        return;
    }
    if (!config.botToken) {
        vscode.window.showWarningMessage(`Environment variable '${config.botTokenEnv}' is not set. Export it before starting VS Code.`);
        return;
    }
    if (config.allowedUserIds.length === 0) {
        vscode.window.showWarningMessage('Telegram allowedUserIds is empty. Run "Configure Telegram" to add your Telegram user ID to this quest\'s settings.');
        return;
    }

    // Force enabled for standalone mode
    const pollingConfig: TelegramConfig = { ...config, enabled: true };
    standaloneChannel = new TelegramChannel(pollingConfig);
    standaloneTelegram = new TelegramNotifier(standaloneChannel, pollingConfig);

    // Initialize command infrastructure (using the same channel for responses)
    responseFormatter = new TelegramResponseFormatter(standaloneChannel);

    // Persistent live-conversation forwarder for this window's quest. Created
    // before the command deps so the chat_* commands can drive it. Forwards
    // every prompt running in this quest — including ones started from VS Code.
    const currentQuest = WsPaths.getWorkspaceQuestId();
    liveConversationForwarder = new TelegramLiveConversationForwarder(
        standaloneChannel,
        config.defaultChatId,
        currentQuest,
    );
    liveConversationForwarder.start();

    // Build live-conversation deps only when we have an extension context —
    // without it the commands can't reach the Anthropic send path, so they
    // stay unregistered.
    const forwarder = liveConversationForwarder;
    const sendPromptDeps: CommandRegistryDeps | undefined = extensionContext
        ? {
            context: extensionContext,
            isChatPanelOpen,
            runAnthropicSend,
            liveConversation: {
                setListening: (on) => forwarder.setListening(on),
                isListening: () => forwarder.isListening(),
                getStatus: () => forwarder.getStatus(),
            },
        }
        : undefined;
    commandRegistry = createCommandRegistry(() => {
        // Stop callback — triggered by stop command
        standaloneTelegram?.sendMessage('⏹ Polling stopped via Telegram command.');
        liveConversationForwarder?.stop();
        liveConversationForwarder = null;
        standaloneTelegram?.dispose();
        standaloneChannel?.dispose();
        standaloneTelegram = null;
        standaloneChannel = null;
        isPollingActive = false;
        commandRegistry = null;
        responseFormatter = null;
        vscode.window.showInformationMessage('⏹ Telegram polling stopped (via stop command).');
    }, sendPromptDeps);

    standaloneTelegram.onCommand((cmd: TelegramCommand) => {
        handleStandaloneCommand(cmd);
    });

    standaloneTelegram.startPolling();
    isPollingActive = true;
    vscode.window.showInformationMessage(`▶️ Telegram polling started (interval: ${config.pollIntervalMs}ms).`);
    bridgeLog(`[Telegram] Standalone polling started (interval: ${config.pollIntervalMs}ms)`);

    // Announce on Telegram which workspace/quest this bot is now driving, so a
    // user running a different bot per workspace knows which one replied.
    const wsName = (() => {
        const root = getWorkspaceRoot();
        return root ? path.basename(root) : 'workspace';
    })();
    const startupMsg =
        `🤖 Tom AI bot online\n` +
        `Workspace: ${wsName}\n` +
        `Quest: ${currentQuest || '(none)'}\n` +
        `Mode: 🔊 listening (live updates on)\n` +
        `Send chat_silent to mute, chat_status for state.`;
    void standaloneTelegram.sendMessage(startupMsg);
}

/**
 * Handle commands received via standalone Telegram polling.
 * Dispatches to the command registry for rich command handling.
 */
function handleStandaloneCommand(cmd: TelegramCommand): void {
    bridgeLog(`[Telegram] Standalone command: ${cmd.type} raw="${cmd.text}" from @${cmd.username}`);

    // If we have a command registry, try to parse and dispatch
    if (commandRegistry && responseFormatter) {
        // Reconstruct the raw text: for 'unknown' type, the raw text is in cmd.text
        // For known types, build a synthetic command text
        let rawText = cmd.text;
        if (cmd.type !== 'unknown' && cmd.type !== 'info') {
            rawText = cmd.type;
        }

        // Try dispatching to the registry (parser accepts with or without / prefix)
        const parsed = commandRegistry.parse(rawText, cmd.userId, cmd.chatId, cmd.username);

        if (parsed) {
            const def = commandRegistry.get(parsed.command);
            if (def) {
                // Send immediate acknowledgment for long-running commands
                if (def.startMessage) {
                    const ackMsg = def.startMessage.replace('{args}', parsed.rawArgs);
                    responseFormatter?.sendPlainMessage(ackMsg, cmd.chatId);
                }
                // Execute the command handler (non-blocking via .then())
                def.handler(parsed).then((result) => {
                    responseFormatter?.sendResult(result, parsed);
                }).catch((err: Error) => {
                    responseFormatter?.sendMessage(`❌ Command error: ${err.message}`, cmd.chatId);
                    bridgeLog(`[Telegram] Command error: ${err.message}`, 'ERROR');
                });
                return;
            }
        }
    }

    // Fallback for unrecognized commands
    switch (cmd.type) {
        case 'info':
            vscode.window.showInformationMessage(`📩 Telegram from @${cmd.username}: ${cmd.text}`);
            standaloneTelegram?.sendMessage(`✅ Message displayed in VS Code\\.`);
            break;

        default:
            standaloneTelegram?.sendMessage(`❓ Unknown command\\. Send help for a list of commands\\.`);
            break;
    }
}

// ============================================================================
// Configure Telegram command
// ============================================================================

/**
 * Interactive configuration for Telegram integration.
 * Prompts for env var name, allowed user IDs, default chat ID, and enabled state,
 * then writes the values to the per-quest settings file
 * `_ai/quests/{questId}/telegram.{questId}.json`.
 *
 * Settings are seeded from the existing quest file if present, otherwise from the
 * shared `aiConversation.telegram` section (for first-time migration), otherwise
 * from {@link TELEGRAM_DEFAULTS}.
 */
export async function telegramConfigureHandler(): Promise<void> {
    bridgeLog('[Telegram] Configure command invoked');

    const questPath = getQuestTelegramConfigPath();
    if (!questPath) {
        vscode.window.showErrorMessage('No workspace open — cannot resolve the quest folder for Telegram settings.');
        return;
    }

    // Seed: existing quest file → shared aiConversation.telegram → defaults.
    let telegram = readEffectiveTelegramRaw();
    if (!telegram || typeof telegram !== 'object' || Object.keys(telegram).length === 0) {
        telegram = { ...TELEGRAM_DEFAULTS };
    }

    // --- Step 1: Bot token env var name ---
    const tokenEnv = await vscode.window.showInputBox({
        title: 'Configure Telegram (1/4): Bot Token Environment Variable',
        prompt: 'Name of the environment variable holding the bot token',
        value: telegram.botTokenEnv ?? 'TELEGRAM_BOT_TOKEN',
        placeHolder: 'TELEGRAM_BOT_TOKEN',
        ignoreFocusOut: true,
    });
    if (tokenEnv === undefined) { return; } // cancelled

    // --- Step 2: Allowed user IDs ---
    const currentUsers = (telegram.allowedUserIds ?? []).join(', ');
    const usersInput = await vscode.window.showInputBox({
        title: 'Configure Telegram (2/4): Allowed User IDs',
        prompt: 'Comma-separated Telegram user IDs allowed to send commands',
        value: currentUsers,
        placeHolder: '123456789, 987654321',
        ignoreFocusOut: true,
    });
    if (usersInput === undefined) { return; } // cancelled

    const allowedUserIds = usersInput
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(Number)
        .filter(n => !isNaN(n) && n > 0);

    // --- Step 3: Default chat ID ---
    const currentChat = telegram.defaultChatId !== null && telegram.defaultChatId !== undefined ? String(telegram.defaultChatId) : '';
    const chatIdInput = await vscode.window.showInputBox({
        title: 'Configure Telegram (3/4): Default Chat ID',
        prompt: 'Telegram chat ID for notifications (leave empty for none)',
        value: currentChat,
        placeHolder: '-1001234567890',
        ignoreFocusOut: true,
    });
    if (chatIdInput === undefined) { return; } // cancelled

    const defaultChatId = chatIdInput.trim().length > 0 ? Number(chatIdInput.trim()) : null;
    if (defaultChatId !== null && isNaN(defaultChatId)) {
        vscode.window.showErrorMessage('Invalid chat ID — must be a number.');
        return;
    }

    // --- Step 4: Enabled toggle ---
    const enabledPick = await vscode.window.showQuickPick(
        [
            { label: 'Enabled', description: 'Telegram notifications active', value: true },
            { label: 'Disabled', description: 'Telegram notifications inactive', value: false },
        ],
        {
            title: 'Configure Telegram (4/4): Enable Notifications?',
            placeHolder: telegram.enabled ? 'Currently: enabled' : 'Currently: disabled',
            ignoreFocusOut: true,
        }
    );
    if (!enabledPick) { return; } // cancelled

    // --- Write config ---
    telegram.botTokenEnv = tokenEnv;
    telegram.allowedUserIds = allowedUserIds;
    telegram.defaultChatId = defaultChatId;
    telegram.enabled = enabledPick.value;

    if (writeQuestTelegramRaw(telegram)) {
        const summary = [
            `Token env: ${tokenEnv}`,
            `Users: ${allowedUserIds.length > 0 ? allowedUserIds.join(', ') : '(none)'}`,
            `Chat ID: ${defaultChatId ?? '(none)'}`,
            `Enabled: ${enabledPick.value}`,
        ].join(' | ');
        vscode.window.showInformationMessage(`✅ Telegram configured (${path.basename(questPath)}) — ${summary}`);
        bridgeLog(`[Telegram] Configuration saved to ${questPath}: ${summary}`);
    }
}

// ============================================================================
// Disposal
// ============================================================================

/** Check if Telegram polling is currently active. */
export function isTelegramPollingActive(): boolean {
    return isPollingActive;
}

/** Dispose standalone Telegram resources. Called on extension deactivation. */
export function disposeTelegramStandalone(): void {
    if (liveConversationForwarder) {
        liveConversationForwarder.stop();
        liveConversationForwarder = null;
    }
    if (standaloneTelegram) {
        standaloneTelegram.dispose();
        standaloneTelegram = null;
    }
    if (standaloneChannel) {
        standaloneChannel.dispose();
        standaloneChannel = null;
    }
    isPollingActive = false;
    commandRegistry = null;
    responseFormatter = null;
}
