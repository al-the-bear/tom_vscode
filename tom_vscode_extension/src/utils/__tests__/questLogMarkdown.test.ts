/**
 * Tests for the markdown renderer behind the @WS Logs section's **MD Trail**
 * tab.
 *
 * The trail files quote user prompts and model answers verbatim, so their
 * markdown is untrusted input: a prompt that happened to contain a `<script>`
 * tag or a `javascript:` link would otherwise become live code, because the
 * rendered HTML is assigned with `innerHTML` into the accordion webview — which
 * deliberately runs without a CSP so its sections can be composed inline.
 *
 * So the renderer's contract is narrower than "render markdown": it renders
 * markdown *and* neutralises embedded HTML and script-bearing URLs, while
 * leaving ordinary formatting intact.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderQuestLogMarkdown } from '../questLogMarkdown.js';

describe('renderQuestLogMarkdown — ordinary markdown', () => {
    test('renders headings, emphasis and lists', () => {
        const html = renderQuestLogMarkdown('# Title\n\n**bold**\n\n- one\n- two\n');
        assert.ok(html.includes('<h1'));
        assert.ok(html.includes('<strong>bold</strong>'));
        assert.ok(html.includes('<li>one</li>'));
    });

    test('renders fenced code blocks', () => {
        const html = renderQuestLogMarkdown('```ts\nconst a = 1;\n```');
        assert.ok(html.includes('<pre>'));
        assert.ok(html.includes('const a = 1;'));
    });

    test('renders tables', () => {
        const html = renderQuestLogMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n');
        assert.ok(html.includes('<table>'));
    });

    test('returns an empty string for empty input', () => {
        assert.equal(renderQuestLogMarkdown(''), '');
    });
});

describe('renderQuestLogMarkdown — embedded HTML is inert', () => {
    test('escapes a block-level raw HTML tag', () => {
        const html = renderQuestLogMarkdown('<script>alert(1)</script>');
        assert.equal(html.includes('<script>'), false);
        assert.ok(html.includes('&lt;script&gt;'));
    });

    test('escapes inline raw HTML', () => {
        const html = renderQuestLogMarkdown('text <img src=x onerror=alert(1)> more');
        assert.equal(html.includes('<img'), false);
        assert.ok(html.includes('&lt;img'));
    });

    test('escapes an iframe smuggled inside a list item', () => {
        const html = renderQuestLogMarkdown('- <iframe src="evil"></iframe>\n');
        assert.equal(html.includes('<iframe'), false);
    });
});

describe('renderQuestLogMarkdown — script-bearing URLs are neutralised', () => {
    test('drops a javascript: link but keeps its text', () => {
        const html = renderQuestLogMarkdown('[click me](javascript:alert(1))');
        assert.equal(/href\s*=/.test(html), false);
        assert.ok(html.includes('click me'));
    });

    test('drops a data: link', () => {
        const html = renderQuestLogMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
        assert.equal(/href\s*=/.test(html), false);
    });

    test('ignores leading whitespace and case when matching the scheme', () => {
        const html = renderQuestLogMarkdown('[x](  JaVaScRiPt:alert(1))');
        assert.equal(/href\s*=/.test(html), false);
    });

    test('keeps ordinary http and relative links', () => {
        const http = renderQuestLogMarkdown('[docs](https://example.com/a)');
        assert.ok(http.includes('href="https://example.com/a"'));
        const rel = renderQuestLogMarkdown('[docs](./doc/a.md)');
        assert.ok(rel.includes('href="./doc/a.md"'));
    });

    test('drops the src of a javascript: image but keeps its alt text', () => {
        const html = renderQuestLogMarkdown('![alt text](javascript:alert(1))');
        assert.equal(/src\s*=/.test(html), false);
        assert.ok(html.includes('alt text'));
    });
});
