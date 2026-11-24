/**
 * The MD Browser renders headings with three extensions the raw markdown
 * pipeline (marked.js) does not provide:
 *
 *  1. Any heading level. HTML only has h1–h6, so levels 7 and deeper are carried
 *     on a marker span (`data-level`) that the webview promotes to a per-level
 *     class; the transform therefore caps the markdown hashes at 6 but records
 *     the true level. A readable rendition's styled-div heading
 *     (`<div class="heading<N>" …><!--[ID]--> Title</div>`, N ≥ 7) is read as a
 *     heading of level N (reading_view part *The MD Browser*, 05b_rdv1).
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
    crlfLineMap,
    transformMarkdown,
} from '../markdownHeadings.js';

describe('parseHeadingLine', () => {
    it('parses every level by counting hashes, beyond 10 too', () => {
        for (let level = 1; level <= 14; level++) {
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

    it('returns null for non-heading lines', () => {
        assert.equal(parseHeadingLine('not a heading'), null);
        assert.equal(parseHeadingLine('####nospace'), null);
    });

    it('reads a styled-div heading at level 7 and 14, its title unescaped then escaped', () => {
        const style = ' style="margin:1em 0 0.5em;padding-left:0.75em;font-weight:bold"';
        const h7 = parseHeadingLine(`<div class="heading7"${style}><!--[RQDEP-ITEM-1]--> <a id="RQDEP-ITEM-1"></a> Requirement Dependency 1</div>`);
        assert.deepEqual(h7, { level: 7, id: 'RQDEP-ITEM-1', text: '<a id="RQDEP-ITEM-1"></a> Requirement Dependency 1' }, 'the anchor stays HTML');
        const h14 = parseHeadingLine('<div class="heading14"><!--[X-14]--> A &amp; B &lt;c&gt; *d* [e]</div>');
        assert.deepEqual(h14, { level: 14, id: 'X-14', text: 'A \\& B \\<c\\> \\*d\\* \\[e\\]' }, 'entities unescaped, Markdown punctuation escaped');
        assert.deepEqual(parseHeadingLine('<div class="heading9">No id</div>'), { level: 9, id: '', text: 'No id' });
    });

    it('leaves a heading div with N ≤ 6, a \\<div line and other divs as content', () => {
        assert.equal(parseHeadingLine('<div class="heading6"><!--[X]--> Six</div>'), null);
        assert.equal(parseHeadingLine('\\<div class="heading7"><!--[X]--> Escaped</div>'), null);
        assert.equal(parseHeadingLine('<div class="note">Seven</div>'), null);
        assert.equal(parseHeadingLine('<div class="heading7"><!--[X]--> Not closed'), null, 'the div on one line');
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

describe('transformMarkdown: heading divs', () => {
    it('rewrites a heading div into the capped heading, one line for one line, nested under the headings above', () => {
        const raw = [
            '###### <!--[DAENT-ENTI-GRANT]--> Grant',
            '',
            '<div class="heading7" style="x"><!--[RQDEP-ITEM-1]--> <a id="RQDEP-ITEM-1"></a> Requirement &amp; Dependency</div>',
            'text',
            '<div class="heading14"><!--[DEEP-1]--> Deep</div>',
            '<div class="heading6"><!--[SIX]--> Six</div>',
        ].join('\n');
        const lines = transformMarkdown(raw).split('\n');
        assert.equal(lines.length, 6, 'one line for one line');
        assert.match(lines[2], /^###### <span class="md-heading-id">RQDEP-ITEM-1<\/span> <a id="RQDEP-ITEM-1"><\/a> Requirement \\& Dependency <span class="md-heading-meta" data-level="7" data-fullid="DAENT-ENTI-GRANT\.RQDEP-ITEM-1"><\/span>$/);
        assert.match(lines[4], /data-level="14" data-fullid="DAENT-ENTI-GRANT\.RQDEP-ITEM-1\.DEEP-1"/);
        assert.equal(lines[5], '<div class="heading6"><!--[SIX]--> Six</div>', 'N ≤ 6 stays content');
    });

    it('leaves a heading div inside fenced code alone', () => {
        const raw = '```\n<div class="heading7"><!--[X]--> In code</div>\n```';
        assert.equal(transformMarkdown(raw), raw);
    });
});

describe('crlfLineMap', () => {
    it('is null when the conversion keeps every line (CRLF endings included)', () => {
        assert.equal(crlfLineMap('a\nb\n\nc'), null);
        assert.equal(crlfLineMap('a\r\nb\r\n'), null);
    });

    it('maps every shown line to its file line; lines a conversion split or changed map to -1', () => {
        const raw = ['# T', '', 'plain', 'json: "x\\ny"', 'after', 'cr\rinside', 'end'].join('\n');
        const shown = convertLineBreaks(raw).split('\n');
        const map = crlfLineMap(raw)!;
        assert.equal(map.length, shown.length, 'one entry per shown line');
        assert.deepEqual(map, [0, 1, 2, -1, -1, 4, -1, -1, 6]);
        assert.equal(shown[5], 'after', 'the line after a split one is still its file line');
    });
});
