/**
 * The queue editor's prompt template and its Copilot-only fields (qrun3).
 *
 *   CF-1 the Template dropdowns read "Prompt template" (item, pre-prompt, follow-up, add form), titled as the prompt
 *        template with the Copilot answer wrapper applied separately
 *   CF-2 a Copilot item, pre-prompt or follow-up shows the reminder, its wait and the answer wait; an Anthropic one
 *        does not (an item without its own transport follows the queue default)
 *   CF-3 the toolbar's Answer Timeout and Reminder Template show only when the queue's default transport is Copilot;
 *        the add form's reminder row follows the add form's transport
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const media = (...p: string[]): string => readFileSync(join(ROOT, 'media', ...p), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function queueEditor(items: unknown[], queueDefaultTransport: 'copilot' | 'anthropic'): Win {
    const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
    w.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
    w.__INIT__ = {
        state: { items, autoSend: false, anthropicProfiles: [], queueDefaultTransport, reminderTemplates: [{ id: 'r1', name: 'Nudge' }] },
        queueDefaultPickerHtml: '',
        addFormPickerHtml: '<select id="addForm-transport-t"><option value="copilot">Copilot</option><option value="anthropic">Anthropic</option></select>',
    };
    w.eval([media('shared', 'mdOverlay.js'), media('shared', 'queueEntryUtils.js'), media('shared', 'queueEntryRenderFunctions.js'), media('shared', 'queueEntryMessageHandlers.js'), media('queueEditor', 'main.js')].join('\n;\n'));
    return w;
}
// Staged: the editable rows (templates, reminders, waits) show on a staged item.
const base = { type: 'normal', template: '(None)', createdAt: new Date().toISOString(), expandedText: '', status: 'staged' };
const el = (w: Win, text: string): Win => [...w.document.querySelectorAll('.queue-item')].find((e: Win) => e.textContent.includes(text));
const shown = (node: Win): boolean => node && node.style.display !== 'none';

describe('queue editor: prompt template and the Copilot-only fields', () => {
    test('CF-1: Prompt template', () => {
        const w = queueEditor([{ ...base, id: 'a', transport: 'copilot', originalText: 'p-copilot', prePrompts: [{ text: 'pre' }], followUps: [{ id: 'f1', originalText: 'fu' }] }], 'copilot');
        try {
            const item = el(w, 'p-copilot');
            const labels = [...item.querySelectorAll('label, span')].map((n: Win) => n.textContent).filter((t: string) => /template:/i.test(t));
            assert.ok(labels.length >= 3, 'item, pre-prompt and follow-up');
            for (const t of labels) { assert.equal(t, 'Prompt template:'); }
            assert.match(item.querySelector('[title*="Copilot answer wrapper is applied separately"]').title, /prompt template/i);
            const addLabel = w.document.querySelector('#addForm label');
            assert.ok([...w.document.querySelectorAll('#addForm label')].some((l: Win) => l.textContent === 'Prompt template:'), 'the add form too');
            assert.ok(addLabel);
        } finally { w.close(); }
    });

    test('CF-2: the fields follow the stage\'s transport', () => {
        const w = queueEditor([
            { ...base, id: 'c', transport: 'copilot', originalText: 'p-copilot', prePrompts: [{ text: 'pre' }], followUps: [{ id: 'f1', originalText: 'fu' }] },
            { ...base, id: 'n', transport: 'anthropic', originalText: 'p-anthropic', prePrompts: [{ text: 'pre' }], followUps: [{ id: 'f2', originalText: 'fu' }] },
            { ...base, id: 'd', originalText: 'p-default', prePrompts: [{ text: 'pre', transport: 'copilot' }] },
        ], 'anthropic');
        try {
            const copilot = el(w, 'p-copilot');
            assert.ok(copilot.querySelectorAll('.copilot-only').length >= 10, 'reminder, wait and answer wait on the item, pre-prompt and follow-up');
            assert.match(copilot.textContent, /Answer Wait/);
            const anthropic = el(w, 'p-anthropic');
            assert.equal(anthropic.querySelectorAll('.copilot-only').length, 0, 'none for Anthropic');
            assert.doesNotMatch(anthropic.textContent, /Answer Wait|Reminder:/);
            assert.match(anthropic.textContent, /Repeats/, 'the repeats stay');
            const byDefault = el(w, 'p-default');
            assert.doesNotMatch(byDefault.querySelector('.template-row').textContent, /Reminder:/, 'the item follows the queue default (Anthropic)');
            assert.ok(byDefault.querySelector('.preprompt-block .copilot-only'), 'its Copilot pre-prompt has them');
        } finally { w.close(); }
    });

    test('CF-3: the toolbar and the add form', () => {
        const anthropic = queueEditor([], 'anthropic');
        const copilot = queueEditor([], 'copilot');
        try {
            assert.equal(shown(anthropic.document.getElementById('copilotQueueSettings')), false, 'Anthropic default: no answer timeout / reminder template');
            assert.equal(shown(copilot.document.getElementById('copilotQueueSettings')), true);
            const pick = anthropic.document.getElementById('addForm-transport-t');
            pick.value = 'anthropic';
            pick.dispatchEvent(new anthropic.Event('change', { bubbles: true }));
            assert.equal(shown(anthropic.document.getElementById('addReminderRow')), false);
            pick.value = 'copilot';
            pick.dispatchEvent(new anthropic.Event('change', { bubbles: true }));
            assert.equal(shown(anthropic.document.getElementById('addReminderRow')), true, 'a Copilot item being added has its reminder');
        } finally { anthropic.close(); copilot.close(); }
    });
});
