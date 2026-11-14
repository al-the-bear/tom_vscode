/**
 * The gate decision from the gate's own prompt (vscimpb85,
 * src/services/gateDecision.ts): a gate's prompt shows its result in the MD
 * Browser with the buttons of the decision after the gate; a click ends the
 * gate's step and takes the choice as Decide… does.
 *
 *   GT-1 offered while the running step is the gate (its marker leads to the decision) or at the gate's decision;
 *        refused at another step, when the gate is not running, without a process, when the process is finished
 *   GT-2 the buttons are the choices Decide… shows after the gate: gate passed (go on) and gate failed (back to the
 *        gate's onFail step, or the gate again)
 *   GT-3 a click while the gate runs: the gate's step is completed (its marker's move: the process at the decision),
 *        then the choice is taken — the process moves as Decide… moves it; a step that cannot be ended takes nothing
 *   GT-4 at the gate's decision already: the choice is taken directly; a choice the decision does not offer is
 *        refused and nothing moves
 *   GT-5 tomAi_askInMdBrowser `gateDecision`: the choices as `decide-<n>` buttons; a click keeps the document open
 *        (`Decided: …` in place of the bar) and answers `decisionTaken`, `gate`, `summary`; refused with
 *        `reopenDecision`, or when the gate decision cannot be offered (the reason named); a non-gate button answers
 *        as before
 *   GT-6 the Assist prompt `gateDecision` (`${gate-decision}` in a step's prompt): default `gate-decision`, its
 *        placeholders, seeded with the others; the schema, the Proceed prompt value and the docs name it
 */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { gateDecisionOptions, gateDecisionSummary, gateDecisionUnavailable, takeGateDecision, type GateDecisionDeps } from '../gateDecision.js';
import { availableMoves, EMPTY_PROCESS_STATE, type ProcessDefinition, type ProcessState } from '../../utils/processDefinition.js';
import { decisionDialog, positionText } from '../../utils/processActionPrompt.js';
import { ASSIST_PROMPT_INFO, ASSIST_PROMPT_USES, ensureDefaultAssistPrompts, type AssistPromptsSection } from '../../utils/assistPrompts.js';
import { MdBrowserAskSlot, askInMdBrowserImpl, type AskInMdBrowserDeps, type AskMdBar } from '../../tools/ask-in-md-browser-tool.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(EXT, ...p), 'utf8');

const DEF: ProcessDefinition = {
    id: 'ideas',
    phases: [
        { id: 'p1', steps: [{ id: 'draft', prompt: 'Draft.' }, { id: 'revise', prompt: 'Revise.' }], gate: { id: 'g1', prompt: 'Check.', onFail: 'revise' } },
        { id: 'p2', steps: [{ id: 'plan', prompt: 'Plan.' }], gate: { id: 'g2', prompt: 'Check.' } },
    ],
};
const at = (phase: string, step: string, extra: Partial<ProcessState> = {}): ProcessState =>
    ({ ...EMPTY_PROCESS_STATE, process: 'ideas', phase, phaseIteration: 1, step, stepIteration: 1, ...extra });

/** Where Proceed at the gate leads: its marker's target, the decision after the gate. */
const gateTarget = (state: ProcessState): ProcessState => availableMoves(DEF, state).find((m) => m.kind === 'proceed')!.target;

/** The store, the running gate's marker and Decide…'s move. */
function world(start: ProcessState, running?: ProcessState) {
    let state = start;
    let runningTarget = running;
    const completed: string[] = [];
    const deps: GateDecisionDeps = {
        definition: () => DEF,
        state: () => state,
        runningStepTarget: () => runningTarget,
        completeRunningStep: async () => {
            if (!runningTarget) { return { ok: false, error: 'no step of this quest is running' }; }
            completed.push(state.step);
            state = runningTarget;
            runningTarget = undefined;
            return { ok: true };
        },
        take: async (label) => {
            const option = decisionDialog(DEF, state)?.options.find((o) => o.label === label);
            if (!option) { return { ok: false, error: `the decision no longer offers "${label}"` }; }
            state = availableMoves(DEF, state).find((m) => m.label === label)!.target;
            return { ok: true };
        },
        where: (s) => positionText(DEF, s),
    };
    return { deps, completed, state: () => state };
}

