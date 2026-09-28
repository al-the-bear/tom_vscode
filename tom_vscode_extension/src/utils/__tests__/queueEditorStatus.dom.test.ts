/**
 * jsdom harness for the Prompt Queue editor's status handling.
 *
 * The queue's `decision-needed` state (a `prefix*` item whose next todo is
 * waiting on the user) has to survive the whole webview pipeline: the panel
 * normalises every incoming item before rendering, ranks the list by status,
 * and reports a "Decision needed" count in the header. A status the
 * normaliser does not recognise is rewritten to `staged`, which silently
 * erases all three — the item looks like an ordinary staged prompt at the
 * bottom of the list and the header gives no hint that the queue is blocked.
 *
 * This loads the real `index.html`, the real shared component scripts and the
 * real `main.js` into jsdom, so a regression in any of the status whitelists
 * fails here rather than in the running extension.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

/** Read one `media/<...>` asset (the source IS the runtime file). */
function readMedia(...parts: string[]): string {
    // out/utils/__tests__ -> project root is three levels up, then media/...
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

interface QueueItemLike { id: string; status: string; originalText?: string; createdAt?: string }

interface QueueEditorProbe {
    normalizeState(): void;
    render(): void;
    getItems(): QueueItemLike[];
    setItems(items: QueueItemLike[]): void;
}

/**
 * Boot the queue editor in jsdom: the document shell with its scripts stripped
 * (jsdom cannot resolve the `{{sharedUri}}` placeholders), then the three
 * shared component scripts and `main.js` in load order.
 *
 * All four are eval'd as ONE script. In the browser they are separate
 * `<script>` elements sharing the global lexical environment, so the shared
 * mixins can see `main.js`'s `let` globals (`currentItems`, `detailsExpanded`,
 * `autoSend`, …). `eval` does not share that environment across calls — one
 * eval per file would put each file's `let`s out of the others' reach. A
 * single concatenated eval reproduces the browser's one shared scope.
 *
 * The probe rides along in the same string for the same reason: the panel's
 * state lives in `let`/`const` bindings, which never become `window`
 * properties.
 */
function setupQueueEditor(t: { after(fn: () => void): void }, items: QueueItemLike[]): {
    window: any;
    probe: QueueEditorProbe;
} {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window as any;
    t.after(() => window.close());

    window.acquireVsCodeApi = () => ({
        postMessage: () => { /* the harness ignores host traffic */ },
        setState: () => { /* noop */ },
        getState: () => undefined,
    });
    window.__INIT__ = { state: { items, autoSend: false } };

    window.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
        'window.__probe = {' +
        '  normalizeState: function() { normalizeState(); },' +
        '  render: function() { render(); },' +
        '  getItems: function() { return currentItems; },' +
        '  setItems: function(v) { currentItems = v; }' +
        '};',
    ].join('\n;\n'));
    assert.equal(window.__queueEditorBooted, true, 'precondition: the panel booted without a render error');
    return { window, probe: window.__probe as QueueEditorProbe };
}

/** Status class of each rendered entry, in display order. */
function renderedStatuses(window: any): string[] {
    return [...window.document.querySelectorAll('#queueList .queue-item')].map((el: any) =>
        [...el.classList].filter((c) => c !== 'queue-item').join(' '),
    );
}

const BLOCKED: QueueItemLike = {
    id: 'blocked-1',
    status: 'decision-needed',
    originalText: 'dec*',
    createdAt: '2026-08-03T09:00:00.000Z',
};
const STAGED: QueueItemLike = {
    id: 'staged-1',
    status: 'staged',
    originalText: 'something else',
    createdAt: '2026-08-03T09:01:00.000Z',
};

