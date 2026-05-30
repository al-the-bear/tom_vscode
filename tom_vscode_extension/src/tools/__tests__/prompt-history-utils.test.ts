/**
 * Tests for pure helpers in `tools/prompt-history-utils.ts`.
 *
 * Builds a realistic quest folder on disk with summary trail files for
 * two subsystems and verifies parsing, pairing, listing, and fetching.
 *
 * Run with:
 *   npm run compile && node --test out/tools/__tests__/prompt-history-utils.test.js
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    findSubsystemFiles,
    getPromptPairs,
    listPromptPairs,
    matchesSubsystemFilter,
    pairPromptsAndAnswers,
    parseTrailFile,
    readTrailFile,
} from '../prompt-history-utils.js';

// ---------------------------------------------------------------------------
// Fixture: a quest folder with two subsystems.
// ---------------------------------------------------------------------------

let tmp: string;
let questFolder: string;
const QUEST_ID = 'demo_quest';

function w(rel: string): string { return path.join(tmp, rel); }

/**
 * Build a summary entry. Real entries are PREPENDED newest-first, so
 * the caller passes them in chronological order and we reverse.
 */
function makeSummaryFile(filePath: string, kind: 'PROMPT' | 'ANSWER', entries: Array<{ id: string; ts: string; seq: number; body: string }>): void {
    // Newest first → reverse the chronological array
    const blocks = entries.slice().reverse().map((e) => {
        const header = `=== ${kind} ${e.id} ${e.ts} ${e.seq} ===`;
        if (kind === 'PROMPT') {
            return `${header}\n\n${e.body}\n\nTEMPLATE: (none)\nANSWER-WRAPPER: no\n\n`;
        }
        return `${header}\n\n${e.body}\n\n`;
    });
    fs.writeFileSync(filePath, blocks.join(''), 'utf-8');
}

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-history-'));
    questFolder = path.join(tmp, '_ai', 'quests', QUEST_ID);
    fs.mkdirSync(questFolder, { recursive: true });

    // ---- Anthropic subsystem: three exchanges ----
    const anthropicPrompts = path.join(questFolder, `${QUEST_ID}.anthropic.prompts.md`);
    const anthropicAnswers = path.join(questFolder, `${QUEST_ID}.anthropic.answers.md`);
    makeSummaryFile(anthropicPrompts, 'PROMPT', [
        { id: 'req-A1', ts: '2026-01-01T10:00:00.000Z', seq: 1, body: 'First Anthropic prompt body.' },
        { id: 'req-A2', ts: '2026-01-01T10:05:00.000Z', seq: 2, body: 'Second Anthropic prompt body with some more text.' },
        { id: 'req-A3', ts: '2026-01-01T10:10:00.000Z', seq: 3, body: 'Third Anthropic prompt — final.' },
    ]);
    makeSummaryFile(anthropicAnswers, 'ANSWER', [
        { id: 'req-A1', ts: '2026-01-01T10:00:01.000Z', seq: 1, body: 'First Anthropic answer.' },
        { id: 'req-A2', ts: '2026-01-01T10:05:01.000Z', seq: 2, body: 'Second Anthropic answer is longer than the first.' },
        // No answer for req-A3 — simulates an in-flight or interrupted turn.
    ]);

    // ---- LocalLLM subsystem (named after a config) ----
    const llmName = 'localllm-bomber-gemma4';
    const llmPrompts = path.join(questFolder, `${QUEST_ID}.${llmName}.prompts.md`);
    const llmAnswers = path.join(questFolder, `${QUEST_ID}.${llmName}.answers.md`);
    makeSummaryFile(llmPrompts, 'PROMPT', [
        { id: 'req-L1', ts: '2026-01-01T11:00:00.000Z', seq: 1, body: 'LLM prompt one.' },
        { id: 'req-L2', ts: '2026-01-01T11:00:30.000Z', seq: 2, body: 'LLM prompt two with longer body.' },
    ]);
    makeSummaryFile(llmAnswers, 'ANSWER', [
        { id: 'req-L1', ts: '2026-01-01T11:00:10.000Z', seq: 1, body: 'LLM answer one.' },
        { id: 'req-L2', ts: '2026-01-01T11:00:35.000Z', seq: 2, body: 'LLM answer two.' },
    ]);

    // ---- A stray non-summary file that should be ignored ----
    fs.writeFileSync(path.join(questFolder, `${QUEST_ID}.anthropic.unrelated.md`), 'noise');
});

after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// parseTrailFile
// ---------------------------------------------------------------------------

