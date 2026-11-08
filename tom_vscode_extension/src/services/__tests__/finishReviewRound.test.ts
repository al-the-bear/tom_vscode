/**
 * Finish review round (ccparity_i_assist-5): the click on the button of that
 * name in the MD Browser (src/services/finishReviewRound.ts), on a real
 * process definition, with the store, the queue and the decision dialog
 * faked as the PROCESS view's moves behave.
 *
 *   FR-1 offered only at a review (a user-action step) or while the running step leads to one; refused otherwise
 *   FR-2 the move and the queued prompt: the click confirms the review, the process moves on, the next step's
 *        prompt is queued
 *   FR-3 from the closing item of the step before the review: that step is completed first (its marker's move)
 *   FR-4 the decision case: the next position is a decision — the decision opens, nothing is queued
 *   FR-5 the next step is the user's again, or the process ends: nothing queued; the summary for the agent
 *   FR-7 the Proceed prompt of a step whose prompt ends with `${finish-review-round}` carries the filled Assist
 *        prompt: the review it leads to, the process, `finishReviewRound: true`
 *   FR-6 wiring: `${finish-review-round}` in a step's prompt expands to the Assist prompt in the Proceed prompt;
 *        tom_specs' closing items and § Showing the result use it; the PROCESS view's Decide… is the same dialog;
 *        an unedited earlier default of the Assist prompt is brought to the current one
 */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { finishReviewRound, finishReviewSummary, finishReviewUnavailable, type FinishReviewDeps } from '../finishReviewRound.js';
import { availableMoves, EMPTY_PROCESS_STATE, userActionAt, type ProcessDefinition, type ProcessState } from '../../utils/processDefinition.js';
import { positionText } from '../../utils/processActionPrompt.js';
import { ASSIST_PROMPT_INFO, ensureDefaultAssistPrompts, type AssistPromptsSection } from '../../utils/assistPrompts.js';

const DEF: ProcessDefinition = {
    id: 'spec',
    phases: [{
        id: 'p1',
        steps: [
            { id: 'draft', prompt: 'Write the draft.' },
            { id: 'review', userAction: true },
            { id: 'refine', prompt: 'Apply the review.' },
            { id: 'review2', userAction: true, repeatable: true },
            { id: 'approve', userAction: true },
        ],
        gate: { id: 'gate1' },
    }],
};
const at = (step: string, extra: Partial<ProcessState> = {}): ProcessState =>
    ({ ...EMPTY_PROCESS_STATE, process: 'spec', phase: 'p1', phaseIteration: 1, step, stepIteration: 1, ...extra });

/** The store, the queue and the dialog, as the PROCESS view's moves behave. */
function world(start: ProcessState, running?: ProcessState) {
    let state = start;
    let runningTarget = running;
    const queued: string[] = [];
    const decided: string[] = [];
    const deps: FinishReviewDeps = {
        definition: () => DEF,
        state: () => state,
        runningStepTarget: () => runningTarget,
        completeRunningStep: async () => {
            if (!runningTarget) { return { ok: false, error: 'no step of this quest is running' }; }
            state = runningTarget;
            runningTarget = undefined;
            return { ok: true };
        },
        proceed: async () => {
            const move = availableMoves(DEF, state).find((m) => m.kind === 'proceed');
            if (!move) { return { ok: false, error: 'no proceed here' }; }
            if (userActionAt(DEF, state)) { state = move.target; return { ok: true, queued: false, label: move.label }; }
            // An agent step: its prompt is queued; the marker moves the state later.
            queued.push(state.step);
            return { ok: true, queued: true, label: move.label };
        },
        decide: async () => { decided.push(state.step); return 'Repeat the step review2'; },
        where: (s) => positionText(DEF, s),
    };
    return { deps, queued, decided, state: () => state };
}

