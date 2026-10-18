/**
 * The Markdown Browser's per-panel navigation history (src/utils/mdBrowserHistory.ts).
 *
 *   MH-1  push / back / forward walk the entries; a push after going back drops the forward entries
 *   MH-2  the reading position is kept per entry: recorded on the current one, given back on back / forward
 *   MH-3  a position for another file than the current entry is ignored
 *   MH-4  at most `max` entries are kept, the oldest dropped
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { NavigationHistory } from '../mdBrowserHistory.js';

const entry = (filePath: string): { filePath: string; group: string } => ({ filePath, group: 'other' });

describe('NavigationHistory', () => {
    test('MH-1: back and forward', () => {
        const h = new NavigationHistory();
        assert.equal(h.canGoBack, false);
        h.push(entry('/a.md'));
        h.push(entry('/b.md'));
        h.push(entry('/c.md'));
        assert.equal(h.goBack()?.filePath, '/b.md');
        assert.equal(h.goBack()?.filePath, '/a.md');
        assert.equal(h.goBack(), undefined);
        assert.equal(h.goForward()?.filePath, '/b.md');
        h.push(entry('/d.md'));
        assert.equal(h.canGoForward, false, 'c is gone');
        assert.equal(h.goBack()?.filePath, '/b.md');
    });

    test('MH-2: reading positions', () => {
        const h = new NavigationHistory();
        h.push(entry('/a.md'));
        h.recordPosition('/a.md', { line: 120, delta: 14, scrollTop: 3000 });
        h.push(entry('/b.md'));
        assert.equal(h.current?.position, undefined, 'a new entry starts at the top');
        h.recordPosition('/b.md', { line: 7, delta: 0, scrollTop: 90 });
        assert.deepEqual(h.goBack()?.position, { line: 120, delta: 14, scrollTop: 3000 });
        h.recordPosition('/a.md', { line: 130, delta: 2, scrollTop: 3300 });
        assert.deepEqual(h.goForward()?.position, { line: 7, delta: 0, scrollTop: 90 });
        assert.deepEqual(h.goBack()?.position, { line: 130, delta: 2, scrollTop: 3300 }, 'the latest position wins');
    });

    test('MH-3: a position for another file', () => {
        const h = new NavigationHistory();
        h.push(entry('/a.md'));
        h.push(entry('/b.md'));
        h.recordPosition('/a.md', { line: 5, delta: 0, scrollTop: 50 });
        assert.equal(h.current?.position, undefined);
        assert.equal(h.goBack()?.position, undefined, 'a late report for a.md is not stored on b.md, nor on a.md');
    });

    test('MH-4: the cap', () => {
        const h = new NavigationHistory(3);
        ['/1.md', '/2.md', '/3.md', '/4.md'].forEach((f) => h.push(entry(f)));
        assert.equal(h.goBack()?.filePath, '/3.md');
        assert.equal(h.goBack()?.filePath, '/2.md');
        assert.equal(h.canGoBack, false);
    });
});
