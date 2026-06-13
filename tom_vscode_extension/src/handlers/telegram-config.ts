/**
 * Single source of truth for the extension's Telegram settings.
 *
 * Telegram settings are stored **per quest** in the two consolidated config
 * files owned by {@link extensionConfigStore} (under `_ai/quests/{questId}/`),
 * split by scope:
 *
 *   - machine-INDEPENDENT preferences (allow-list, default chat id,
 *     notification toggles, poll interval) live in the `telegram` section of
 *     `extension_config.{questId}.yaml`;
 *   - machine-SPECIFIC bits (`enabled`, `autostart`, `botTokenEnv`) live in the
 *     `telegram` section of `extension_config.{hostname}.{questId}.yaml`.
 *
 * The `_ai` clone is shared/symlinked across the fleet, so the host split keeps
 * each machine's bot token / enable / autostart separate while the shared
 * preferences stay in one place. {@link readEffectiveTelegramRaw} merges the two
 * (machine fields win); {@link writeQuestTelegramRaw} splits a raw object back
 * across them.
 *
 * Every Telegram consumer reads/writes through this module so they never
 * diverge: the standalone polling bot, the status-page settings UI, the
 * `Configure Telegram` command, the activation-time autostart check, and the AI
 * Conversation panel's notifier. This module deliberately depends only on
 * low-level helpers (no other handler) so all of them can import it without
 * creating an import cycle.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import {
    machineConfigPath,
    readMergedTelegramRaw,
    writeSplitTelegramRaw,
} from '../managers/extensionConfigStore';
import { getConfigPath } from './handler_shared';
import { TelegramConfig, parseTelegramConfig } from './telegram-notifier';

/**
 * Path to the file that surfaces the per-quest Telegram settings for display
 * (the machine-specific consolidated config file, where the bot token env +
 * enable/autostart live). Returns `undefined` when no workspace is open.
 */
export function getQuestTelegramConfigPath(): string | undefined {
    if (!vscode.workspace.workspaceFolders?.length) { return undefined; }
    return machineConfigPath();
}

/**
 * Read the raw Telegram settings object from the shared
 * `tom_vscode_extension.json → aiConversation.telegram` section, if present.
 * Used as a one-time migration source: the first save lifts these values into
 * the per-quest files, after which the shared section is ignored.
 */
function readSharedTelegramRaw(): any | undefined {
    const configPath = getConfigPath();
    if (!configPath || !fs.existsSync(configPath)) { return undefined; }
    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return raw?.aiConversation?.telegram ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Effective raw Telegram settings: the merged per-quest sections (machine
 * fields overlaid on the machine-independent ones) when present, else the shared
 * `aiConversation.telegram` section (migration source), else an empty object.
 * This is what the status page reads to populate its fields and what
 * `Configure Telegram` seeds from.
 */
export function readEffectiveTelegramRaw(): any {
    return readMergedTelegramRaw() ?? readSharedTelegramRaw() ?? {};
}

/**
 * Effective **parsed** Telegram config for the current quest. Returns parsed
 * defaults when nothing is configured (mirrors `parseTelegramConfig({})`), so
 * callers always get a usable {@link TelegramConfig}. Used by consumers that
 * don't need to distinguish "unconfigured" from "configured" (e.g. the AI
 * Conversation panel's notifier).
 */
export function readEffectiveTelegramConfig(): TelegramConfig {
    return parseTelegramConfig(readEffectiveTelegramRaw());
}

/**
 * Persist raw Telegram settings by splitting them across the two per-quest
 * config files, creating the quest folder if needed. The runtime-resolved
 * `botToken` is never written (it is derived from the env var on load). Returns
 * `false` (with an error toast) when no workspace is open or the write fails.
 */
export function writeQuestTelegramRaw(raw: any): boolean {
    if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage('No workspace open — cannot resolve the quest folder for Telegram settings.');
        return false;
    }
    try {
        writeSplitTelegramRaw(raw);
        return true;
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to write Telegram settings: ${err.message}`);
        return false;
    }
}

/**
 * Load the parsed Telegram config for the current quest, used to drive the bot.
 * Unlike {@link readEffectiveTelegramConfig}, this surfaces an error toast and
 * returns `undefined` when nothing is configured, so the bot can refuse to start.
 *
 * Resolution order:
 *   1. Merged per-quest sections (authoritative when present).
 *   2. Shared `tom_vscode_extension.json → aiConversation.telegram` (migration fallback).
 */
export function loadTelegramConfig(): TelegramConfig | undefined {
    // Primary: merged per-quest settings. Authoritative when present.
    const merged = readMergedTelegramRaw();
    if (merged !== undefined) {
        return parseTelegramConfig(merged);
    }

    // Fallback: shared aiConversation.telegram section.
    const shared = readSharedTelegramRaw();
    if (shared) { return parseTelegramConfig(shared); }

    const configPath = getQuestTelegramConfigPath();
    const fileName = configPath ? path.basename(configPath) : `extension_config.${WsPaths.hostSlug()}.<quest>.yaml`;
    vscode.window.showErrorMessage(
        `No Telegram settings found for this quest. Open the status page → Telegram (or run "Configure Telegram") to create ${fileName}.`,
    );
    return undefined;
}
