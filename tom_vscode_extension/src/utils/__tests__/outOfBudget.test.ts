/**
 * A queue stage that stops because the API credit balance is too low
 * (src/utils/outOfBudget.ts).
 *
 * The direct API answers a 400 invalid_request_error "Your credit balance is
 * too low to access the Anthropic API"; the queue failed the item like any
 * malformed request and stopped auto-send, so an unattended walk ended there.
 * Decided (finishvsf6, the user's policy): a profile may name a profile to
 * continue on and switch to it automatically (A); otherwise the item shows a
 * profile picker (preset to the profile's choice) with "Continue on profile"
 * (A, by hand) and "Resend" (B: the very last request again).
 *
 *   OB-1 the failure is recognised by its message or its error type, and nothing else is
 *   OB-2 the decision: switch only when the profile switches automatically to another existing
 *        profile; else ask, suggesting the profile's choice when it is a real other profile
 *   OB-3 the prompt sent on the other profile names the stopped profile, its session, the session's
 *        live trail and the original prompt; and says when it runs in another session
 *   OB-4 the queue manager: the failure is handled before the "unretryable 400" rule, the
 *        automatic switch and the button share continueOnProfile, an item switches by itself once,
 *        and later stages of the item run on the profile it switched to (applyBudgetFallback: a
 *        stage on the profile that ran out moves, with the fallback session if named; others stay)
 *   OB-5 the profile editor stores the policy; the schema and the config type know it
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyBudgetFallback, decideOutOfBudget, isOutOfBudgetFailure, outOfBudgetPrompt, type OutOfBudgetMark } from '../outOfBudget';

const root = join(__dirname, '..', '..', '..');
const src = (...p: string[]): string => readFileSync(join(root, ...p), 'utf-8');

const CREDIT = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

const PROFILES = [
    { id: 'opus-5-5-direct', name: 'Opus 5.5 — Direct', outOfBudget: { fallbackProfileId: 'opus-5-5-agent-sdk-mm', autoSwitch: true } },
    { id: 'sonnet-5-5-direct', name: 'Sonnet 5.5 — Direct', outOfBudget: { fallbackProfileId: 'opus-5-5-agent-sdk-mm' } },
    { id: 'haiku-5-5-direct', name: 'Haiku 5.5 — Direct', outOfBudget: { fallbackProfileId: 'haiku-5-5-direct', autoSwitch: true } },
    { id: 'fable-5-1-direct', name: 'Fable', outOfBudget: { fallbackProfileId: 'gone', autoSwitch: true } },
    { id: 'opus-5-5-agent-sdk-mm', name: 'Opus 5.5 — Agent SDK SDK-MM' },
];

describe('out of budget', () => {
    test('OB-1: recognised', () => {
        assert.equal(isOutOfBudgetFailure(CREDIT), true);
        assert.equal(isOutOfBudgetFailure('{"error":{"type":"credit_balance_too_low"}}'), true);
        for (const other of ['429 rate_limit_error', '400 invalid_request_error: prompt is too long', 'weekly limit reached, resets 3pm', '', undefined]) {
            assert.equal(isOutOfBudgetFailure(other), false, String(other));
        }
    });

    test('OB-2: switch or ask', () => {
        assert.deepEqual(decideOutOfBudget('opus-5-5-direct', PROFILES), { kind: 'switch', profileId: 'opus-5-5-agent-sdk-mm' });
        assert.deepEqual(decideOutOfBudget('sonnet-5-5-direct', PROFILES), { kind: 'ask', suggestedProfileId: 'opus-5-5-agent-sdk-mm' });
        assert.deepEqual(decideOutOfBudget('haiku-5-5-direct', PROFILES), { kind: 'ask' }, 'itself is no fallback');
        assert.deepEqual(decideOutOfBudget('fable-5-1-direct', PROFILES), { kind: 'ask' }, 'an unknown profile is no fallback');
        assert.deepEqual(decideOutOfBudget('opus-5-5-agent-sdk-mm', PROFILES), { kind: 'ask' });
        assert.deepEqual(decideOutOfBudget(undefined, PROFILES), { kind: 'ask' });
    });

    test('OB-3: the prompt on the other profile', () => {
        const mark: OutOfBudgetMark = {
            profileId: 'opus-5-5-direct', profileName: 'Opus 5.5 — Direct', model: 'claude-opus-5-5', session: 'default',
            message: 'Your credit balance is too low to access the Anthropic API.', at: '2026-11-05T09:24:50.000Z',
        };
        const text = outOfBudgetPrompt(mark, { quest: 'vscode_extension', toProfileName: 'Opus 5.5 — Agent SDK SDK-MM', runsInSession: 'default', originalPrompt: 'Do quest todo finishvsf6' });
        assert.match(text, /^\*\*Out of budget/);
        assert.match(text, /profile "Opus 5\.5 — Direct" \(opus-5-5-direct, model claude-opus-5-5\) in session "default"/);
        assert.match(text, /credit balance is too low/);
        assert.match(text, /`_ai\/quests\/vscode_extension\/history\/sessions\/default\/live-trail\.md`/);
        assert.match(text, /do not start it over/);
        assert.ok(text.trimEnd().endsWith('Do quest todo finishvsf6'));
        assert.doesNotMatch(text, /runs in session/);
        const other = outOfBudgetPrompt({ ...mark, session: 'p2-review' }, { quest: 'q', toProfileName: 'X', runsInSession: 'default', originalPrompt: 'P' });
        assert.match(other, /runs in session "default": session "p2-review" keeps its conversation where profile "X" cannot continue it/);
    });

    test('OB-4: the queue manager', () => {
        const qm = src('src', 'managers', 'promptQueueManager.ts');
        const budget = qm.indexOf('if (isOutOfBudgetFailure(searchText))');
        assert.ok(budget > 0, 'the failure is handled');
        assert.ok(budget < qm.indexOf('if (isUnretryableRequestError(searchText))'), 'before the unretryable-400 rule');
        assert.match(qm, /async continueOnProfile\(id: string, profileId: string/);
        assert.match(qm, /void this\.continueOnProfile\(item\.id, decision\.profileId, \{ automatic: true \}\)/);
        assert.match(qm, /return applyBudgetFallback\(this\.resolveStageTransportAsQueued\(item, stage\), item\.budgetFallback\);/);
        assert.match(qm, /if \(decision\.kind === 'switch' && item\.budgetFallback\)/, 'switches by itself once per item');
        const fb = { fromProfileId: 'opus-5-5-direct', toProfileId: 'opus-5-5-agent-sdk-mm' };
        assert.deepEqual(applyBudgetFallback({ anthropicProfileId: 'opus-5-5-direct', anthropicConfigId: 'c', session: 's' }, fb),
            { anthropicProfileId: 'opus-5-5-agent-sdk-mm', anthropicConfigId: undefined, session: 's' });
        assert.deepEqual(applyBudgetFallback({ anthropicProfileId: 'opus-5-5-direct', session: 's' }, { ...fb, session: 'default' }),
            { anthropicProfileId: 'opus-5-5-agent-sdk-mm', anthropicConfigId: undefined, session: 'default' });
        const other = { anthropicProfileId: 'haiku-5-5-direct', session: 's' };
        assert.equal(applyBudgetFallback(other, fb), other, 'a stage on another profile is left alone');
        assert.equal(applyBudgetFallback(other, undefined), other);
        const handler = src('src', 'handlers', 'queueEditor-handler.ts');
        assert.match(handler, /case 'continueOnProfile':/);
    });

    test('OB-5: the profile editor, the schema and the config type', () => {
        const editor = src('src', 'handlers', 'globalTemplateEditor-handler.ts');
        assert.match(editor, /name: 'outOfBudgetFallbackProfileId'/);
        assert.match(editor, /name: 'outOfBudgetAutoSwitch'/);
        assert.match(editor, /outOfBudget: \{/);
        const schema = JSON.parse(src('src', 'config', 'tom_vscode_extension.schema.json'));
        const json = JSON.stringify(schema);
        assert.match(json, /"outOfBudget":\{"type":"object"/);
        assert.match(src('src', 'utils', 'sendToChatConfig.ts'), /outOfBudget\?: \{ fallbackProfileId\?: string; autoSwitch\?: boolean \}/);
    });
});
