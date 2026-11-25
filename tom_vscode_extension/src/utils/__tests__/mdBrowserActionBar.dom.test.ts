/**
 * The MD Browser's action bar (media/markdownBrowser/index.html, style.css): one panel on top.
 *
 *   AB-1 a single action bar holds the document picker, every action and the file / search group (no second bar);
 *        the ask bar stays above it
 *   AB-2 it wraps: the bar, its action group and its file / search group wrap their elements onto more lines, so
 *        every element stays visible in a narrow panel
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const media = (f: string): string => readFileSync(join(__dirname, '..', '..', '..', 'media', 'markdownBrowser', f), 'utf-8');

describe('MD Browser: the action bar', () => {
    test('AB-1: one bar with every action, the file and the search', () => {
        const d = new JSDOM(media('index.html')).window.document;
        const bars = d.querySelectorAll('.action-bar');
        assert.equal(bars.length, 1, 'one action bar');
        assert.equal(d.querySelector('.file-info-bar'), null, 'no second bar');
        const bar = bars[0];
        for (const id of ['openInEditorBtn', 'backBtn', 'reloadBtn', 'editModeBtn', 'foldAllBtn', 'indentBtn', 'readKindBtn', 'saveDefaultsBtn',
            'navPrevBtn', 'navKindBtn', 'navNextBtn', 'acceptAllBtn', 'nextUnresolvedBtn',
            'filePath', 'linePos', 'docBackBtn', 'docForwardBtn', 'searchInput', 'searchScope', 'searchPrevBtn', 'searchNextBtn']) {
            assert.ok(bar.querySelector(`#${id}`), `#${id} is in the action bar`);
        }
        assert.ok(bar.querySelector('.picker-area') && bar.querySelector('.nav-area') && bar.querySelector('.file-info'));
        const body = media('index.html');
        assert.ok(body.indexOf('id="askBar"') < body.indexOf('class="action-bar"'), 'the ask bar above it');
    });

    test('AB-2: the bar and its groups wrap', () => {
        const css = media('style.css');
        const rule = (selector: string): string => {
            const at = css.indexOf(`${selector} {`);
            assert.ok(at >= 0, `${selector} has a rule`);
            return css.slice(at, css.indexOf('}', at));
        };
        for (const selector of ['.action-bar', '.action-bar .nav-area', '.action-bar .file-info']) {
            assert.match(rule(selector), /flex-wrap:\s*wrap/, `${selector} wraps`);
        }
        assert.match(rule('.action-bar .picker-area'), /min-width:\s*0/, 'the picker may shrink');
        assert.match(rule('.action-bar .file-info .file-path'), /min-width:\s*0/, 'the file path shrinks with an ellipsis');
    });
});
