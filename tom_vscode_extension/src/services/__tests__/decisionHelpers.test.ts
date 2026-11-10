/**
 * Grill me / Explain a decision at process decisions (ccparity_i_assist-7):
 * src/services/decisionHelpers.ts with faked dialog, sessions and send, and
 * the note's Back to the decision button (tomAi_askInMdBrowser `reopenDecision`).
 *
 *   DH-1 the Decide… dialog's buttons: the decision's options, then Grill me and Explain a decision; a pick is an
 *        option (made), a helper (run) or nothing
 *   DH-2 a helper's run: its Assist prompt (Grill me at a decision / Explain a decision) filled with the process,
 *        the position, the decision and the note in the quest's process folder; a temporary session based on the
 *        process's session, removed afterwards; the decision reopens when the turn ends
 *   DH-3 the reopened decision: the note's button reopens it (once — the turn's end does not reopen it again);
 *        a decision taken meanwhile is not reopened; a failed run reopens it; not at a decision / a second helper
 *        refused
 *   DH-4 the note's button: `reopenDecision` adds Back to the decision only at a decision; its click reopens the
 *        decision, keeps the panel open, answers `decisionReopened`
 *   DH-5 wiring: decideInDialog offers the helpers with the extension's context; the PROCESS view passes it; the
 *        default prompts show the note with `reopenDecision` and allow the question panel for a short answer
 *   DH-6 the decision's own choices on the note: `reopenDecision` puts one button per option (`decide-<n>`) before
 *        Back to the decision; a click takes that option (answer `decisionTaken`), the note stays open, and a helper
 *        whose note took the decision does not reopen it when its turn ends; a button id `decide-<n>` of the agent's is
 *        refused; the previous default prompts are upgraded
 */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    DECISION_HELPER_LABELS, decisionDialogButtons, decisionHelperRunning, decisionNoteName, decisionText, interpretDecisionPick,
    markDecisionReopened, runDecisionHelper, type DecisionHelperDeps,
} from '../decisionHelpers.js';
import { ASSIST_PROMPT_INFO, ensureDefaultAssistPrompts, type AssistPromptsSection } from '../../utils/assistPrompts.js';
import { MdBrowserAskSlot, askInMdBrowserImpl, type AskInMdBrowserDeps } from '../../tools/ask-in-md-browser-tool.js';

const OPTIONS = [{ label: 'Gate passed — go on to Phase 2', kind: 'gate-passed' }, { label: 'Gate failed — back to Draft', kind: 'gate-failed' }];
const NOW = new Date(2026, 10, 8, 10, 15, 30);

function fake(over: Partial<DecisionHelperDeps> = {}) {
    let atDecision = true;
    let reopens = 0;
    const created: Array<{ name: string; basedOn?: string }> = [];
    const deleted: string[] = [];
    const dirs: string[] = [];
    const sent: Array<{ prompt: string; session: string; source: string }> = [];
    const deps: DecisionHelperDeps = {
        workspaceRoot: '/ws',
        context: () => (atDecision ? { quest: 'q', process: 'tom_specs', position: 'Phase 1 › G1', decision: decisionText('Decide how the process goes on after Phase 1 › G1', OPTIONS) } : undefined),
        questFolder: (quest) => `/ws/_ai/quests/${quest}`,
        ensureDir: (abs) => { dirs.push(abs); },
        assistPrompts: () => undefined,
        baseSession: () => 'p1-work',
        sessionsFolder: () => '/ws/_ai/quests/q/history',
        hasSession: (_f, name) => name === 'p1-work',
        createSession: (_f, name, opts) => { created.push({ name, ...opts }); return { ok: true }; },
        deleteSession: (_f, name) => { deleted.push(name); },
        send: async (prompt, session, source) => { sent.push({ prompt, session, source }); return { ok: true }; },
        reopenDecision: async () => { reopens++; },
        isAtDecision: () => atDecision,
        now: () => NOW,
        ...over,
    };
    return { deps, created, deleted, dirs, sent, reopens: () => reopens, decide: () => { atDecision = false; } };
}

