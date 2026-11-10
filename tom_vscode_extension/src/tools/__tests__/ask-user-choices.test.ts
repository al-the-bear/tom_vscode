/**
 * Choices in questions (ccparity_i_assist-4): buttons in tomAi_askUser and in
 * the Agent SDK's intercepted AskUserQuestion — answers, process moves,
 * branches and subprocesses (src/utils/askChoices.ts, ask-user-tool.ts).
 *
 *   CH-1 the refusal: a choice is checked when the ask is made — id, label, kind, question number, a marker
 *        naming no choice, a move to a position outside the current process (or with no process set), a branch /
 *        subprocess not in the current step's list; refused asks open nothing
 *   CH-2 positions: `step` (current phase first, else unique), `phase/step`, `phase/step/substep`; the step's
 *        `branches:` / `subprocesses:` lists (ids or {process, description})
 *   CH-3 the rendering plan: a marker is cut out of its question's text at its place; a choice without a marker
 *        goes under its `question` (default the last); plain text names the label (Telegram, the journal)
 *   CH-4 the move on click: made by the extension through moveTo with the target resolved against where the
 *        process is now, reported to the agent; a failed move says so; an answer choice answers its target;
 *        an unknown choice id answers nothing
 *   CH-5 the Agent SDK's AskUserQuestion: its `choices`, the questions as the panel shows them, and the route
 *        through the question panel
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { askUserImpl, choiceClickAnswer, choiceClickAnswerAsync, type AskUserDeps } from '../ask-user-tool.js';
import { AskUserRegistry, type PendingAsk } from '../../services/askUserRegistry.js';
import {
    choiceAnswer, layoutChoices, questionText, resolveMoveTarget, stepChoiceLists, validateChoices,
    type AskChoice, type ChoiceContext,
} from '../../utils/askChoices.js';
import { EMPTY_PROCESS_STATE, type ProcessChange, type ProcessDefinition, type ProcessState } from '../../utils/processDefinition.js';
import { askUserQuestionChoices, parseAskUserQuestionInput, questionsForPanel } from '../../services/agent-sdk-questions.js';

const DEF: ProcessDefinition = {
    id: 'flow',
    phases: [
        { id: 'p1', steps: [{ id: 'draft', substeps: [{ id: 's1' }, { id: 's2' }] }, { id: 'review' }], gate: { id: 'gate1' } },
        { id: 'p2', steps: [{ id: 'review' }, { id: 'ship' }], gate: { id: 'gate2' } },
    ],
};
const STATE: ProcessState = { ...EMPTY_PROCESS_STATE, process: 'flow', phase: 'p1', phaseIteration: 1, step: 'draft', stepIteration: 1, substep: 's1', substepIteration: 1 };
const CTX: ChoiceContext = { def: DEF, state: STATE };
const check = (choices: unknown, questions = ['Q1', 'Q2'], ctx: ChoiceContext = CTX) => validateChoices(choices, questions, () => ctx);
const err = (r: ReturnType<typeof validateChoices>): string => (r.ok ? '' : r.error);

function harness(ctx: ChoiceContext = CTX) {
    const opens: PendingAsk[] = [];
    const moves: ProcessChange[] = [];
    const registry = new AskUserRegistry({ genId: () => 'req-1' });
    const deps: AskUserDeps = {
        registry,
        loadConfig: () => ({ maxWaitMinutes: 0, fallbackPrompt: 'FALLBACK' }),
        onOpen: (p) => opens.push(p),
        onResolve: () => undefined,
        processContext: () => ctx,
        moveTo: (change) => { moves.push(change); return { ok: true, where: `${change.phase} › ${change.step}` }; },
    };
    return { deps, opens, moves, registry };
}

describe('choices in questions', () => {
    test('CH-1: the refusal', async () => {
        assert.deepEqual(check(undefined), { ok: true, choices: [] });
        assert.match(err(check([{ id: 'a b', label: 'A', kind: 'answer' }])), /`id` must be/);
        assert.match(err(check([{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }])), /used twice/);
        assert.match(err(check([{ id: 'a', label: ' ', kind: 'answer' }])), /`label` is empty/);
        assert.match(err(check([{ id: 'a', label: 'A', kind: 'jump' }])), /`kind` must be one of answer, move, branch, subprocess/);
        assert.match(err(check([{ id: 'a', label: 'A', question: 3 }])), /from 1 to 2/);
        assert.match(err(check([{ id: 'a', label: 'A' }], ['Pick {{choice:b}}'])), /not in `choices`: b/);
        assert.match(err(check([], ['Pick {{choice:b}}'])), /`choices` is empty/);
        assert.match(err(check([{ id: 'm', label: 'M', kind: 'move', target: 'nowhere' }])), /choice "m": process "flow" has no step "nowhere"/);
        assert.match(err(check([{ id: 'm', label: 'M', kind: 'move', target: 'p9/draft' }])), /no phase "p9"/);
        assert.match(err(check([{ id: 'm', label: 'M', kind: 'move' }])), /needs a `target`/);
        assert.match(err(check([{ id: 'm', label: 'M', kind: 'move', target: 'review' }], ['Q'], { def: null, state: { ...EMPTY_PROCESS_STATE } })), /needs a process, and the quest has none set/);
        assert.match(err(check([{ id: 'b', label: 'B', kind: 'branch', target: 'other_process' }])), /step "draft" lists no branches/);
        assert.match(err(check([{ id: 's', label: 'S', kind: 'subprocess', target: 'team_review' }])), /step "draft" lists no subprocesses/);
        // A refused ask opens nothing and answers the reason.
        const h = harness();
        const answer = await askUserImpl(h.deps, { questions: ['Where to?'], choices: [{ id: 'm', label: 'M', kind: 'move', target: 'nowhere' }] });
        assert.match(answer, /^askUser error: choice "m": process "flow" has no step "nowhere"\. Nothing was asked\.$/);
        assert.equal(h.opens.length, 0);
        assert.equal(h.registry.hasPending(), false);
    });

    test('CH-2: positions and the step\'s lists', () => {
        assert.deepEqual(resolveMoveTarget(DEF, STATE, 'review'), { phase: 'p1', step: 'review' }, 'the current phase first');
        assert.deepEqual(resolveMoveTarget(DEF, STATE, 'ship'), { phase: 'p2', step: 'ship' }, 'else the one phase that has it');
        assert.match(resolveMoveTarget(DEF, { ...STATE, phase: 'p0' }, 'review') as string, /several phases \(p1, p2\)/);
        assert.deepEqual(resolveMoveTarget(DEF, STATE, 'p2/review'), { phase: 'p2', step: 'review' });
        assert.deepEqual(resolveMoveTarget(DEF, STATE, 'p1/draft/s2'), { phase: 'p1', step: 'draft', substep: 's2' });
        assert.match(resolveMoveTarget(DEF, STATE, 'p1/draft/s9') as string, /no sub-step "s9"/);
        assert.match(resolveMoveTarget(DEF, STATE, 'a/b/c/d') as string, /no position/);
        // A step that lists branches and subprocesses (the nested-process lists).
        const withLists = JSON.parse(JSON.stringify(DEF)) as ProcessDefinition;
        Object.assign(withLists.phases[0].steps[0], { branches: ['explore'], subprocesses: [{ process: 'team_review' }, { process: 'proof', description: 'the defined entry form: an id or {process, description}' }] });
        assert.deepEqual(stepChoiceLists(withLists, STATE), { step: 'draft', branches: ['explore'], subprocesses: ['team_review', 'proof'] });
        const ctx = { def: withLists, state: STATE };
        assert.equal(check([{ id: 'b', label: 'B', kind: 'branch', target: 'explore' }, { id: 's', label: 'S', kind: 'subprocess', target: 'proof' }], ['Q'], ctx).ok, true);
        assert.match(err(check([{ id: 'b', label: 'B', kind: 'branch', target: 'proof' }], ['Q'], ctx)), /"proof" is not among the branches of step "draft" \(explore\)/);
    });

    test('CH-3: the rendering plan', () => {
        const choices: AskChoice[] = [
            { id: 'go', label: 'Go on', kind: 'move', target: 'review' },
            { id: 'yes', label: 'Yes', kind: 'answer' },
            { id: 'no', label: 'No', kind: 'answer', question: 1 },
        ];
        const questions = ['Ready? {{choice:go}} or keep drafting', 'Anything else?'];
        assert.deepEqual(layoutChoices(questions, choices), [
            { segments: [{ text: 'Ready? ' }, { choiceId: 'go' }, { text: ' or keep drafting' }], below: ['no'] },
            { segments: [{ text: 'Anything else?' }], below: ['yes'] },
        ]);
        assert.equal(questionText(questions[0], choices), 'Ready? [Go on] or keep drafting');
    });

    test('CH-4: the move on click', async () => {
        const h = harness();
        const call = askUserImpl(h.deps, {
            questions: ['Go to review? {{choice:go}}'],
            choices: [{ id: 'go', label: 'Go to review', kind: 'move', target: 'p1/review' }, { id: 'later', label: 'Later', kind: 'answer', target: 'not now' }],
        });
        const pending = h.registry.getPending()!;
        assert.deepEqual(pending.choices.map((c) => c.id), ['go', 'later']);
        assert.deepEqual(pending.layout[0].segments, [{ text: 'Go to review? ' }, { choiceId: 'go' }]);
        assert.deepEqual(pending.layout[0].below, ['later']);
        assert.equal(choiceClickAnswer(h.deps, pending, 'nope'), undefined, 'an unknown choice');
        const answer = choiceClickAnswer(h.deps, pending, 'go')!;
        assert.deepEqual(h.moves, [{ phase: 'p1', step: 'review' }], 'the extension made the move');
        assert.equal(answer, 'The user clicked the choice "Go to review" (id go, move). The extension moved the process to p1 › review; do not move it yourself.');
        h.registry.submit(pending.requestId, answer, 'vscode');
        assert.equal(await call, answer, 'reported to the agent');
        // An answer choice; a failed move.
        assert.equal(choiceAnswer({ id: 'later', label: 'Later', kind: 'answer', target: 'not now' }), 'The user clicked the choice "Later" (id later, answer). Answer: not now');
        const failing = harness();
        failing.deps.moveTo = () => ({ ok: false, error: 'no quest is active' });
        void askUserImpl(failing.deps, { questions: ['Q'], choices: [{ id: 'go', label: 'Go', kind: 'move', target: 'review' }] });
        assert.match(choiceClickAnswer(failing.deps, failing.registry.getPending()!, 'go')!, /The move to review failed: no quest is active\. The process was not moved\./);
        // The process moved on since the ask: the target is resolved again, and a gone process is reported.
        const gone = harness();
        void askUserImpl(gone.deps, { questions: ['Q'], choices: [{ id: 'go', label: 'Go', kind: 'move', target: 'review' }] });
        gone.deps.processContext = () => ({ def: null, state: { ...EMPTY_PROCESS_STATE } });
        assert.match(choiceClickAnswer(gone.deps, gone.registry.getPending()!, 'go')!, /failed: the quest has no process set any more/);
        assert.deepEqual(gone.moves, []);
    });

    test('CH-6: a clicked branch or subprocess starts its process', async () => {
        const pending = {
            requestId: 'r', questions: ['Q'], createdAt: 0, layout: [],
            choices: [
                { id: 'rev', label: 'Team review', kind: 'subprocess', target: 'team_review' },
                { id: 'alt', label: 'Explore', kind: 'branch', target: 'explore' },
                { id: 'later', label: 'Later', kind: 'answer', target: 'not now' },
            ],
        } as unknown as PendingAsk;
        const calls: string[] = [];
        const deps: Pick<AskUserDeps, 'startNested'> = {
            startNested: async (kind, process) => {
                calls.push(`${kind}:${process}`);
                if (process === 'explore') { return { ok: false, error: 'the user did not choose what the step does when it ends', cancelled: true }; }
                return { ok: true, started: 'the subprocess team_review', followUp: 'Go on past the step', inputs: { documents: 'docs/*.md' } };
            },
        };
        assert.equal(await choiceClickAnswerAsync(deps, pending, 'rev'), 'The user clicked the choice "Team review" (id rev, subprocess). The extension started the subprocess team_review on the quest\'s process stack, with the inputs documents = docs/*.md. The step waits until it ends, then: Go on past the step. Do not move the process yourself; the new level runs once you end this turn.');
        assert.equal(await choiceClickAnswerAsync(deps, pending, 'alt'), 'The user clicked the choice "Explore" (id alt, branch). Starting explore was cancelled: the user did not choose what the step does when it ends. Nothing was started.');
        assert.deepEqual(calls, ['subprocess:team_review', 'branch:explore']);
        assert.match(choiceAnswer(pending.choices[0], undefined, { ok: false, error: 'the step lists no subprocess "team_review"' })!, /Starting team_review failed: the step lists no subprocess "team_review"\. Nothing was started\./);
        assert.match((await choiceClickAnswerAsync({}, pending, 'rev'))!, /Starting a subprocess from this question is not available here; nothing was started/);
        assert.equal(await choiceClickAnswerAsync(deps, pending, 'later'), 'The user clicked the choice "Later" (id later, answer). Answer: not now', 'other kinds as before');
        assert.equal(await choiceClickAnswerAsync(deps, pending, 'nope'), undefined);
    });

    test('CH-5: the Agent SDK\'s AskUserQuestion', () => {
        const input = {
            questions: [{ question: 'Next? {{choice:go}}', header: 'Flow', options: [{ label: 'A' }, { label: 'B' }] }],
            choices: [{ id: 'go', label: 'Go on', kind: 'move', target: 'review' }],
        };
        assert.deepEqual(askUserQuestionChoices(input), input.choices);
        assert.equal(askUserQuestionChoices({ questions: input.questions }), undefined);
        assert.equal(askUserQuestionChoices({ questions: input.questions, choices: [] }), undefined);
        assert.deepEqual(questionsForPanel(parseAskUserQuestionInput(input)!), ['[Flow] Next? {{choice:go}} (options: A / B)']);
        const transport = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'agent-sdk-transport.ts'), 'utf8');
        assert.match(transport, /const choices = askUserQuestionChoices\(input\);\n\s+if \(choices && interactiveQuestions\?\.enabled\) \{\n\s+const \{ askUserWithChoices \} = await import\('\.\/askUser-handler\.js'\);/);
        assert.ok(transport.indexOf('askUserQuestionChoices(input)') < transport.indexOf('collectInteractiveAnswers(liveUserPrompter, parsed)'), 'before the QuickPicks');
    });
});
