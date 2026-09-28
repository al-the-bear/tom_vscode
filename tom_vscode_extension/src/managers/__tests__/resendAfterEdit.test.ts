/**
 * Resending a queue item that was edited after its last dispatch.
 *
 * `lastDispatched` exists so the Resend button can replay a dispatch that was
 * lost — a transport error, a cancelled turn, an answer that never arrived. It
 * records the byte-identical expanded text so the retry is the same request.
 *
 * That contract is right for a *retry* and wrong for the workflow the queue
 * actually invites: cancel a running item, fix the prompt, send it again. The
 * cancel reverts the item to `staged`, editing rebuilds `expandedText` from the
 * corrected `originalText` — and then the resend dispatched the snapshot, so
 * the edit was visible in the item and absent from the wire. The prompt panel
 * was telling the truth; the send was replaying the old text.
 *
 * An edit is an explicit statement of what the user now wants sent, so for the
 * **main** stage it wins over the snapshot. The other two stages keep the
 * snapshot: `expandedText` is a scratch field that the pre-prompt and follow-up
 * builders overwrite in place, so it holds *that stage's* text and has no
 * relationship to the item's own prompt. Replaying a follow-up must replay the
 * follow-up.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveResendText } from '../../utils/queueStep3Utils.js';

describe('resolveResendText', () => {
    test('a main-stage resend sends the edit, not the text that was cancelled', () => {
        // The reported bug, in one assertion.
        assert.equal(
            resolveResendText({ kind: 'main', expandedText: 'the old prompt' }, 'the corrected prompt'),
            'the corrected prompt',
        );
    });

    test('an untouched main item resends exactly what went out before', () => {
        // Nothing edited the item, so both texts are the same value and the
        // retry stays byte-identical — the original contract, undisturbed.
        assert.equal(
            resolveResendText({ kind: 'main', expandedText: 'unchanged' }, 'unchanged'),
            'unchanged',
        );
    });

    test('a follow-up resend replays the follow-up, not the item prompt', () => {
        // `item.expandedText` still holds whatever the last builder wrote. For
        // a follow-up dispatch that is the follow-up's own text, and after an
        // edit it is the main prompt — neither is a reason to stop replaying
        // the stage the user asked to replay.
        assert.equal(
            resolveResendText({ kind: 'followUp', expandedText: 'follow-up 2' }, 'the main prompt'),
            'follow-up 2',
        );
    });

    test('a pre-prompt resend replays the pre-prompt', () => {
        assert.equal(
            resolveResendText({ kind: 'prePrompt', expandedText: 'set the scene' }, 'the main prompt'),
            'set the scene',
        );
    });

    test('an empty edit does not silently fall back to the snapshot', () => {
        // Emptying the prompt is a strange thing to do, but it is a thing the
        // user did. Treating "" as "no edit" would resend the cancelled text
        // and look exactly like the bug this function exists to fix.
        assert.equal(
            resolveResendText({ kind: 'main', expandedText: 'the old prompt' }, ''),
            '',
        );
    });

    test('a missing current text falls back to the snapshot rather than sending nothing', () => {
        // Defensive only at this one boundary: the field is optional on the
        // persisted shape, and a resend that dispatches `undefined` would fail
        // deep inside a transport instead of here.
        assert.equal(
            resolveResendText({ kind: 'main', expandedText: 'the old prompt' }, undefined),
            'the old prompt',
        );
    });
});
