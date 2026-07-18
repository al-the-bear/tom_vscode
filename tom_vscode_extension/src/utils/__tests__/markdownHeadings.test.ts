/**
 * The MD Browser renders headings with three extensions the raw markdown
 * pipeline (marked.js) does not provide:
 *
 *  1. Up to 10 heading levels. HTML only has h1–h6, so levels 7–10 are carried
 *     on a marker span (`data-level`) that the webview promotes to a per-level
 *     class; the transform therefore caps the markdown hashes at 6 but records
 *     the true level.
 *  2. A per-heading ID declared in a leading HTML comment
 *     (`###### <!--[FR-3]--> Title`). The id is always shown as a badge and is
 *     also chained with its ancestors' ids into a dotted "full id".
 *  3. An optional CR/LF pass that turns literal / escaped line-break characters
 *     into real newlines so escaped blobs (e.g. JSON-embedded text) read as
 *     multi-line.
 *
 * These pure helpers own that logic so the webview stays DOM-glue only and the
 * behaviour can be unit-tested without the VS Code host.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseHeadingLine,
    convertLineBreaks,
    transformMarkdown,
} from '../markdownHeadings.js';

describe('parseHeadingLine', () => {
    it('parses all levels 1..10 by counting hashes', () => {
        for (let level = 1; level <= 10; level++) {
            const line = '#'.repeat(level) + ' Title';
            const h = parseHeadingLine(line);
            assert.ok(h, `level ${level} should parse`);
            assert.equal(h!.level, level);
            assert.equal(h!.text, 'Title');
            assert.equal(h!.id, '');
        }
    });

    it('extracts a leading id comment and keeps the remaining text', () => {
        const h = parseHeadingLine('###### <!--[FRE-REQU-3]--> Functional Requirement 3');
        assert.ok(h);
        assert.equal(h!.level, 6);
        assert.equal(h!.id, 'FRE-REQU-3');
        assert.equal(h!.text, 'Functional Requirement 3');
    });

    it('tolerates spaces inside the id comment', () => {
        const h = parseHeadingLine('## <!-- [FR-1] --> Title');
        assert.ok(h);
        assert.equal(h!.id, 'FR-1');
        assert.equal(h!.text, 'Title');
    });

    it('strips an ATX closing hash sequence', () => {
        const h = parseHeadingLine('## Title ##');
        assert.ok(h);
        assert.equal(h!.text, 'Title');
    });

    it('allows up to three leading spaces', () => {
        const h = parseHeadingLine('   ### Indented');
        assert.ok(h);
        assert.equal(h!.level, 3);
        assert.equal(h!.text, 'Indented');
    });

    it('returns null for non-heading lines and >10 hashes', () => {
        assert.equal(parseHeadingLine('not a heading'), null);
        assert.equal(parseHeadingLine('#'.repeat(11) + ' too many'), null);
        assert.equal(parseHeadingLine('####nospace'), null);
    });

    it('parses an empty heading (hashes only)', () => {
        const h = parseHeadingLine('###');
        assert.ok(h);
        assert.equal(h!.level, 3);
        assert.equal(h!.text, '');
        assert.equal(h!.id, '');
    });
});

describe('convertLineBreaks', () => {
    it('turns escaped \\n / \\r\\n / \\r sequences into real newlines', () => {
        assert.equal(convertLineBreaks('a\\nb'), 'a\nb');
        assert.equal(convertLineBreaks('a\\r\\nb'), 'a\nb');
        assert.equal(convertLineBreaks('a\\rb'), 'a\nb');
    });

    it('normalises actual CR / CRLF characters to newlines', () => {
        assert.equal(convertLineBreaks('a\r\nb'), 'a\nb');
        assert.equal(convertLineBreaks('a\rb'), 'a\nb');
    });

    it('leaves plain text untouched', () => {
        assert.equal(convertLineBreaks('a\nb'), 'a\nb');
        assert.equal(convertLineBreaks('nothing to do'), 'nothing to do');
    });
});

describe('transformMarkdown', () => {
    it('caps markdown hashes at 6 but records the real level on the marker', () => {
        const out = transformMarkdown('######## Deep');
        assert.match(out, /^###### /); // 6 hashes emitted for a level-8 heading
        assert.match(out, /data-level="8"/);
    });

    it('emits the id badge and preserves inline markdown in the text', () => {
        const out = transformMarkdown('## <!--[FR-1]--> Some **bold** title');
        assert.match(out, /<span class="md-heading-id">FR-1<\/span>/);
        assert.match(out, /Some \*\*bold\*\* title/); // still markdown for marked to render
    });

    it('chains ancestor ids into a dotted full id (all intermediate levels)', () => {
        const src = [
            '# <!--[SBP]--> System',
            '## <!--[FR]--> Functional',
            '### <!--[FR-REQU-LST]--> Requirements',
            '#### <!--[FR-REQU-3]--> Requirement 3',
        ].join('\n');
        const out = transformMarkdown(src);
        assert.match(out, /data-fullid="SBP\.FR\.FR-REQU-LST\.FR-REQU-3"/);
        // the shallowest heading's full id is just its own id
        assert.match(out, /data-fullid="SBP"/);
    });

    it('skips idless intermediate levels in the full id but keeps the hierarchy', () => {
        const src = [
            '# <!--[A]--> A',
            '## No id here',
            '### <!--[C]--> C',
        ].join('\n');
        const out = transformMarkdown(src);
        // C is nested under an idless h2, so its full id is A.C
        assert.match(out, /data-fullid="A\.C"[^]*data-level="3"|data-level="3"[^]*data-fullid="A\.C"/);
    });

    it('re-uses the stack so siblings do not inherit each other', () => {
        const src = [
            '# <!--[A]--> A',
            '## <!--[B1]--> B1',
            '## <!--[B2]--> B2',
        ].join('\n');
        const out = transformMarkdown(src);
        assert.match(out, /data-fullid="A\.B1"/);
        assert.match(out, /data-fullid="A\.B2"/);
        assert.doesNotMatch(out, /data-fullid="A\.B1\.B2"/);
    });

    it('does not treat hashes inside fenced code blocks as headings', () => {
        const src = [
            '```',
            '# not a heading',
            '```',
            '# <!--[X]--> Real',
        ].join('\n');
        const out = transformMarkdown(src);
        assert.match(out, /# not a heading/); // untouched inside the fence
        assert.doesNotMatch(out, /data-fullid="X"[^]*not a heading/);
        assert.match(out, /data-fullid="X"/);
    });

    it('applies the CR/LF conversion when requested', () => {
        const out = transformMarkdown('line one\\nline two', { convertLineBreaks: true });
        assert.match(out, /line one\nline two/);
    });

    it('leaves escaped newlines intact when CR/LF conversion is off', () => {
        const out = transformMarkdown('line one\\nline two');
        assert.match(out, /line one\\nline two/);
    });

    it('html-escapes ids in the badge and attributes', () => {
        const out = transformMarkdown('# <!--[A&<B]--> Title');
        assert.match(out, /A&amp;&lt;B/);
    });
});