describe('the gate decision', () => {
    test('GT-1: where it is offered', () => {
        const g1 = at('p1', 'g1');
        assert.equal(gateDecisionUnavailable(world(g1, gateTarget(g1)).deps), undefined, 'the gate is running');
        assert.equal(gateDecisionUnavailable(world(gateTarget(g1)).deps), undefined, 'at the gate\'s decision');
        assert.match(gateDecisionUnavailable(world(g1).deps)!, /gate's step is not running/);
        assert.match(gateDecisionUnavailable(world(at('p1', 'draft'), at('p1', 'revise')).deps)!, /not at a gate/);
        assert.match(gateDecisionUnavailable(world({ ...EMPTY_PROCESS_STATE }).deps)!, /no process set/);
        assert.match(gateDecisionUnavailable(world(at('p2', 'g2', { completed: true })).deps)!, /finished/);
        assert.match(gateDecisionUnavailable(world(g1, g1).deps)!, /does not lead to a decision/);
    });

    test('GT-2: the choices Decide… shows', () => {
        const g1 = at('p1', 'g1');
        const target = gateTarget(g1);
        assert.equal(target.decision, true);
        const expected = decisionDialog(DEF, target)!.options.map((o) => o.label);
        assert.deepEqual(gateDecisionOptions(world(g1, target).deps), expected);
        assert.deepEqual(expected, ['Gate passed — go on to p2 › plan', 'Gate failed — back to revise']);
        const g2 = at('p2', 'g2');
        assert.deepEqual(gateDecisionOptions(world(g2, gateTarget(g2)).deps), ['Gate passed — finish the process', 'Gate failed — run g2 again', 'Gate failed — back to the start of p1']);
        assert.deepEqual(gateDecisionOptions(world(at('p1', 'draft')).deps), []);
    });

    test('GT-3: a click while the gate runs', async () => {
        const g1 = at('p1', 'g1');
        const w = world(g1, gateTarget(g1));
        const outcome = await takeGateDecision(w.deps, 'Gate passed — go on to p2 › plan');
        assert.deepEqual(outcome, { ok: true, decided: 'Gate passed — go on to p2 › plan', gate: 'p1 › g1 #1', where: 'p2 › plan' });
        assert.deepEqual(w.completed, ['g1'], 'the gate\'s step was ended first');
        assert.equal(w.state().step, 'plan');
        assert.equal(gateDecisionSummary(outcome), 'The user decided at p1 › g1 #1: Gate passed — go on to p2 › plan; the process is at p2 › plan.');
        const failed = world(g1, gateTarget(g1));
        assert.equal((await takeGateDecision(failed.deps, 'Gate failed — back to revise')).ok, true);
        assert.equal(failed.state().step, 'revise', 'back to the gate\'s onFail step');
        const stuck = world(g1, gateTarget(g1));
        stuck.deps.completeRunningStep = async () => ({ ok: false, error: 'the marker is gone' });
        const refused = await takeGateDecision(stuck.deps, 'Gate failed — back to revise');
        assert.deepEqual(refused, { ok: false, error: 'the gate\'s step could not be ended: the marker is gone' });
        assert.equal(stuck.state().step, 'g1', 'nothing moved');
        assert.match(gateDecisionSummary(refused), /stays the user's in the PROCESS view/);
    });

    test('GT-4: at the gate\'s decision already; an unknown choice', async () => {
        const w = world(gateTarget(at('p2', 'g2')));
        const outcome = await takeGateDecision(w.deps, 'Gate passed — finish the process');
        assert.equal(outcome.ok, true);
        assert.deepEqual(w.completed, [], 'no step to end');
        assert.equal(w.state().completed, true);
        const unknown = world(gateTarget(at('p1', 'g1')));
        assert.deepEqual(await takeGateDecision(unknown.deps, 'Repeat everything'), { ok: false, error: 'the gate\'s decision does not offer "Repeat everything"' });
        assert.equal(unknown.state().step, 'g1');
    });
});

describe('tomAi_askInMdBrowser gateDecision', () => {
    function fake(over: Partial<AskInMdBrowserDeps> = {}) {
        const bars: AskMdBar[] = [];
        const cleared: string[] = [];
        const closed: string[] = [];
        const taken: string[] = [];
        const deps: AskInMdBrowserDeps = {
            workspaceRoot: '/ws',
            exists: () => true,
            openWithBar: (_abs, bar) => { bars.push(bar); return 'p1'; },
            clearBar: (_p, _r, note) => { cleared.push(note); },
            closePanel: (p) => { closed.push(p); },
            deleteFile: () => undefined,
            now: () => 1000,
            genId: () => `req${bars.length + 1}`,
            gateDecision: {
                unavailable: () => undefined,
                options: () => ['Gate passed — go on to p2 › plan', 'Gate failed — back to revise'],
                take: async (label) => { taken.push(label); return { ok: true, decided: label, gate: 'p1 › g1', where: 'p2 › plan' }; },
            },
            reopenDecision: { unavailable: () => undefined, run: async () => undefined },
            ...over,
        };
        return { deps, bars, cleared, closed, taken };
    }
    const tick = () => new Promise((r) => setImmediate(r));

    test('GT-5: the buttons, the click, the refusals', async () => {
        const f = fake();
        const slot = new MdBrowserAskSlot();
        const call = askInMdBrowserImpl(f.deps, { filePath: 'gates/G1.md', gateDecision: true, title: 'Gate: p1 › g1' }, slot);
        await tick();
        assert.deepEqual(f.bars[0].buttons, [
            { id: 'decide-1', label: 'Gate passed — go on to p2 › plan' },
            { id: 'decide-2', label: 'Gate failed — back to revise' },
        ]);
        assert.equal(slot.click('req1', 'decide-1', true), true);
        const out = JSON.parse(await call);
        assert.deepEqual(f.taken, ['Gate passed — go on to p2 › plan']);
        assert.equal(out.decisionTaken, 'Gate passed — go on to p2 › plan');
        assert.equal(out.button, 'decide-1');
        assert.deepEqual(out.gate, { ok: true, decided: 'Gate passed — go on to p2 › plan', gate: 'p1 › g1', where: 'p2 › plan' });
        assert.equal(out.summary, 'The user decided at p1 › g1: Gate passed — go on to p2 › plan; the process is at p2 › plan.');
        assert.deepEqual(f.closed, [], 'the document stays open');
        assert.deepEqual(f.cleared, ['Decided: Gate passed — go on to p2 › plan']);
        assert.equal(slot.hasOpen(), false);

        const both = await askInMdBrowserImpl(fake().deps, { filePath: 'gates/G1.md', gateDecision: true, reopenDecision: true }, new MdBrowserAskSlot());
        assert.match(JSON.parse(both).error, /set one/);
        const notNow = fake({ gateDecision: { unavailable: () => 'the process is not at a gate', options: () => [], take: async () => ({ ok: false, error: 'x' }) } });
        assert.match(JSON.parse(await askInMdBrowserImpl(notNow.deps, { filePath: 'gates/G1.md', gateDecision: true }, new MdBrowserAskSlot())).error,
            /The gate decision cannot be offered: the process is not at a gate\..*PROCESS view/);

        // A button of the agent's own beside them answers as before; the decision is not taken.
        const own = fake();
        const slot2 = new MdBrowserAskSlot();
        const call2 = askInMdBrowserImpl(own.deps, { filePath: 'gates/G1.md', gateDecision: true, buttons: [{ id: 'later', label: 'Later' }] }, slot2);
        await tick();
        assert.deepEqual(own.bars[0].buttons.map((b) => b.id), ['later', 'decide-1', 'decide-2']);
        slot2.click('req1', 'later', true);
        const out2 = JSON.parse(await call2);
        assert.equal(out2.button, 'later');
        assert.equal(out2.decisionTaken, undefined);
        assert.deepEqual(own.taken, []);
    });
});

describe('the Assist prompt gateDecision', () => {
    test('GT-6: default, placeholders, seeding, wiring, docs', () => {
        assert.ok(ASSIST_PROMPT_USES.includes('gateDecision'));
        const info = ASSIST_PROMPT_INFO.gateDecision;
        assert.equal(info.defaultId, 'gate-decision');
        assert.deepEqual(Object.keys(info.placeholders), ['process', 'step', 'resultsFile']);
        assert.match(info.defaultBody, /tomAi_askInMdBrowser: `gateDecision: true`/);
        assert.match(info.defaultBody, /Do not move the process or queue anything yourself/);
        const config: { assistPrompts?: AssistPromptsSection } = {};
        ensureDefaultAssistPrompts(config);
        assert.ok(config.assistPrompts!.templates!.some((t) => t.id === 'gate-decision'));
        const schema = JSON.parse(read('src', 'config', 'tom_vscode_extension.schema.json'));
        assert.ok(schema.properties.assistPrompts.properties.selected.properties.gateDecision);
        assert.match(read('src', 'services', 'processActionService.ts'), /values\['gate-decision'\] = buildAssistPrompt\(loadSendToChatConfig\(\)\?\.assistPrompts, 'gateDecision', \{/);
        assert.match(read('src', 'handlers', 'markdownBrowser-handler.ts'), /gateDecision: \{\s*unavailable: \(run\) => processActions\(\)\.gateDecisionUnavailableNow\(run\),/);
        assert.match(read('doc', 'llm_tools.md'), /gateDecision/);
        assert.match(read('doc', 'user_guide.md'), /\$\{gate-decision\}/);
        assert.match(read('README.md'), /\$\{gate-decision\}/);
    });
});
