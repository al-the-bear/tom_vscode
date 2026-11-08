/**
 * The "Assist prompts": the prompts the extension runs to help the user —
 * Grill me, Explain in detail, Explain a decision, Finish review round, and
 * the prompt a queue item continues with on another profile when its profile
 * ran out of credit (Out of budget).
 *
 * They are templates of one category (`assistPrompts.templates`, edited in the
 * Global Template Editor); for each use the Status Page chooses which template
 * runs (`assistPrompts.selected.<use>`). A use with no choice runs its default
 * template (the seeded one with the use's default id), and only when that is
 * gone the built-in text below. Each use has its own placeholders, filled by
 * the caller before anything else expands the prompt.
 *
 * vscode-free.
 */

export const ASSIST_PROMPT_USES = ['grillMe', 'explainInDetail', 'explainDecision', 'finishReviewRound', 'outOfBudget'] as const;
export type AssistPromptUse = typeof ASSIST_PROMPT_USES[number];

export interface AssistPromptTemplate {
    id: string;
    name: string;
    description?: string;
    template: string;
}

/** `assistPrompts` in the extension config. */
export interface AssistPromptsSection {
    /** The template each use runs (an id of `templates`). Empty or missing: the use's default. */
    selected?: Partial<Record<AssistPromptUse, string>>;
    templates?: AssistPromptTemplate[];
}

/** What a use is: its label, its default template, and the placeholders the caller fills. */
export interface AssistPromptUseInfo {
    label: string;
    /** Where it runs, for the Status Page and the editor's help. */
    purpose: string;
    defaultId: string;
    defaultName: string;
    defaultBody: string;
    placeholders: Record<string, string>;
}

const GRILL_ME_BODY = [
    '**Grill me** on question ${questionId} in `${file}`.',
    '',
    'The question as written:',
    '',
    '${questionBlock}',
    '',
    'Help me answer it by asking — do not answer it for me:',
    '',
    '1. Read the document around the question so you know its context: its options and recommendation with tomAi_mdQuestions (in a TomSpecs document, tomAi_specAnnotations).',
    '2. Ask me narrowing questions through tomAi_askUser — a few at a time, each saying what it settles — until the question can be answered. Never ask in your reply text.',
    '3. Then propose the answer under the question with tomAi_mdProposeAnswer (source `grill me`). Do not write the Answer line: I accept, edit or discard the proposal in the MD Browser.',
    '4. End with one short paragraph: what you proposed and why.',
].join('\n');

const EXPLAIN_IN_DETAIL_BODY = [
    '**Explain in detail** question ${questionId} in `${file}`.',
    '',
    'The question as written:',
    '',
    '${questionBlock}',
    '',
    '1. Read the document around the question so you know its context: its options and recommendation with tomAi_mdQuestions (in a TomSpecs document, tomAi_specAnnotations).',
    '2. Write the explanation to `${explanationFile}`: what the question decides and why it matters; each option at length — what it means, what follows from it, what it costs and risks; how the recommendation was reached. End with the points worth digging deeper into.',
    '3. Show it with tomAi_askInMdBrowser and the buttons `deeper` (Dig deeper), `propose` (Propose an answer) and `done` (Done); Keep this file is mine to decide.',
    '   - Dig deeper: ask me which point (tomAi_askUser), extend the explanation, and show it again.',
    '   - Propose an answer: propose it under the question with tomAi_mdProposeAnswer (source `explain in detail`).',
    '   - Done: stop.',
    '4. Never write the Answer line yourself.',
].join('\n');

const EXPLAIN_DECISION_BODY = [
    '**Explain a decision** of process ${process}, at ${position}.',
    '',
    'The decision: ${decision}',
    '',
    '1. Read where the process is (tomAi_getProcessState) and what the work that led here did: the session\'s live trail, the files it changed.',
    '2. Write your advice to `${noteFile}`: each choice — what happens next if it is taken, what speaks for and against it given the work so far — and which one you would take and why. The decision stays mine.',
    '3. Show it with tomAi_askInMdBrowser and the button `back` (Back to the decision); Keep this file is mine to decide.',
    '4. Do not move the process yourself.',
].join('\n');