describe('parseTrailFile', () => {
    test('returns [] for empty input', () => {
        assert.deepEqual(parseTrailFile(''), []);
    });

    test('parses a single prompt entry and strips the TEMPLATE footer', () => {
        const content = '=== PROMPT id1 2026-01-01T10:00:00.000Z 1 ===\n\nhello world\n\nTEMPLATE: (none)\nANSWER-WRAPPER: no\n\n';
        const entries = parseTrailFile(content);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].kind, 'PROMPT');
        assert.equal(entries[0].requestId, 'id1');
        assert.equal(entries[0].timestamp, '2026-01-01T10:00:00.000Z');
        assert.equal(entries[0].sequence, 1);
        assert.equal(entries[0].body, 'hello world');
    });

    test('parses multiple entries in file order (newest first)', () => {
        const file = path.join(questFolder, `${QUEST_ID}.anthropic.prompts.md`);
        const entries = parseTrailFile(fs.readFileSync(file, 'utf-8'));
        assert.equal(entries.length, 3);
        // Newest first because that's how the file is built
        assert.equal(entries[0].requestId, 'req-A3');
        assert.equal(entries[1].requestId, 'req-A2');
        assert.equal(entries[2].requestId, 'req-A1');
    });

    test('preserves body content (minus the TEMPLATE footer for prompts)', () => {
        const file = path.join(questFolder, `${QUEST_ID}.anthropic.prompts.md`);
        const entries = parseTrailFile(fs.readFileSync(file, 'utf-8'));
        assert.equal(entries[0].body, 'Third Anthropic prompt — final.');
        assert.match(entries[1].body, /Second Anthropic prompt body/);
    });

    test('keeps the first occurrence when duplicate ids appear', () => {
        const content =
            '=== PROMPT dup 2026-01-01T10:00:00.000Z 2 ===\n\nnewer\n\n' +
            '=== PROMPT dup 2026-01-01T09:00:00.000Z 1 ===\n\nolder\n\n';
        const entries = parseTrailFile(content);
        // Both entries are returned; dedup happens in `pairPromptsAndAnswers`
        assert.equal(entries.length, 2);
        assert.equal(entries[0].body, 'newer');
        assert.equal(entries[1].body, 'older');
    });

    test('ignores lines with no preceding header', () => {
        const content = 'stray noise\nmore noise\n\n=== PROMPT id1 2026-01-01T10:00:00.000Z 1 ===\n\nreal body\n';
        const entries = parseTrailFile(content);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].body, 'real body');
    });
});

// ---------------------------------------------------------------------------
// readTrailFile (thin wrapper over parseTrailFile + fs)
// ---------------------------------------------------------------------------

describe('readTrailFile', () => {
    test('returns [] for missing file', () => {
        assert.deepEqual(readTrailFile(path.join(tmp, 'nope.md')), []);
    });
    test('reads and parses an existing file', () => {
        const entries = readTrailFile(path.join(questFolder, `${QUEST_ID}.anthropic.prompts.md`));
        assert.equal(entries.length, 3);
    });
});

// ---------------------------------------------------------------------------
// findSubsystemFiles
// ---------------------------------------------------------------------------

describe('findSubsystemFiles', () => {
    test('discovers both subsystems', () => {
        const files = findSubsystemFiles(questFolder, QUEST_ID);
        const names = files.map((f) => f.subsystem).sort();
        assert.deepEqual(names, ['anthropic', 'localllm-bomber-gemma4']);
    });

    test('subsystemFilter exact match', () => {
        const files = findSubsystemFiles(questFolder, QUEST_ID, 'anthropic');
        assert.deepEqual(files.map((f) => f.subsystem), ['anthropic']);
    });

    test('subsystemFilter family-prefix ("localllm" matches "localllm-*")', () => {
        const files = findSubsystemFiles(questFolder, QUEST_ID, 'localllm');
        assert.deepEqual(files.map((f) => f.subsystem), ['localllm-bomber-gemma4']);
    });

    test('subsystemFilter explicit prefix-glob ("localllm-*")', () => {
        const files = findSubsystemFiles(questFolder, QUEST_ID, 'localllm-*');
        assert.deepEqual(files.map((f) => f.subsystem), ['localllm-bomber-gemma4']);
    });

    test('non-matching filter → empty', () => {
        const files = findSubsystemFiles(questFolder, QUEST_ID, 'nonexistent');
        assert.deepEqual(files, []);
    });

    test('missing quest folder → []', () => {
        const files = findSubsystemFiles(path.join(tmp, 'no-such'), QUEST_ID);
        assert.deepEqual(files, []);
    });

    test('ignores unrelated files in the quest folder', () => {
        const files = findSubsystemFiles(questFolder, QUEST_ID);
        const names = files.map((f) => f.subsystem);
        assert.ok(!names.some((s) => s.includes('unrelated')));
    });
});

// ---------------------------------------------------------------------------
// matchesSubsystemFilter (small unit)
// ---------------------------------------------------------------------------

