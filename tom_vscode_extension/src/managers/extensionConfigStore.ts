/**
 * extensionConfigStore — the single owner of the two consolidated per-quest
 * extension-config YAML files.
 *
 * Several extension subsystems keep small bits of per-quest state that used to
 * live in their own files (`quest-refresh.<host>.<quest>.yaml`,
 * `telegram.<host>.<quest>.yaml`) or, worse, in the shared workspace
 * `tom_vscode_extension.json` (CLI / MCP server autostart). Those are now
 * consolidated into exactly two files, both under `_ai/quests/{questId}/`:
 *
 *   - `extension_config.{questId}.yaml`           — machine-INDEPENDENT settings
 *     that should be the same on every host (e.g. the telegram notification
 *     preferences, allow-list, chat id).
 *
 *   - `extension_config.{hostSlug}.{questId}.yaml` — machine-SPECIFIC settings.
 *     The `_ai` clone is a single checkout symlinked into every workspace and
 *     synced across the fleet, so per-host state (quest-refresh counters, the
 *     telegram bot token env + enable/autostart, CLI / MCP server autostart)
 *     carries the host slug to avoid clobbering across machines.
 *
 * Both files are *section* documents: each subsystem owns one top-level key
 * (`questRefresh`, `telegram`, `cliServer`, `mcpServer`). Reads/writes are
 * section-scoped and preserve unknown sections, so the subsystems never tread on
 * each other when they share a file.
 *
 * This module is intentionally low-level (depends only on `utils/`), so any
 * handler/manager can import it without an import cycle.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { WsPaths } from '../utils/workspacePaths';
import { FsUtils } from '../utils/fsUtils';
import {
    getMcpServerSettings,
    type McpServerConfig,
    type ResolvedMcpServerSettings,
} from '../utils/sendToChatConfig';

// ============================================================================
// Section keys
// ============================================================================

/** Top-level section key in the machine file holding quest-refresh state. */
export const SECTION_QUEST_REFRESH = 'questRefresh';
/** Top-level section key (both files) holding telegram settings. */
export const SECTION_TELEGRAM = 'telegram';
/** Top-level section key in the machine file holding CLI-server autostart. */
export const SECTION_CLI_SERVER = 'cliServer';
/** Top-level section key in the machine file holding MCP-server autostart. */
export const SECTION_MCP_SERVER = 'mcpServer';

/**
 * Telegram fields that are machine-SPECIFIC and therefore live in the machine
 * file (each host runs its own bot token / enable / autostart). Everything else
 * (notification preferences, allow-list, chat id, poll interval) is
 * machine-independent and lives in the quest file.
 */
export const MACHINE_TELEGRAM_FIELDS: readonly string[] = ['enabled', 'autostart', 'botTokenEnv'];

// ============================================================================
// Path resolution
// ============================================================================

type Doc = Record<string, any>;

