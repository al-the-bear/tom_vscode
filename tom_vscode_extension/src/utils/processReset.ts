/**
 * Resetting a process run (vscimpb91): the PROCESS view's **Reset Run** and
 * **Reset Process**, and tomAi_resetProcess.
 *
 *  - `run` (Reset Run) clears everything process-related: the run goes to no
 *    process yet — `default` keeps its process and goes back to its first
 *    position — every level of its process stack goes, its open
 *    process-move markers go, and every custom chat variable of the run is
 *    cleared.
 *  - `process` (Reset Process): the run goes back to its process's first
 *    position (the stack's other levels and the open markers go too), and
 *    only the variables the process declares as its `runParameters` are
 *    cleared.
 *
 * vscode-free: what is reset, the confirmation's words and the journal entry.
 */

import { DEFAULT_RUN } from './processRuns';

export type ProcessResetMode = 'run' | 'process';

export interface ProcessResetPlan {
    mode: ProcessResetMode;
    run: string;
    /** The process the run follows now ('' none). */
    process: string;
    /** Where it stands now, for people ('' none). */
    position: string;
    /** The process it follows afterwards ('' none) — at its first position. */
    processAfter: string;
    /** The custom chat variables cleared, with their values now. */
    variables: Array<{ name: string; value: string }>;
    /** The levels of the process stack above the run's own process that go. */
    nestedLevels: number;
    /** The open process-move markers of the run that go. */
    markers: number;
}

/** Why the reset cannot be made; undefined when it can. */
export function processResetRefused(mode: ProcessResetMode, process: string, runParameters: readonly string[] | undefined): string | undefined {
    if (mode === 'process') {
        if (!process) { return 'the run follows no process: Reset Process puts a process back to its start (Reset Run clears a run)'; }
        if (!runParameters) { return `the process ${process} could not be read`; }
    }
    return undefined;
}

/** What a reset of `mode` clears in a run, from the run's state and its custom variables. */
export function processResetPlan(input: {
    mode: ProcessResetMode;
    run: string;
    process: string;
    position: string;
    custom: Readonly<Record<string, string>>;
    /** The process's declared run parameters (Reset Process clears only these). */
    runParameters?: readonly string[];
    nestedLevels: number;
    markers: number;
}): ProcessResetPlan {
    const names = input.mode === 'run'
        ? Object.keys(input.custom)
        : (input.runParameters ?? []).filter((n) => Object.prototype.hasOwnProperty.call(input.custom, n));
    return {
        mode: input.mode,
        run: input.run,
        process: input.process,
        position: input.position,
        processAfter: input.mode === 'run' && input.run !== DEFAULT_RUN ? '' : input.process,
        variables: names.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, value: input.custom[name] ?? '' })),
        nestedLevels: input.nestedLevels,
        markers: input.markers,
    };
}

const short = (v: string): string => (v.length > 60 ? `${v.slice(0, 57)}…` : v);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The lines saying what the reset does (the confirmation's detail, the tool's answer). */
export function processResetLines(plan: ProcessResetPlan): string[] {
    const lines: string[] = [];
    if (plan.processAfter) {
        lines.push(`The run goes back to the first position of ${plan.processAfter}${plan.position ? ` (it stands at ${plan.position})` : ''}.`);
    } else {
        lines.push(`The run follows no process afterwards${plan.process ? ` (it follows ${plan.process}${plan.position ? `, at ${plan.position}` : ''})` : ''}.`);
    }
    if (plan.nestedLevels) { lines.push(`${plural(plan.nestedLevels, 'running subprocess or branch level')} of its process stack go.`); }
    if (plan.markers) { lines.push(`${plural(plan.markers, 'open process-move marker')} in the prompt queue go (the step's prompts stay).`); }
    if (plan.variables.length) {
        lines.push(`${plan.mode === 'run' ? 'Every custom chat variable of the run is cleared' : 'The run parameters the process declares are cleared'}: ${plan.variables.map((v) => `${v.name} = ${short(v.value)}`).join(', ')}.`);
    } else {
        lines.push(plan.mode === 'run' ? 'The run has no custom chat variables to clear.' : 'None of the run parameters the process declares is set.');
    }
    return lines;
}

/** The confirmation: its message and detail. */
export function processResetConfirmation(plan: ProcessResetPlan): { message: string; detail: string; confirm: string } {
    const what = plan.mode === 'run' ? 'Reset Run' : 'Reset Process';
    const runName = plan.run === DEFAULT_RUN ? 'the run default' : `the run ${plan.run}`;
    return {
        message: `${what}: reset ${runName}?`,
        detail: [...processResetLines(plan), '', 'This cannot be undone; it is written to the quest\'s decisions journal.'].join('\n'),
        confirm: what,
    };
}

/** The decisions journal entry of a reset. */
export function processResetJournalEntry(plan: ProcessResetPlan, at: Date = new Date()): string {
    return [
        `## ${at.toISOString()} — ${plan.mode === 'run' ? 'Reset Run' : 'Reset Process'}: run ${plan.run}`,
        '',
        `- **Was:** ${plan.process ? `${plan.process}${plan.position ? ` › ${plan.position}` : ''}` : 'no process'}`,
        `- **Now:** ${plan.processAfter ? `${plan.processAfter} at its first position` : 'no process'}`,
        ...(plan.variables.length ? [`- **Cleared:** ${plan.variables.map((v) => `\`${v.name}\` = ${short(v.value) || '(empty)'}`).join(', ')}`] : []),
        ...(plan.nestedLevels ? [`- **Levels removed:** ${plan.nestedLevels}`] : []),
        ...(plan.markers ? [`- **Markers removed:** ${plan.markers}`] : []),
        '',
    ].join('\n');
}
