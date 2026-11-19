/**
 * The file names of a review round (src/utils/reviewRound.ts).
 *
 *   RRN-1 documentExtension keeps the format suffix a document's name carries: `.tomspecs.yaml`,
 *         `.tomspecs.md` (a SOM document), `.docspecs.md` (a DocSpecs document); any other file its
 *         last extension
 *   RRN-2 the copies and the default round folder follow it: `alice.docspecs.md`, the member read back
 *         from it, `review-rounds/reading_view-<stamp>` for `reading_view.docspecs.md`
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { copyFileName, defaultRoundFolderName, documentExtension, memberOfFile } from '../reviewRound';

describe('review round names', () => {
    test('RRN-1: documentExtension', () => {
        assert.equal(documentExtension('a/tom_uam.sbp.tomspecs.yaml'), '.tomspecs.yaml');
        assert.equal(documentExtension('a/tom_uam.sbp.tomspecs.md'), '.tomspecs.md');
        assert.equal(documentExtension('a/reading_view.docspecs.md'), '.docspecs.md');
        assert.equal(documentExtension('a/Specification.Webwork.DocSpecs.md'), '.DocSpecs.md');
        assert.equal(documentExtension('a/notes.md'), '.md');
        assert.equal(documentExtension('a/data.yaml'), '.yaml');
    });

    test('RRN-2: copies and round folder of a DocSpecs document', () => {
        const ext = documentExtension('ideas/reading_view/reading_view.docspecs.md');
        assert.equal(copyFileName('alice', ext), 'alice.docspecs.md');
        assert.equal(memberOfFile('alice.docspecs.md', ext), 'alice');
        assert.equal(memberOfFile('base.docspecs.md', ext), null);
        const folder = defaultRoundFolderName('ideas/reading_view/reading_view.docspecs.md', new Date(2026, 10, 19, 9, 5));
        assert.equal(folder, 'reading_view-20261119-0905');
    });
});
