/**
 * Telegram Bot Command Handlers.
 *
 * Implements all commands available via the Telegram bot polling interface.
 * Each handler receives a ParsedTelegramCommand and returns a TelegramCommandResult.
 *
 * Commands:
 *   help [command]       — Show available commands or details for one
 *   ls [path]            — List files in current/given directory
 *   cd <path>            — Change working directory
 *   cwd                  — Show current working directory
 *   project [name]       — Change into a project root folder
 *   dart analyze         — Run dart analyze on current project
 *   problems             — Show VS Code Problems pane summary
 *   todos                — Show TODO/FIXME comments from Problems pane
 *   bk [args...]         — Run buildkit with arguments
 *   tk [args...]         — Run testkit with arguments
 *   bridge <restart|stop|mode> — Control the Dart bridge
 *   cli-integration <start|stop> [port] — CLI integration server
 *   status               — Workspace/polling status overview
 *   stop                 — Stop Telegram polling
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { bridgeLog, getWorkspaceRoot, getBridgeClient, getConfigPath } from './handler_shared';
import {
    TelegramCommandRegistry,
    TelegramCommandResult,
    ParsedTelegramCommand,
} from './telegram-cmd-parser';
import { escapeMarkdownV2 } from './telegram-markdown';
import { findNearestDetectedProject, scanWorkspaceProjectsByDetectors } from '../utils/projectDetector';
import {
    parseSendPromptArgs,
    isSendPromptParseError,
    SEND_PROMPT_USAGE,
} from '../utils/telegramSendPrompt';
import {
    parseQueuePromptArgs,
    parseQueueDeleteArg,
    isQueueCommandParseError,
    QUEUE_PROMPT_USAGE,
    QUEUE_DELETE_USAGE,
} from '../utils/telegramQueueCommands';
import type { LiveConversationStatus } from './telegramTrailForwarder';
import type { SendToChatOutcome } from './sendToChatRouter';

// ============================================================================
// State — virtual working directory for the Telegram session
// ============================================================================

let telegramCwd: string = '';

/** Get the current Telegram working directory (initializes to workspace root). */
function getCwd(): string {
    if (!telegramCwd) {
        telegramCwd = getWorkspaceRoot() ?? process.cwd();
    }
    return telegramCwd;
}

/** Resolve a path relative to the current Telegram working directory. */
function resolvePath(p: string): string {
    if (path.isAbsolute(p)) { return p; }
    return path.resolve(getCwd(), p);
}

/** Format a path relative to the workspace root for display. */
function displayPath(absPath: string): string {
    const wsRoot = getWorkspaceRoot();
    if (wsRoot && absPath.startsWith(wsRoot)) {
        const rel = path.relative(wsRoot, absPath);
        return rel || path.basename(wsRoot);
    }
    return absPath;
}

/** Escape text for Telegram MarkdownV2 (escape special chars in user-supplied text). */
const esc = escapeMarkdownV2;

// ============================================================================
// Project discovery
// ============================================================================

interface ProjectInfo {
    name: string;
    absPath: string;
}

/** Discover workspace projects via configurable detector rules. */
function discoverProjects(): ProjectInfo[] {
    return scanWorkspaceProjectsByDetectors(5).map((project) => ({
        name: project.name,
        absPath: project.absolutePath,
    }));
}

/** Find a project by name (case-insensitive, partial match). */
function findProject(name: string): ProjectInfo | undefined {
    const projects = discoverProjects();
    const lower = name.toLowerCase();

    // Exact match first
    const exact = projects.find(p => p.name.toLowerCase() === lower);
    if (exact) { return exact; }

    // Prefix match
    return projects.find(p => p.name.toLowerCase().startsWith(lower));
}

/** Detect the closest configured project from a directory. */
function detectProject(fromDir: string): ProjectInfo | undefined {
    const project = findNearestDetectedProject(fromDir);
    if (!project) {
        return undefined;
    }
    return {
        name: project.name,
        absPath: project.absolutePath,
    };
}

// ============================================================================
// Shell command executor
// ============================================================================

/** Run a shell command and return stdout + stderr. Pass timeoutMs=0 for no timeout. */
function execShell(cmd: string, cwd: string, timeoutMs: number = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
        exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
            resolve({
                stdout: stdout?.toString() ?? '',
                stderr: stderr?.toString() ?? '',
                exitCode: error?.code ?? (error ? 1 : 0),
            });
        });
    });
}

// ============================================================================
// Command handlers
// ============================================================================

// --- /help ---
async function helpHandler(cmd: ParsedTelegramCommand, registry: TelegramCommandRegistry): Promise<TelegramCommandResult> {
    const topic = cmd.args[0];
    return { text: registry.generateHelp(topic) };
}

