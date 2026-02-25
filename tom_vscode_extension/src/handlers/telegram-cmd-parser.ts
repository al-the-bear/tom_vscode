/**
 * Telegram Command Parser — CLI-like command/subcommand parsing for Telegram bot messages.
 *
 * Supports:
 *  - Commands with subcommands: bridge restart, cli-integration start 8080
 *  - Global flags: --attach (send reply as attachment)
 *  - Positional arguments: cd somedir, file path/to/file
 *  - Help generation per command
 *  - Optional / prefix (accepted but not required)
 *
 * The parser is modeled after CLI argument parsers (like yargs/commander) but
 * tailored for short Telegram messages.
 */

import { bridgeLog } from './handler_shared';

// ============================================================================
// Interfaces
// ============================================================================

/** A parsed command ready for execution. */
export interface ParsedTelegramCommand {
    /** Top-level command name (without leading slash if any), e.g. "bridge" */
    command: string;
    /** Subcommand name if any, e.g. "restart" */
    subcommand: string | null;
    /** Positional args after the command/subcommand */
    args: string[];
    /** Named flags parsed from --key or --key=value */
    flags: Record<string, string | boolean>;
    /** Original raw text */
    raw: string;
    /** Raw arguments after the command name (unparsed, for pass-through commands like bk/tk) */
    rawArgs: string;
    /** Sender metadata */
    userId: number;
    chatId: number;
    username: string;
}

/** Definition for a registered command. */
export interface TelegramCommandDef {
    /** Command name, e.g. "ls" or "bridge" */
    name: string;
    /** Short description shown in help */
    description: string;
    /** Usage pattern shown in help, e.g. "bridge <restart|stop|mode>" */
    usage?: string;
    /** Subcommand definitions (if this command has subcommands) */
    subcommands?: TelegramSubcommandDef[];
    /** Handler function */
    handler: (cmd: ParsedTelegramCommand) => Promise<TelegramCommandResult>;
    /**
     * If set, this message is sent immediately when the command is dispatched,
     * before the handler completes. Useful for long-running commands (bk, tk, dart)
     * so the user knows the command was received and is running.
     * Supports {args} placeholder which is replaced with the raw arguments.
     */
    startMessage?: string;
}

/** Subcommand definition. */
export interface TelegramSubcommandDef {
    name: string;
    description: string;
    usage?: string;
}

/** Result returned from a command handler. */
export interface TelegramCommandResult {
    /** The text body of the response. */
    text: string;
    /** If true, send as a document/file attachment regardless of length. */
    forceAttachment?: boolean;
    /** Custom filename when sending as attachment (default: "response.txt"). */
    attachmentFilename?: string;
    /** If true, skip markdown formatting entirely (send raw). */
    rawText?: boolean;
    /** If true, suppress the response entirely (handler already sent messages). */
    silent?: boolean;
}

// ============================================================================
// Command Registry
// ============================================================================

export class TelegramCommandRegistry {
    private commands: Map<string, TelegramCommandDef> = new Map();

    /** Register a command. */
    register(def: TelegramCommandDef): void {
        this.commands.set(def.name.toLowerCase(), def);
    }

    /** Get a command definition by name. */
    get(name: string): TelegramCommandDef | undefined {
        return this.commands.get(name.toLowerCase());
    }

    /** Get all registered commands. */
    all(): TelegramCommandDef[] {
        return Array.from(this.commands.values());
    }

    /** Parse a raw Telegram message into a ParsedTelegramCommand. Accepts with or without / prefix. */
    parse(text: string, userId: number, chatId: number, username: string): ParsedTelegramCommand | null {
        const trimmed = text.trim();
        if (!trimmed) { return null; }

        // Tokenize: split by whitespace, respecting double-quoted strings
        const tokens = this.tokenize(trimmed);
        if (tokens.length === 0) { return null; }

        // First token is the command — strip optional leading slash and any @botname suffix
        let commandToken = tokens[0];
        if (commandToken.startsWith('/')) { commandToken = commandToken.substring(1); }
        const atIndex = commandToken.indexOf('@');
        if (atIndex >= 0) { commandToken = commandToken.substring(0, atIndex); }

        const command = commandToken.toLowerCase();
        if (!command) { return null; }
        const def = this.commands.get(command);

        // Extract rawArgs: everything after the first token (command name), unparsed
        // Find where the command token ends in the original text
        const firstTokenEnd = trimmed.indexOf(tokens[0]) + tokens[0].length;
        const rawArgs = trimmed.substring(firstTokenEnd).trim();

        // Extract flags and positional args from remaining tokens
        const flags: Record<string, string | boolean> = {};
        const positional: string[] = [];

        for (let i = 1; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.startsWith('--')) {
                const eqIdx = token.indexOf('=');
                if (eqIdx >= 0) {
                    flags[token.substring(2, eqIdx)] = token.substring(eqIdx + 1);
                } else {
                    flags[token.substring(2)] = true;
                }
            } else {
                positional.push(token);
            }
        }

        // Determine subcommand
        let subcommand: string | null = null;
        const args = [...positional];

        if (def?.subcommands && args.length > 0) {
            const candidate = args[0].toLowerCase();
            if (def.subcommands.some(sc => sc.name === candidate)) {
                subcommand = candidate;
                args.shift();
            }
        }

        bridgeLog(`[TelegramCmd] Parsed: ${command}${subcommand ? ' ' + subcommand : ''} args=[${args.join(', ')}] rawArgs="${rawArgs}" flags=${JSON.stringify(flags)}`);

        return { command, subcommand, args, flags, raw: trimmed, rawArgs, userId, chatId, username };
    }

    /** Generate help text for all commands or a specific command. */
    generateHelp(commandName?: string): string {
        if (commandName) {
            // Strip optional / prefix from the query
            const name = commandName.startsWith('/') ? commandName.substring(1) : commandName;
            const def = this.commands.get(name.toLowerCase());
            if (!def) { return `Unknown command: ${name}`; }

            let help = `*${def.name}* — ${def.description}\n`;
            if (def.usage) { help += `Usage: ${def.usage}\n`; }
            if (def.subcommands && def.subcommands.length > 0) {
                help += '\nSubcommands:\n';
                for (const sc of def.subcommands) {
                    help += `  ${def.name} ${sc.name} — ${sc.description}\n`;
                    if (sc.usage) { help += `    ${sc.usage}\n`; }
                }
            }
            help += '\nGlobal: --attach (force file attachment)';
            return help;
        }

        // Full help listing
        let help = '📋 *Available Commands*\n\n';
        const sorted = Array.from(this.commands.values()).sort((a, b) => a.name.localeCompare(b.name));
        for (const def of sorted) {
            help += `${def.name} — ${def.description}\n`;
        }
        help += '\n_Use help <command> for details\\. \\-\\-attach on any command to get file output\\._';
        return help;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /** Tokenize a string, respecting double-quoted segments. */
    private tokenize(input: string): string[] {
        const tokens: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < input.length; i++) {
            const ch = input[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
            } else if (ch === ' ' && !inQuotes) {
                if (current.length > 0) {
                    tokens.push(current);
                    current = '';
                }
            } else {
                current += ch;
            }
        }
        if (current.length > 0) { tokens.push(current); }

        return tokens;
    }
}
