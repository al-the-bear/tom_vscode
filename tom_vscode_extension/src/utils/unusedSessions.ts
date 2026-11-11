/**
 * Which of a quest's sessions the SESSIONS view's "Remove unused sessions"
 * action offers for deletion, and which it keeps and why — pure
 * (src/handlers/sessionsView-handler.ts shows the plan as a multi-picker).
 *
 * Kept, never offered:
 * - `default` and `chat` (the queue's and the ANTHROPIC/LLM panel's);
 * - a session a queue item not yet done runs in (any status but `sent`: a
 *   staged, errored or interrupted item still runs again), or one such an
 *   item's session is to be created from, and the queue's default session;
 * - a session a process definition names — at the process, a phase, a step,
 *   a gate, a post-gate step or a sub-step, as its name or its base; a name
 *   with placeholders (`p2s${step-iteration}-todo`) keeps every session it
 *   can become; a process run's session (`<name>@<run>`, src/utils/runSessions.ts)
 *   when its `<name>` is such a session and the run `<run>` still exists
 *   (a deleted run's sessions are offered);
 * - a session another session is based on (deleting it is refused);
 * - a temporary session (`tmp-*`), which goes with its item.
 *
 * Every other named session is offered; those without a conversation are
 * ticked in advance, the user decides about the rest.
 */

import type { ProcessDefinition, ProcessSessionSpec } from './processDefinition';
import type { SessionRow } from './sessionsViewRows';
import { DEFAULT_RUN } from './processRuns';
import { sessionBaseName, sessionRun } from './runSessions';

/** What the plan needs of a queue item. */
export interface SessionUsingItem {
    id: string;
    status: string;
    session?: string;
    sessionCreate?: { basedOn?: string };
}

export interface UnusedSessionsInput {
    rows: readonly SessionRow[];
    queueItems: readonly SessionUsingItem[];
    queueDefaultSession?: string;
    processes: readonly ProcessDefinition[];
    /** The quest's process runs (`default` and the others): a run's sessions are kept while it exists. */
    runs: readonly string[];
}

export interface OfferedSession {
    name: string;
    hasConversation: boolean;
    /** Ticked in the picker when it opens: the sessions without a conversation. */
    preselected: boolean;
    /** One line for the picker: lifetime, base, conversation, last use. */
    detail: string;
}

export interface KeptSession {
    name: string;
    reason: string;
}

export interface UnusedSessionsPlan {
    offered: OfferedSession[];
    kept: KeptSession[];
}

/** Every session spec of a definition, at every level. */
function processSessionSpecs(def: ProcessDefinition): ProcessSessionSpec[] {
    const out: Array<ProcessSessionSpec | undefined> = [def.session];
    for (const phase of def.phases ?? []) {
        out.push(phase.session);
        const steps = [...(phase.steps ?? []), phase.gate, ...(phase.postGate ? [phase.postGate] : [])];
        for (const step of steps) {
            if (!step) { continue; }
            out.push(step.session);
            for (const sub of step.substeps ?? []) { out.push(sub.session); }
        }
    }
    return out.filter((s): s is ProcessSessionSpec => s !== undefined && s !== '');
}

/** A session name a definition writes, as a test: placeholders stand for any text. */
function nameMatcher(template: string): (name: string) => boolean {
    if (!template.includes('${')) { return (name) => name === template; }
    const source = template
        .split(/\$\{[^}]*\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.+');
    const re = new RegExp(`^${source}$`);
    return (name) => re.test(name);
}

/** The names a process definition uses (its sessions and their bases), as tests with what they came from. */
function processUses(processes: readonly ProcessDefinition[]): Array<{ test: (name: string) => boolean; reason: string }> {
    const uses: Array<{ test: (name: string) => boolean; reason: string }> = [];
    for (const def of processes) {
        for (const spec of processSessionSpecs(def)) {
            const name = typeof spec === 'string' ? spec : spec.name;
            if (name) { uses.push({ test: nameMatcher(name), reason: `named by the process "${def.id}" (${name})` }); }
            const base = typeof spec === 'string' ? undefined : spec.basedOn;
            if (base) { uses.push({ test: nameMatcher(base), reason: `the base of a session of the process "${def.id}"` }); }
        }
    }
    return uses;
}

function detailOf(row: SessionRow): string {
    return [
        row.lifetime ?? 'continue',
        row.basedOn ? `based on ${row.basedOn}` : '',
        row.hasConversation ? 'has a conversation' : 'no conversation',
        row.lastUse ? `last used ${row.lastUse.slice(0, 10)}` : '',
    ].filter(Boolean).join(' · ');
}

/** Why a named session is kept, or undefined when it may be offered. */
function keepReason(row: SessionRow, input: UnusedSessionsInput, uses: ReturnType<typeof processUses>): string | undefined {
    if (row.usedBy) { return `used by ${row.usedBy}`; }
    if (!row.hasFile) { return 'no session file'; }
    if (row.temporary) { return 'temporary: removed with its item'; }
    if (row.dependents.length > 0) { return `the base of ${row.dependents.join(', ')}`; }
    if (input.queueDefaultSession === row.name) { return 'the queue\'s default session'; }
    const item = input.queueItems.find((i) => i.status !== 'sent' && (i.session === row.name || i.sessionCreate?.basedOn === row.name));
    if (item) { return `queue item ${item.id} (${item.status}) ${item.session === row.name ? 'runs in it' : 'is created from it'}`; }
    return processReason(row.name, input.runs, uses);
}

/**
 * Why a process keeps session `name`: a name its definition writes, or — for a
 * run's session `<name>@<run>` — `<name>` while the run `<run>` exists.
 */
function processReason(name: string, runs: readonly string[], uses: ReturnType<typeof processUses>): string | undefined {
    const run = sessionRun(name);
    if (run === DEFAULT_RUN) { return uses.find((u) => u.test(name))?.reason; }
    if (!runs.includes(run)) { return undefined; }
    const reason = uses.find((u) => u.test(sessionBaseName(name)))?.reason;
    return reason ? `${reason}, run ${run}` : undefined;
}

export function planUnusedSessions(input: UnusedSessionsInput): UnusedSessionsPlan {
    const uses = processUses(input.processes);
    const plan: UnusedSessionsPlan = { offered: [], kept: [] };
    for (const row of input.rows) {
        const reason = keepReason(row, input, uses);
        if (reason) {
            plan.kept.push({ name: row.name, reason });
        } else {
            plan.offered.push({ name: row.name, hasConversation: row.hasConversation, preselected: !row.hasConversation, detail: detailOf(row) });
        }
    }
    return plan;
}
