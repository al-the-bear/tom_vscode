/**
 * The store of the prompts as sent (src/utils/sentPrompts.ts).
 *
 *   SP-1 a text is kept once, under its hash; reading takes only well-formed references
 *   SP-2 records: appended at most 200 (the oldest go), the composed texts filled in, YAML round trip
 *   SP-3 pruning deletes the texts no record names, only once the store holds more than the limit
 *   SP-4 the label of a stage from the item's last dispatch
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    appendSentRecord, MAX_SENT_RECORDS, pruneSentTexts, readSentText, referencedSentTexts, SENT_PROMPTS_FOLDER,
    sentRecordsFromYaml, sentRecordsToYaml, sentStageLabel, sentTextRef, storeSentText, withComposedTexts,
} from '../sentPrompts.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-prompts-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe('the prompts as sent', () => {
    test('SP-1: one file per text', () => {
        const a = storeSentText(DIR, 'system prompt');
        assert.equal(storeSentText(DIR, 'system prompt'), a);
        assert.match(a, /^[0-9a-f]{20}$/);
        assert.equal(a, sentTextRef('system prompt'));
        assert.equal(readSentText(DIR, a), 'system prompt');
        assert.equal(fs.readdirSync(path.join(DIR, SENT_PROMPTS_FOLDER)).length, 1);
        assert.equal(readSentText(DIR, '../../etc/passwd'), undefined, 'a malformed reference is refused');
        assert.equal(readSentText(DIR, '0'.repeat(20)), undefined, 'an unknown one answers nothing');
    });

    test('SP-2: records', () => {
        let records = appendSentRecord(undefined, { label: 'x', sentAt: 't' });
        for (let i = 0; i < MAX_SENT_RECORDS + 5; i++) { records = appendSentRecord(records, { label: `r${i}`, sentAt: 't' }); }
        assert.equal(records.length, MAX_SENT_RECORDS);
        assert.equal(records[records.length - 1].label, `r${MAX_SENT_RECORDS + 4}`, 'the newest kept');
        const filled = withComposedTexts(DIR, { label: 'Main prompt', sentAt: '2026-11-26T10:00:00.000Z' }, { systemPrompt: 'SYS', userMessage: 'USER' });
        assert.equal(readSentText(DIR, filled.promptRef!), 'USER');
        assert.equal(readSentText(DIR, filled.systemRef!), 'SYS');
        assert.deepEqual([filled.promptChars, filled.systemChars], [4, 3]);
        assert.equal(withComposedTexts(DIR, { label: 'L', sentAt: 't' }, { systemPrompt: '', userMessage: 'only user' }).systemRef, undefined, 'no system prompt, no reference');
        assert.deepEqual(sentRecordsFromYaml(sentRecordsToYaml([filled])), [filled]);
        assert.equal(sentRecordsFromYaml('nope'), undefined);
        assert.deepEqual(sentRecordsFromYaml([{ label: 'ok', 'sent-at': 't' }, { label: 1 }]), [{ label: 'ok', sentAt: 't' }], 'unreadable entries dropped');
    });

    test('SP-3: pruning', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-prune-'));
        try {
            const kept = storeSentText(dir, 'kept');
            for (let i = 0; i < 5; i++) { storeSentText(dir, `old ${i}`); }
            const refs = referencedSentTexts([{ label: 'k', sentAt: 't', promptRef: kept }]);
            assert.equal(pruneSentTexts(dir, refs, 10), 0, 'below the limit nothing goes');
            assert.equal(pruneSentTexts(dir, refs, 3), 5);
            assert.deepEqual(fs.readdirSync(path.join(dir, SENT_PROMPTS_FOLDER)), [`${kept}.md`]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('SP-4: labels', () => {
        assert.equal(sentStageLabel({ lastDispatched: { kind: 'prePrompt', prePromptIndex: 1 } }), 'Pre-prompt 2');
        assert.equal(sentStageLabel({ lastDispatched: { kind: 'followUp', followUpIndex: 0 } }), 'Follow-up 1');
        assert.equal(sentStageLabel({ lastDispatched: { kind: 'main' }, repeatTodoId: 'abc3' }), 'Main prompt — todo abc3');
        assert.equal(sentStageLabel({ lastDispatched: { kind: 'main' }, iterationSeq: 3 }), 'Main prompt (iteration 3)');
        assert.equal(sentStageLabel({ lastDispatched: { kind: 'main' } }), 'Main prompt');
        assert.equal(sentStageLabel({}), 'Prompt');
    });
});
