import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseQueuePromptArgs,
    parseQueueDeleteArg,
    isQueueCommandParseError,
    type QueuePromptArgs,
} from '../telegramQueueCommands';

/** Narrow a parse result to the success type, asserting it is not an error. */
function ok(result: ReturnType<typeof parseQueuePromptArgs>): QueuePromptArgs {
    assert.equal(isQueueCommandParseError(result), false, `expected success, got ${JSON.stringify(result)}`);
    return result as QueuePromptArgs;
}

test('parseQueuePromptArgs: plain prompt has no count and next=false', () => {
    const r = ok(parseQueuePromptArgs('Run the analyzer on tom_core'));
    assert.equal(r.prompt, 'Run the analyzer on tom_core');
    assert.equal(r.repeatCount, undefined);
    assert.equal(r.next, false);
});

test('parseQueuePromptArgs: leading positive integer is a repetition count', () => {
    const r = ok(parseQueuePromptArgs('3 Retry the failing test'));
    assert.equal(r.repeatCount, 3);
    assert.equal(r.prompt, 'Retry the failing test');
    assert.equal(r.next, false);
});

test('parseQueuePromptArgs: leading "next" queues at the top', () => {
    const r = ok(parseQueuePromptArgs('next Fix the build first'));
    assert.equal(r.next, true);
    assert.equal(r.repeatCount, undefined);
    assert.equal(r.prompt, 'Fix the build first');
});

test('parseQueuePromptArgs: count + next in either order', () => {
    const a = ok(parseQueuePromptArgs('3 next do the thing'));
    assert.equal(a.repeatCount, 3);
    assert.equal(a.next, true);
    assert.equal(a.prompt, 'do the thing');

    const b = ok(parseQueuePromptArgs('next 3 do the thing'));
    assert.equal(b.repeatCount, 3);
    assert.equal(b.next, true);
    assert.equal(b.prompt, 'do the thing');
});

test('parseQueuePromptArgs: only the first integer is consumed as count', () => {
    const r = ok(parseQueuePromptArgs('3 5 reasons why'));
    assert.equal(r.repeatCount, 3);
    assert.equal(r.prompt, '5 reasons why');
});

test('parseQueuePromptArgs: zero is not a valid count and stays in the prompt', () => {
    const r = ok(parseQueuePromptArgs('0 do nothing'));
    assert.equal(r.repeatCount, undefined);
    assert.equal(r.prompt, '0 do nothing');
});

test('parseQueuePromptArgs: internal newlines are preserved', () => {
    const r = ok(parseQueuePromptArgs('line one\nline two\nline three'));
    assert.equal(r.prompt, 'line one\nline two\nline three');
});

test('parseQueuePromptArgs: empty input is a parse error', () => {
    const r = parseQueuePromptArgs('   ');
    assert.equal(isQueueCommandParseError(r), true);
});

test('parseQueuePromptArgs: options with no prompt body is an error', () => {
    assert.equal(isQueueCommandParseError(parseQueuePromptArgs('next')), true);
    assert.equal(isQueueCommandParseError(parseQueuePromptArgs('3 next')), true);
});

test('parseQueueDeleteArg: accepts a positive integer', () => {
    assert.equal(parseQueueDeleteArg('2'), 2);
    assert.equal(parseQueueDeleteArg('  3  '), 3);
});

test('parseQueueDeleteArg: rejects non-numbers, empty, and zero', () => {
    assert.equal(isQueueCommandParseError(parseQueueDeleteArg('abc')), true);
    assert.equal(isQueueCommandParseError(parseQueueDeleteArg('')), true);
    assert.equal(isQueueCommandParseError(parseQueueDeleteArg('0')), true);
});
