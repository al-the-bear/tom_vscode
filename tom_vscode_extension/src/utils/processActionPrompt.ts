/**
 * Process actions — the prompts the PROCESS view's action bar queues (pure; no
 * `vscode`, no IO).
 *
 * Every move kind (`next`, `finish`, `repeat`, `gate-passed`, `gate-failed`,
 * `finish-process`, `skip`, `back`) has ONE prompt template, global for all
 * processes, kept in the extension config under `processActionTemplates` and
 * edited in the process template editor. What is specific to a step comes from
 * the definition's `prompt` fields, which the template inserts through
 * `${action-prompt}` (or `${phase-prompt}` / `${step-prompt}` / `${substep-prompt}`).
 *
 * The template is resolved by the placeholder engine with the values of
 * {@link processActionValues} laid over the chat variables: the process
 * variables describe the position the move LEADS TO, so a template reads as
 * the instruction for the step being started. A template that resolves to
 * nothing queues nothing — `skip` and `back` default to that.
 */

// Keys here are move kinds and placeholder names (`gate-passed`, `${action-prompt}`), dashed by design.
/* eslint-disable @typescript-eslint/naming-convention */

import {
    currentRole,
    processVariableValues,
    findPhase,
    findStep,
    findSubstep,
    type ProcessDefinition,
    type ProcessMove,
    type ProcessMoveKind,
    type ProcessState,
} from './processDefinition';

export type ProcessActionTemplates = Partial<Record<ProcessMoveKind, string>>;

const POSITION =
    'Process `${process}`, phase `${phase}` (iteration ${phase-iteration}), step `${step}` (iteration ${step-iteration})'
    + '${{ vars.substep ? ", sub-step `" + vars.substep + "` (iteration " + vars["substep-iteration"] + ")" : "" }}.';

const INSTRUCTIONS = '${{ vars["custom-instructions"] ? "\\n\\n## Instructions\\n\\n" + vars["custom-instructions"] : "" }}';

const ACTION_PROMPT = '${{ vars["action-prompt"] ? "\\n\\n## What to do\\n\\n" + vars["action-prompt"] : "" }}';

const CLOSING = '\n\nThe process state has already been moved here; record further moves with `tomAi_setProcessState`.';

/** The templates used when the config holds none for a kind. */
export const DEFAULT_PROCESS_ACTION_TEMPLATES: Readonly<Record<ProcessMoveKind, string>> = Object.freeze({
    next: `# Next: \${action-target}\n\n${POSITION}${ACTION_PROMPT}${INSTRUCTIONS}${CLOSING}`,
    finish: `# \${action-label} — on to \${action-target}\n\nThe \${action-level} is finished. ${POSITION}${ACTION_PROMPT}${INSTRUCTIONS}${CLOSING}`,
    repeat: `# \${action-label}: iteration \${action-iteration}\n\nAnother iteration of the \${action-level} starts. ${POSITION}\n\nTake in what the previous iteration left open.${ACTION_PROMPT}${INSTRUCTIONS}${CLOSING}`,
    'gate-passed': `# Gate passed — on to \${action-target}\n\nThe quality gate \`\${from-step}\` of phase \`\${from-phase}\` passed. ${POSITION}${ACTION_PROMPT}${INSTRUCTIONS}${CLOSING}`,
    'gate-failed': `# Gate failed — run it again\n\nThe quality gate \`\${step}\` did not pass; it is run again (iteration \${step-iteration}). Fix what the last run found, then check the gate again.${ACTION_PROMPT}${INSTRUCTIONS}${CLOSING}`,
    'finish-process': `# Process finished\n\nThe last step of process \`\${process}\` is done. Summarise the outcome and what is left open.${INSTRUCTIONS}`,
    skip: '',
    back: '',
});

