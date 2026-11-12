/**
 * A Bash command that outlives its call — `cmd &`, `nohup`, `setsid`,
 * `disown`, `screen -d`, `tmux new -d` — runs on unseen: the Bash tool
 * returns at once, the CLI does not list it as a background task, and the
 * queue cannot wait for it. In an Agent SDK queue run such a command is
 * refused (a PreToolUse hook) with {@link DETACHING_REFUSAL}: the agent
 * starts it with `run_in_background` instead, which the queue waits for.
 *
 * The check reads the command with its quoted strings and escaped characters
 * removed, so `echo "a & b"` passes; `&&`, `&>`, `>&`, `<&` and `|&` are
 * redirections and lists, not backgrounding, so `a && b`, `cmd 2>&1` and
 * `[ -f x ] && y` pass too.
 *
 * Pure.
 */

/** What the refused call answers. */
export const DETACHING_REFUSAL = 'start it with run_in_background instead — the queue waits for it';

/** The full refusal for a command detaching by `reason`. */
export function detachingRefusalMessage(reason: string): string {
    return `This command would keep running after its call ends (${reason}), and the queue cannot wait for it: ${DETACHING_REFUSAL}.`;
}

/** The command with quoted strings, escaped characters and comments blanked out. */
function unquoted(command: string): string {
    let out = '';
    let i = 0;
    while (i < command.length) {
        const c = command[i];
        if (c === '\\') { out += '  '; i += 2; continue; }
        if (c === "'") {
            const end = command.indexOf("'", i + 1);
            const stop = end < 0 ? command.length : end + 1;
            out += ' '.repeat(stop - i);
            i = stop;
            continue;
        }
        if (c === '"') {
            let j = i + 1;
            while (j < command.length && command[j] !== '"') { j += command[j] === '\\' ? 2 : 1; }
            const stop = Math.min(command.length, j + 1);
            out += ' '.repeat(stop - i);
            i = stop;
            continue;
        }
        // A comment runs to the end of its line (a `#` starting a word).
        if (c === '#' && (i === 0 || /\s/.test(command[i - 1]))) {
            const nl = command.indexOf('\n', i);
            const stop = nl < 0 ? command.length : nl;
            out += ' '.repeat(stop - i);
            i = stop;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/** A command word at the start of a simple command (after `;`, `&`, `|`, `(`, a newline or the start). */
function commandWord(text: string, word: string): boolean {
    return new RegExp(`(^|[;&|(\\n]|\\s)${word}(?=\\s|$|;)`).test(text);
}

/**
 * Why `command` detaches from its call, or undefined when it does not.
 * Each reason names the construct, e.g. ``a `&` that puts a command in the background``.
 */
export function detachingCommandReason(command: string): string | undefined {
    const text = unquoted(command);
    if (commandWord(text, 'nohup')) { return '`nohup`'; }
    if (commandWord(text, 'setsid')) { return '`setsid`'; }
    if (commandWord(text, 'disown')) { return '`disown`'; }
    if (commandWord(text, 'daemonize')) { return '`daemonize`'; }
    // screen -d / -dm / -dmS name …: a detached session.
    if (/(^|[;&|(\s])screen\b[^;&|\n]*\s-[A-Za-z]*d/.test(text)) { return '`screen -d`'; }
    // tmux new / new-session … -d: a detached session.
    if (/(^|[;&|(\s])tmux\s[^;&|\n]*?\bnew(-session)?\b[^;&|\n]*?\s-[A-Za-z]*d/.test(text)) { return '`tmux new -d`'; }
    // A lone `&` once lists and redirections are taken out.
    const rest = text.replace(/&&/g, '  ').replace(/[<>|]&/g, '  ').replace(/&>/g, '  ');
    if (rest.includes('&')) { return 'a `&` that puts a command in the background'; }
    return undefined;
}
