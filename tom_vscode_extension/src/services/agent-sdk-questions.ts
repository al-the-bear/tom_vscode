/**
 * Pure logic for intercepting the Claude Agent SDK's built-in
 * `AskUserQuestion` tool (spec: anthropic_sdk_integration.md §18,
 * "Anthropic Interactive Questions").
 *
 * ## Why this exists
 *
 * `AskUserQuestion` is a built-in tool of the Claude Code preset that only
 * exists on the `agentSdk` transport with `useBuiltInTools: true`. In a
 * headless run (no TTY) the SDK cannot collect an answer, so the unanswered
 * questions surface as the turn's final text — i.e. the agent "asks" but
 * nothing ever answers, and the run stalls.
 *
 * The transport's `canUseTool` callback intercepts the call and returns a
 * `deny` result whose message is fed back to the model as the tool result.
 * Two modes:
 *   - **interactive enabled**  → drive a VS Code QuickPick per question and
 *     return the user's selections as the answer ({@link collectInteractiveAnswers}).
 *   - **interactive disabled** (default) or **user dismissed** → return the
 *     resolved fallback template ({@link DEFAULT_INTERACTIVE_QUESTIONS_TEMPLATE}),
 *     telling the agent to proceed autonomously.
 *
 * Everything here is free of `vscode` / SDK *runtime* imports (the
 * `UserPrompter` dependency is a type-only import, erased at compile time)
 * so it can be unit-tested under `node --test` with a stub prompter.
 */

import type { UserPrompter, PickerItem } from '../tools/user-interaction-tools';

/** The built-in tool name the SDK uses (no `mcp__` prefix on built-ins). */
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/** Label appended to every question's option list for free-text entry. */
export const OTHER_OPTION_LABEL = 'Other…';

export interface AskUserQuestionOption {
    label: string;
    description?: string;
}

export interface AskUserQuestionItem {
    /** The question text shown to the user. */
    question: string;
    /** Short header/category for the question (SDK calls it `header`). */
    header: string;
    /** Whether multiple options may be selected. */
    multiSelect: boolean;
    /** Predefined answer options (the SDK auto-adds an "Other" affordance). */
    options: AskUserQuestionOption[];
}

export interface ParsedAskUserQuestion {
    questions: AskUserQuestionItem[];
}

/**
 * Fallback returned to the model when interactive questions are disabled or
 * the user dismisses the picker. References `${questions}` (expanded by the
 * handler with the placeholder engine to a digest of the skipped questions).
 */
export const DEFAULT_INTERACTIVE_QUESTIONS_TEMPLATE =
    'The user is not available to answer interactive questions right now. ' +
    'Do not wait for a response — proceed autonomously using your best ' +
    'judgement and the recommendation you would otherwise have presented. ' +
    'If a choice is reversible, pick the most reasonable default and state ' +
    'the assumption you made in your answer.\n\n' +
    'Questions that were skipped:\n${questions}';

/** True when the SDK is calling its built-in `AskUserQuestion` tool. */
export function isAskUserQuestionTool(toolName: string): boolean {
    return toolName === ASK_USER_QUESTION_TOOL_NAME;
}

/**
 * Validate and normalise the SDK's `AskUserQuestionInput` shape. Returns
 * `null` when the input doesn't look like a question payload (defensive —
 * the caller then leaves the tool call untouched).
 */
