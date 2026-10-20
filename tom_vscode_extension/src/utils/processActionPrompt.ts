/**
 * Process actions — the prompt the PROCESS view's Proceed button queues (pure;
 * no `vscode`, no IO).
 *
 * Proceed is the only move that runs anything: it queues the prompt of the
 * CURRENT position, then the state moves on (or, at a decision point, stays,
 * marked as run). Every other move only moves the state. The prompt comes
 * from ONE template, global for all processes, kept in the extension config
 * under `processActionTemplates.proceed` and edited in the process template
 * editor. What is specific to a step comes from the definition's `prompt`
 * fields, which the template inserts through `${action-prompt}` (or
 * `${phase-prompt}` / `${step-prompt}` / `${substep-prompt}`).
 *
 * The template is resolved by the placeholder engine with the values of
 * {@link processActionValues} laid over the chat variables: the process
 * variables describe the position being run.
 */

// Keys here are placeholder names (`${action-prompt}`), dashed by design.
/* eslint-disable @typescript-eslint/naming-convention */

import {
    currentRole,
    effectiveSession,
    processVariableValues,
    findPhase,
    findStep,
    findSubstep,
    phaseSteps,
    type ProcessDefinition,
    type ProcessSession,
    type ProcessMove,
    type ProcessState,
} from './processDefinition';

/** The moves that have a prompt template: only Proceed runs anything. */
export type ProcessTemplateKind = 'proceed';
export const PROCESS_TEMPLATE_KINDS: readonly ProcessTemplateKind[] = ['proceed'];

export type ProcessActionTemplates = Partial<Record<ProcessTemplateKind, string>>;

const POSITION =
    'Process `${process}`, phase `${phase}` (iteration ${phase-iteration}), step `${step}` (iteration ${step-iteration})'
    + '${{ vars.substep ? ", sub-step `" + vars.substep + "` (iteration " + vars["substep-iteration"] + ")" : "" }}.';

const NOTE = '${{ vars["action-note"] ? "\\n\\n" + vars["action-note"] : "" }}';

const INSTRUCTIONS = '${{ vars["custom-instructions"] ? "\\n\\n## Instructions\\n\\n" + vars["custom-instructions"] : "" }}';

const ACTION_PROMPT = '${{ vars["action-prompt"] ? "\\n\\n## What to do\\n\\n" + vars["action-prompt"] : "" }}';

const AFTER = '\n\n${action-after}';

/** The template used when the config holds none. */
export const DEFAULT_PROCESS_ACTION_TEMPLATES: Readonly<Record<ProcessTemplateKind, string>> = Object.freeze({
    proceed: `# Run: \${action-position}\n\n${POSITION}${NOTE}${ACTION_PROMPT}${INSTRUCTIONS}${AFTER}`,
});

/** What each template is, for the template editor. */
export const PROCESS_ACTION_TITLES: Readonly<Record<ProcessTemplateKind, string>> = Object.freeze({
    proceed: 'Proceed — run the current phase, step or sub-step',
});

/** The variables an action adds to the chat and process variables. */
export const PROCESS_ACTION_VARIABLES: ReadonlyArray<{ name: string; description: string }> = Object.freeze([
    { name: 'custom-instructions', description: 'What you typed on the action page' },
    { name: 'action-prompt', description: 'The `prompt` fields of what runs here: the phase (at its first step), the step (at its first sub-step), the sub-step' },
    { name: 'action-note', description: 'A note for a repeated run: another iteration, or a gate run again' },
    { name: 'action-position', description: 'The position being run, e.g. "Phase 2 › 03 Iteration #1 › 01 Questions Round"' },
    { name: 'action-after', description: 'What the PROCESS view does after queuing: where it moved on to, or that it stays for the user\'s decision' },
    { name: 'action', description: 'The move kind (proceed)' },
    { name: 'action-label', description: 'The button label: "Proceed" or "Run again"' },
    { name: 'action-target', description: 'Where the state goes after queuing, e.g. "phase2 / 03-iteration / 02-structural-requirements-pass"' },
]);

/** The template for `kind`: the configured one (an empty string included), else the default. */
export function processActionTemplate(kind: ProcessTemplateKind, configured?: ProcessActionTemplates | null): string {
    const own = configured?.[kind];
    return typeof own === 'string' ? own : DEFAULT_PROCESS_ACTION_TEMPLATES[kind];
}

/**
 * The `prompt` fields of what runs at `state`: the sub-step's; the step's too
 * when this is its first sub-step (or it has none); the phase's too when this
 * is, in addition, the phase's first step.
 */
