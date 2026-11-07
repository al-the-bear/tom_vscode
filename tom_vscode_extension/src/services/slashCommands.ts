/**
 * Claude Code's slash commands as `/name` completions (CC-13 (a)).
 *
 * A command is `.claude/commands/<name>.md` — in a sub-folder
 * `.claude/commands/<folder>/<name>.md`, named `<folder>:<name>` — with
 * optional YAML frontmatter (`description`, `argument-hint`) and a body, the
 * prompt template. Commands are found like skills: the workspace's own
 * `.claude/commands/` and every parent folder's, the nearest of a name
 * winning. The `/` completion in the @CHAT panels and the queue editor's add
 * form offers them beside the skills; choosing one asks for its arguments and
 * inserts the expanded template ({@link expandSlashCommand}).
 *
 * Expansion follows Claude Code: `$ARGUMENTS` is the whole argument text,
 * `$1` … `$9` its words; a template with neither gets the arguments appended
 * as `ARGUMENTS: …`. Shell lines (`!`) and file references (`@path`) are left
 * as written — they run nowhere here.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import { claudeDirsUpward, firstProseLine, frontmatterString, splitFrontmatter } from './claudeDirs';

export interface SlashCommand {
    /** `name`, or `folder:name` for a command in a sub-folder. */
    name: string;
    description: string;
    /** The frontmatter's `argument-hint`, e.g. `<pr-number> [focus]`. */
    argumentHint?: string;
    /** The prompt template (the body, frontmatter removed). */
    template: string;
    /** Absolute path of the command file. */
    file: string;
    /** True when it lives in the workspace's own `.claude/commands/`. */
    direct: boolean;
}

/** The `.md` files under `dir`, relative, sub-folders included. */
function commandFiles(dir: string, rel = '', depth = 0): string[] {
    let names: string[];
    try { names = fs.readdirSync(path.join(dir, rel)).sort(); } catch { return []; }
    const out: string[] = [];
    for (const name of names) {
        if (name.startsWith('.')) { continue; }
        const relPath = rel ? `${rel}/${name}` : name;
        let stat: fs.Stats;
        try { stat = fs.statSync(path.join(dir, relPath)); } catch { continue; }
        if (stat.isDirectory()) {
            if (depth < 4) { out.push(...commandFiles(dir, relPath, depth + 1)); }
        } else if (name.endsWith('.md')) {
            out.push(relPath);
        }
    }
    return out;
}

function readCommand(dir: string, relPath: string, direct: boolean): SlashCommand | undefined {
    const file = path.join(dir, relPath);
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
    const { meta, body } = splitFrontmatter(text);
    const template = body.trim();
    return {
        name: relPath.replace(/\.md$/, '').split('/').join(':'),
        description: frontmatterString(meta.description) ?? firstProseLine(template),
        argumentHint: frontmatterString(meta['argument-hint']),
        template,
        file,
        direct,
    };
}

/**
 * The commands visible from the workspace whose name starts with `query`
 * (any case; empty = all): the workspace's own first, each folder's by name.
 */
export function listSlashCommands(wsRoot: string, query: string): SlashCommand[] {
    const byName = new Map<string, SlashCommand>();
    for (const { dir, direct } of claudeDirsUpward(wsRoot, 'commands')) {
        for (const relPath of commandFiles(dir)) {
            const command = readCommand(dir, relPath, direct);
            // The nearest command of a name wins.
            if (command && !byName.has(command.name)) { byName.set(command.name, command); }
        }
    }
    const prefix = query.trim().toLowerCase();
    return [...byName.values()].filter((c) => prefix === '' || c.name.toLowerCase().startsWith(prefix));
}

/** The argument text as words: whitespace-separated, quotes ("…" or '…') keep a word together. */
export function splitCommandArguments(args: string): string[] {
    const words: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(args)) !== null) {
        words.push(match[1] ?? match[2] ?? match[3]);
    }
    return words;
}

/** `$ARGUMENTS` or `$1` … `$9`; one pass, so argument text is never expanded again. */
const PLACEHOLDER = /\$ARGUMENTS\b|\$([1-9])(?!\d)/g;

/** Whether the command takes arguments: its template has a placeholder, or it states an argument hint. */
export function commandTakesArguments(command: SlashCommand): boolean {
    return new RegExp(PLACEHOLDER.source).test(command.template) || command.argumentHint !== undefined;
}

/** The command's prompt with `args` filled in (see the module comment). */
export function expandSlashCommand(command: SlashCommand, args: string): string {
    const text = args.trim();
    const hasPlaceholder = new RegExp(PLACEHOLDER.source).test(command.template);
    if (!hasPlaceholder) {
        return text ? `${command.template}\n\nARGUMENTS: ${text}` : command.template;
    }
    const words = splitCommandArguments(text);
    return command.template.replace(PLACEHOLDER, (_m, n: string | undefined) => (n ? words[Number(n) - 1] ?? '' : text));
}
