/**
 * The background-work reminder (vscimpb143): a queue turn ended its answer
 * while background work it started still runs. Instead of the queue waiting
 * silently (utils/backgroundWait.ts), the agent gets one prompt in the same
 * session and turn that names the work and tells it to wait for it actively —
 * check its progress periodically, check the result, then answer again.
 *
 * The text is the Assist prompt `backgroundWork` (utils/assistPrompts.ts:
 * chosen on the Status Page, edited in the Global Template Editor) with
 * `${backgroundWork}`, `${waitingSince}` and `${limitMinutes}`; a template
 * whose text is empty sends no reminder.
 *
 * vscode-free and pure.
 */

import { buildAssistPrompt, resolveAssistPrompt, type AssistPromptsSection } from './assistPrompts';
import type { BackgroundWaitState, BackgroundWorkItem } from './backgroundWait';

/** One line per piece of work: what it is, its id, the command, the output file. */
export function backgroundWorkLines(items: readonly BackgroundWorkItem[]): string {
    return items.map((i) => {
        const what = i.description || i.command || i.id;
        const parts = [`- ${what} [${i.id}]`];
        if (i.command && i.command !== what) { parts.push(`command \`${i.command}\``); }
        if (i.outputFile) { parts.push(`output \`${i.outputFile}\``); }
        return parts.join(' — ');
    }).join('\n');
}

/** `2026-11-17 14:05` in local time. */
export function localMinute(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) { return iso; }
    const two = (n: number): string => (n < 10 ? `0${n}` : String(n));
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The reminder for `state`, or undefined when the chosen template's text is empty or nothing runs. */
export function backgroundWorkReminder(section: AssistPromptsSection | undefined, state: BackgroundWaitState): string | undefined {
    if (!state.items.length) { return undefined; }
    if (!resolveAssistPrompt(section, 'backgroundWork').template.trim()) { return undefined; }
    return buildAssistPrompt(section, 'backgroundWork', {
        backgroundWork: backgroundWorkLines(state.items),
        waitingSince: localMinute(state.since),
        limitMinutes: String(Math.round(state.limitMinutes)),
    });
}

/**
 * Once per wait: the reminder goes out for a wait whose work was not reminded about yet (a later wait for new
 * work gets it again). `reminded` holds the ids already named; answers whether to send, and records them.
 */
export function takeReminderFor(items: readonly BackgroundWorkItem[], reminded: Set<string>): boolean {
    const fresh = items.filter((i) => !reminded.has(i.id));
    if (!fresh.length) { return false; }
    for (const i of items) { reminded.add(i.id); }
    return true;
}