describe('Finish review round', () => {
    test('FR-1: where it is offered', () => {
        assert.equal(finishReviewUnavailable(world(at('review')).deps), undefined, 'at a review');
        assert.equal(finishReviewUnavailable(world(at('draft'), at('review')).deps), undefined, 'the running step leads to a review');
        assert.match(finishReviewUnavailable(world(at('draft')).deps)!, /not at a review/);
        assert.match(finishReviewUnavailable(world(at('refine'), at('refine')).deps)!, /not at a review/, 'the running step leads elsewhere');
        assert.match(finishReviewUnavailable(world({ ...EMPTY_PROCESS_STATE }).deps)!, /no process set/);
        assert.match(finishReviewUnavailable(world(at('approve', { completed: true })).deps)!, /finished/);
        assert.match(finishReviewUnavailable(world(at('review2', { decision: true })).deps)!, /not at a review/, 'a decision is no review');
    });

    test('FR-2: the move and the queued prompt', async () => {
        const w = world(at('review'));
        const outcome = await finishReviewRound(w.deps);
        assert.deepEqual(outcome, { ok: true, confirmed: 'Confirm done', next: 'queued', where: 'p1 › refine' });
        assert.equal(w.state().step, 'refine', 'the process moved on');
        assert.deepEqual(w.queued, ['refine'], 'the next step\'s prompt is queued');
        assert.deepEqual(w.decided, []);
        assert.equal(finishReviewSummary(outcome), 'The review is confirmed; the process is at p1 › refine and its prompt is queued.');
    });

    test('FR-3: from the closing item of the step before', async () => {
        const w = world(at('draft'), at('review'));
        const outcome = await finishReviewRound(w.deps);
        assert.equal(outcome.ok, true);
        assert.equal(w.state().step, 'refine');
        assert.deepEqual(w.queued, ['refine']);
        const stuck = world(at('draft'), at('review'));
        stuck.deps.completeRunningStep = async () => ({ ok: false, error: 'the marker is gone' });
        assert.deepEqual(await finishReviewRound(stuck.deps), { ok: false, error: 'the step before the review could not be completed: the marker is gone' });
        assert.deepEqual(stuck.queued, []);
    });

    test('FR-4: the decision case', async () => {
        const w = world(at('review2'));
        const outcome = await finishReviewRound(w.deps);
        assert.deepEqual(outcome, { ok: true, confirmed: 'Confirm done', next: 'decision', where: 'p1 › review2 #1', decided: 'Repeat the step review2' });
        assert.equal(w.state().decision, true, 'at the decision after the repeatable review');
        assert.deepEqual(w.decided, ['review2'], 'the decision opened');
        assert.deepEqual(w.queued, [], 'nothing queued');
        assert.match(finishReviewSummary(outcome), /at a decision \(p1 › review2 #1\) and the user chose: Repeat the step review2/);
        const dismissed = world(at('review2'));
        dismissed.deps.decide = async () => undefined;
        assert.match(finishReviewSummary(await finishReviewRound(dismissed.deps)), /which the user takes in the PROCESS view/);
    });

    test('FR-5: the user\'s step again, the end, failures', async () => {
        // review2 → decision; at approve (the last step before the gate) a user step leads to the gate's decision.
        const two = world(at('review'));
        two.deps.proceed = async () => ({ ok: false, error: 'the step is still running' });
        assert.deepEqual(await finishReviewRound(two.deps), { ok: false, error: 'the review could not be confirmed: the step is still running' });
        const def2: ProcessDefinition = { id: 'x', phases: [{ id: 'p', steps: [{ id: 'a', userAction: true }, { id: 'b', userAction: true }, { id: 'c' }], gate: { id: 'g' } }] };
        let state: ProcessState = { ...EMPTY_PROCESS_STATE, process: 'x', phase: 'p', phaseIteration: 1, step: 'a', stepIteration: 1 };
        const queued: string[] = [];
        const outcome = await finishReviewRound({
            definition: () => def2, state: () => state, runningStepTarget: () => undefined, completeRunningStep: async () => ({ ok: true }),
            proceed: async () => { const m = availableMoves(def2, state).find((x) => x.kind === 'proceed')!; if (userActionAt(def2, state)) { state = m.target; } else { queued.push(state.step); } return { ok: true, queued: false, label: m.label }; },
            decide: async () => undefined, where: (s) => positionText(def2, s),
        });
        assert.deepEqual(outcome, { ok: true, confirmed: 'Confirm done', next: 'userAction', where: 'p › b' });
        assert.deepEqual(queued, [], 'the next step is the user\'s: nothing queued');
        assert.equal(finishReviewSummary(outcome), 'The review is confirmed; the process is at p › b, which is the user\'s to do.');
        assert.equal(finishReviewSummary({ ok: true, confirmed: 'Confirm done', next: 'finished', where: '' }), 'The review is confirmed; the process is finished.');
        assert.equal(finishReviewSummary({ ok: false, error: 'x' }), 'Finish review round failed: x');
    });

    test('FR-6: wiring', () => {
        const EXT = path.join(__dirname, '..', '..', '..');
        const src = (rel: string) => fs.readFileSync(path.join(EXT, 'src', rel), 'utf8');
        const service = src('services/processActionService.ts');
        assert.match(service, /values\['finish-review-round'\] = buildAssistPrompt\(loadSendToChatConfig\(\)\?\.assistPrompts, 'finishReviewRound'/);
        assert.match(service, /export async function decideInDialog\(context\?: vscode\.ExtensionContext\)/);
        assert.match(src('handlers/processPanel-handler.ts'), /const \{ result \} = await decideInDialog\(this\.context\);/, 'the PROCESS view\'s Decide… is the same dialog');
        assert.match(src('handlers/markdownBrowser-handler.ts'), /run: \(\) => processActions\(\)\.runFinishReviewRound\(mdBrowserContext\)/);
        const proc = path.join(EXT, '..', '..', '..', '_ai', 'processes', 'tom_specs');
        if (fs.existsSync(proc)) {
            const yaml = fs.readFileSync(path.join(proc, 'tom_specs.process.yaml'), 'utf8');
            assert.equal((yaml.match(/\$\{finish-review-round\}/g) ?? []).length, 17, 'every closing item that shows the result');
            assert.ok(!yaml.includes('then open the working document\'s current rendition with `tomAi_openInMdBrowser`'), 'no closing item opens it without the button');
            assert.match(fs.readFileSync(path.join(proc, 'tom_specs.md'), 'utf8'), /\*\*Showing the result\.\*\*[\s\S]*?`\$\$\{finish-review-round\}`[\s\S]*?finishReviewRound: true/);
        }
        // The Assist prompt uses the Finish button; an unedited earlier default is upgraded, an edited one kept.
        assert.match(ASSIST_PROMPT_INFO.finishReviewRound.defaultBody, /`finishReviewRound: true`/);
        const old = '**Finish review round** of step ${step} (process ${process}).\n\nThe review\'s results are in `${resultsFile}`.\n\n1. Show them with tomAi_askInMdBrowser and the button `finish` (Finish review round); Keep this file is mine to decide.\n2. Wait for the click. On Finish review round the review is done: say so in one line and end your answer.\n3. On anything else (the panel closed, a timeout) report it and end without moving the process.';
        const config: { assistPrompts?: AssistPromptsSection } = { assistPrompts: { templates: [{ id: 'finish-review-round', name: 'Finish review round', template: old }, { id: 'grill-me', name: 'Grill me', template: 'mine' }] } };
        assert.equal(ensureDefaultAssistPrompts(config), true);
        const byId = (id: string) => config.assistPrompts!.templates!.find((t) => t.id === id)!;
        assert.equal(byId('finish-review-round').template, ASSIST_PROMPT_INFO.finishReviewRound.defaultBody);
        assert.equal(byId('grill-me').template, 'mine');
        assert.equal(ensureDefaultAssistPrompts(config), false, 'once');
    });

    test('FR-7: the Proceed prompt expands it', async () => {
        const { buildProcessActionPrompt } = await import('../processActionService.js');
        const def = JSON.parse(JSON.stringify(DEF)) as ProcessDefinition;
        def.phases[0].steps[0].prompt = 'Write the draft.\n\nLast, show it for the review:\n\n${finish-review-round}';
        const store = { currentDefinition: () => def, state: at('draft'), processDescription: () => '' };
        const move = availableMoves(def, store.state).find((m) => m.kind === 'proceed')!;
        const text = buildProcessActionPrompt(store as never, move, '');
        assert.ok(!text.includes('${finish-review-round}'), 'expanded');
        assert.match(text, /\*\*Finish review round\*\* — put the results in front of the user for the review, p1 › review of process spec\./);
        assert.match(text, /Show the document this step produced with tomAi_askInMdBrowser: `finishReviewRound: true`/);
    });
});

