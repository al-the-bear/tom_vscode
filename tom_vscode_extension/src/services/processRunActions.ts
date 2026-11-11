/**
 * The PROCESS view's run list (vscimpb42): what its messages do.
 *
 *   selectRun {run}  — work on that run in this window (ProcessStateStore.selectRun)
 *   createRun        — a name (the run-name rules, not taken), then a process (optional),
 *                      then the run is created and selected
 *   deleteRuns       — a multi-select of the runs except `default`, a confirmation, then they go;
 *                      their sessions (`<session>@<run>`) are offered for deletion after
 *
 * vscode-free: the store and the pickers come in as ports (the handler wires
 * ProcessStateStore and vscode.window), so the tests drive them with fakes.
 */

import { DEFAULT_RUN, runNameError } from '../utils/processRuns';

/** A run as the list shows it (ProcessStateStore.runs(), the last changed first). */
export interface RunListEntry {
    run: string;
    process: string;
    position: string;
    /** When its state file was last written (ISO), null when never. */
    changed: string | null;
    current: boolean;
}

export type RunActionResult = { ok: true } | { ok: false; error: string };

/** What the actions need of the process store. */
export interface RunStorePort {
    runs(): RunListEntry[];
    /** The processes a new run may follow (valid definitions). */
    processes(): Array<{ id: string; name: string }>;
    selectRun(run: string): RunActionResult;
    createRun(run: string, process: string | undefined): RunActionResult;
    deleteRuns(runs: readonly string[]): RunActionResult;
    /** The sessions the runs use (`<session>@<run>`). */
    runSessions(runs: readonly string[]): string[];
    /** Delete those sessions with their storage. */
    deleteRunSessions(runs: readonly string[]): string[];
}

/** The pickers (vscode.window in the handler). Each answers undefined when dismissed. */
export interface RunUiPort {
    /** The new run's name; `validate` answers why a value cannot be taken. */
    inputRunName(validate: (value: string) => string | undefined): Promise<string | undefined>;
    /** The process the run follows: an id, `null` for none yet, undefined when dismissed. */
    pickProcess(items: Array<{ id: string; label: string; description?: string }>): Promise<string | null | undefined>;
    /** The runs to delete (several). */
    pickRuns(items: Array<{ run: string; label: string; description: string }>): Promise<string[] | undefined>;
    /** A modal confirmation: true when `button` was clicked. */
    confirm(message: string, detail: string, button: string): Promise<boolean>;
}

/** Why `value` cannot name a new run: the run-name rules, or a run the quest has. */
export function runNameInputError(value: string, taken: readonly string[]): string | undefined {
    const name = value.trim();
    if (!name) { return 'Enter the name of the new run, e.g. a change id.'; }
    const rule = runNameError(name);
    if (rule) { return rule; }
    if (taken.includes(name)) { return `The quest has a run "${name}" already.`; }
    return undefined;
}

/** A run of the delete picker: its name, and where it stands. */
function describeRun(r: RunListEntry): string {
    return [r.process ? `${r.process}${r.position ? ` — ${r.position}` : ''}` : 'no process yet', r.current ? 'this window\'s run' : ''].filter(Boolean).join(' · ');
}

/** Select run `run`; the current one again is no change. */
export function selectRunAction(store: RunStorePort, run: string): RunActionResult {
    if (!run) { return { ok: false, error: 'no run named' }; }
    const entry = store.runs().find((r) => r.run === run);
    if (entry?.current) { return { ok: true }; }
    return store.selectRun(run);
}

/** The + button: a name, a process (optional), then the run is created and selected. Dismissed: nothing happens. */
export async function createRunAction(store: RunStorePort, ui: RunUiPort): Promise<RunActionResult | undefined> {
    const taken = store.runs().map((r) => r.run);
    const name = await ui.inputRunName((value) => runNameInputError(value, taken));
    if (name === undefined) { return undefined; }
    const error = runNameInputError(name, taken);
    if (error) { return { ok: false, error }; }
    const processes = store.processes();
    const process = await ui.pickProcess([
        { id: '', label: '— no process yet —', description: 'choose it later in the Process dropdown' },
        ...processes.map((p) => ({ id: p.id, label: p.name || p.id, description: p.id })),
    ]);
    if (process === undefined) { return undefined; }
    return store.createRun(name.trim(), process || undefined);
}

/** The trash button: the runs except `default` to choose from, a confirmation, then they are deleted. */
export async function deleteRunsAction(store: RunStorePort, ui: RunUiPort): Promise<RunActionResult | undefined> {
    const candidates = store.runs().filter((r) => r.run !== DEFAULT_RUN);
    if (candidates.length === 0) { return { ok: false, error: 'the quest has no run besides "default", which is never deleted' }; }
    const picked = await ui.pickRuns(candidates.map((r) => ({ run: r.run, label: r.run, description: describeRun(r) })));
    if (!picked || picked.length === 0) { return undefined; }
    const current = picked.find((r) => candidates.find((c) => c.run === r)?.current);
    const button = picked.length === 1 ? 'Delete the run' : `Delete ${picked.length} runs`;
    const ok = await ui.confirm(
        `Delete ${picked.length === 1 ? `the run "${picked[0]}"` : `${picked.length} runs: ${picked.join(', ')}`}?`,
        `Their state files go (process position, stack, records); nothing else of the quest changes.${current ? ` "${current}" is this window's run: the window goes back to "default".` : ''}`,
        button,
    );
    if (!ok) { return undefined; }
    const sessions = store.runSessions(picked);
    const deleted = store.deleteRuns(picked);
    if (!deleted.ok || sessions.length === 0) { return deleted; }
    // The runs' own sessions (`<session>@<run>`): offered, not taken for granted — a conversation may still be wanted.
    const also = await ui.confirm(
        `Also delete the ${sessions.length === 1 ? 'session' : `${sessions.length} sessions`} of ${picked.length === 1 ? 'the run' : 'these runs'}?`,
        `${sessions.join(', ')} — with their history, trails, tool results and quest memory. Kept, they stay in the SESSIONS view.`,
        sessions.length === 1 ? 'Delete the session' : 'Delete the sessions',
    );
    if (also) { store.deleteRunSessions(picked); }
    return deleted;
}

/** The view's run messages; `handled: false` for any other message. */
export async function handleRunMessage(
    msg: { type: string; run?: string },
    store: RunStorePort,
    ui: RunUiPort,
): Promise<{ handled: false } | { handled: true; result: RunActionResult | undefined }> {
    switch (msg.type) {
        case 'selectRun': return { handled: true, result: selectRunAction(store, String(msg.run ?? '')) };
        case 'createRun': return { handled: true, result: await createRunAction(store, ui) };
        case 'deleteRuns': return { handled: true, result: await deleteRunsAction(store, ui) };
        default: return { handled: false };
    }
}
