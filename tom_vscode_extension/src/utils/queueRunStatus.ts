/**
 * The queue's status bar text for the window's run while its running prompt is
 * held or waits (vscimpb112) — the same icon and word as the run tab:
 * `$(debug-disconnect) held: Bash`, `$(loading~spin) interrupting`,
 * `❓ answer needed`, `⏳ until 14:20`. Undefined when nothing holds it (the
 * status bar then says what it says for a sending queue). Pure.
 */

import type { SoftInterruptState } from '../services/softInterrupt';
import type { WaitForState } from './waitFor';

export interface RunStatusInput {
    /** The window's run's name. */
    run: string;
    /** Its sending item's soft interrupt, if one is requested. */
    softInterrupt?: SoftInterruptState;
    /** Its sending item's turn waits for the user's answer (the question's first line, when known). */
    question?: { firstLine?: string };
    /** Its sending item's turn waits in tomAi_waitFor. */
    waitingFor?: WaitForState;
}

/** `14:20` of an ISO time or epoch ms (local), else the input. */
function clock(at: string | number): string {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) { return String(at); }
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function runStatusBarText(input: RunStatusInput): { text: string; tooltip: string } | undefined {
    const s = input.softInterrupt;
    if (s && s.heldAt !== undefined) {
        const what = s.kind === 'question' ? 'answer' : s.kind === 'wait' ? 'tomAi_waitFor' : (s.tool ?? 'tool');
        return {
            text: `$(debug-disconnect) held: ${what}`,
            tooltip: `Run ${input.run}: held for continuation since ${clock(s.heldAt)}${s.kind === 'tool' || !s.kind ? ` at the result of ${s.tool ?? 'a tool'}` : ''} — resume to go on`,
        };
    }
    if (s) {
        return { text: '$(loading~spin) interrupting', tooltip: `Run ${input.run}: soft interrupt requested at ${clock(s.requestedAt)} — the next tool result is held; hard interrupt after 15 s without one` };
    }
    if (input.question) {
        return { text: '❓ answer needed', tooltip: `Run ${input.run}: the running prompt waits for your answer${input.question.firstLine ? ` — ${input.question.firstLine}` : ''}` };
    }
    if (input.waitingFor) {
        return { text: `⏳ until ${clock(input.waitingFor.until)}`, tooltip: `Run ${input.run}: waiting (tomAi_waitFor) — ${input.waitingFor.reason}, until ${clock(input.waitingFor.until)}, since ${clock(input.waitingFor.since)}` };
    }
    return undefined;
}
