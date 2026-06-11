/**
 * Single source of truth for the extension's Telegram settings.
 *
 * Telegram settings are stored **per quest** at
 * `_ai/quests/{questId}/telegram.{questId}.json` — not in the shared
 * `tom_vscode_extension.json`. Every quest's `.code-workspace` opens the same
 * workspace root, so `getConfigPath()` resolves to one shared config file for
 * all quests; storing the settings in the quest folder lets each
 * workspace/quest drive its own bot.
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
import { getConfigPath } from './handler_shared';
import { TelegramConfig, parseTelegramConfig } from './telegram-notifier';

/**
 * Path to the per-quest Telegram settings file:
 * `_ai/quests/{questId}/telegram.{questId}.json`. Returns `undefined` when no
 * workspace is open.
 */
export function getQuestTelegramConfigPath(): string | undefined {
    const questId = WsPaths.getWorkspaceQuestId();
    return WsPaths.ai('quests', questId, `telegram.${questId}.json`);
}

/**
 * Read the raw Telegram settings object from the shared
 * `tom_vscode_extension.json → aiConversation.telegram` section, if present.
 * Used as a one-time migration source: the first save lifts these values into
 * the per-quest file, after which the shared section is ignored.
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
 * Read the raw per-quest Telegram settings object, or `undefined` when no
 * per-quest file exists. A parse error surfaces a toast and returns `undefined`.
 */
function readQuestTelegramRaw(): any | undefined {
    const questPath = getQuestTelegramConfigPath();
    if (!questPath || !fs.existsSync(questPath)) { return undefined; }
    try {
        return JSON.parse(fs.readFileSync(questPath, 'utf-8'));
    } catch (err: any) {
        vscode.window.showErrorMessage(`Error reading ${path.basename(questPath)}: ${err.message}`);
        return undefined;
    }
}

/**
 * Effective raw Telegram settings: the per-quest file when present, else the
 * shared `aiConversation.telegram` section (migration source), else an empty
 * object. This is what the status page reads to populate its fields and what
 * `Configure Telegram` seeds from.
 */
export function readEffectiveTelegramRaw(): any {
    return readQuestTelegramRaw() ?? readSharedTelegramRaw() ?? {};
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
 * Persist raw Telegram settings to the per-quest file, creating the quest folder
 * if needed. The runtime-resolved `botToken` is never written (it is derived
 * from the env var on load). Returns `false` (with an error toast) when no
 * workspace is open or the write fails.
 */
export function writeQuestTelegramRaw(raw: any): boolean {
    const questPath = getQuestTelegramConfigPath();
    if (!questPath) {
        vscode.window.showErrorMessage('No workspace open — cannot resolve the quest folder for Telegram settings.');
        return false;
    }
    const out = { ...raw };
    delete out.botToken;
    try {
        fs.mkdirSync(path.dirname(questPath), { recursive: true });
        fs.writeFileSync(questPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
        return true;
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to write ${path.basename(questPath)}: ${err.message}`);
        return false;
    }
}

/**
 * Load the parsed Telegram config for the current quest, used to drive the bot.
 * Unlike {@link readEffectiveTelegramConfig}, this surfaces an error toast and
 * returns `undefined` when nothing is configured, so the bot can refuse to start.
 *
 * Resolution order:
 *   1. Per-quest file `_ai/quests/{questId}/telegram.{questId}.json` (authoritative when present).
 *   2. Shared `tom_vscode_extension.json → aiConversation.telegram` (migration fallback).
 */
export function loadTelegramConfig(): TelegramConfig | undefined {
    const questPath = getQuestTelegramConfigPath();

    // Primary: per-quest settings file. Authoritative when it exists — a parse
    // error is surfaced (by readQuestTelegramRaw) rather than silently falling
    // back to the shared config.
    if (questPath && fs.existsSync(questPath)) {
        const raw = readQuestTelegramRaw();
        return raw ? parseTelegramConfig(raw) : undefined;
    }

    // Fallback: shared aiConversation.telegram section.
    const shared = readSharedTelegramRaw();
    if (shared) { return parseTelegramConfig(shared); }

    const fileName = questPath ? path.basename(questPath) : 'telegram.<quest>.json';
    vscode.window.showErrorMessage(
        `No Telegram settings found for this quest. Open the status page → Telegram (or run "Configure Telegram") to create ${fileName}.`,
    );
    return undefined;
}
