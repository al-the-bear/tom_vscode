/**
 * The Recent Prompts page (media/recentPromptsPanel) in jsdom, on rows from the real collector.
 *
 *   RPP-1 one collapsed row per item: kind, todos or first line, settings, time, prompt count, answer start; the bar
 *         counts prompts and items; it posts `ready`
 *   RPP-2 expand / collapse: a row shows its iterations and single prompts, an iteration its prompts, a prompt its
 *         text (as sent or as queued) and the start of its answer; a refresh keeps what is expanded
 *   RPP-3 Full text shows prompt and answer in full in the page (and shortens again)
 *   RPP-4 Markdown posts `renderMarkdown` with the prompt and the answer; the host's `markdownHtml` opens the shared overlay
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { collectRecentPrompts, type RecentPromptSourceItem } from '../recentPrompts.js';

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const LONG_ANSWER = `Start of the answer. ${'more '.repeat(100)}THE END`;
const ITEMS: RecentPromptSourceItem[] = [
    {
        id: 'walk', status: 'sent', originalText: 'Work the todo', createdAt: '2026-11-20T09:00:00.000Z', sentAt: '2026-11-20T10:00:00.000Z',
        repeatCount: 'abc*', walkedTodos: ['abc1', 'abc2'], run: 'rel1', session: 'work', template: 'execute-todo',
        repetitionAnswers: [{ key: 'abc1', text: 'one done', at: '2026-11-20T09:30:00.000Z' }, { key: 'abc2', text: LONG_ANSWER, at: '2026-11-20T10:00:00.000Z' }],
        lastDispatched: { kind: 'main', expandedText: 'EXPANDED for abc2', dispatchedAt: '2026-11-20T09:40:00.000Z' },
    },
    { id: 'chat', status: 'chat-sent', chatSource: 'panel', originalText: 'Hello\nmore', expandedText: 'Hello\nmore', createdAt: '2026-11-20T08:00:00.000Z', sentAt: '2026-11-20T08:00:00.000Z', answerText: 'Hi back' },
];

function stateOf(items: RecentPromptSourceItem[]): Record<string, unknown> {
    const { rows, promptCount, truncated } = collectRecentPrompts(items, { todoTitle: (id) => (id === 'abc1' ? 'First todo' : undefined) });
    return { type: 'state', rows, promptCount, truncated, limit: 100 };
}

function setup(t: { after(fn: () => void): void }): { window: Win; doc: Win; posted: Array<Record<string, unknown>> } {
    const html = readMedia('recentPromptsPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window as Win;
    t.after(() => window.close());
    const posted: Array<Record<string, unknown>> = [];
    let saved: unknown;
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push({ ...m }), setState: (s: unknown) => { saved = s; }, getState: () => saved });
    window.__INIT__ = { state: stateOf(ITEMS) };
    window.eval(`${readMedia('shared', 'mdOverlay.js')}\n;\n${readMedia('recentPromptsPanel', 'main.js')}`);
    return { window, doc: window.document, posted };
}

const click = (el: Win): void => { el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true })); };
const head = (doc: Win, key: string): Win => doc.querySelector(`[data-toggle="${key}"]`);
const send = (window: Win, data: unknown): void => { window.dispatchEvent(new window.MessageEvent('message', { data })); };

describe('Recent Prompts page', () => {
    test('RPP-1: collapsed rows, newest first', (t) => {
        const { doc, posted } = setup(t);
        assert.deepEqual(posted[0], { type: 'ready' });
        assert.equal(doc.getElementById('bar').textContent.trim(), '3 prompts in 2 items');
        const rows = [...doc.querySelectorAll('.row')];
        assert.deepEqual(rows.map((r: Win) => r.dataset.row), ['walk', 'chat']);
        const walk = rows[0] as Win;
        assert.equal(walk.querySelector('.kind').textContent, 'walk');
        assert.equal(walk.querySelector('.title').textContent, 'abc*');
        assert.equal(walk.querySelector('.count').textContent, '2 prompts');
        assert.deepEqual([...walk.querySelectorAll('.settings .chip')].map((c: Win) => c.textContent), ['Run: rel1', 'Session: work', 'Template: execute-todo']);
        assert.ok(walk.querySelector('.answer-start').textContent.startsWith('Start of the answer.'));
        assert.ok(walk.querySelector('.answer-start').textContent.length <= 201);
        assert.equal((rows[1] as Win).querySelector('.title').textContent, 'Hello');
        assert.equal((rows[1] as Win).querySelector('.kind').textContent, 'chat');
        assert.equal(doc.querySelector('.children'), null, 'collapsed');
    });

    test('RPP-2: expanding a row, an iteration, a prompt; a refresh keeps it', (t) => {
        const { window, doc } = setup(t);
        click(head(doc, 'walk'));
        assert.deepEqual([...doc.querySelectorAll('[data-row="walk"] .iteration > .head .title')].map((e: Win) => e.textContent), ['Todo abc1 — First todo', 'Todo abc2']);
        assert.equal(doc.querySelector('.prompt'), null, 'the iterations are collapsed');
        click(head(doc, 'walk|1'));
        click(head(doc, 'walk|1|0'));
        const body = doc.querySelector('[data-prompt="walk|1|0"] .body');
        assert.equal(body.querySelector('.label').textContent, 'Prompt as sent');
        assert.equal(body.querySelector('.prompt-text').textContent, 'EXPANDED for abc2');
        assert.ok(body.querySelector('.answer-text').textContent.endsWith('…'), 'the start of the answer');
        // The first iteration's prompt is the text as queued.
        click(head(doc, 'walk|0'));
        click(head(doc, 'walk|0|0'));
        assert.equal(doc.querySelector('[data-prompt="walk|0|0"] .tag').textContent, 'as queued');
        assert.equal(doc.querySelector('[data-prompt="walk|0|0"] .label').textContent, 'Prompt as queued');
        // A refresh (the queue changed) keeps what is expanded.
        send(window, stateOf([...ITEMS, { id: 'new', status: 'sent', originalText: 'Newer', createdAt: '2026-11-20T11:00:00.000Z', sentAt: '2026-11-20T11:00:00.000Z', answerText: 'ok' }]));
        assert.deepEqual([...doc.querySelectorAll('.row')].map((r: Win) => r.dataset.row), ['new', 'walk', 'chat']);
        assert.ok(doc.querySelector('[data-prompt="walk|1|0"] .body'), 'still expanded');
        // Collapsing the row hides everything under it.
        click(head(doc, 'walk'));
        assert.equal(doc.querySelector('[data-row="walk"] .children'), null);
    });

    test('RPP-3: Full text', (t) => {
        const { doc } = setup(t);
        click(head(doc, 'walk'));
        click(head(doc, 'walk|1'));
        click(head(doc, 'walk|1|0'));
        click(doc.querySelector('[data-action="full"][data-key="walk|1|0"]'));
        const body = doc.querySelector('[data-prompt="walk|1|0"] .body');
        assert.equal(body.querySelector('.answer-text').textContent, LONG_ANSWER);
        assert.equal(body.querySelector('[data-action="full"]').textContent, 'Shorten');
        click(body.querySelector('[data-action="full"]'));
        assert.ok(doc.querySelector('[data-prompt="walk|1|0"] .answer-text').textContent.endsWith('…'));
    });

    test('RPP-4: Markdown opens the shared overlay through the host', (t) => {
        const { window, doc, posted } = setup(t);
        click(head(doc, 'chat'));
        click(head(doc, 'chat|0'));
        click(doc.querySelector('[data-action="markdown"][data-key="chat|0"]'));
        const msg = posted[posted.length - 1];
        assert.equal(msg.type, 'renderMarkdown');
        assert.equal(msg.title, 'Chat send (panel)');
        assert.equal(msg.markdown, '## Prompt\n\nHello\nmore\n\n## Answer\n\nHi back');
        send(window, { type: 'markdownHtml', title: 'Chat send (panel)', html: '<p>rendered</p>' });
        const overlay = doc.querySelector('.tom-md-overlay');
        assert.ok(overlay.classList.contains('visible'));
        assert.equal(overlay.querySelector('.tom-md-title').textContent, 'Chat send (panel)');
        assert.equal(overlay.querySelector('.tom-md-body').innerHTML, '<p>rendered</p>');
    });
});