/** Normalise a quest id into a filename-safe segment, defaulting to `default`. */
function resolveQuestId(questId?: string): string {
    const q = (questId ?? WsPaths.getWorkspaceQuestId() ?? '').trim();
    const safe = (q || 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
    return safe || 'default';
}

/** Absolute path of `_ai/quests/{questId}/{fileName}`, with a workspace fallback. */
function questFilePath(safeQuest: string, fileName: string): string {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return (
        WsPaths.ai('quests', safeQuest, fileName) ||
        path.join(wsRoot, '_ai', 'quests', safeQuest, fileName)
    );
}

/** Path to the machine-INDEPENDENT quest config file. */
export function questConfigPath(questId?: string): string {
    const safeQuest = resolveQuestId(questId);
    return questFilePath(safeQuest, `extension_config.${safeQuest}.yaml`);
}

/** Path to the machine-SPECIFIC quest config file. */
export function machineConfigPath(questId?: string): string {
    const safeQuest = resolveQuestId(questId);
    return questFilePath(safeQuest, `extension_config.${WsPaths.hostSlug()}.${safeQuest}.yaml`);
}

// ============================================================================
// Whole-document IO
// ============================================================================

function readDoc(filePath: string): Doc {
    const raw = FsUtils.safeReadYaml<Doc>(filePath);
    return raw && typeof raw === 'object' ? raw : {};
}

/** Read the whole machine-independent quest document (`{}` when absent). */
export function readQuestDoc(questId?: string): Doc {
    return readDoc(questConfigPath(questId));
}

/** Read the whole machine-specific document (`{}` when absent). */
export function readMachineDoc(questId?: string): Doc {
    return readDoc(machineConfigPath(questId));
}

// ============================================================================
// Section-scoped IO (preserves unknown sections)
// ============================================================================

function readSection<T = any>(filePath: string, key: string): T | undefined {
    const doc = readDoc(filePath);
    const value = doc[key];
    return value === undefined ? undefined : (value as T);
}

function writeSection(filePath: string, key: string, value: unknown): void {
    const doc = readDoc(filePath);
    if (value === undefined) {
        delete doc[key];
    } else {
        doc[key] = value;
    }
    FsUtils.safeWriteYaml(filePath, doc);
}

/** Read one section of the machine-independent quest file. */
export function readQuestSection<T = any>(key: string, questId?: string): T | undefined {
    return readSection<T>(questConfigPath(questId), key);
}

/** Read one section of the machine-specific file. */
export function readMachineSection<T = any>(key: string, questId?: string): T | undefined {
    return readSection<T>(machineConfigPath(questId), key);
}

/** Write one section of the machine-independent quest file, preserving others. */
export function writeQuestSection(key: string, value: unknown, questId?: string): void {
    writeSection(questConfigPath(questId), key, value);
}

/** Write one section of the machine-specific file, preserving others. */
export function writeMachineSection(key: string, value: unknown, questId?: string): void {
    writeSection(machineConfigPath(questId), key, value);
}

// ============================================================================
// Typed helpers — CLI / MCP server autostart (machine file)
// ============================================================================

/** Whether the CLI integration server should auto-start on activation. */
export function getCliServerAutostart(questId?: string): boolean {
    return readMachineSection<{ autostart?: unknown }>(SECTION_CLI_SERVER, questId)?.autostart === true;
}

/** Persist the CLI integration server autostart flag (machine-scoped). */
export function setCliServerAutostart(value: boolean, questId?: string): void {
    writeMachineSection(SECTION_CLI_SERVER, { autostart: value === true }, questId);
}

/** Whether the standalone MCP server should auto-start on activation. */
export function getMcpServerAutostart(questId?: string): boolean {
    return readMachineSection<{ autostart?: unknown }>(SECTION_MCP_SERVER, questId)?.autostart === true;
}

/** Persist the MCP server autostart flag (machine-scoped). */
export function setMcpServerAutostart(value: boolean, questId?: string): void {
    writeMachineSection(SECTION_MCP_SERVER, { autostart: value === true }, questId);
}

// ============================================================================
// Typed helpers — MCP server settings (machine-INDEPENDENT quest file)
//
// All MCP settings other than `autostart` (enabled / host / basePort /
// apiKeyEnv / allowWriteWithoutAuth / toolsEnabled / enabledTools) are the same
// on every host, so they live in the quest file's `mcpServer` section. Only
// `autostart` is machine-scoped (the helpers above); these helpers deliberately
// never read or write it, so the two files never tread on each other.
// ============================================================================

/** Drop the machine-scoped `autostart` field so it never lands in the quest file. */
function stripMcpAutostart(raw: Doc): Doc {
    const out: Doc = {};
    for (const [key, value] of Object.entries(raw)) {
        if (key === 'autostart') { continue; }
        out[key] = value;
    }
    return out;
}

/** Read the machine-independent MCP server config from the quest file. */
export function getMcpServerConfig(questId?: string): McpServerConfig {
    const section = readQuestSection<Doc>(SECTION_MCP_SERVER, questId);
    if (!section || typeof section !== 'object') { return {}; }
    return stripMcpAutostart(section) as McpServerConfig;
}

/** Persist the machine-independent MCP server config to the quest file. */
export function setMcpServerConfig(config: McpServerConfig, questId?: string): void {
    const source = config && typeof config === 'object' ? (config as Doc) : {};
    writeQuestSection(SECTION_MCP_SERVER, stripMcpAutostart(source), questId);
}

/**
 * Fully-resolved MCP server settings sourced from the quest file and run through
 * the shared resolver (so the documented defaults apply consistently).
 */
export function readEffectiveMcpServerSettings(questId?: string): ResolvedMcpServerSettings {
    return getMcpServerSettings(getMcpServerConfig(questId));
}

// ============================================================================
// Telegram split / merge
// ============================================================================

/** Split a raw telegram object into its machine-specific subset. */
function machineTelegramSubset(raw: Doc): Doc {
    const out: Doc = {};
    for (const field of MACHINE_TELEGRAM_FIELDS) {
        if (raw[field] !== undefined) { out[field] = raw[field]; }
    }
    return out;
}

/** Split a raw telegram object into its machine-independent subset. */
function questTelegramSubset(raw: Doc): Doc {
    const out: Doc = {};
    for (const [key, value] of Object.entries(raw)) {
        if (key === 'botToken') { continue; } // never persisted (derived from env)
        if (MACHINE_TELEGRAM_FIELDS.includes(key)) { continue; }
        out[key] = value;
    }
    return out;
}

/**
 * Effective raw telegram settings: the machine-independent quest section
 * overlaid with the machine-specific section. Returns `undefined` when neither
 * section exists, so callers can fall back to a legacy source.
 */
export function readMergedTelegramRaw(questId?: string): Doc | undefined {
    const quest = readQuestSection<Doc>(SECTION_TELEGRAM, questId);
    const machine = readMachineSection<Doc>(SECTION_TELEGRAM, questId);
    if (quest === undefined && machine === undefined) { return undefined; }
    return { ...(quest ?? {}), ...(machine ?? {}) };
}

/**
 * Persist a raw telegram object by splitting it across the two files:
 * machine-specific fields to the machine file, the rest to the quest file. The
 * runtime-resolved `botToken` is never written (derived from the env var).
 */
export function writeSplitTelegramRaw(raw: Doc, questId?: string): void {
    const source = raw && typeof raw === 'object' ? raw : {};
    writeQuestSection(SECTION_TELEGRAM, questTelegramSubset(source), questId);
    writeMachineSection(SECTION_TELEGRAM, machineTelegramSubset(source), questId);
}

// ============================================================================
// One-time migration from the legacy per-subsystem files
// ============================================================================

/**
 * Migrate the legacy per-subsystem config files for a quest into the two
 * consolidated files. Idempotent: each piece is migrated only when the
 * destination section is still absent, so re-running on an already-migrated
 * quest is a no-op. The legacy files are NOT deleted here — removal from git is
 * a separate, deliberate step.
 *
 * Sources migrated:
 *   - `quest-refresh.{host}.{quest}.yaml`  → machine `questRefresh` section.
 *   - `telegram.{host}.{quest}.yaml`       → split telegram sections.
 *   - `tom_vscode_extension.json`          → machine `cliServer` / `mcpServer`
 *     autostart (from `bridge.cliServerAutostart` / `mcpServer.autoStart`) and
 *     the quest `mcpServer` section (the remaining, machine-independent MCP
 *     settings from the shared `mcpServer` block).
 */
export function migrateQuestExtensionConfig(questId?: string): void {
    const safeQuest = resolveQuestId(questId);
    migrateLegacyQuestRefresh(safeQuest);
    migrateLegacyTelegram(safeQuest);
    migrateLegacyAutostart(safeQuest);
    migrateLegacyMcpServerSettings(safeQuest);
}

function migrateLegacyQuestRefresh(safeQuest: string): void {
    if (readMachineSection(SECTION_QUEST_REFRESH, safeQuest) !== undefined) { return; }
    const legacyPath = questFilePath(
        safeQuest,
        `quest-refresh.${WsPaths.hostSlug()}.${safeQuest}.yaml`,
    );
    const legacy = FsUtils.safeReadYaml<Doc>(legacyPath);
    if (legacy && typeof legacy === 'object' && legacy.panels) {
        writeMachineSection(SECTION_QUEST_REFRESH, { panels: legacy.panels }, safeQuest);
    }
}

function migrateLegacyTelegram(safeQuest: string): void {
    if (readMergedTelegramRaw(safeQuest) !== undefined) { return; }
    const legacyPath = questFilePath(
        safeQuest,
        `telegram.${WsPaths.hostSlug()}.${safeQuest}.yaml`,
    );
    const legacy = FsUtils.safeReadYaml<Doc>(legacyPath);
    if (legacy && typeof legacy === 'object') {
        writeSplitTelegramRaw(legacy, safeQuest);
    }
}

function migrateLegacyAutostart(safeQuest: string): void {
    const cliMissing = readMachineSection(SECTION_CLI_SERVER, safeQuest) === undefined;
    const mcpMissing = readMachineSection(SECTION_MCP_SERVER, safeQuest) === undefined;
    if (!cliMissing && !mcpMissing) { return; }

    const legacy = readLegacyWorkspaceConfigRaw();
    if (!legacy) { return; }
    if (cliMissing && legacy.bridge?.cliServerAutostart !== undefined) {
        setCliServerAutostart(legacy.bridge.cliServerAutostart === true, safeQuest);
    }
    if (mcpMissing && legacy.mcpServer?.autoStart !== undefined) {
        setMcpServerAutostart(legacy.mcpServer.autoStart === true, safeQuest);
    }
}

/**
 * Migrate the machine-independent MCP server settings out of the shared
 * `tom_vscode_extension.json` `mcpServer` block into the quest file's
 * `mcpServer` section. Idempotent: only runs while the quest section is still
 * absent. The legacy `autoStart` field is intentionally NOT migrated here — it
 * is machine-scoped and handled by {@link migrateLegacyAutostart}.
 */
function migrateLegacyMcpServerSettings(safeQuest: string): void {
    if (readQuestSection(SECTION_MCP_SERVER, safeQuest) !== undefined) { return; }
    const legacy = readLegacyWorkspaceConfigRaw();
    const mcp = legacy?.mcpServer;
    if (!mcp || typeof mcp !== 'object') { return; }
    const settings = stripMcpAutostart(mcp);
    // `autoStart` was the legacy spelling of the machine-scoped autostart flag;
    // drop it too so only machine-independent settings reach the quest file.
    delete settings.autoStart;
    if (Object.keys(settings).length > 0) {
        writeQuestSection(SECTION_MCP_SERVER, settings, safeQuest);
    }
}

/**
 * Read the legacy workspace `tom_vscode_extension.json` raw, for the one-time
 * autostart migration. Resolves the workspace `.tom/` config (the primary
 * branch of the handler's config-path resolution); a missing/invalid file
 * yields `undefined`.
 */
function readLegacyWorkspaceConfigRaw(): Doc | undefined {
    const configPath = WsPaths.wsConfig(WsPaths.configFileName);
    if (!configPath) { return undefined; }
    return FsUtils.safeReadJson<Doc>(configPath);
}