export function parseAskUserQuestionInput(input: unknown): ParsedAskUserQuestion | null {
    if (!input || typeof input !== 'object') {
        return null;
    }
    const rawQuestions = (input as { questions?: unknown }).questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        return null;
    }
    const questions: AskUserQuestionItem[] = [];
    for (const raw of rawQuestions) {
        if (!raw || typeof raw !== 'object') {
            return null;
        }
        const q = raw as {
            question?: unknown;
            header?: unknown;
            multiSelect?: unknown;
            options?: unknown;
        };
        if (typeof q.question !== 'string' || q.question.trim().length === 0) {
            return null;
        }
        const options: AskUserQuestionOption[] = [];
        if (Array.isArray(q.options)) {
            for (const opt of q.options) {
                if (opt && typeof opt === 'object' && typeof (opt as { label?: unknown }).label === 'string') {
                    const o = opt as { label: string; description?: unknown };
                    options.push({
                        label: o.label,
                        description: typeof o.description === 'string' ? o.description : undefined,
                    });
                }
            }
        }
        questions.push({
            question: q.question,
            header: typeof q.header === 'string' ? q.header : '',
            multiSelect: q.multiSelect === true,
            options,
        });
    }
    return questions.length > 0 ? { questions } : null;
}

/**
 * Human-readable digest of the questions (one bullet per question with its
 * options), suitable for inlining into the fallback template via
 * `${questions}`.
 */
export function summarizeQuestions(parsed: ParsedAskUserQuestion): string {
    return parsed.questions
        .map((q) => {
            const head = q.header ? `[${q.header}] ` : '';
            const opts = q.options.length > 0
                ? ` (options: ${q.options.map((o) => o.label).join(', ')})`
                : '';
            return `- ${head}${q.question}${opts}`;
        })
        .join('\n');
}

/**
 * Format collected answers into the tool-result text handed back to the
 * model. Pure — separated from {@link collectInteractiveAnswers} so it can
 * be tested without a prompter.
 */
export function formatInteractiveAnswers(
    answers: Array<{ header: string; question: string; selections: string[] }>,
): string {
    const lines = ['The user answered your questions:', ''];
    for (const a of answers) {
        const head = a.header ? `**${a.header}** — ` : '';
        const value = a.selections.length > 0 ? a.selections.join(', ') : '(no selection)';
        lines.push(`${head}${a.question}`);
        lines.push(`→ ${value}`);
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}

/**
 * Drive the prompter to collect answers interactively, one QuickPick per
 * question. Each question's options are shown plus an "Other…" entry that
 * falls through to a free-text input box.
 *
 * Returns the formatted answer text, or `null` if the user dismissed any
 * question (the caller then falls back to the template). Returning `null`
 * on first dismissal keeps the contract simple: a partial answer set is
 * never sent — the agent either gets a complete set or the autonomous
 * fallback.
 */
export async function collectInteractiveAnswers(
    prompter: UserPrompter,
    parsed: ParsedAskUserQuestion,
): Promise<string | null> {
    const answers: Array<{ header: string; question: string; selections: string[] }> = [];
    for (const q of parsed.questions) {
        const items: PickerItem[] = q.options.map((o) => ({
            label: o.label,
            description: o.description,
            value: o.label,
        }));
        items.push({ label: OTHER_OPTION_LABEL, value: OTHER_OPTION_LABEL });

        const picked = await prompter.showQuickPick(items, {
            title: q.header || 'Question',
            placeHolder: q.question,
            canPickMany: q.multiSelect,
            matchOnDescription: true,
            ignoreFocusOut: true,
        });
        if (picked === undefined) {
            return null; // dismissed → autonomous fallback
        }

        const pickedArr = Array.isArray(picked) ? picked : [picked];
        const selections: string[] = [];
        let needsFreeText = false;
        for (const p of pickedArr) {
            if (p.value === OTHER_OPTION_LABEL) {
                needsFreeText = true;
            } else {
                selections.push(p.value);
            }
        }
        if (needsFreeText) {
            const free = await prompter.showInputBox({
                prompt: q.question,
                placeHolder: 'Type your answer…',
                title: q.header || 'Question',
                ignoreFocusOut: true,
            });
            if (free === undefined) {
                return null; // dismissed the free-text box → autonomous fallback
            }
            if (free.trim().length > 0) {
                selections.push(free.trim());
            }
        }
        answers.push({ header: q.header, question: q.question, selections });
    }
    return formatInteractiveAnswers(answers);
}