describe('matchesSubsystemFilter', () => {
    test('empty filter matches anything', () => {
        assert.equal(matchesSubsystemFilter('anthropic', ''), true);
    });
    test('exact match', () => {
        assert.equal(matchesSubsystemFilter('anthropic', 'anthropic'), true);
        assert.equal(matchesSubsystemFilter('anthropic', 'copilot'), false);
    });
    test('trailing-star prefix glob', () => {
        assert.equal(matchesSubsystemFilter('localllm-foo', 'localllm-*'), true);
        assert.equal(matchesSubsystemFilter('lm-api-foo', 'localllm-*'), false);
    });
    test('bare-family prefix', () => {
        assert.equal(matchesSubsystemFilter('localllm-foo', 'localllm'), true);
        assert.equal(matchesSubsystemFilter('lm-api-foo', 'localllm'), false);
    });
});

// ---------------------------------------------------------------------------
// pairPromptsAndAnswers
// ---------------------------------------------------------------------------

describe('pairPromptsAndAnswers', () => {
    test('pairs by requestId', () => {
        const prompts = readTrailFile(path.join(questFolder, `${QUEST_ID}.anthropic.prompts.md`));
        const answers = readTrailFile(path.join(questFolder, `${QUEST_ID}.anthropic.answers.md`));
        const pairs = pairPromptsAndAnswers(prompts, answers, 'anthropic', QUEST_ID);
        assert.equal(pairs.length, 3);
        // Newest first
        assert.equal(pairs[0].requestId, 'req-A3');
        assert.equal(pairs[1].requestId, 'req-A2');
        assert.equal(pairs[2].requestId, 'req-A1');
        // hasAnswer for the two with answers
        const a3 = pairs.find((p) => p.requestId === 'req-A3')!;
        const a2 = pairs.find((p) => p.requestId === 'req-A2')!;
        assert.equal(a3.hasAnswer, false);
        assert.equal(a3.answerChars, 0);
        assert.equal(a3.answerPreview, '');
        assert.equal(a2.hasAnswer, true);
        assert.ok(a2.answerChars > 0);
    });

    test('preview is clipped + collapses whitespace', () => {
        const prompts = readTrailFile(path.join(questFolder, `${QUEST_ID}.anthropic.prompts.md`));
        const answers = readTrailFile(path.join(questFolder, `${QUEST_ID}.anthropic.answers.md`));
        const pairs = pairPromptsAndAnswers(prompts, answers, 'anthropic', QUEST_ID, 12);
        const a2 = pairs.find((p) => p.requestId === 'req-A2')!;
        assert.ok(a2.promptPreview.length <= 13); // 12 + the ellipsis
        assert.ok(a2.promptPreview.endsWith('…'));
    });

    test('index re-stamped within the result', () => {
        const prompts = readTrailFile(path.join(questFolder, `${QUEST_ID}.anthropic.prompts.md`));
        const answers = readTrailFile(path.join(questFolder, `${QUEST_ID}.anthropic.answers.md`));
        const pairs = pairPromptsAndAnswers(prompts, answers, 'anthropic', QUEST_ID);
        assert.equal(pairs[0].index, 0);
        assert.equal(pairs[1].index, 1);
        assert.equal(pairs[2].index, 2);
    });

    test('deduplicates repeated prompt requestIds (newest wins)', () => {
        const dupContent =
            '=== PROMPT same-id 2026-01-01T12:00:00.000Z 2 ===\n\nnewer body\n\nTEMPLATE: (none)\nANSWER-WRAPPER: no\n\n' +
            '=== PROMPT same-id 2026-01-01T11:00:00.000Z 1 ===\n\nolder body\n\nTEMPLATE: (none)\nANSWER-WRAPPER: no\n\n';
        const prompts = parseTrailFile(dupContent);
        const pairs = pairPromptsAndAnswers(prompts, [], 'anthropic', QUEST_ID);
        assert.equal(pairs.length, 1);
        assert.equal(pairs[0].promptPreview.includes('newer body'), true);
    });
});

// ---------------------------------------------------------------------------
// listPromptPairs
// ---------------------------------------------------------------------------