// --- /ls ---
async function lsHandler(cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    const targetDir = cmd.args.length > 0 ? resolvePath(cmd.args[0]) : getCwd();

    if (!fs.existsSync(targetDir)) {
        return { text: `❌ Directory not found: ${displayPath(targetDir)}` };
    }
    if (!fs.statSync(targetDir).isDirectory()) {
        return { text: `❌ Not a directory: ${displayPath(targetDir)}` };
    }

    try {
        const entries = fs.readdirSync(targetDir, { withFileTypes: true });
        const lines: string[] = [`📂 *${esc(displayPath(targetDir))}*\n`];

        // Sort: directories first, then files
        const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
        const files = entries.filter(e => !e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

        for (const d of dirs) {
            // Show all directories including hidden ones
            lines.push(`📁 ${esc(d.name)}/`);
        }
        for (const f of files) {
            if (f.name.startsWith('.') && f.name !== '.gitignore') { continue; }
            lines.push(`   ${esc(f.name)}`);
        }

        lines.push(`\n_${dirs.length} dirs, ${files.length} files_`);
        return { text: lines.join('\n'), attachmentFilename: 'ls_output.txt' };
    } catch (err: any) {
        return { text: `❌ Error listing directory: ${err.message}` };
    }
}

// --- /cd ---
async function cdHandler(cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    if (cmd.args.length === 0) {
        // cd with no args → go to workspace root
        telegramCwd = getWorkspaceRoot() ?? process.cwd();
        return { text: `📂 ${esc(displayPath(telegramCwd))}` };
    }

    const target = resolvePath(cmd.args.join(' '));

    if (!fs.existsSync(target)) {
        return { text: `❌ Directory not found: ${esc(cmd.args.join(' '))}` };
    }
    if (!fs.statSync(target).isDirectory()) {
        return { text: `❌ Not a directory: ${esc(cmd.args.join(' '))}` };
    }

    telegramCwd = target;
    return { text: `📂 ${esc(displayPath(telegramCwd))}` };
}

// --- /cwd ---
async function cwdHandler(_cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    const cwd = getCwd();
    const project = detectProject(cwd);
    let text = `📂 *Current directory:*\n${esc(displayPath(cwd))}`;
    if (project) {
        text += `\n📦 *Project:* ${esc(project.name)}`;
    }
    return { text };
}

// --- /project ---
async function projectHandler(cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    if (cmd.args.length === 0) {
        // List all projects
        const projects = discoverProjects();
        if (projects.length === 0) {
            return { text: '❌ No projects found in workspace.' };
        }

        const wsRoot = getWorkspaceRoot() ?? '';
        const lines = ['📦 *Projects*\n'];
        for (const p of projects.sort((a, b) => a.name.localeCompare(b.name))) {
            const relPath = wsRoot ? path.relative(wsRoot, p.absPath) : p.absPath;
            lines.push(`• \`${esc(p.name)}\` — ${esc(relPath)}`);
        }
        return { text: lines.join('\n'), attachmentFilename: 'projects.txt' };
    }

    const name = cmd.args.join(' ');
    const project = findProject(name);

    if (!project) {
        return { text: `❌ Project not found: ${name}\nUse /project to list all projects.` };
    }

    telegramCwd = project.absPath;
    return { text: `📦 Switched to *${esc(project.name)}*\n📂 ${esc(displayPath(project.absPath))}` };
}

// --- /dart analyze ---
async function dartHandler(cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    if (!cmd.subcommand || cmd.subcommand !== 'analyze') {
        return { text: '❌ Usage: dart analyze [project]\nRuns `dart analyze` on the current or specified project.' };
    }

    let targetDir = getCwd();

    // If a project name is provided as an arg, use it
    if (cmd.args.length > 0) {
        const project = findProject(cmd.args[0]);
        if (project) {
            targetDir = project.absPath;
        } else {
            return { text: `❌ Project not found: ${cmd.args[0]}` };
        }
    }

    // Verify it's a Dart project
    const project = detectProject(targetDir);
    if (!project) {
        return { text: `❌ No Dart project found at ${displayPath(targetDir)}.\nUse /project <name> to switch to a project first.` };
    }

    const { stdout, stderr, exitCode } = await execShell('dart analyze', project.absPath, 0);
    const output = (stdout + '\n' + stderr).trim();
    const icon = exitCode === 0 ? '✅' : '❌';

    return {
        text: `${icon} *dart analyze* — ${project.name}\n\`\`\`\n${output}\n\`\`\``,
        attachmentFilename: `analyze_${project.name}.txt`,
    };
}

// --- /problems ---
async function problemsHandler(_cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    const diagnostics = vscode.languages.getDiagnostics();

    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    const fileIssues: { file: string; errors: number; warnings: number; infos: number }[] = [];

    for (const [uri, diags] of diagnostics) {
        if (diags.length === 0) { continue; }
        let e = 0, w = 0, i = 0;
        for (const d of diags) {
            if (d.severity === vscode.DiagnosticSeverity.Error) { e++; errorCount++; }
            else if (d.severity === vscode.DiagnosticSeverity.Warning) { w++; warningCount++; }
            else { i++; infoCount++; }
        }
        const wsRoot = getWorkspaceRoot() ?? '';
        const relPath = wsRoot ? path.relative(wsRoot, uri.fsPath) : uri.fsPath;
        fileIssues.push({ file: relPath, errors: e, warnings: w, infos: i });
    }

    if (fileIssues.length === 0) {
        return { text: '✅ *No problems* in the workspace.' };
    }

    // Sort by errors descending
    fileIssues.sort((a, b) => b.errors - a.errors || b.warnings - a.warnings);

    const lines = [
        `⚠️ *Problems Summary*`,
        `❌ ${errorCount} errors | ⚠️ ${warningCount} warnings | ℹ️ ${infoCount} info\n`,
    ];

    // Show top files (limit to 20)
    const shown = fileIssues.slice(0, 20);
    for (const fi of shown) {
        const parts: string[] = [];
        if (fi.errors > 0) { parts.push(`${fi.errors}E`); }
        if (fi.warnings > 0) { parts.push(`${fi.warnings}W`); }
        if (fi.infos > 0) { parts.push(`${fi.infos}I`); }
        lines.push(`• ${esc(fi.file)} (${parts.join(', ')})`);
    }
    if (fileIssues.length > 20) {
        lines.push(`\n_... and ${fileIssues.length - 20} more files_`);
    }

    return { text: lines.join('\n'), attachmentFilename: 'problems.txt' };
}

// --- /todos ---
async function todosHandler(_cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    // Collect TODO/FIXME/HACK diagnostics from the problems pane
    const diagnostics = vscode.languages.getDiagnostics();
    const todoItems: { file: string; line: number; message: string }[] = [];

    for (const [uri, diags] of diagnostics) {
        for (const d of diags) {
            const msg = d.message.toLowerCase();
            if (msg.includes('todo') || msg.includes('fixme') || msg.includes('hack')) {
                const wsRoot = getWorkspaceRoot() ?? '';
                const relPath = wsRoot ? path.relative(wsRoot, uri.fsPath) : uri.fsPath;
                todoItems.push({
                    file: relPath,
                    line: d.range.start.line + 1,
                    message: d.message,
                });
            }
        }
    }

    if (todoItems.length === 0) {
        return { text: '✅ *No TODOs/FIXMEs* found in Problems pane.' };
    }

    const lines = [`📝 *TODOs/FIXMEs* (${todoItems.length})\n`];
    for (const item of todoItems.slice(0, 30)) {
        lines.push(`• ${esc(item.file)}:${item.line} — ${esc(item.message)}`);
    }
    if (todoItems.length > 30) {
        lines.push(`\n_... and ${todoItems.length - 30} more_`);
    }

    return { text: lines.join('\n'), attachmentFilename: 'todos.txt' };
}

/**
 * Normalize Telegram "smart typography" back to plain ASCII.
 * Telegram converts -- to em-dash, etc. We need to reverse this for CLI args.
 */
function normalizeArgs(args: string): string {
    return args
        .replace(/—/g, '--')   // em-dash → double hyphen
        .replace(/–/g, '-')    // en-dash → single hyphen  
        .replace(/'/g, "'")    // smart single quote
        .replace(/'/g, "'")    // smart single quote
        .replace(/"/g, '"')    // smart double quote
        .replace(/"/g, '"');   // smart double quote
}

// --- bk (buildkit) ---
async function bkHandler(cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    const cwd = getCwd();
    const args = normalizeArgs(cmd.rawArgs);
    const fullCmd = args ? `buildkit ${args}` : 'buildkit';

    bridgeLog(`[Telegram] Running: ${fullCmd} in ${cwd}`);
    const { stdout, stderr, exitCode } = await execShell(fullCmd, cwd, 0);
    const output = (stdout + '\n' + stderr).trim();
    const icon = exitCode === 0 ? '✅' : '❌';

    return {
        text: `${icon} *buildkit ${esc(args)}*\n\`\`\`\n${output}\n\`\`\``,
        attachmentFilename: `buildkit_output.txt`,
    };
}

// --- tk (testkit) ---
async function tkHandler(cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    const cwd = getCwd();
    const args = normalizeArgs(cmd.rawArgs);
    const fullCmd = args ? `testkit ${args}` : 'testkit';

    bridgeLog(`[Telegram] Running: ${fullCmd} in ${cwd}`);
    const { stdout, stderr, exitCode } = await execShell(fullCmd, cwd, 0);
    const output = (stdout + '\n' + stderr).trim();
    const icon = exitCode === 0 ? '✅' : '❌';

    return {
        text: `${icon} *testkit ${esc(args)}*\n\`\`\`\n${output}\n\`\`\``,
        attachmentFilename: `testkit_output.txt`,
    };
}

// --- /bridge ---
async function bridgeHandler(cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    if (!cmd.subcommand) {
        return { text: '❌ Usage: bridge <restart|stop|mode>\n\n• bridge restart — Restart the Dart bridge\n• bridge stop — Stop the Dart bridge\n• bridge mode <dev|prod> — Switch bridge mode' };
    }

    switch (cmd.subcommand) {
        case 'restart':
            await vscode.commands.executeCommand('tomAi.bridge.restart');
            return { text: '🔄 *Bridge restart* initiated.' };

        case 'stop': {
            const client = getBridgeClient();
            if (client) {
                try {
                    client.stop();
                    return { text: '⏹ *Bridge stopped.*' };
                } catch (err: any) {
                    return { text: `❌ Failed to stop bridge: ${err.message}` };
                }
            }
            return { text: '⚠️ Bridge is not running.' };
        }

        case 'mode': {
            const mode = cmd.args[0]?.toLowerCase();
            if (!mode || !['development', 'production', 'dev', 'prod'].includes(mode)) {
                return { text: '❌ Usage: bridge mode <development|production>' };
            }
            // Map short names to profile keys
            const profileKey = (mode === 'dev' || mode === 'development') ? 'development' : 'production';

            // Directly write the profile to config and restart
            const configPath = getConfigPath();
            if (configPath && fs.existsSync(configPath)) {
                try {
                    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                    if (raw.bridge?.profiles?.[profileKey]) {
                        raw.bridge.current = profileKey;
                        fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
                        // Restart bridge with new profile
                        await vscode.commands.executeCommand('tomAi.bridge.restart');
                        return { text: `🔄 *Bridge mode switched to ${profileKey}* and restarting.` };
                    } else {
                        return { text: `❌ Profile '${profileKey}' not found in config.` };
                    }
                } catch (err: any) {
                    return { text: `❌ Failed to switch profile: ${err.message}` };
                }
            }
            return { text: '❌ Config file not found.' };
        }

        default:
            return { text: `❌ Unknown bridge subcommand: ${cmd.subcommand}\nUse: restart, stop, mode` };
    }
}

// --- /cli-integration ---
async function cliIntegrationHandler(cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    if (!cmd.subcommand) {
        return { text: '❌ Usage: cli-integration <start|stop> [port]\n\n• cli-integration start [port] — Start CLI server\n• cli-integration stop — Stop CLI server' };
    }

    switch (cmd.subcommand) {
        case 'start': {
            if (cmd.args.length > 0) {
                // Custom port — delegates to startCliServerCustomPort which uses an input box.
                // We can't easily pass the port, so just trigger the standard start.
                await vscode.commands.executeCommand('tomAi.cliServer.start');
            } else {
                await vscode.commands.executeCommand('tomAi.cliServer.start');
            }
            return { text: '▶️ *CLI Integration Server* start initiated.' };
        }

        case 'stop':
            await vscode.commands.executeCommand('tomAi.cliServer.stop');
            return { text: '⏹ *CLI Integration Server* stop initiated.' };

        default:
            return { text: `❌ Unknown subcommand: ${cmd.subcommand}\nUse: start, stop` };
    }
}

// --- /status ---
async function statusHandler(_cmd: ParsedTelegramCommand): Promise<TelegramCommandResult> {
    const wsRoot = getWorkspaceRoot();
    const cwd = getCwd();
    const project = detectProject(cwd);

    const lines = [
        `📊 *Status*\n`,
        `*Workspace:* ${wsRoot ? path.basename(wsRoot) : 'none'}`,
        `*CWD:* ${esc(displayPath(cwd))}`,
        project ? `*Project:* ${esc(project.name)}` : '*Project:* (none)',
        `*Time:* ${new Date().toLocaleString()}`,
    ];

    // Check bridge status
    const client = getBridgeClient();
    lines.push(`*Bridge:* ${client ? 'running' : 'not running'}`);

    return { text: lines.join('\n') };
}

// ============================================================================
// Live-conversation commands — send_prompt / chat_silent / chat_listen / chat_status
// ============================================================================

/**
 * Controls the persistent live-conversation forwarder owns. Passed in so the
 * command handlers can toggle listening mode and report running state without
 * importing the forwarder wiring directly.
 */
export interface LiveConversationControls {
    /** Stream live updates (`true`) or only the final answer (`false`). */
    setListening(on: boolean): void;
    /** Whether live updates are currently streamed. */
    isListening(): boolean;
    /** Master switch: forward anything (`true`) or nothing at all (`false`). */
    setForwarding(on: boolean): void;
    /** Whether any messages are forwarded at all (master switch). */
    isForwarding(): boolean;
    /** Snapshot of the running prompt + listening mode. */
    getStatus(): LiveConversationStatus;
}

/**
 * Dependencies the live-conversation commands need from the extension host.
 * Passed in (rather than imported here) so the command-handler module stays
 * free of the chat-panel / router wiring and is easy to unit-test, and so the
 * registry can be built without these when no extension context is available.
 */
export interface CommandRegistryDeps {
    /** Extension context, threaded into the Anthropic send path. */
    context: vscode.ExtensionContext;
    /** Run a prompt exactly as a panel send would; resolves with the outcome. */
    runAnthropicSend: (
        context: vscode.ExtensionContext,
        prompt: string,
    ) => Promise<SendToChatOutcome>;
    /**
     * Cancel the running **direct** chat prompt (panel Send / Send-to-Chat /
     * Telegram `send_prompt`), like the chat panel's Stop button. Returns `true`
     * if a prompt was running and was cancelled.
     */
    cancelChat: () => boolean;
    /**
     * Cancel the running **queue** prompt, like the queue's Stop button. Returns
     * `true` if a queue item was running and was cancelled.
     */
    cancelQueue: () => boolean;
    /** Controls for the persistent live-conversation forwarder. */
    liveConversation: LiveConversationControls;
    /** Controls for the prompt queue (queue_prompt / queue_list / …). */
    queue: QueueControls;
}

/** One sending/pending queue entry, for `queue_list` rendering. */
export interface QueueListEntry {
    /** Lifecycle status — only `'sending'` or `'pending'` are listed. */
    status: 'sending' | 'pending';
    /** Original prompt text (untruncated; the handler abbreviates for display). */
    preview: string;
}

/** Result of a `queue_delete` request. */
export interface QueueDeleteResult {
    /** True when an entry at the requested index was removed. */
    ok: boolean;
    /** A user-facing message (the removed preview, or why nothing happened). */
    message: string;
}

/**
 * Host wiring for the prompt-queue commands. Passed in (rather than importing
 * {@link PromptQueueManager} here) so this module stays free of manager wiring
 * and is easy to unit-test.
 */
export interface QueueControls {
    /**
     * Add a prompt to the queue. `repeatCount` repeats it; `next` queues it at
     * the top so it is dispatched next.
     */
    addPrompt: (prompt: string, opts: { repeatCount?: number; next: boolean }) => Promise<void>;
    /** The sending + pending entries, in queue order. */
    list: () => QueueListEntry[];
    /** Delete the entry at a 1-based index within {@link list}. */
    deleteAt: (oneBasedIndex: number) => QueueDeleteResult;
    /** Toggle pause/resume. Returns `true` when the queue is now running. */
    togglePause: () => boolean;
    /** Whether the queue is currently running (auto-send on) vs paused. */
    isRunning: () => boolean;
}

/** Render an elapsed-milliseconds duration as a compact `Xm Ys` / `Ys` string. */
function formatElapsed(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/**
 * Handle `send_prompt <prompt text>` — run a prompt in *this* window's Anthropic
 * chat exactly as a panel send would. Settings are per workspace/quest, so the
 * window that polls the bot is the one that runs the prompt — no quest selector.
 *
 * The turn runs **headless** — the @CHAT panel need not be open. The Anthropic
 * handler writes the turn to `live-trail.md` regardless, and the result is
 * mirrored into the panel only when it happens to be open. Progress is forwarded
 * by the persistent live-conversation forwarder (always subscribed), so this
 * handler stays quiet on success. If a prompt is already running — whether
 * started here or from VS Code — the send is rejected with an informative
 * message (the prompt queue, not Telegram, owns queuing).
 */
async function sendPromptHandler(
    cmd: ParsedTelegramCommand,
    deps: CommandRegistryDeps,
): Promise<TelegramCommandResult> {
    const parsed = parseSendPromptArgs(cmd.rawArgs);
    if (isSendPromptParseError(parsed)) {
        return { text: `❌ ${parsed.error}`, rawText: true };
    }

    bridgeLog(`[Telegram] send_prompt (${parsed.prompt.length} chars)`);

    const outcome = await deps.runAnthropicSend(deps.context, parsed.prompt);

    if (outcome.rejected) {
        const status = deps.liveConversation.getStatus();
        // The rejection comes from the direct-send guard, so report the chat
        // prompt's elapsed time when we have it.
        const chat = status.running.find((r) => r.source === 'chat');
        const elapsed = chat ? ` (running for ${formatElapsed(chat.elapsedMs)})` : '';
        return {
            text:
                `⏳ A prompt is already running in this quest${elapsed}. ` +
                'Your new prompt was not started — try again once the current one finishes.',
            rawText: true,
        };
    }
    if (!outcome.ok) {
        return { text: `❌ Prompt failed: ${outcome.error ?? 'unknown error'}`, rawText: true };
    }
    // The live-conversation forwarder already delivered the answer (streamed in
    // listening mode, or the final answer in silent mode), so stay quiet.
    return { text: '', rawText: true, silent: true };
}

/** Handle `chat_silent` — suppress live updates; only the final answer is sent. */
async function chatSilentHandler(deps: CommandRegistryDeps): Promise<TelegramCommandResult> {
    deps.liveConversation.setListening(false);
    return {
        text: '🔇 Silent mode: live updates muted. You will still receive the final answer.',
        rawText: true,
    };
}

/** Handle `chat_listen` — resume streaming the live conversation. */
async function chatListenHandler(deps: CommandRegistryDeps): Promise<TelegramCommandResult> {
    deps.liveConversation.setListening(true);
    return {
        text: '🔊 Listening: you will now receive live updates from the running prompt.',
        rawText: true,
    };
}

/**
 * Handle `chat_start` — turn the master forwarding switch on so messages from
 * the running (and future) prompts are sent again. Does not touch the
 * listening/silent mode, which resumes at whatever it was.
 */
async function chatStartHandler(deps: CommandRegistryDeps): Promise<TelegramCommandResult> {
    deps.liveConversation.setForwarding(true);
    const mode = deps.liveConversation.isListening() ? '🔊 listening' : '🔇 silent';
    return {
        text: `▶️ Forwarding on. You will receive chat messages again (mode: ${mode}).`,
        rawText: true,
    };
}

/**
 * Handle `chat_stop` — turn the master forwarding switch off so *nothing* is
 * sent, not even the prompt restatement or final answer. Lets the user drive
 * the bot without a running chat interrupting. `chat_start` re-enables it.
 */
async function chatStopHandler(deps: CommandRegistryDeps): Promise<TelegramCommandResult> {
    deps.liveConversation.setForwarding(false);
    return {
        text: '⏹ Forwarding off. No chat messages will be sent (not even prompts or final answers). Send chat_start to resume.',
        rawText: true,
    };
}

/**
 * Handle `chat_status` — report which prompt(s) are running and for how long.
 * The queue and a direct chat send can run concurrently, so this emits one
 * block per running source (📋 queue / 💬 direct).
 */
async function chatStatusHandler(deps: CommandRegistryDeps): Promise<TelegramCommandResult> {
    const status = deps.liveConversation.getStatus();
    const forwarding = status.forwarding ? '▶️ on' : '⏹ off';
    const mode = status.listening ? '🔊 listening' : '🔇 silent';
    const pending = deps.queue.list().filter((e) => e.status === 'pending').length;
    const queueState = deps.queue.isRunning() ? '▶️ running' : '⏸ paused';
    const stateLines =
        `Forwarding: ${forwarding}\n` +
        `Mode: ${mode}\n` +
        `Queue: ${queueState} (${pending} pending)`;
    if (status.running.length === 0) {
        return { text: `💤 No prompt is running.\n${stateLines}`, rawText: true };
    }
    const blocks = status.running.map((r) => {
        const label = r.source === 'queue' ? '📋 Queue prompt' : '💬 Direct prompt';
        const where = [r.transport, r.config].filter(Boolean).join('/');
        const whereLine = where ? ` [${where}]` : '';
        return `${label}${whereLine} — running ${formatElapsed(r.elapsedMs)}`;
    });
    return {
        text: `⏳ ${status.running.length} prompt(s) running:\n${blocks.join('\n')}\n${stateLines}`,
        rawText: true,
    };
}

/**
 * Handle `cancel_chat` — interrupt the running **direct** chat prompt (panel
 * Send / Send-to-Chat / `send_prompt`), like clicking Stop in the chat panel.
 */
async function cancelChatHandler(deps: CommandRegistryDeps): Promise<TelegramCommandResult> {
    const cancelled = deps.cancelChat();
    return {
        text: cancelled
            ? '🛑 Cancelled the running direct chat prompt.'
            : 'ℹ️ No direct chat prompt is currently running.',
        rawText: true,
    };
}

/**
 * Handle `cancel_queue` — interrupt the running **queue** prompt, like clicking
 * Stop on the active queue item.
 */
async function cancelQueueHandler(deps: CommandRegistryDeps): Promise<TelegramCommandResult> {
    const cancelled = deps.cancelQueue();
    return {
        text: cancelled
            ? '🛑 Cancelled the running queue prompt.'
            : 'ℹ️ No queue prompt is currently running.',
        rawText: true,
    };
}

/**
 * Handle `queue_prompt [count] [next] <prompt>` — add a prompt to the queue.
 * `count` repeats it; `next` queues it at the top so it is dispatched next.
 */
async function queuePromptHandler(
    cmd: ParsedTelegramCommand,
    deps: CommandRegistryDeps,
): Promise<TelegramCommandResult> {
    const parsed = parseQueuePromptArgs(cmd.rawArgs);
    if (isQueueCommandParseError(parsed)) {
        return { text: `❌ ${parsed.error}`, rawText: true };
    }
    await deps.queue.addPrompt(parsed.prompt, {
        ...(parsed.repeatCount !== undefined ? { repeatCount: parsed.repeatCount } : {}),
        next: parsed.next,
    });
    const bits = [
        parsed.next ? 'at the top' : 'to the queue',
        parsed.repeatCount ? `×${parsed.repeatCount}` : '',
    ].filter(Boolean).join(' ');
    return {
        text: `✅ Queued ${bits}: ${abbreviate(parsed.prompt, 80)}`,
        rawText: true,
    };
}

/** Handle `queue_list` — show sending/pending queue items with 1-based indices. */
async function queueListHandler(deps: CommandRegistryDeps): Promise<TelegramCommandResult> {
    const entries = deps.queue.list();
    if (entries.length === 0) {
        return { text: '📭 The prompt queue is empty.', rawText: true };
    }
    const running = deps.queue.isRunning() ? '▶️ running' : '⏸ paused';
    const lines = entries.map((e, i) => {
        const marker = e.status === 'sending' ? '▶️' : '•';
        return `${i + 1}. ${marker} ${abbreviate(e.preview, 80)}`;
    });
    return {
        text: `📋 Prompt queue (${running}):\n${lines.join('\n')}`,
        rawText: true,
    };
}

/** Handle `queue_delete <index>` — remove the entry at a 1-based queue index. */
async function queueDeleteHandler(
    cmd: ParsedTelegramCommand,
    deps: CommandRegistryDeps,
): Promise<TelegramCommandResult> {
    const parsed = parseQueueDeleteArg(cmd.rawArgs);
    if (isQueueCommandParseError(parsed)) {
        return { text: `❌ ${parsed.error}`, rawText: true };
    }
    const result = deps.queue.deleteAt(parsed);
    return { text: result.message, rawText: true };
}

/** Handle `queue_pause` — toggle queue execution; report the new state. */
async function queuePauseHandler(deps: CommandRegistryDeps): Promise<TelegramCommandResult> {
    const running = deps.queue.togglePause();
    return {
        text: running
            ? '▶️ Queue resumed — pending prompts will be sent.'
            : '⏸ Queue paused — no new prompts will be sent until you resume.',
        rawText: true,
    };
}

/** Abbreviate a single-line preview of `text` to at most `max` chars. */
function abbreviate(text: string, max: number): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

// ============================================================================
// Registry setup
// ============================================================================

/**
 * Create and populate the command registry with all available commands.
 * The registry is used by the standalone polling handler to dispatch commands.
 *
 * @param stopCallback Called when /stop is received to stop polling.
 * @param deps         Optional host wiring enabling the `send_prompt` command.
 *                     Omitted when no extension context is available — the
 *                     command is then simply not registered.
 */
export function createCommandRegistry(
    stopCallback: () => void,
    deps?: CommandRegistryDeps,
): TelegramCommandRegistry {
    const registry = new TelegramCommandRegistry();

    // /help
    registry.register({
        name: 'help',
        description: 'Show available commands or details for one',
        usage: 'help [command]',
        handler: (cmd) => helpHandler(cmd, registry),
    });

    // /ls
    registry.register({
        name: 'ls',
        description: 'List files in current or given directory',
        usage: 'ls [path]',
        handler: lsHandler,
    });

    // /cd
    registry.register({
        name: 'cd',
        description: 'Change working directory',
        usage: 'cd <path>',
        handler: cdHandler,
    });

    // /cwd
    registry.register({
        name: 'cwd',
        description: 'Show current working directory',
        handler: cwdHandler,
    });

    // /project
    registry.register({
        name: 'project',
        description: 'List projects or switch to a project root',
        usage: 'project [name]',
        handler: projectHandler,
    });

    // /dart
    registry.register({
        name: 'dart',
        description: 'Run Dart tooling commands',
        usage: 'dart analyze [project]',
        subcommands: [
            { name: 'analyze', description: 'Run dart analyze', usage: 'dart analyze [project]' },
        ],
        handler: dartHandler,
        startMessage: '⏳ Running dart {args}...',
    });

    // /problems
    registry.register({
        name: 'problems',
        description: 'Show VS Code Problems pane summary',
        handler: problemsHandler,
    });

    // /todos
    registry.register({
        name: 'todos',
        description: 'Show TODOs/FIXMEs from Problems pane',
        handler: todosHandler,
    });

    // bk (buildkit)
    registry.register({
        name: 'bk',
        description: 'Run buildkit with arguments',
        usage: 'bk [args...]',
        handler: bkHandler,
        startMessage: '⏳ Running buildkit {args}...',
    });
    registry.register({
        name: 'buildkit',
        description: 'Run buildkit with arguments (alias: bk)',
        usage: 'buildkit [args...]',
        handler: bkHandler,
        startMessage: '⏳ Running buildkit {args}...',
    });

    // tk (testkit)
    registry.register({
        name: 'tk',
        description: 'Run testkit with arguments',
        usage: 'tk [args...]',
        handler: tkHandler,
        startMessage: '⏳ Running testkit {args}...',
    });
    registry.register({
        name: 'testkit',
        description: 'Run testkit with arguments (alias: tk)',
        usage: 'testkit [args...]',
        handler: tkHandler,
        startMessage: '⏳ Running testkit {args}...',
    });

    // /bridge
    registry.register({
        name: 'bridge',
        description: 'Control the Dart bridge',
        usage: 'bridge <restart|stop|mode>',
        subcommands: [
            { name: 'restart', description: 'Restart the Dart bridge' },
            { name: 'stop', description: 'Stop the Dart bridge' },
            { name: 'mode', description: 'Switch bridge profile', usage: 'bridge mode <dev|prod>' },
        ],
        handler: bridgeHandler,
    });

    // /cli-integration
    registry.register({
        name: 'cli-integration',
        description: 'Control CLI Integration Server',
        usage: 'cli-integration <start|stop> [port]',
        subcommands: [
            { name: 'start', description: 'Start the CLI server', usage: 'cli-integration start [port]' },
            { name: 'stop', description: 'Stop the CLI server' },
        ],
        handler: cliIntegrationHandler,
    });

    // /status
    registry.register({
        name: 'status',
        description: 'Show workspace and polling status',
        handler: statusHandler,
    });

    // Live-conversation commands — need host wiring (Anthropic send path +
    // the persistent forwarder). Omitted when no extension context is available.
    if (deps) {
        registry.register({
            name: 'send_prompt',
            description: 'Run a prompt in this quest window\'s Anthropic chat',
            usage: SEND_PROMPT_USAGE,
            handler: (cmd) => sendPromptHandler(cmd, deps),
        });
        registry.register({
            name: 'chat_silent',
            description: 'Mute live updates (still receive the final answer)',
            handler: () => chatSilentHandler(deps),
        });
        registry.register({
            name: 'chat_listen',
            description: 'Resume streaming the live conversation',
            handler: () => chatListenHandler(deps),
        });
        registry.register({
            name: 'chat_start',
            description: 'Turn chat forwarding on (send prompts/answers again)',
            handler: () => chatStartHandler(deps),
        });
        registry.register({
            name: 'chat_stop',
            description: 'Turn chat forwarding off (suppress all chat messages)',
            handler: () => chatStopHandler(deps),
        });
        registry.register({
            name: 'chat_status',
            description: 'Show whether a prompt is running and for how long',
            handler: () => chatStatusHandler(deps),
        });
        registry.register({
            name: 'cancel_chat',
            description: 'Stop the running direct chat prompt (like the chat Stop button)',
            handler: () => cancelChatHandler(deps),
        });
        registry.register({
            name: 'cancel_queue',
            description: 'Stop the running queue prompt (like the queue Stop button)',
            handler: () => cancelQueueHandler(deps),
        });
        registry.register({
            name: 'queue_prompt',
            description: 'Add a prompt to the queue (optional count / next)',
            usage: QUEUE_PROMPT_USAGE,
            handler: (cmd) => queuePromptHandler(cmd, deps),
        });
        registry.register({
            name: 'queue_list',
            description: 'List sending/pending prompts in the queue',
            handler: () => queueListHandler(deps),
        });
        registry.register({
            name: 'queue_delete',
            description: 'Delete a queued prompt by its queue_list index',
            usage: QUEUE_DELETE_USAGE,
            handler: (cmd) => queueDeleteHandler(cmd, deps),
        });
        registry.register({
            name: 'queue_pause',
            description: 'Toggle queue execution (pause/resume)',
            handler: () => queuePauseHandler(deps),
        });
    }

    // /stop — special: triggers the stop callback
    registry.register({
        name: 'stop',
        description: 'Stop Telegram polling',
        handler: async (_cmd) => {
            stopCallback();
            return { text: '⏹ Polling stopped via stop command.', silent: true };
        },
    });

    return registry;
}
