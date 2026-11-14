/**
 * The "Assist prompts": the prompts the extension runs to help the user —
 * Grill me, Explain in detail, Explain a decision, Finish review round, Gate
 * decision, and
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

export const ASSIST_PROMPT_USES = ['grillMe', 'explainInDetail', 'explainDecision', 'grillMeDecision', 'finishReviewRound', 'gateDecision', 'outOfBudget'] as const;
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

/** Grill me as i-3 seeded it (no document kind). */
const GRILL_ME_BODY_V1 = [
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

/** Explain in detail as i-3 seeded it. */
const EXPLAIN_IN_DETAIL_BODY_V1 = [
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

/** How a question is read and an answer proposed, by document kind — both kinds named, the prompt says which this is. */
const READ_AND_PROPOSE = [
    'This document is ${documentKind}. In plain Markdown read the question (its options and recommendation) with tomAi_mdQuestions and propose with tomAi_mdProposeAnswer;',
    'in a TomSpecs specification read it with tomAi_specAnnotations and propose as a reviewer comment under the question with tomAi_specInsertComment, its text starting `Proposed answer:`.',
].join(' ');

const GRILL_ME_BODY = [
    '**Grill me** on question ${questionId} in `${file}`.',
    '',
    'The question as written:',
    '',
    '${questionBlock}',
    '',
    READ_AND_PROPOSE,
    '',
    'Help me answer it by asking — do not answer it for me:',
    '',
    '1. Read the document around the question so you know its context.',
    '2. Ask me narrowing questions through tomAi_askUser — a few at a time, each saying what it settles; offer the likely answers as `choices` — until the question can be answered. Never ask in your reply text.',
    '3. Then propose the answer under the question (source `grill me`). Do not write the Answer line: I accept, edit or discard the proposal in the MD Browser.',
    '4. End with one short paragraph: what you proposed and why.',
].join('\n');

/** Explain in detail before its notes linked their files (a path in backticks cannot be clicked). */
const EXPLAIN_IN_DETAIL_BODY_V2 = [
    '**Explain in detail** question ${questionId} in `${file}`.',
    '',
    'The question as written:',
    '',
    '${questionBlock}',
    '',
    READ_AND_PROPOSE,
    '',
    '1. Read the document around the question so you know its context.',
    '2. Write the explanation to `${explanationFile}`: what the question decides and why it matters; each option at length — what it means, what follows from it, what it costs and risks; how the recommendation was reached. End with the points worth digging deeper into.',
    '3. Show it with tomAi_askInMdBrowser and the buttons `deeper` (Dig deeper), `propose` (Propose an answer) and `done` (Done); Keep this file is mine to decide.',
    '   - Dig deeper: ask which point through tomAi_askUser, the points as `choices` (kind `answer`), extend the explanation, and show it again.',
    '   - Propose an answer: propose it under the question (source `explain in detail`).',
    '   - Done: stop.',
    '4. Never write the Answer line yourself.',
].join('\n');

/** How a note names a file: a link the MD Browser can follow. */
const LINK_FILES =
    '   Name every file as a Markdown link relative to the note, e.g. `[the design](../designs/<id>/<id>.md)` — never as a bare path in backticks: the MD Browser opens a link on a click, a path not at all.';

const EXPLAIN_IN_DETAIL_BODY = [
    '**Explain in detail** question ${questionId} in `${file}`.',
    '',
    'The question as written:',
    '',
    '${questionBlock}',
    '',
    READ_AND_PROPOSE,
    '',
    '1. Read the document around the question so you know its context.',
    '2. Write the explanation to `${explanationFile}`: what the question decides and why it matters; each option at length — what it means, what follows from it, what it costs and risks; how the recommendation was reached. End with the points worth digging deeper into.',
    LINK_FILES,
    '3. Show it with tomAi_askInMdBrowser and the buttons `deeper` (Dig deeper), `propose` (Propose an answer) and `done` (Done); Keep this file is mine to decide.',
    '   - Dig deeper: ask which point through tomAi_askUser, the points as `choices` (kind `answer`), extend the explanation, and show it again.',
    '   - Propose an answer: propose it under the question (source `explain in detail`).',
    '   - Done: stop.',
    '4. Never write the Answer line yourself.',
].join('\n');

/** Explain a decision as i-3 seeded it (the button without the reopen). */
const EXPLAIN_DECISION_BODY_V1 = [
    '**Explain a decision** of process ${process}, at ${position}.',
    '',
    'The decision: ${decision}',
    '',
    '1. Read where the process is (tomAi_getProcessState) and what the work that led here did: the session\'s live trail, the files it changed.',
    '2. Write your advice to `${noteFile}`: each choice — what happens next if it is taken, what speaks for and against it given the work so far — and which one you would take and why. The decision stays mine.',
    '3. Show it with tomAi_askInMdBrowser and the button `back` (Back to the decision); Keep this file is mine to decide.',
    '4. Do not move the process yourself.',
].join('\n');

/** How the advice was shown before the note carried the decision's choices. */
const SHOW_DECISION_ADVICE_V1 = [
    '3. Show the note with tomAi_askInMdBrowser and `reopenDecision: true`: its button **Back to the decision** reopens the decision for me; Keep this file is mine to decide.',
    '   When your advice fits in a few sentences, you may instead give it through tomAi_askUser and skip the note; the decision reopens when your turn ends.',
    '4. Do not move the process and do not decide: the decision stays mine.',
].join('\n');

/** Explain a decision before its notes linked their files. */
const EXPLAIN_DECISION_BODY_V2 = [
    '**Explain a decision** of process ${process}, at ${position}.',
    '',
    'The decision: ${decision}',
    '',
    '1. Read where the process is (tomAi_getProcessState) and what the work that led here did: the session\'s live trail, the files it changed.',
    '2. Write your advice to `${noteFile}`: each choice — what happens next if it is taken, what speaks for and against it given the work so far — and which one you would take and why.',
    SHOW_DECISION_ADVICE_V1,
].join('\n');

/** How the advice is shown: the note with the decision's own choices and Back to the decision; or briefly in the question panel. */
const SHOW_DECISION_ADVICE = [
    '3. Show the note with tomAi_askInMdBrowser and `reopenDecision: true`: its bar carries the decision\'s own choices — a click takes that choice — and **Back to the decision**, which reopens the decision for me; Keep this file is mine to decide.',
    '   When your advice fits in a few sentences, you may instead give it through tomAi_askUser and skip the note; the decision reopens when your turn ends.',
    '4. Do not move the process and do not decide: the decision stays mine. When my click took a choice (`decisionTaken` in the answer), the extension made it — end your answer.',
].join('\n');

const EXPLAIN_DECISION_LINES = [
    '**Explain a decision** of process ${process}, at ${position}.',
    '',
    'The decision: ${decision}',
    '',
    '1. Read where the process is (tomAi_getProcessState) and what the work that led here did: the session\'s live trail, the files it changed.',
    '2. Write your advice to `${noteFile}`: each choice — what happens next if it is taken, what speaks for and against it given the work so far — and which one you would take and why.',
    LINK_FILES,
];

/** Explain a decision before its note carried the decision's choices. */
const EXPLAIN_DECISION_BODY_V3 = [...EXPLAIN_DECISION_LINES, SHOW_DECISION_ADVICE_V1].join('\n');

const EXPLAIN_DECISION_BODY = [...EXPLAIN_DECISION_LINES, SHOW_DECISION_ADVICE].join('\n');

const GRILL_ME_DECISION_LINES = [
    '**Grill me** on a decision of process ${process}, at ${position}.',
    '',
    'The decision: ${decision}',
    '',
    'Help me decide by asking — do not decide for me:',
    '',
    '1. Read where the process is (tomAi_getProcessState) and what the work that led here did: the session\'s live trail, the files it changed.',
    '2. Ask me narrowing questions through tomAi_askUser — a few at a time, each saying what it settles; offer the likely answers as `choices` (kind `answer`) — until it is clear which choice fits. Never ask in your reply text.',
    '   Then write your advice to `${noteFile}`: what my answers settled, the choice you would take and why, and what speaks against the others.',
];

/** Grill me at a decision before its notes linked their files. */
const GRILL_ME_DECISION_BODY_V1 = [...GRILL_ME_DECISION_LINES, SHOW_DECISION_ADVICE_V1].join('\n');

/** Grill me at a decision before its note carried the decision's choices. */
const GRILL_ME_DECISION_BODY_V2 = [...GRILL_ME_DECISION_LINES, LINK_FILES, SHOW_DECISION_ADVICE_V1].join('\n');

const GRILL_ME_DECISION_BODY = [...GRILL_ME_DECISION_LINES, LINK_FILES, SHOW_DECISION_ADVICE].join('\n');

/** Finish review round before it told one document from several (the review document). */
const FINISH_REVIEW_ROUND_BODY_V2 = [
    '**Finish review round** — put the results in front of the user for the review, ${step} of process ${process}.',
    '',
    '1. Show ${resultsFile} with tomAi_askInMdBrowser: `finishReviewRound: true`, the title `Review: ${step}`; Keep this file is the user\'s to decide. If the call is refused (no review follows), open the document with tomAi_openInMdBrowser instead and say so.',
    '2. Wait for the answer. On `finish` the extension has confirmed the review, closed that panel and moved the process on — the next step\'s prompt is queued, or the decision is open: report its `summary` in one line and end your answer. Do not move the process or queue anything yourself.',
    '3. On anything else (the panel closed, a timeout) report it and end without moving the process.',
].join('\n');

const FINISH_REVIEW_ROUND_BODY = [
    '**Finish review round** — put the results in front of the user for the review, ${step} of process ${process}.',
    '',
    '1. What is under review: ${resultsFile} — every document this step produced or changed that the user is to review (the step\'s prompt names them). Close the MD Browser panels that show older copies of them (round folders; tomAi_listMdBrowserPanels, tomAi_closeMdBrowser with each `panelId`), so only current versions are open.',
    '2. One document: make sure its current version is open and in front, and show it with tomAi_askInMdBrowser: `finishReviewRound: true`, the title `Review: ${step}`.',
    '   Several documents: write the review document `${reviewFile}` in the step\'s round folder (else beside the first document): the review\'s title and position, then one entry per document — a Markdown link relative to it (a space written `%20`), what changed in it this round, its open questions (count and ids) and what to look at. Open each document\'s current version (tomAi_openInMdBrowser, `preserveFocus: true`), then show the review document with tomAi_askInMdBrowser: `finishReviewRound: true`, the title `Review: ${step}`.',
    '   Keep this file is the user\'s to decide. If the call is refused (no review follows), open the document(s) with tomAi_openInMdBrowser instead and say so.',
    '3. Wait for the answer. On `finish` the extension has confirmed the review, closed that panel and moved the process on — the next step\'s prompt is queued, or the decision is open: report its `summary` in one line and end your answer. Do not move the process or queue anything yourself.',
    '4. On anything else (the panel closed, a timeout) report it and end without moving the process.',
].join('\n');

const GATE_DECISION_BODY = [
    '**Gate decision** — put the gate\'s result in front of the user with the decision\'s buttons, ${step} of process ${process}.',
    '',
    '1. The result: ${resultsFile} — each checklist item with pass or fail and why, the answers taken in, and your recommendation (go on, or repeat / gate failed) with its full explanation. Name every file it refers to as a Markdown link relative to it. Close the MD Browser panels that show older copies of it (tomAi_listMdBrowserPanels, tomAi_closeMdBrowser with each `panelId`).',
    '2. Show it with tomAi_askInMdBrowser: `gateDecision: true`, the title `Gate: ${step}` — the buttons are the decision\'s own choices (gate passed / gate failed, go on / repeat). Keep this file is the user\'s to decide. If the call is refused, open the document with tomAi_openInMdBrowser instead, say so, and leave the decision to the PROCESS view (Decide…).',
    '3. Wait for the answer. On a choice (`decisionTaken`) the extension has ended the gate\'s step and taken the decision as Decide… does: report its `summary` in one line and end your answer. Do not move the process or queue anything yourself.',
    '4. On anything else (the panel closed, a timeout) report it and end without moving the process: the decision opens in the PROCESS view once this prompt has ended.',
].join('\n');

/**
 * Earlier built-in defaults, by use: a default template on disk whose text is
 * still exactly one of them was never edited, so seeding replaces it with the
 * current default. An edited one is kept.
 */
const PREVIOUS_DEFAULT_BODIES: Partial<Record<string, string[]>> = {
    explainDecision: [EXPLAIN_DECISION_BODY_V1, EXPLAIN_DECISION_BODY_V2, EXPLAIN_DECISION_BODY_V3],
    grillMe: [GRILL_ME_BODY_V1],
    explainInDetail: [EXPLAIN_IN_DETAIL_BODY_V1, EXPLAIN_IN_DETAIL_BODY_V2],
    grillMeDecision: [GRILL_ME_DECISION_BODY_V1, GRILL_ME_DECISION_BODY_V2],
    finishReviewRound: [FINISH_REVIEW_ROUND_BODY_V2, [
        '**Finish review round** of step ${step} (process ${process}).',
        '',
        'The review\'s results are in `${resultsFile}`.',
        '',
        '1. Show them with tomAi_askInMdBrowser and the button `finish` (Finish review round); Keep this file is mine to decide.',
        '2. Wait for the click. On Finish review round the review is done: say so in one line and end your answer.',
        '3. On anything else (the panel closed, a timeout) report it and end without moving the process.',
    ].join('\n')],
};

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
    documentKind: '`plain Markdown` or `a TomSpecs specification` — which tools read and propose',
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
    grillMeDecision: {
        label: 'Grill me at a decision',
        purpose: 'A process decision (Decide…): asks you narrowing questions until it is clear which choice fits, then advice in a note in the quest\'s process folder.',
        defaultId: 'grill-me-decision', defaultName: 'Grill me at a decision', defaultBody: GRILL_ME_DECISION_BODY,
        placeholders: {
            process: 'the process id',
            position: 'where the process is (phase, step, sub-step)',
            decision: 'what is to be decided, with its choices',
            noteFile: 'the note to write the advice to',
        },
    },
    finishReviewRound: {
        label: 'Finish review round',
        purpose: 'A step\'s closing item before a review: shows the results in the MD Browser with the Finish review round button (in a process step\'s prompt as `${finish-review-round}`).',
        defaultId: 'finish-review-round', defaultName: 'Finish review round', defaultBody: FINISH_REVIEW_ROUND_BODY,
        placeholders: {
            process: 'the process id',
            step: 'the review (the user-action step the results are reviewed in)',
            resultsFile: 'the document to review (`the document this step produced` in a process step\'s prompt)',
            reviewFile: 'the name of the review document a review of several documents gets (`review_<phase>_<step>_repetition_<n>_<yyyymmdd_hhmmss>.md`)',
        },
    },
    gateDecision: {
        label: 'Gate decision',
        purpose: 'The end of a gate\'s prompt: shows the gate\'s result in the MD Browser with the buttons of the decision after the gate — gate passed / failed, go on / repeat (in a process step\'s prompt as `${gate-decision}`).',
        defaultId: 'gate-decision', defaultName: 'Gate decision', defaultBody: GATE_DECISION_BODY,
        placeholders: {
            process: 'the process id',
            step: 'the gate (where the process is)',
            resultsFile: 'the gate\'s result document (`the gate\'s result document` in a process step\'s prompt; the gate\'s prompt names it, e.g. gates/G<n>.md)',
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
 * Seed the default templates that are missing (by id), so each use has
 * an editable template on disk, and bring a default template still holding an
 * earlier built-in text (never edited) to the current one. Idempotent; an
 * edited template and the choices are never touched. Returns whether it
 * changed the section.
 */
export function ensureDefaultAssistPrompts(config: { assistPrompts?: AssistPromptsSection }): boolean {
    const section = (config.assistPrompts ??= {});
    const templates = (section.templates ??= []);
    let changed = false;
    for (const use of ASSIST_PROMPT_USES) {
        const info = ASSIST_PROMPT_INFO[use];
        const existing = templates.find((t) => t.id === info.defaultId);
        if (existing) {
            if ((PREVIOUS_DEFAULT_BODIES[use] ?? []).includes(existing.template)) {
                existing.template = info.defaultBody;
                existing.description = info.purpose;
                changed = true;
            }
            continue;
        }
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
