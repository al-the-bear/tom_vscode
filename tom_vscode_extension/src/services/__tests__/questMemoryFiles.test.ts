/**
 * The files of a quest's memory folder (src/services/questMemoryFiles.ts): pure logic.
 *
 *   MF-1 the folder is `memory/` in the quest folder; a candidates file is `candidates.<host>.md` (the host made
 *        safe for a file name), every other file is curated; curated files sort before candidates files
 *   MF-2 the candidate entry's text: the format / parse pair round-trips (a session name holding `@`, a file name
 *        holding a space, `}` or `%`, no session); a line without the prefix is the fact alone, meant for `facts.md`
 *   MF-3 the injected block: curated files in the order given, then the candidates under their own heading; a file
 *        past the budget is left out and the next tried; of the candidates the newest entries that fit; nothing to
 *        inject is the empty text
 *   MF-4 the Memory panel's rows: curated first, the candidates files marked with their host and whether it is
 *        this host's
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import {
    DEFAULT_MEMORY_FILE,
    buildMemoryBlock,
    candidateTargetFile,
    candidatesFileName,
    candidatesHeading,
    candidatesHostOf,
    compareMemoryFiles,
    formatCandidateText,
    memoryFileKind,
    memoryPanelRows,
    parseCandidateText,
    questMemoryFolder,
    safeHostForFile,
    type MemoryFileBody,
} from '../questMemoryFiles.js';

const file = (name: string, body: string, mtime = 0): MemoryFileBody => ({ file: name, body, bytes: Buffer.byteLength(body), mtime });

describe('quest memory files', () => {
    test('MF-1: the folder and the file kinds', () => {
        assert.equal(questMemoryFolder(path.join('ws', '_ai', 'quests'), 'tom_uam'), path.join('ws', '_ai', 'quests', 'tom_uam', 'memory'));
        assert.equal(DEFAULT_MEMORY_FILE, 'facts.md');
        assert.equal(candidatesFileName('mbp.local'), 'candidates.mbp.local.md');
        assert.equal(candidatesFileName('Big Beast/01'), 'candidates.Big_Beast_01.md');
        assert.equal(safeHostForFile(''), 'unknown');
        assert.equal(safeHostForFile('..hidden'), 'hidden');
        assert.equal(candidatesHostOf('candidates.mbp.local.md'), 'mbp.local');
        assert.equal(candidatesHostOf('facts.md'), undefined);
        assert.equal(candidatesHostOf('candidates.md'), undefined, 'no host, no candidates file');
        assert.equal(candidatesHostOf('topics/candidates.mbp.md'), undefined, 'only directly in the folder');
        assert.deepEqual(['facts.md', 'facts-gemma4.md', 'decisions.md', 'candidates.txt', 'candidates.mbp.md'].map(memoryFileKind),
            ['curated', 'curated', 'curated', 'curated', 'candidates']);
        assert.deepEqual(['candidates.b.md', 'zeta.md', 'candidates.a.md', 'facts.md'].sort(compareMemoryFiles),
            ['facts.md', 'zeta.md', 'candidates.a.md', 'candidates.b.md']);
    });

    test('MF-2: the candidate text format', () => {
        const text = formatCandidateText({ session: 'default@default', targetFile: 'facts.md', text: '  The build runs on mbp.  ' });
        assert.equal(text, '{session=default@default file=facts.md} The build runs on mbp.');
        assert.deepEqual(parseCandidateText(text), { session: 'default@default', targetFile: 'facts.md', text: 'The build runs on mbp.' });

        // A run's session (`<session>@<run>`), a file name with a space, `}` and `%`: read back as written.
        for (const c of [
            { session: 'walk@aifmt-3', targetFile: 'facts-gemma4.md', text: 'a {braced} fact with file=x} inside' },
            { session: 'tmp-261027-120000-a1', targetFile: 'my notes}100%.md', text: 'x' },
            { session: 'odd name', targetFile: 'topics/build.md', text: 'nested target' },
        ]) {
            const formatted = formatCandidateText(c);
            assert.equal(formatted.split('\n').length, 1, 'one line');
            assert.deepEqual(parseCandidateText(formatted), c, formatted);
            assert.equal(candidateTargetFile(formatted), c.targetFile);
        }

        // No session (the extraction ran in none): the prefix names the file only.
        const sessionless = formatCandidateText({ targetFile: 'facts.md', text: 'no session' });
        assert.equal(sessionless, '{session= file=facts.md} no session');
        assert.deepEqual(parseCandidateText(sessionless), { targetFile: 'facts.md', text: 'no session' });
        // No target file named: the default file.
        assert.equal(formatCandidateText({ session: 'chat', text: 'x' }), '{session=chat file=facts.md} x');

        // A legacy line without the prefix: the fact alone, meant for the default file.
        assert.deepEqual(parseCandidateText('User prefers terse commits.'), { text: 'User prefers terse commits.' });
        assert.deepEqual(parseCandidateText('{not a prefix} text'), { text: '{not a prefix} text' });
        assert.equal(candidateTargetFile('User prefers terse commits.'), 'facts.md');
    });

    test('MF-3: the injected block', () => {
        const curated = [file('decisions.md', 'newest curated\n', 30), file('facts.md', 'older curated\n', 20)];
        const candidates = { file: 'candidates.mbp.md', lines: ['- 2026-06-02T00:00:00Z [mbp] {session=chat file=facts.md} newer', '- 2026-06-01T00:00:00Z [mbp] {session=chat file=facts.md} older'], bytes: 120, mtime: 40 };

        const all = buildMemoryBlock({ curated, candidates, charBudget: 10_000 });
        assert.equal(all.text, [
            '## Memory',
            '',
            '### quest/decisions.md',
            'newest curated',
            '',
            '### quest/facts.md',
            'older curated',
            '',
            candidatesHeading('candidates.mbp.md'),
            candidates.lines[0],
            candidates.lines[1],
            '',
        ].join('\n'));
        assert.match(candidatesHeading('candidates.mbp.md'), /^### candidates\/candidates\.mbp\.md — extracted automatically on this host, not curated/);
        assert.deepEqual(all.included.map((e) => [e.kind, e.file]),
            [['curated', 'decisions.md'], ['curated', 'facts.md'], ['candidates', 'candidates.mbp.md']]);

        // The budget: a file that does not fit is left out, the next one tried.
        const first = '### quest/decisions.md\nnewest curated\n';
        const big = buildMemoryBlock({ curated: [file('big.md', 'x'.repeat(500)), ...curated], charBudget: first.length });
        assert.deepEqual(big.included.map((e) => e.file), ['decisions.md']);
        assert.equal(big.text, `## Memory\n\n${first}`);

        // Of the candidates the newest entries that fit.
        const head = candidatesHeading('candidates.mbp.md');
        const oneCandidate = buildMemoryBlock({ curated: [], candidates, charBudget: head.length + 1 + candidates.lines[0].length + 1 });
        assert.equal(oneCandidate.text, `## Memory\n\n${head}\n${candidates.lines[0]}\n`);
        assert.deepEqual(oneCandidate.included.map((e) => e.kind), ['candidates']);
        const noRoom = buildMemoryBlock({ curated: [], candidates, charBudget: head.length });
        assert.deepEqual([noRoom.text, noRoom.included], ['', []], 'a heading without an entry is not injected');

        // Nothing to inject: empty files, no candidates.
        assert.deepEqual(buildMemoryBlock({ curated: [file('facts.md', '  \n')], candidates: { ...candidates, lines: [] }, charBudget: 1000 }), { text: '', included: [] });
        assert.deepEqual(buildMemoryBlock({ curated, candidates, charBudget: 0 }), { text: '', included: [] });
    });

    test('MF-4: the Memory panel\'s rows', () => {
        const rows = memoryPanelRows([
            { file: 'candidates.bomber.md', bytes: 7 },
            { file: 'zeta.md', bytes: 3 },
            { file: 'candidates.mbp.local.md', bytes: 9 },
            { file: 'facts.md', bytes: 5 },
        ], 'mbp.local');
        assert.deepEqual(rows, [
            { file: 'facts.md', bytes: 5, kind: 'curated' },
            { file: 'zeta.md', bytes: 3, kind: 'curated' },
            { file: 'candidates.bomber.md', bytes: 7, kind: 'candidates', host: 'bomber', ownHost: false },
            { file: 'candidates.mbp.local.md', bytes: 9, kind: 'candidates', host: 'mbp.local', ownHost: true },
        ]);
        assert.deepEqual(memoryPanelRows([], 'mbp.local'), []);
    });
});
