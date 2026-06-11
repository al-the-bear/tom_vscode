/**
 * Unit tests for the pure `send_prompt` helpers.
 *
 * Cover the parser's required-parts contract (quest + prompt), verbatim prompt
 * preservation, and the case-insensitive quest matching that decides whether a
 * given window owns an incoming prompt.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseSendPromptArgs,
    isSendPromptParseError,
    questMatches,
} from '../telegramSendPrompt.js';

describe('parseSendPromptArgs', () => {
    test('splits the first token as quest and the rest as prompt', () => {
        const r = parseSendPromptArgs('vscode_extension Summarize the open bug');
        assert.ok(!isSendPromptParseError(r));
        assert.equal(r.quest, 'vscode_extension');
        assert.equal(r.prompt, 'Summarize the open bug');
    });

    test('preserves internal newlines and casing in the prompt', () => {
        const r = parseSendPromptArgs('myquest Line one\nLine TWO\n  indented');
        assert.ok(!isSendPromptParseError(r));
        assert.equal(r.quest, 'myquest');
        assert.equal(r.prompt, 'Line one\nLine TWO\n  indented');
    });

    test('trims surrounding whitespace but not the inner body', () => {
        const r = parseSendPromptArgs('   q   hello world   ');
        assert.ok(!isSendPromptParseError(r));
        assert.equal(r.quest, 'q');
        assert.equal(r.prompt, 'hello world');
    });

    test('errors when nothing is provided', () => {
        const r = parseSendPromptArgs('');
        assert.ok(isSendPromptParseError(r));
        assert.match(r.error, /No quest specified/);
    });

    test('errors when only a quest is provided', () => {
        const r = parseSendPromptArgs('onlyquest');
        assert.ok(isSendPromptParseError(r));
        assert.match(r.error, /No prompt text specified/);
        assert.match(r.error, /onlyquest/);
    });

    test('errors when the prompt is only whitespace after the quest', () => {
        const r = parseSendPromptArgs('q    \n   ');
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
