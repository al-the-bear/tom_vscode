/**
 * Unit tests for the pure `send_prompt` helpers.
 *
 * Cover the parser's contract (the whole message is the prompt — settings are
 * per workspace/quest so no quest selector is parsed), verbatim prompt
 * preservation, and the case-insensitive quest matching the live-conversation
 * forwarder uses to filter trail events to its own window's quest.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseSendPromptArgs,
    isSendPromptParseError,
    questMatches,
} from '../telegramSendPrompt.js';

describe('parseSendPromptArgs', () => {
    test('takes the whole message as the prompt', () => {
        const r = parseSendPromptArgs('Summarize the open bug');
        assert.ok(!isSendPromptParseError(r));
        assert.equal(r.prompt, 'Summarize the open bug');
    });

    test('preserves internal newlines and casing in the prompt', () => {
        const r = parseSendPromptArgs('Line one\nLine TWO\n  indented');
        assert.ok(!isSendPromptParseError(r));
        assert.equal(r.prompt, 'Line one\nLine TWO\n  indented');
    });

    test('trims surrounding whitespace but not the inner body', () => {
        const r = parseSendPromptArgs('   hello   world   ');
        assert.ok(!isSendPromptParseError(r));
        assert.equal(r.prompt, 'hello   world');
    });

    test('errors when nothing is provided', () => {
        const r = parseSendPromptArgs('');
        assert.ok(isSendPromptParseError(r));
        assert.match(r.error, /No prompt text specified/);
    });

    test('errors when the message is only whitespace', () => {
        const r = parseSendPromptArgs('    \n   ');
        assert.ok(isSendPromptParseError(r));
        assert.match(r.error, /No prompt text specified/);
    });
});

describe('questMatches', () => {
    test('matches identical quest ids', () => {
        assert.equal(questMatches('vscode_extension', 'vscode_extension'), true);
    });

    test('matches case-insensitively and trims', () => {
        assert.equal(questMatches('  VSCode_Extension ', 'vscode_extension'), true);
    });

    test('does not match different quests', () => {
        assert.equal(questMatches('tom_flow', 'vscode_extension'), false);
    });

    test('never matches when either side is empty', () => {
        assert.equal(questMatches('', 'vscode_extension'), false);
        assert.equal(questMatches('vscode_extension', ''), false);
        assert.equal(questMatches('', ''), false);
    });
});
