/**
 * The Prompt Queue editor's scroll area (media/queueEditor/index.html, main.js, media/shared/queueEntryStyles.css).
 *
 *   QS-1 the headline, the shared models and the run tabs stay outside the scroll area; the run's part (its
 *        context bar, defaults, toolbar, add form and list) is inside it
 *   QS-2 the page is a column filling the window that does not scroll itself; the scroll area takes the rest and
 *        scrolls
 *   QS-3 each run tab opens where it was left: switching tabs keeps the scroll position per run
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const MEDIA = join(__dirname, '..', '..', '..', 'media');
const read = (...p: string[]): string => readFileSync(join(MEDIA, ...p), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

describe('Prompt Queue editor — the scroll area under the run tabs', () => {
    test('QS-1: what scrolls', () => {
        const doc = new JSDOM(read('queueEditor', 'index.html')).window.document as Win;
        const scroll = doc.getElementById('queueScroll');
        assert.ok(scroll && scroll.classList.contains('queue-scroll'));
        assert.ok(doc.body.classList.contains('queue-editor-page'));
        for (const id of ['runTabs', 'compactionPickers']) {
            assert.equal(scroll.contains(doc.getElementById(id)), false, `${id} stays in view`);
            assert.equal(doc.getElementById(id).parentElement, doc.body);
        }
        assert.equal(scroll.contains(doc.querySelector('h2')), false);
        for (const id of ['contextSummary', 'runDefaultsSummary', 'copilotDefaultsRow', 'addForm', 'queueList']) {
            assert.ok(scroll.contains(doc.getElementById(id)), `${id} scrolls`);
        }
        assert.ok(scroll.contains(doc.querySelector('.toolbar')), 'the toolbar scrolls');
        assert.equal(doc.getElementById('runTabs').nextElementSibling, scroll, 'directly under the tabs');
    });

    test('QS-2: the layout', () => {
        const css = read('shared', 'queueEntryStyles.css');
        assert.match(css, /body\.queue-editor-page \{ height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; \}/);
        assert.match(css, /body\.queue-editor-page > \.queue-scroll \{ flex: 1 1 auto; min-height: 0; overflow-y: auto;/);
    });

    test('QS-3: the scroll position per run', (t) => {
        const html = read('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        w.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => ({}) });
        w.__INIT__ = {
            state: { items: [], autoSend: false, processRuns: ['default', 'chg1'], currentRun: 'default' },
            queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
            addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
        };
        w.eval([read('shared', 'queueEntryUtils.js'), read('shared', 'queueEntryRenderFunctions.js'), read('shared', 'queueEntryMessageHandlers.js'), read('queueEditor', 'main.js')].join('\n;\n'));
        const scroller = w.document.getElementById('queueScroll');
        scroller.scrollTop = 120;
        w.selectRunTab('chg1');
        assert.equal(scroller.scrollTop, 0, 'a tab not seen yet opens at the top');
        scroller.scrollTop = 40;
        w.selectRunTab('default');
        assert.equal(scroller.scrollTop, 120, 'back where it was left');
        w.selectRunTab('chg1');
        assert.equal(scroller.scrollTop, 40);
    });
});
