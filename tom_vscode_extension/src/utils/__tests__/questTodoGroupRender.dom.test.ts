/**
 * jsdom harness for the Quest TODO list's prefix-group rendering.
 *
 * The companion `questTodoPrefixGroups.test.ts` pins the pure grouping *rule*.
 * This one pins what the user actually sees: that the list pane renders one
 * separator row per prefix carrying the group's todo count, that every group
 * starts collapsed on a fresh script load (the "collapsed after a window reload
 * / VS Code restart" requirement — the webview script is re-evaluated on both,
 * so a fresh load IS that state), that clicking a separator toggles just that
 * group, and that "Collapse all" closes them again.
 *
 * It loads the real `fragment.html`, `grouping.js` and `main.js` — the files
 * the panel ships — into a jsdom window with a stub `vscode` handle, so a
 * rendering regression fails here rather than in the running extension.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

interface TodoLike { id: string; title?: string; status?: string; sourceFile?: string }

/** Read one `media/questTodoPanel/<file>` asset (the source IS the runtime file). */
function readPanelAsset(file: string): string {
    // out/utils/__tests__ -> project root is three levels up, then media/...
    return readFileSync(
        join(__dirname, '..', '..', '..', 'media', 'questTodoPanel', file),
        'utf-8',
    );
}

/**
 * Build a jsdom panel from the real fragment, load the real scripts, and hand
 * back the window. `qtViewConfig` mirrors what `getQuestTodoScript()` prepends.
 */
function setupPanel(todos: TodoLike[]): any {
    const dom = new JSDOM(
        `<!DOCTYPE html><body>${readPanelAsset('fragment.html')}</body>`,
        { runScripts: 'outside-only' },
    );
    const window = dom.window as any;
    window.vscode = { postMessage: () => { /* the harness ignores host traffic */ } };
    window.eval('var qtViewConfig = {};');
    window.eval(readPanelAsset('grouping.js'));
    window.eval(readPanelAsset('main.js'));
    window.qtTodos = todos;
    window.eval('qtRenderList()');
    return window;
}

/** The rendered separator rows, in document order. */
function groupHeaders(window: any): any[] {
    return [...window.document.querySelectorAll('#qt-list-pane .qt-group-header')];
}

/**
 * `"<label> <count>"` per separator row, in document order. Label and count
 * are read from their own spans rather than from `textContent`, so the
 * assertion pins the two pieces of information and not the markup's
 * whitespace (the gap between them is CSS, not a text node).
 */
function headerTexts(window: any): string[] {
    return groupHeaders(window).map(
        (h) => `${h.querySelector('.qt-group-label').textContent} ${h.querySelector('.qt-group-count').textContent}`,
    );
}

/** Ids of the todo rows currently visible in the list pane. */
function visibleTodoIds(window: any): string[] {
    return [...window.document.querySelectorAll('#qt-list-pane .qt-todo-item')]
        .map((el: any) => el.getAttribute('data-qt-id'));
}

/** Click the separator row whose label matches. */
function clickHeader(window: any, label: string): void {
    const hdr = groupHeaders(window)
        .find((h) => h.querySelector('.qt-group-label').textContent === label);
    assert.ok(hdr, `no group separator labelled "${label}"`);
    hdr.click();
}

const SAMPLE: TodoLike[] = [
    { id: 'qr1-alpha', title: 'Alpha', status: 'not-started' },
    { id: 'vex2-beta', title: 'Beta', status: 'not-started' },
    { id: 'qr3-gamma', title: 'Gamma', status: 'not-started' },
    { id: 'cleanup', title: 'Delta', status: 'not-started' },
];

describe('Quest TODO list — prefix group rendering', () => {
    test('renders one separator per prefix, with the group size in brackets', () => {
        const window = setupPanel(SAMPLE);

        assert.deepEqual(headerTexts(window), ['qr (2)', 'vex (1)', 'Unprefixed (1)']);
    });

    test('every group starts collapsed, so a fresh load shows no todo rows', () => {
        const window = setupPanel(SAMPLE);

        assert.deepEqual(visibleTodoIds(window), []);
        assert.equal(groupHeaders(window).length, 3, 'the separators themselves stay visible');
        for (const hdr of groupHeaders(window)) {
            assert.ok(hdr.classList.contains('collapsed'), 'separator must carry the collapsed marker');
        }
    });

    test('clicking a separator reveals exactly that group', () => {
        const window = setupPanel(SAMPLE);

        clickHeader(window, 'qr');

        assert.deepEqual(visibleTodoIds(window), ['qr1-alpha', 'qr3-gamma']);
        const [qr, vex] = groupHeaders(window);
        assert.equal(qr.classList.contains('collapsed'), false);
        assert.equal(vex.classList.contains('collapsed'), true);
    });

    test('clicking an open separator closes it again', () => {
        const window = setupPanel(SAMPLE);

        clickHeader(window, 'qr');
        clickHeader(window, 'qr');

        assert.deepEqual(visibleTodoIds(window), []);
    });

    test('the Unprefixed group is togglable like any other', () => {
        const window = setupPanel(SAMPLE);

        clickHeader(window, 'Unprefixed');

        assert.deepEqual(visibleTodoIds(window), ['cleanup']);
    });

    test('Collapse all closes every open group', () => {
        const window = setupPanel(SAMPLE);
        clickHeader(window, 'qr');
        clickHeader(window, 'vex');
        assert.equal(visibleTodoIds(window).length, 3, 'precondition: two groups open');

        window.document.getElementById('qt-btn-collapse-all').click();

        assert.deepEqual(visibleTodoIds(window), []);
        assert.equal(groupHeaders(window).length, 3);
    });

    test('shift-click ranges never reach into a collapsed group', () => {
        // qtLastRenderOrder drives shift-click stack ranges. Feeding it hidden
        // rows would let one shift-click stack todos the user cannot see.
        const window = setupPanel(SAMPLE);

        clickHeader(window, 'qr');

        // Array.from: arrays built inside the jsdom realm carry that realm's
        // Array.prototype, which deepStrictEqual treats as a mismatch.
        assert.deepEqual(Array.from(window.qtLastRenderOrder), ['qr1-alpha', 'qr3-gamma']);
    });

    test('expansion survives a data reload within the session', () => {
        // Re-rendering after the backend pushes fresh todos must not slam the
        // groups shut under the user — only a script reload resets them.
        const window = setupPanel(SAMPLE);
        clickHeader(window, 'qr');

        window.qtTodos = SAMPLE.slice();
        window.eval('qtRenderList()');

        assert.deepEqual(visibleTodoIds(window), ['qr1-alpha', 'qr3-gamma']);
    });

    test('revealing a todo opens its group', () => {
        const window = setupPanel(SAMPLE);

        window.eval("qtExpandGroupForTodo('vex2-beta'); qtRenderList()");

        assert.deepEqual(visibleTodoIds(window), ['vex2-beta']);
    });
});
