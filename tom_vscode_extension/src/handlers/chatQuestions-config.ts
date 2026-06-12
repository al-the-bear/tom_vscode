/**
 * Single source of truth for the "Chat questions" (`tomAi_askUser`) settings.
 *
 * Like the Telegram settings, these live **per quest and per host** at
 * `_ai/quests/{questId}/chat-questions.{hostname}.{questId}.yaml` — not in the
 * shared `tom_vscode_extension.json`. Every quest's `.code-workspace` opens the
 * same workspace root, so a shared config file would be identical across all
 * quests; storing the settings in the quest folder lets each workspace/quest
 * pick its own timeout + fallback prompt, and the `_ai` clone being shared
 * across the fleet means the hostname segment keeps each machine separate.
 *
 * Two knobs only:
 *   - `maxWaitMinutes`  — how long the ask blocks the prompt queue before the
 *                         timeout resolves it with `fallbackPrompt` (≥ 1).
 *   - `fallbackPrompt`  — the tool reply handed to the model on timeout.
 *
 * The status page ("Chat questions" section) and the `tomAi_askUser` tool both
 * read/write through this module so they never diverge.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { WsPaths } from '../utils/workspacePaths';

/** Parsed, always-usable Chat questions config. */
export interface ChatQuestionsConfig {
    /** Minutes the ask blocks the queue before timing out. Clamped to ≥ 1. */
    maxWaitMinutes: number;
    /** Tool reply handed to the model when the timeout fires. */
    fallbackPrompt: string;
}

/** Defaults applied when nothing is configured (or a field is missing). */
export const CHAT_QUESTIONS_DEFAULTS: ChatQuestionsConfig = {
    maxWaitMinutes: 15,
    fallbackPrompt: "The user didn't answer. Please follow your recommendations.",
};

/**
 * Path to the per-quest, per-host Chat questions settings file:
 * `_ai/quests/{questId}/chat-questions.{hostname}.{questId}.yaml`. Returns
 * `undefined` when no workspace is open.
 */
export function getChatQuestionsConfigPath(): string | undefined {
    const questId = WsPaths.getWorkspaceQuestId();
    return WsPaths.ai('quests', questId, `chat-questions.${WsPaths.hostSlug()}.${questId}.yaml`);
}

/**
 * Parse a raw object into a {@link ChatQuestionsConfig}, filling in defaults for
 * missing / wrong-typed fields. `maxWaitMinutes` is clamped to a whole number ≥ 1.
 */
export function parseChatQuestionsConfig(raw: unknown): ChatQuestionsConfig {
    if (!raw || typeof raw !== 'object') { return { ...CHAT_QUESTIONS_DEFAULTS }; }
    const obj = raw as Record<string, unknown>;
    const rawMinutes = typeof obj.maxWaitMinutes === 'number' && Number.isFinite(obj.maxWaitMinutes)
        ? obj.maxWaitMinutes
        : CHAT_QUESTIONS_DEFAULTS.maxWaitMinutes;
    const fallbackPrompt = typeof obj.fallbackPrompt === 'string' && obj.fallbackPrompt.trim()
        ? obj.fallbackPrompt
        : CHAT_QUESTIONS_DEFAULTS.fallbackPrompt;
    return {
        maxWaitMinutes: Math.max(1, Math.floor(rawMinutes)),
        fallbackPrompt,
    };
}

/**
 * Read the raw per-quest settings object, or `undefined` when the file is
 * absent. A parse error surfaces a toast and returns `undefined` (caller falls
 * back to defaults).
 */
function readChatQuestionsRaw(): unknown {
    const cfgPath = getChatQuestionsConfigPath();
    if (!cfgPath || !fs.existsSync(cfgPath)) { return undefined; }
    try {
        return parseYaml(fs.readFileSync(cfgPath, 'utf-8'));
    } catch (err) {
        vscode.window.showErrorMessage(`Error reading ${path.basename(cfgPath)}: ${(err as Error).message}`);
        return undefined;
    }
}

/**
 * Effective parsed Chat questions config for the current quest — the per-quest
 * file when present, else parsed defaults. Always returns a usable config.
 */
export function readChatQuestionsConfig(): ChatQuestionsConfig {
    return parseChatQuestionsConfig(readChatQuestionsRaw());
}

/**
 * Persist Chat questions settings to the per-quest file, creating the quest
 * folder if needed. Returns `false` (with an error toast) when no workspace is
 * open or the write fails.
 */
export function writeChatQuestionsConfig(cfg: ChatQuestionsConfig): boolean {
    const cfgPath = getChatQuestionsConfigPath();
    if (!cfgPath) {
        vscode.window.showErrorMessage('No workspace open — cannot resolve the quest folder for Chat questions settings.');
        return false;
    }
    const out: ChatQuestionsConfig = {
        maxWaitMinutes: Math.max(1, Math.floor(cfg.maxWaitMinutes)),
        fallbackPrompt: cfg.fallbackPrompt?.trim() ? cfg.fallbackPrompt : CHAT_QUESTIONS_DEFAULTS.fallbackPrompt,
    };
    try {
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, stringifyYaml(out), 'utf-8');
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to write ${path.basename(cfgPath)}: ${(err as Error).message}`);
        return false;
    }
}