export function positionPrompts(def: ProcessDefinition, state: ProcessState): string {
    const phase = findPhase(def, state.phase);
    const step = findStep(phase, state.step);
    const sub = findSubstep(step, state.substep);
    const subs = step?.substeps ?? [];
    const atStepStart = !sub || subs[0] === sub;
    const atPhaseStart = atStepStart && !!phase && phaseSteps(phase)[0]?.step === step;
    const levels: Array<{ prompt?: string } | undefined> = [];
    if (atPhaseStart) { levels.push(phase); }
    if (atStepStart) { levels.push(step); }
    if (sub) { levels.push(sub); }
    return levels.map((n) => n?.prompt?.trim() ?? '').filter(Boolean).join('\n\n');
}

/** A note for a run that is not the first: another iteration of what starts here, or a gate run again. */
export function runNote(def: ProcessDefinition, state: ProcessState): string {
    const phase = findPhase(def, state.phase);
    const step = findStep(phase, state.step);
    const sub = findSubstep(step, state.substep);
    if (phase && step === phase.gate && state.stepIteration > 1) {
        return `This is run ${state.stepIteration} of the gate: the previous run did not pass. Check first that what it found has been fixed.`;
    }
    const subs = step?.substeps ?? [];
    const atStepStart = !sub || subs[0] === sub;
    const atPhaseStart = atStepStart && !!phase && phaseSteps(phase)[0]?.step === step;
    if (sub && state.substepIteration > 1) {
        return `This is iteration ${state.substepIteration} of the sub-step: take in what the previous iteration left open.`;
    }
    if (atStepStart && state.stepIteration > 1) {
        return `Iteration ${state.stepIteration} of the step starts here: take in what the previous iteration left open.`;
    }
    if (atPhaseStart && state.phaseIteration > 1) {
        return `Iteration ${state.phaseIteration} of the phase starts here: take in what the previous iteration left open.`;
    }
    return '';
}

/** What happens after the prompt is queued, for the prompt itself. */
function afterText(def: ProcessDefinition, state: ProcessState, move: ProcessMove): string {
    const t = move.target;
    if (t.ran) {
        return 'The PROCESS view stays at this position until the user decides how the process goes on '
            + '(finish, repeat, gate passed or failed). Do not move the process state yourself.';
    }
    return `The PROCESS view has moved on to ${positionText(def, t)}; that runs only when the user proceeds again. `
        + `This prompt belongs to ${positionText(def, state)} — work in it, and do not move the process state yourself.`;
}

/** The values the Proceed template is resolved with, laid over the chat variables: those of the position being run. */
export function processActionValues(
    def: ProcessDefinition,
    state: ProcessState,
    move: ProcessMove,
    customInstructions: string,
    processDescription: string,
): Record<string, string> {
    const t = move.target;
    const values: Record<string, string> = {
        ...processVariableValues(def, state, processDescription),
        'custom-instructions': customInstructions.trim(),
        'action-prompt': positionPrompts(def, state),
        'action-note': runNote(def, state),
        'action-position': positionText(def, state),
        'action-after': afterText(def, state, move),
        action: move.kind,
        'action-label': move.label,
        'action-target': [t.phase, t.step, t.substep].filter(Boolean).join(' / '),
    };
    const role = currentRole(def, state);
    if (role) { values.role = role; }
    return values;
}

/**
 * A position for people: `Phase › Step › Sub-step`, each by name (else id),
 * with its iteration where the level is repeatable; ` (finished)` at the end
 * of a finished process.
 */
export function positionText(def: ProcessDefinition, state: ProcessState): string {
    const phase = findPhase(def, state.phase);
    const step = findStep(phase, state.step);
    const sub = findSubstep(step, state.substep);
    const part = (node: { id: string; name?: string; repeatable?: boolean } | undefined, n: number, gate = false): string =>
        node ? `${node.name || node.id}${node.repeatable || gate ? ` #${n}` : ''}` : '';
    const parts = [part(phase, state.phaseIteration), part(step, state.stepIteration, !!phase && step === phase.gate), part(sub, state.substepIteration)].filter(Boolean);
    return parts.join(' › ') + (state.completed ? ' (finished)' : '');
}

/** The session a move's prompt is queued in, and where that choice comes from. */
export interface ActionSession {
    /** The session name; `''` = the queue's default. */
    name: string;
    source: 'override' | 'process' | 'queue-default';
    /** The definition's spec, when it comes from the process (to create a missing session). */
    spec?: ProcessSession;
}

/**
 * The session the prompt of `state` runs in: the one picked on the action
 * page (`override`; `''` picks the queue default), else the one the process
 * names for that position (innermost of sub-step, step, phase), else the
 * queue default.
 */
export function actionSession(def: ProcessDefinition, state: ProcessState, override?: string): ActionSession {
    if (override !== undefined) {
        return override ? { name: override, source: 'override' } : { name: '', source: 'queue-default' };
    }
    const spec = effectiveSession(def, state);
    return spec ? { name: spec.name, source: 'process', spec } : { name: '', source: 'queue-default' };
}