describe('listPromptPairs', () => {
    test('lists everything from every subsystem, newest first', () => {
        const r = listPromptPairs(questFolder, QUEST_ID);
        assert.equal(r.questId, QUEST_ID);
        assert.equal(r.totalAvailable, 5);
        assert.equal(r.returned, 5);
        // Newest first by timestamp:
        //  L2  11:00:30
        //  L1  11:00:00
        //  A3  10:10:00
        //  A2  10:05:00
        //  A1  10:00:00
        const ids = r.pairs.map((p) => p.requestId);
        assert.deepEqual(ids, ['req-L2', 'req-L1', 'req-A3', 'req-A2', 'req-A1']);
    });

    test('subsystem filter narrows the scan', () => {
        const r = listPromptPairs(questFolder, QUEST_ID, { subsystem: 'anthropic' });
        const ids = r.pairs.map((p) => p.requestId);
        assert.deepEqual(ids, ['req-A3', 'req-A2', 'req-A1']);
        assert.deepEqual(r.subsystemsScanned, ['anthropic']);
    });

    test('subsystem family filter ("localllm")', () => {
        const r = listPromptPairs(questFolder, QUEST_ID, { subsystem: 'localllm' });
        const ids = r.pairs.map((p) => p.requestId);
        assert.deepEqual(ids, ['req-L2', 'req-L1']);
    });

    test('limit + offset paging', () => {
        const page1 = listPromptPairs(questFolder, QUEST_ID, { limit: 2 });
        const page2 = listPromptPairs(questFolder, QUEST_ID, { limit: 2, offset: 2 });
        const page3 = listPromptPairs(questFolder, QUEST_ID, { limit: 2, offset: 4 });
        assert.equal(page1.returned, 2);
        assert.equal(page2.returned, 2);
        assert.equal(page3.returned, 1);
        // page boundaries don't overlap
        const ids1 = page1.pairs.map((p) => p.requestId);
        const ids2 = page2.pairs.map((p) => p.requestId);
        assert.equal(ids1.some((x) => ids2.includes(x)), false);
    });

    test('limit gets clamped to 1..500', () => {
        const small = listPromptPairs(questFolder, QUEST_ID, { limit: 0 });
        assert.equal(small.limit, 1);
        const big = listPromptPairs(questFolder, QUEST_ID, { limit: 10_000 });
        assert.equal(big.limit, 500);
    });

    test('previewChars=0 disables previews', () => {
        const r = listPromptPairs(questFolder, QUEST_ID, { previewChars: 0 });
        for (const p of r.pairs) {
            assert.equal(p.promptPreview, '');
            assert.equal(p.answerPreview, '');
        }
    });

    test('missing quest folder → empty result, no error', () => {
        const r = listPromptPairs(path.join(tmp, 'no-such'), QUEST_ID);
        assert.equal(r.totalAvailable, 0);
        assert.deepEqual(r.pairs, []);
    });
});

// ---------------------------------------------------------------------------
// getPromptPairs
// ---------------------------------------------------------------------------

describe('getPromptPairs', () => {
    test('fetch by single requestId returns full bodies', () => {
        const r = getPromptPairs(questFolder, QUEST_ID, { requestIds: ['req-A2'] });
        assert.equal(r.pairs.length, 1);
        const p = r.pairs[0];
        assert.equal(p.requestId, 'req-A2');
        assert.match(p.promptBody, /Second Anthropic prompt body/);
        assert.match(p.answerBody, /Second Anthropic answer/);
        assert.deepEqual(r.notFoundRequestIds, []);
    });

    test('fetch by multiple requestIds preserves caller order', () => {
        const r = getPromptPairs(questFolder, QUEST_ID, { requestIds: ['req-L1', 'req-A1', 'req-A2'] });
        assert.deepEqual(r.pairs.map((p) => p.requestId), ['req-L1', 'req-A1', 'req-A2']);
    });

    test('unknown requestId surfaces in notFoundRequestIds', () => {
        const r = getPromptPairs(questFolder, QUEST_ID, { requestIds: ['req-A1', 'no-such'] });
        assert.equal(r.pairs.length, 1);
        assert.deepEqual(r.notFoundRequestIds, ['no-such']);
    });

    test('fetch by index returns the newest', () => {
        const r = getPromptPairs(questFolder, QUEST_ID, { index: 0 });
        assert.equal(r.pairs.length, 1);
        assert.equal(r.pairs[0].requestId, 'req-L2');  // newest overall
    });

    test('fetch by index + count returns a slice', () => {
        const r = getPromptPairs(questFolder, QUEST_ID, { index: 1, count: 3 });
        assert.deepEqual(r.pairs.map((p) => p.requestId), ['req-L1', 'req-A3', 'req-A2']);
    });

    test('subsystem filter applies to both list+index resolution', () => {
        const r = getPromptPairs(questFolder, QUEST_ID, { subsystem: 'anthropic', index: 0 });
        assert.equal(r.pairs[0].requestId, 'req-A3');
    });

    test('answer body empty when there was no paired answer', () => {
        const r = getPromptPairs(questFolder, QUEST_ID, { requestIds: ['req-A3'] });
        assert.equal(r.pairs[0].hasAnswer, false);
        assert.equal(r.pairs[0].answerBody, '');
    });

    test('count gets clamped to 1..50', () => {
        const r = getPromptPairs(questFolder, QUEST_ID, { index: 0, count: 999 });
        // 5 total pairs in fixture; clamp doesn't expand beyond what exists
        assert.equal(r.pairs.length, 5);
    });
});