describe('Prompt Queue editor — decision-needed status', () => {
    test('normalisation keeps decision-needed instead of downgrading it to staged', (t) => {
        const { probe } = setupQueueEditor(t, [BLOCKED]);

        probe.normalizeState();

        assert.equal(probe.getItems()[0].status, 'decision-needed');
    });

    test('the header reports the blocked count', (t) => {
        const { window, probe } = setupQueueEditor(t, [BLOCKED, STAGED]);

        probe.render();

        const label = window.document.getElementById('countLabel').textContent;
        assert.match(label, /Decision needed: 1/);
    });

    test('a blocked item is rendered first, above the staged backlog', (t) => {
        // statusSortRank puts decision-needed at 0 — but only if the status
        // survived normalisation. A blocked item buried under the backlog is
        // exactly the symptom the user sees when it does not.
        const { window, probe } = setupQueueEditor(t, [STAGED, BLOCKED]);

        probe.render();

        assert.deepEqual(renderedStatuses(window), ['decision-needed', 'staged']);
    });

    test('an unknown status is still coerced to staged', (t) => {
        const { probe } = setupQueueEditor(t, [{ id: 'x', status: 'not-a-status' }]);

        probe.normalizeState();

        assert.equal(probe.getItems()[0].status, 'staged');
    });
});

const INTERRUPTED = {
    id: 'held-1',
    status: 'interrupted',
    originalText: 'rep two of three',
    createdAt: '2026-09-17T09:00:00.000Z',
    lastDispatched: { kind: 'main', expandedText: 'rep two of three', transport: 'anthropic', dispatchedAt: '2026-09-17T09:00:00.000Z' },
} as unknown as QueueItemLike;
const SENDING: QueueItemLike = {
    id: 'live-1',
    status: 'sending',
    originalText: 'in flight',
    createdAt: '2026-09-17T09:00:30.000Z',
};

describe('Prompt Queue editor — interrupted (held for continuation) status', () => {
    test('normalisation keeps interrupted instead of downgrading it to staged', (t) => {
        const { probe } = setupQueueEditor(t, [INTERRUPTED]);

        probe.normalizeState();

        assert.equal(probe.getItems()[0].status, 'interrupted');
    });

    test('the header reports the interrupted count', (t) => {
        const { window, probe } = setupQueueEditor(t, [INTERRUPTED, STAGED]);

        probe.render();

        const label = window.document.getElementById('countLabel').textContent;
        assert.match(label, /Interrupted: 1/);
    });

    test('a held item is rendered above the staged backlog', (t) => {
        const { window, probe } = setupQueueEditor(t, [STAGED, INTERRUPTED]);

        probe.render();

        assert.deepEqual(renderedStatuses(window), ['interrupted', 'staged']);
    });

    test('the row says it will resend, and offers Resend plus back-to-Staged', (t) => {
        const { window, probe } = setupQueueEditor(t, [INTERRUPTED]);

        probe.render();

        const row = window.document.querySelector('#queueList .queue-item.interrupted');
        assert.ok(row, 'row rendered with the interrupted status class');
        assert.match(row.textContent, /INTERRUPTED — RESENDS ON RESUME/);
        assert.ok(row.querySelector('[onclick^="resendLastPrompt("]'), 'Resend control present');
        assert.ok(row.querySelector('[onclick^="setItemStatus("][title*="Staged"]'), 'back-to-Staged control present');
    });

    test('a sending row offers the interrupt-for-continuation control', (t) => {
        const { window, probe } = setupQueueEditor(t, [SENDING]);

        probe.render();

        const row = window.document.querySelector('#queueList .queue-item.sending');
        assert.ok(row?.querySelector('[onclick^="interruptForContinuation("]'), 'per-row interrupt control present');
    });

    test('the toolbar interrupt button is enabled only while something is sending', (t) => {
        const withSending = setupQueueEditor(t, [SENDING]);
        withSending.probe.render();
        assert.equal(withSending.window.document.getElementById('interruptForContinuationBtn').disabled, false);

        const idle = setupQueueEditor(t, [STAGED]);
        idle.probe.render();
        assert.equal(idle.window.document.getElementById('interruptForContinuationBtn').disabled, true);
    });
});