describe('decision helpers', () => {
    test('DH-1: the dialog\'s buttons', () => {
        assert.deepEqual(decisionDialogButtons(OPTIONS.map((o) => o.label)), [...OPTIONS.map((o) => o.label), 'Grill me', 'Explain a decision']);
        assert.deepEqual(interpretDecisionPick('Gate failed — back to Draft', OPTIONS), { kind: 'option', option: OPTIONS[1] });
        assert.deepEqual(interpretDecisionPick('Grill me', OPTIONS), { kind: 'helper', use: 'grillMeDecision' });
        assert.deepEqual(interpretDecisionPick('Explain a decision', OPTIONS), { kind: 'helper', use: 'explainDecision' });
        assert.deepEqual(interpretDecisionPick(undefined, OPTIONS), { kind: 'none' });
        assert.deepEqual(interpretDecisionPick('something else', OPTIONS), { kind: 'none' });
    });

    test('DH-2: a helper\'s run', async () => {
        const f = fake();
        const outcome = await runDecisionHelper(f.deps, 'explainDecision');
        assert.deepEqual(outcome, { ok: true, session: 'tmp-261108-101530-explain-decision', noteFile: '_ai/quests/q/process/decision-261108-101530-explain.md', reopened: 'turn-end' });
        assert.deepEqual(f.dirs, ['/ws/_ai/quests/q/process'], 'the quest\'s process folder');
        assert.deepEqual(f.created, [{ name: 'tmp-261108-101530-explain-decision', basedOn: 'p1-work' }]);
        assert.deepEqual(f.deleted, ['tmp-261108-101530-explain-decision']);
        assert.equal(f.sent[0].source, 'Explain a decision (decision at Phase 1 › G1)');
        assert.match(f.sent[0].prompt, /^\*\*Explain a decision\*\* of process tom_specs, at Phase 1 › G1\./);
        assert.match(f.sent[0].prompt, /The choices: "Gate passed — go on to Phase 2"; "Gate failed — back to Draft"\./);
        assert.match(f.sent[0].prompt, /`_ai\/quests\/q\/process\/decision-261108-101530-explain\.md`/);
        assert.match(f.sent[0].prompt, /`reopenDecision: true`/);
        assert.equal(f.reopens(), 1, 'the decision reopens when the turn ends');
        assert.equal(decisionNoteName('grillMeDecision', NOW), 'decision-261108-101530-grill-me.md');
        const g = fake({ hasSession: () => false });
        const grill = await runDecisionHelper(g.deps, 'grillMeDecision');
        assert.equal(grill.ok, true);
        assert.deepEqual(g.created, [{ name: 'tmp-261108-101530-grill-me-decision' }], 'fresh when the process session has no file');
        assert.match(g.sent[0].prompt, /^\*\*Grill me\*\* on a decision of process tom_specs/);
    });

    test('DH-3: the reopened decision', async () => {
        // The note's button during the turn: reopened once, not again at the turn's end.
        const f = fake({ send: async () => { assert.equal(decisionHelperRunning(), true); markDecisionReopened(); return { ok: true }; } });
        const viaButton = await runDecisionHelper(f.deps, 'explainDecision');
        assert.equal(viaButton.ok && viaButton.reopened, 'button');
        assert.equal(f.reopens(), 0, 'the button reopened it (here faked), the turn\'s end does not');
        assert.equal(decisionHelperRunning(), false);
        // Decided meanwhile (e.g. in the PROCESS view): not reopened.
        const d = fake();
        d.deps.send = async () => { d.decide(); return { ok: true }; };
        const decided = await runDecisionHelper(d.deps, 'grillMeDecision');
        assert.equal(decided.ok && decided.reopened, 'decided');
        assert.equal(d.reopens(), 0);
        // A failed run reopens it, and says why.
        const busy = fake({ send: async () => ({ ok: false, rejected: true }) });
        assert.deepEqual(await runDecisionHelper(busy.deps, 'explainDecision'), { ok: false, error: 'the ANTHROPIC panel is busy with another request — try again when it is done', reopened: true });
        assert.equal(busy.reopens(), 1);
        assert.deepEqual(busy.deleted.length, 1, 'the temporary session goes anyway');
        // Refused: not at a decision; a second helper while one runs.
        const none = fake();
        none.decide();
        assert.deepEqual(await runDecisionHelper(none.deps, 'explainDecision'), { ok: false, error: 'the process is not at a decision', reopened: false });
        let release: () => void = () => undefined;
        const slow = fake({ send: () => new Promise((r) => { release = () => r({ ok: true }); }) });
        const first = runDecisionHelper(slow.deps, 'explainDecision');
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(await runDecisionHelper(fake().deps, 'grillMeDecision'), { ok: false, error: 'a decision helper is already running', reopened: false });
        release();
        assert.equal((await first).ok, true);
    });

    test('DH-4: the note\'s Back to the decision button', async () => {
        const files = new Set(['/ws/_ai/quests/q/process/note.md']);
        const closed: string[] = [];
        const cleared: string[] = [];
        let reopened = 0;
        let unavailable: string | undefined = 'the process is not at a decision';
        const deps: AskInMdBrowserDeps = {
            workspaceRoot: '/ws', exists: (p) => files.has(p),
            openWithBar: () => 'p1', clearBar: (_p, _r, note) => { cleared.push(note); }, closePanel: (p) => { closed.push(p); }, deleteFile: () => undefined,
            genId: () => 'req1',
            reopenDecision: { unavailable: () => unavailable, run: async () => { reopened++; } },
        };
        const slot = new MdBrowserAskSlot();
        assert.match(JSON.parse(await askInMdBrowserImpl(deps, { filePath: '_ai/quests/q/process/note.md', reopenDecision: true }, slot)).error, /Back to the decision cannot be offered: the process is not at a decision/);
        assert.match(JSON.parse(await askInMdBrowserImpl({ ...deps, reopenDecision: undefined }, { filePath: '_ai/quests/q/process/note.md', reopenDecision: true }, slot)).error, /not available here/);
        unavailable = undefined;
        assert.match(JSON.parse(await askInMdBrowserImpl(deps, { filePath: '_ai/quests/q/process/note.md', reopenDecision: true, buttons: [{ id: 'decide', label: 'x' }] }, slot)).error, /button ids `decide` and `decide-<n>`/);
        const call = askInMdBrowserImpl(deps, { filePath: '_ai/quests/q/process/note.md', reopenDecision: true }, slot);
        await new Promise((r) => setImmediate(r));
        assert.equal(slot.click('req1', 'decide', true), true);
        const answer = JSON.parse(await call);
        assert.deepEqual([answer.button, answer.label, answer.decisionReopened, answer.fileDeleted], ['decide', 'Back to the decision', true, false]);
        await new Promise((r) => setImmediate(r));
        assert.equal(reopened, 1, 'the decision reopened');
        assert.deepEqual(closed, [], 'the note stays open beside the decision');
        assert.deepEqual(cleared, ['Answered: Back to the decision']);
    });

    test('DH-5: wiring and the default prompts', () => {
        const EXT = path.join(__dirname, '..', '..', '..');
        const src = (rel: string) => fs.readFileSync(path.join(EXT, 'src', rel), 'utf8');
        const service = src('services/processActionService.ts');
        assert.match(service, /const buttons = context \? decisionDialogButtons\(labels\) : labels;/);
        assert.match(service, /void runDecisionHelper\(liveDecisionHelperDeps\(context\), pick\.use\)/);
        assert.match(src('handlers/processPanel-handler.ts'), /await decideInDialog\(this\.context\)/, 'the PROCESS view\'s Decide… offers the helpers');
        assert.match(src('handlers/markdownBrowser-handler.ts'), /reopenDecision: \{[\s\S]*?processActions\(\)\.reopenDecision\(mdBrowserContext\)/);
        assert.match(src('handlers/markdownBrowser-handler.ts'), /runFinishReviewRound\(mdBrowserContext\)/, 'Finish review round\'s decision offers them too');
        assert.equal(DECISION_HELPER_LABELS.grillMeDecision, 'Grill me');
        for (const use of ['explainDecision', 'grillMeDecision'] as const) {
            const body = ASSIST_PROMPT_INFO[use].defaultBody;
            assert.match(body, /`reopenDecision: true`/, use);
            assert.match(body, /tomAi_askUser and skip the note; the decision reopens when your turn ends/, use);
            assert.match(body, /Do not move the process and do not decide/, use);
        }
        assert.match(ASSIST_PROMPT_INFO.grillMeDecision.defaultBody, /`choices`/);
    });

    test('DH-6: the decision\'s own choices on the note', async () => {
        const taken: string[] = [];
        let reopened = 0;
        const closed: string[] = [];
        const deps: AskInMdBrowserDeps = {
            workspaceRoot: '/ws', exists: () => true,
            openWithBar: () => 'p1', clearBar: () => undefined, closePanel: (p) => { closed.push(p); }, deleteFile: () => undefined,
            genId: () => 'req2',
            reopenDecision: {
                unavailable: () => undefined, run: async () => { reopened++; },
                options: () => OPTIONS.map((o) => o.label), take: async (label) => { taken.push(label); },
            },
        };
        const slot = new MdBrowserAskSlot();
        assert.match(JSON.parse(await askInMdBrowserImpl(deps, { filePath: 'n.md', reopenDecision: true, buttons: [{ id: 'decide-1', label: 'x' }] }, slot)).error, /`decide-<n>`/);
        // Inside a helper's run: the click takes the option, so the turn's end does not reopen the decision.
        const helper = fake({
            send: async () => {
                const call = askInMdBrowserImpl(deps, { filePath: 'n.md', reopenDecision: true }, slot);
                await new Promise((r) => setImmediate(r));
                assert.equal(slot.click('req2', 'decide-2', true), true);
                const answer = JSON.parse(await call);
                assert.deepEqual([answer.button, answer.label, answer.decisionTaken, answer.decisionReopened], ['decide-2', OPTIONS[1].label, OPTIONS[1].label, undefined]);
                return { ok: true };
            },
        });
        const outcome = await runDecisionHelper(helper.deps, 'explainDecision');
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(taken, [OPTIONS[1].label], 'the option taken');
        assert.equal(reopened, 0);
        assert.equal(helper.reopens(), 0, 'not reopened at the turn\'s end');
        assert.equal(outcome.ok && outcome.reopened, 'button');
        assert.deepEqual(closed, [], 'the note stays open');
        // The bar: the options, then Back to the decision.
        let bar: { buttons: Array<{ id: string; label: string }> } | undefined;
        const call = askInMdBrowserImpl({ ...deps, openWithBar: (_p, b) => { bar = b; return 'p1'; } }, { filePath: 'n.md', reopenDecision: true }, slot);
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(bar?.buttons.map((b) => b.id), ['decide-1', 'decide-2', 'decide']);
        slot.click('req2', 'decide', true);
        await call;
        for (const use of ['explainDecision', 'grillMeDecision'] as const) {
            assert.match(ASSIST_PROMPT_INFO[use].defaultBody, /its bar carries the decision's own choices/, use);
            assert.match(ASSIST_PROMPT_INFO[use].defaultBody, /`decisionTaken`/, use);
        }
        // The defaults before the choices, unedited, are upgraded.
        const before = (body: string) => body
            .replace('its bar carries the decision\'s own choices — a click takes that choice — and **Back to the decision**, which reopens', 'its button **Back to the decision** reopens')
            .replace(' When my click took a choice (`decisionTaken` in the answer), the extension made it — end your answer.', '');
        const config: { assistPrompts?: AssistPromptsSection } = { assistPrompts: { templates: [
            { id: 'explain-decision', name: 'Explain a decision', template: before(ASSIST_PROMPT_INFO.explainDecision.defaultBody) },
            { id: 'grill-me-decision', name: 'Grill me at a decision', template: before(ASSIST_PROMPT_INFO.grillMeDecision.defaultBody) },
        ] } };
        assert.notEqual(config.assistPrompts!.templates![0].template, ASSIST_PROMPT_INFO.explainDecision.defaultBody);
        ensureDefaultAssistPrompts(config);
        assert.deepEqual(config.assistPrompts!.templates!.slice(0, 2).map((t) => t.template), [ASSIST_PROMPT_INFO.explainDecision.defaultBody, ASSIST_PROMPT_INFO.grillMeDecision.defaultBody]);
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'markdownBrowser-handler.ts'), 'utf8');
        assert.match(src, /options: \(\) => processActions\(\)\.decisionOptionLabels\(\),\s*take: async \(label\) => \{ await processActions\(\)\.takeDecisionOption\(label\); \}/);
    });
});
