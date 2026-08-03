/**
 * Wiring guard for the @WS → Logs → **Current Prompt** tab.
 *
 * The catalogue and the file mapping are pinned as pure functions in
 * `questLogFiles.test.ts`. What that cannot reach is whether anything actually
 * *calls* them: `AnthropicHandler` and `questLogs-handler` both import `vscode`
 * and cannot be instantiated under `node:test`, and the webview client is
 * browser JS. So the three invariants that make the feature work rather than
 * merely exist are asserted against the sources.
 *
 *   1. **Capture happens once, at the convergence point.** Every transport —
 *      direct SDK, Agent SDK, vscodeLm, the Local LLM bridge — is dispatched
 *      from `sendMessage()` *after* the block that resolves the system prompt
 *      and the expanded user message. Capturing there covers all of them; a
 *      capture moved into a transport branch would silently stop covering the
 *      others.
 *   2. **The literal is what the user typed.** `options.userText`, not the
 *      keyword-stripped `effectiveUserText` the model receives — telling those
 *      two apart is the entire reason the tab offers both.
 *   3. **The reader threads the variant through.** A dropdown over one tab
 *      breaks the old "one tab = one file" assumption; every hop from the
 *      client's request to the host's change-detection cache has to carry it.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Project root is three levels up from out/utils/__tests__. */
const root = join(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf-8');

describe('the Anthropic send path captures the running prompt', () => {
    const handler = read('src', 'handlers', 'anthropic-handler.ts');
    const lines = handler.split('\n');

    test('calls writeCurrentPrompt exactly once', () => {
        // More than once means a transport branch grew its own copy, and the
        // two will drift. Zero means the tab shows the last extension host's
        // leftovers forever.
        const calls = lines.filter(l => /writeCurrentPrompt\(/.test(l) && !/^\s*(\*|\/\/)/.test(l));
        assert.equal(
            calls.length,
            1,
            `expected one writeCurrentPrompt call, found ${calls.length}`,
        );
    });

    test('captures beside the raw-trail write, before any transport dispatch', () => {
        // `writeRawPrompt` is the existing marker for "system prompt, expanded
        // user message and quest are all resolved, nothing has been dispatched
        // yet". Anchoring to it means this test keeps pointing at the right
        // place when the surrounding code moves.
        const rawIdx = lines.findIndex(l => /TrailService\.instance\.writeRawPrompt\(/.test(l));
        const captureIdx = lines.findIndex(l => /writeCurrentPrompt\(/.test(l));
        assert.ok(rawIdx >= 0, 'writeRawPrompt anchor not found — has sendMessage been restructured?');
        assert.ok(captureIdx >= 0, 'no writeCurrentPrompt call in the Anthropic handler');
        assert.ok(
            Math.abs(captureIdx - rawIdx) <= 25,
            `writeCurrentPrompt (line ${captureIdx + 1}) has drifted away from the raw-trail write `
            + `(line ${rawIdx + 1}); it may no longer run for every transport`,
        );
    });

    test('passes the literal, the sent user message, the system prompt and the origin', () => {
        const captureIdx = lines.findIndex(l => /writeCurrentPrompt\(/.test(l));
        const call = lines.slice(captureIdx, captureIdx + 12).join('\n');

        // The literal is what the user typed — deliberately NOT
        // `effectiveUserText`, which has had keyword triggers stripped out.
        assert.match(
            call,
            /literal:\s*options\.userText\b/,
            'the literal must be options.userText — effectiveUserText is already keyword-stripped, '
            + 'so using it would make "Literal Prompt" and "User Prompt" differ by less than they should',
        );
        assert.match(call, /user:\s*\w/, 'no user message passed to the capture');
        assert.match(call, /system:\s*systemPrompt\b/, 'the system prompt must be the one actually sent');
        assert.match(
            call,
            /source:\s*options\.source\s*\?\?\s*'chat'/,
            'the origin must be resolved the same way the live trail resolves it, or a queue item '
            + 'will overwrite the chat files',
        );
    });
});

describe('the Logs viewer carries the variant end to end', () => {
    const handler = read('src', 'handlers', 'questLogs-handler.ts');
    const client = read('media', 'questLogs', 'main.js');

    test('the host resolves the requested variant instead of assuming one file per tab', () => {
        assert.match(
            handler,
            /isQuestLogVariantId\(/,
            'the variant arrives from the webview and must be validated before it picks a file',
        );
        assert.match(
            handler,
            /questLogLocation\(/,
            'file resolution must go through the catalogue so reader and writer agree on names',
        );
    });

    test('the change-detection cache is keyed by what is on screen, not by the tab', () => {
        // Keying by tab alone would answer "unchanged" for variant B because
        // variant A had not moved — five of the six options would never load.
        assert.match(
            handler,
            /lastSent\s*=\s*new Map<string,/,
            'lastSent must be keyed by the tab+variant view key, not by QuestLogTabId',
        );
        assert.match(handler, /questLogViewKey\(/, 'nothing computes the cache key');
    });

    test('every reply to the webview echoes the variant it describes', () => {
        // The client drops replies whose tab does not match the active one; the
        // same has to hold for the variant, or switching the dropdown mid-poll
        // paints the previous selection's text under the new label. Each reply
        // has to carry it — the two `qlogContent` error paths as much as the
        // success one, since those are what a just-selected empty variant hits.
        const replies = handler.match(/postMessage\(\{[\s\S]*?\}\);/g) ?? [];
        assert.ok(replies.length >= 4, `expected the four qlog replies, found ${replies.length}`);
        for (const reply of replies) {
            assert.match(
                reply,
                /\bvariant\b/,
                `a reply to the webview omits the variant it describes:\n${reply}`,
            );
        }
    });

    test('the client ignores a reply for a variant it is no longer showing', () => {
        assert.match(
            client,
            /msg\.variant\s*!==\s*qlogActiveVariant/,
            'without this, a reply in flight when the dropdown changed is applied to the new label',
        );
    });

    test('the client sends the variant with every request and with open-in-editor', () => {
        const requests = client.match(/vscode\.postMessage\(\{[^}]*type:\s*'qlog(Request|OpenInEditor)'[^}]*\}\)/g) ?? [];
        assert.equal(requests.length, 2, `expected 2 qlog postMessage calls, found ${requests.length}`);
        for (const call of requests) {
            assert.match(call, /variant:/, `qlog message without a variant: ${call}`);
        }
    });

    test('the dropdown selection survives a reload alongside the tab', () => {
        assert.match(client, /s\.qlogVariant\s*=\s*qlogActiveVariant/, 'the variant is never persisted');
        assert.match(client, /s\.qlogVariant/, 'the variant is never restored');
    });

    test('the dropdown is built from the catalogue and shown only for its tab', () => {
        assert.match(
            handler,
            /CURRENT_PROMPT_VARIANTS/,
            'the six options must come from the catalogue, not be re-typed into HTML',
        );
        assert.match(
            client,
            /qlog-variant/,
            'the client never touches the dropdown element',
        );
    });
});