/** What each move kind is, for the template editor. */
export const PROCESS_ACTION_TITLES: Readonly<Record<ProcessMoveKind, string>> = Object.freeze({
    next: 'Next — the next step or sub-step',
    finish: 'Finish phase / step / sub-step — where a repeat was possible',
    repeat: 'Repeat phase / step / sub-step — a new iteration',
    'gate-passed': 'Gate passed — on to the post-gate step or the next phase',
    'gate-failed': 'Gate failed — the gate is run again',
    'finish-process': 'Finish process — the last step is done',
    skip: 'Skip — move on without work (empty: nothing is queued)',
    back: 'Back — a correction to the previous position (empty: nothing is queued)',
});

/** The variables an action adds to the chat and process variables. */
export const PROCESS_ACTION_VARIABLES: ReadonlyArray<{ name: string; description: string }> = Object.freeze([
    { name: 'custom-instructions', description: 'What you typed on the action page' },
    { name: 'action-prompt', description: 'The `prompt` fields of what the move starts: phase, step, sub-step' },
    { name: 'action', description: 'The move kind (next, finish, repeat, …)' },
    { name: 'action-label', description: 'The button label, e.g. "Repeat step"' },
    { name: 'action-level', description: 'phase / step / sub-step for finish and repeat' },
    { name: 'action-iteration', description: 'The iteration a repeat starts' },
    { name: 'action-target', description: 'Where the move leads, e.g. "phase2 / 03-iteration / 01-questions-round"' },
    { name: 'from-phase', description: 'The phase before the move' },
    { name: 'from-step', description: 'The step before the move' },
    { name: 'from-substep', description: 'The sub-step before the move' },
]);

/** The template for `kind`: the configured one (an empty string included), else the default. */
export function processActionTemplate(kind: ProcessMoveKind, configured?: ProcessActionTemplates | null): string {
    const own = configured?.[kind];
    return typeof own === 'string' ? own : DEFAULT_PROCESS_ACTION_TEMPLATES[kind];
}

const LEVEL_TITLE = { phase: 'phase', step: 'step', substep: 'sub-step' } as const;

/**
 * The `prompt` fields of what the move starts: a new phase (or phase
 * iteration) starts its phase, first step and first sub-step; a new step its
 * step and first sub-step; a new sub-step itself. Nothing when the position
 * does not change (finishing, reopening).
 */
export function startedPrompts(def: ProcessDefinition, before: ProcessState, target: ProcessState): string {
    const phase = findPhase(def, target.phase);
    const step = findStep(phase, target.step);
    const sub = findSubstep(step, target.substep);
    const levels: Array<{ prompt?: string } | undefined> = [];
    if (target.phase !== before.phase || target.phaseIteration !== before.phaseIteration) {
        levels.push(phase, step, sub);
    } else if (target.step !== before.step || target.stepIteration !== before.stepIteration) {
        levels.push(step, sub);
    } else if (target.substep !== before.substep || target.substepIteration !== before.substepIteration) {
        levels.push(sub);
    }
    return levels.map((n) => n?.prompt?.trim() ?? '').filter(Boolean).join('\n\n');
}

/** The values a move's template is resolved with, laid over the chat variables. */
export function processActionValues(
    def: ProcessDefinition,
    before: ProcessState,
    move: ProcessMove,
    customInstructions: string,
    processDescription: string,
): Record<string, string> {
    const t = move.target;
    const values: Record<string, string> = {
        ...processVariableValues(def, t, processDescription),
        'custom-instructions': customInstructions.trim(),
        'action-prompt': startedPrompts(def, before, t),
        action: move.kind,
        'action-label': move.label,
        'action-level': move.level ? LEVEL_TITLE[move.level] : '',
        'action-iteration': move.level ? String(t[`${move.level}Iteration` as const]) : '',
        'action-target': [t.phase, t.step, t.substep].filter(Boolean).join(' / '),
        'from-phase': before.phase,
        'from-step': before.step,
        'from-substep': before.substep,
    };
    const role = currentRole(def, t);
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
