/**
 * A QuickPick that always lets the user answer in their own words.
 *
 * ## Why this exists
 *
 * A list of options is a guess about what the answer might be. The real answer
 * is regularly none of them — so every picker we put in front of the user ends
 * with an "Other…" entry that opens a free-text box. Without it the user can
 * only pick the least wrong option, and we get an answer nobody meant.
 *
 * Two callers share this: the Agent-SDK `AskUserQuestion` interceptor
 * (`agent-sdk-questions.ts`) and the `tomAi_askUserPicker` tool
 * (`user-interaction-tools.ts`). They fold the outcome into different result
 * shapes, so this module stops at the common part — append the entry, run the
 * pick, follow up with the input box — and returns a neutral outcome.
 *
 * Free of `vscode` *runtime* imports (the seam types are type-only, erased at
 * compile time) so both callers — including the deliberately runtime-pure
 * question interceptor — can use it, and so it is unit-testable under
 * `node --test` with a stub prompter.
 */

import type { UserPrompter, PickerItem, QuickPickOpts } from '../tools/user-interaction-tools';

/** Label of the entry appended to every option list for free-text entry. */
export const OTHER_OPTION_LABEL = 'Other…';

/** Wording of the free-text box shown after the user picks "Other…". */
export interface FreeTextBoxOpts {
    prompt?: string;
    title?: string;
    placeHolder?: string;
}

/**
 * The outcome of a pick. `dismissed` and `timedOut` are kept apart on purpose:
 * dismissed means the user saw the question and declined, timed out means
 * nobody was there.
 *
 * `selections` is empty when the user confirmed a multi-select without ticking
 * anything, or picked "Other…" and submitted a blank box — in both cases they
 * answered, with nothing.
 */
export type FreeTextPickResult =
    | { kind: 'picked'; selections: PickerItem[] }
    | { kind: 'dismissed' }
    | { kind: 'timedOut' };

/**
 * The caller's options plus the free-text entry. Callers that already offer
 * their own "Other…" keep theirs — a duplicate row would just be confusing.
 */
export function withFreeTextOption(items: PickerItem[]): PickerItem[] {
    const present = items.some((i) => i.label === OTHER_OPTION_LABEL || i.value === OTHER_OPTION_LABEL);
    return present ? items : [...items, { label: OTHER_OPTION_LABEL, value: OTHER_OPTION_LABEL }];
}

/**
 * Show `items` plus an "Other…" entry; when the user takes it, follow up with
 * a free-text box and return what they typed as one more selection (label and
 * value both the typed text — the caller has no vocabulary for it either).
 *
 * Dismissing *either* widget is a dismissal of the whole question: a partial
 * answer would be indistinguishable from a deliberate one.
 */
export async function pickWithFreeTextOption(
    prompter: UserPrompter,
    items: PickerItem[],
    opts: QuickPickOpts,
    freeText: FreeTextBoxOpts,
): Promise<FreeTextPickResult> {
    const picked = await prompter.showQuickPick(withFreeTextOption(items), opts);

    // `QUICK_PICK_TIMED_OUT` is matched by type rather than imported by value,
    // because importing it would pull `vscode` into this runtime-pure module.
    if (typeof picked === 'symbol') { return { kind: 'timedOut' }; }
    if (picked === undefined) { return { kind: 'dismissed' }; }

    const pickedArr = Array.isArray(picked) ? picked : [picked];
    const selections: PickerItem[] = [];
    let wantsFreeText = false;
    for (const p of pickedArr) {
        if (p.value === OTHER_OPTION_LABEL) { wantsFreeText = true; } else { selections.push(p); }
    }
    if (!wantsFreeText) { return { kind: 'picked', selections }; }

    const typed = await prompter.showInputBox({
        prompt: freeText.prompt,
        placeHolder: freeText.placeHolder ?? 'Type your answer…',
        title: freeText.title,
        ignoreFocusOut: true,
    });
    if (typed === undefined) { return { kind: 'dismissed' }; }
    const trimmed = typed.trim();
    if (trimmed.length > 0) { selections.push({ label: trimmed, value: trimmed }); }
    return { kind: 'picked', selections };
}