const FINISH_REVIEW_ROUND_BODY = [
    '**Finish review round** of step ${step} (process ${process}).',
    '',
    'The review\'s results are in `${resultsFile}`.',
    '',
    '1. Show them with tomAi_askInMdBrowser and the button `finish` (Finish review round); Keep this file is mine to decide.',
    '2. Wait for the click. On Finish review round the review is done: say so in one line and end your answer.',
    '3. On anything else (the panel closed, a timeout) report it and end without moving the process.',
].join('\n');

/** The out-of-budget prompt, as the code built it before it became a template. */
const OUT_OF_BUDGET_BODY = [
    '**Out of budget — continuing on profile "${toProfile}".**',
    '',
    'The prompt below was running on profile "${stoppedProfile}" (${stoppedProfileId}, model ${stoppedModel}) in session "${stoppedSession}" and stopped at ${stoppedAt}: ${budgetMessage}',
    'It is sent again on profile "${toProfile}".${sessionNote}',
    '',
    'What the stopped run had already done is in that session\'s live trail, ${liveTrail}; changes it made and did not commit are in the working trees (`git status`). Read them first and continue the work from where it stopped — do not start it over.',
    '',
    '---',
    '',
    '${originalPrompt}',
].join('\n');

const QUESTION_PLACEHOLDERS = {
    file: 'the document holding the question (workspace-relative)',
    questionId: 'the question id, e.g. `CC-125`',
    questionBlock: 'the question block as written in the document',
};

export const ASSIST_PROMPT_INFO: Record<AssistPromptUse, AssistPromptUseInfo> = {
    grillMe: {
        label: 'Grill me',
        purpose: 'An open question in the MD Browser: asks you narrowing questions until it can be answered, then proposes the answer.',
        defaultId: 'grill-me', defaultName: 'Grill me', defaultBody: GRILL_ME_BODY,
        placeholders: { ...QUESTION_PLACEHOLDERS },
    },
    explainInDetail: {
        label: 'Explain in detail',
        purpose: 'An open question in the MD Browser: explains it and each option at length in a note beside the document.',
        defaultId: 'explain-in-detail', defaultName: 'Explain in detail', defaultBody: EXPLAIN_IN_DETAIL_BODY,
        placeholders: { ...QUESTION_PLACEHOLDERS, explanationFile: 'the note to write the explanation to (`<document folder>/notes/<question id>-explained.md`)' },
    },
    explainDecision: {
        label: 'Explain a decision',
        purpose: 'A process decision (Decide…): advice on each choice in a note in the quest\'s process folder.',
        defaultId: 'explain-decision', defaultName: 'Explain a decision', defaultBody: EXPLAIN_DECISION_BODY,
        placeholders: {
            process: 'the process id',
            position: 'where the process is (phase, step, sub-step)',
            decision: 'what is to be decided, with its choices',
            noteFile: 'the note to write the advice to',
        },
    },
    finishReviewRound: {
        label: 'Finish review round',
        purpose: 'A review step\'s closing item: shows the results in the MD Browser with the Finish review round button.',
        defaultId: 'finish-review-round', defaultName: 'Finish review round', defaultBody: FINISH_REVIEW_ROUND_BODY,
        placeholders: {
            process: 'the process id',
            step: 'the review step',
            resultsFile: 'the review\'s results document',
        },
    },
    outOfBudget: {
        label: 'Out of budget',
        purpose: 'A queue item continuing on another profile after its profile ran out of API credit.',
        defaultId: 'out-of-budget', defaultName: 'Out of budget', defaultBody: OUT_OF_BUDGET_BODY,
        placeholders: {
            stoppedProfile: 'the name of the profile that ran out',
            stoppedProfileId: 'its id',
            stoppedModel: 'its model (`unknown` when not recorded)',
            stoppedSession: 'the session the stopped stage ran in',
            stoppedAt: 'when it stopped (ISO time)',
            budgetMessage: 'the API\'s message',
            liveTrail: 'that session\'s live trail (its path in backticks when the quest is known)',
            toProfile: 'the name of the profile the work continues on',
            runsInSession: 'the session it continues in',
            sessionNote: 'a sentence saying why it runs in another session, empty when it runs in the same one',
            originalPrompt: 'the prompt that stopped, as it was sent',
        },
    },
};

