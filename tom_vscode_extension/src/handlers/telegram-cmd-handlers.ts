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
                    if (raw.tomAiBridge?.profiles?.[profileKey]) {
                        raw.tomAiBridge.current = profileKey;
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
// Registry setup
// ============================================================================

/**
 * Create and populate the command registry with all available commands.
 * The registry is used by the standalone polling handler to dispatch commands.
 *
 * @param stopCallback Called when /stop is received to stop polling.
 */
export function createCommandRegistry(stopCallback: () => void): TelegramCommandRegistry {
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
