/**
 * Tests for the markdown *source* highlighter used by the @WS panel's Logs
 * section. Every log sub-tab except MD Trail shows the raw markdown of a quest
 * file with syntax colouring — not rendered markdown — so this module turns a
 * markdown string into escaped HTML with `<span class="mdh-*">` markers.
 *
 * Two contracts carry the weight:
 *
 *   - **Everything is escaped.** The input is a trail file that quotes user
 *     prompts verbatim, so it routinely contains `<script>`, `&`, and quotes.
 *     The output is assigned via `innerHTML` in a webview with no CSP, so an
 *     unescaped `<` is a code-execution bug, not a rendering glitch.
 *   - **Fenced code blocks are literal.** Inside a fence, `*text*` and `# x`
 *     are code, not emphasis and not a heading — highlighting them would
 *     misrepresent the file the user is reading.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { highlightMarkdownSource } from '../markdownSourceHighlight.js';

/** Strip every `<span …>` / `</span>` so only the escaped text remains. */
function textOf(html: string): string {
    return html.replace(/<\/?span[^>]*>/g, '');
}

describe('highlightMarkdownSource — escaping', () => {
    test('escapes the HTML metacharacters that make innerHTML dangerous', () => {
        const out = highlightMarkdownSource('<script>alert("x" & \'y\')</script>');
        assert.equal(out.includes('<script>'), false);
        assert.ok(out.includes('&lt;script&gt;'));
        assert.ok(out.includes('&amp;'));
        assert.ok(out.includes('&quot;'));
        assert.ok(out.includes('&#39;'));
    });

    test('escapes ampersands exactly once — no double-encoding', () => {
        assert.equal(textOf(highlightMarkdownSource('a &amp; b')), 'a &amp;amp; b');
    });

    test('escapes HTML inside a heading, which is still highlighted', () => {
        const out = highlightMarkdownSource('# <b>title</b>');
        assert.ok(out.includes('mdh-heading'));
        assert.equal(out.includes('<b>'), false);
    });

    test('escapes HTML inside a fenced code block', () => {
        const out = highlightMarkdownSource('```\n<img src=x onerror=1>\n```');
        assert.equal(out.includes('<img'), false);
        assert.ok(out.includes('&lt;img'));
    });

    test('returns an empty string for empty input', () => {
        assert.equal(highlightMarkdownSource(''), '');
    });
});

describe('highlightMarkdownSource — line structure', () => {
    test('preserves the line count so the view lines up with the file', () => {
        const out = highlightMarkdownSource('one\ntwo\nthree');
        assert.equal(out.split('\n').length, 3);
    });

    test('leaves plain text as escaped text with no markers', () => {
        assert.equal(highlightMarkdownSource('just a sentence'), 'just a sentence');
    });

    test('round-trips the original text when the markers are stripped', () => {
        // Nothing is reordered, merged or dropped — the only difference between
        // input and de-marked output is HTML escaping (`>` here).
        const src = '# Title\n\n- item *one*\n\n> quote\n\n| a | b |\n';
        assert.equal(
            textOf(highlightMarkdownSource(src)),
            '# Title\n\n- item *one*\n\n&gt; quote\n\n| a | b |\n',
        );
    });
});

describe('highlightMarkdownSource — block constructs', () => {
    test('marks ATX headings at every level', () => {
        for (const hashes of ['#', '##', '###', '####', '#####', '######']) {
            const out = highlightMarkdownSource(`${hashes} Heading`);
            assert.ok(out.includes('mdh-heading'), `level ${hashes.length} not highlighted`);
        }
    });

    test('does not treat a bare hash without a space as a heading', () => {
        const out = highlightMarkdownSource('#nothashtag');
        assert.equal(out.includes('mdh-heading'), false);
    });

    test('marks blockquotes', () => {
        assert.ok(highlightMarkdownSource('> quoted').includes('mdh-quote'));
    });

    test('marks bullet and ordered list markers', () => {
        assert.ok(highlightMarkdownSource('- item').includes('mdh-list'));
        assert.ok(highlightMarkdownSource('* item').includes('mdh-list'));
        assert.ok(highlightMarkdownSource('1. item').includes('mdh-list'));
    });

    test('marks horizontal rules', () => {
        assert.ok(highlightMarkdownSource('---').includes('mdh-hr'));
    });

    test('marks table rows', () => {
        assert.ok(highlightMarkdownSource('| a | b |').includes('mdh-table'));
    });
});

describe('highlightMarkdownSource — fenced code blocks', () => {
    test('marks the fence lines and the code between them', () => {
        const out = highlightMarkdownSource('```ts\nconst a = 1;\n```');
        assert.ok(out.includes('mdh-fence'));
        assert.ok(out.includes('mdh-code'));
    });

    test('does not highlight markdown constructs inside a fence', () => {
        const out = highlightMarkdownSource('```\n# not a heading\n- not a list\n*not italic*\n```');
        assert.equal(out.includes('mdh-heading'), false);
        assert.equal(out.includes('mdh-list'), false);
        assert.equal(out.includes('mdh-italic'), false);
    });

    test('resumes highlighting after the closing fence', () => {
        const out = highlightMarkdownSource('```\ncode\n```\n# after');
        assert.ok(out.includes('mdh-heading'));
    });

    test('treats an unclosed fence as code to the end of the slice', () => {
        // The viewer shows a tail of a large file, so a fence opened before the
        // slice boundary is common — everything after it stays code rather than
        // flipping back to prose highlighting.
        const out = highlightMarkdownSource('```\n# still code\n- still code');
        assert.equal(out.includes('mdh-heading'), false);
        assert.equal(out.includes('mdh-list'), false);
    });
});

describe('highlightMarkdownSource — inline constructs', () => {
    test('marks inline code spans', () => {
        assert.ok(highlightMarkdownSource('use `foo()` here').includes('mdh-inline-code'));
    });

    test('marks bold and italic emphasis', () => {
        assert.ok(highlightMarkdownSource('**bold**').includes('mdh-bold'));
        assert.ok(highlightMarkdownSource('*italic*').includes('mdh-italic'));
    });

    test('marks links', () => {
        assert.ok(highlightMarkdownSource('see [docs](./a.md)').includes('mdh-link'));
    });

    test('does not highlight emphasis inside an inline code span', () => {
        // `*` is a literal character in code; marking it italic would show the
        // reader emphasis that is not in the file.
        const out = highlightMarkdownSource('`a *b* c`');
        assert.equal(out.includes('mdh-italic'), false);
        assert.ok(out.includes('mdh-inline-code'));
    });
});