/** The template a use runs, and where it came from. */
export interface ResolvedAssistPrompt {
    id: string;
    name: string;
    template: string;
    /** `selected`: the Status Page's choice; `default`: the use's default template; `builtIn`: the text in this module. */
    source: 'selected' | 'default' | 'builtIn';
}

/** The template `use` runs: the chosen one, else the use's default template, else the built-in text. */
export function resolveAssistPrompt(section: AssistPromptsSection | undefined, use: AssistPromptUse): ResolvedAssistPrompt {
    const info = ASSIST_PROMPT_INFO[use];
    const templates = section?.templates ?? [];
    const chosenId = section?.selected?.[use];
    const chosen = chosenId ? templates.find((t) => t.id === chosenId) : undefined;
    if (chosen) { return { id: chosen.id, name: chosen.name || chosen.id, template: chosen.template, source: 'selected' }; }
    const fallback = templates.find((t) => t.id === info.defaultId);
    if (fallback) { return { id: fallback.id, name: fallback.name || fallback.id, template: fallback.template, source: 'default' }; }
    return { id: info.defaultId, name: info.defaultName, template: info.defaultBody, source: 'builtIn' };
}

/**
 * `body` with the use's placeholders filled — every one the use declares, a
 * missing value as empty text — in one pass, so a value is never expanded
 * again. Placeholders the use does not declare stay for the prompt's own
 * expansion.
 */
export function fillAssistPrompt(use: AssistPromptUse, body: string, values: Partial<Record<string, string>>): string {
    const declared = ASSIST_PROMPT_INFO[use].placeholders;
    return body.replace(/\$\{(\w+)\}/g, (all, key: string) =>
        Object.prototype.hasOwnProperty.call(declared, key) ? (values[key] ?? '') : all);
}

/** The chosen template of `use`, filled. */
export function buildAssistPrompt(section: AssistPromptsSection | undefined, use: AssistPromptUse, values: Partial<Record<string, string>>): string {
    return fillAssistPrompt(use, resolveAssistPrompt(section, use).template, values);
}

/**
 * Seed the five default templates that are missing (by id), so each use has
 * an editable template on disk. Idempotent; never touches an existing one or
 * the choices. Returns whether it changed the section.
 */
export function ensureDefaultAssistPrompts(config: { assistPrompts?: AssistPromptsSection }): boolean {
    const section = (config.assistPrompts ??= {});
    const templates = (section.templates ??= []);
    let changed = false;
    for (const use of ASSIST_PROMPT_USES) {
        const info = ASSIST_PROMPT_INFO[use];
        if (templates.some((t) => t.id === info.defaultId)) { continue; }
        templates.push({ id: info.defaultId, name: info.defaultName, description: info.purpose, template: info.defaultBody });
        changed = true;
    }
    return changed;
}

/** The editor's help for the category: every use with its placeholders. */
export function assistPromptsHelp(): string {
    return ASSIST_PROMPT_USES.map((use) => {
        const info = ASSIST_PROMPT_INFO[use];
        const rows = Object.entries(info.placeholders).map(([k, v]) => `<code>\${${k}}</code> – ${v}`).join('<br>');
        return `<strong>${info.label}</strong> — ${info.purpose}<br>${rows}`;
    }).join('<br><br>');
}
