/**
 * The group prompt editor's page (media/groupPromptEditor/main.js), in a JSDOM running the real script.
 *
 *   GE-1 the list: the global default (marked built-in without a file) and additions; the quest's own
 *        default, additions and prompts; "＋" buttons ask the host to create, the quest's own default only
 *        while it has none
 *   GE-2 editing: a variable is inserted at the cursor, the entry is marked changed, Save sends only the
 *        changed entries, the preview is asked for with the texts as edited
 *   GE-3 Delete asks the host (the global default's button reads "Use built-in"); switching the quest
 *        asks the host
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'groupPromptEditor', file), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0];
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) });
    w.eval(asset('main.js'));
    return { w, posted };
}
const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const entry = (scope: string, kind: string, name: string, text: string, exists = true) => ({ scope, kind, name, text, exists, key: `${scope}:${kind}:${name}` });
const LOAD = {
    type: 'load',
    questId: 'q1',
    quests: ['q1', 'q2'],
    selected: 'global:default:',
    entries: [
        entry('global', 'default', '', 'Built in ${repeatTodoId}', false),
        entry('global', 'addition', 'tests', 'Run the tests.'),
        entry('quest', 'prompt', 'review', 'Review ${repeatTodoId}.'),
    ],
    variables: [{ name: 'repeatTodoId', description: 'the todo' }],
};

describe('group prompt editor', () => {
    test('GE-1: the list', () => {
        const { w, posted } = setup();
        assert.deepEqual(posted[0], { type: 'ready' });
        send(w, LOAD);
        const names = [...w.document.querySelectorAll('.item')].map((li: Win) => li.textContent);
        assert.deepEqual(names, ['Default built-in', 'tests', 'review']);
        const adds = [...w.document.querySelectorAll('button.add')].map((b: Win) => `${b.dataset.scope}:${b.dataset.kind}`);
        assert.deepEqual(adds, ['global:addition', 'quest:default', 'quest:addition', 'quest:prompt']);
        w.document.querySelector('button.add[data-scope="quest"][data-kind="prompt"]').click();
        assert.deepEqual(posted.pop(), { type: 'create', scope: 'quest', kind: 'prompt' });
        send(w, { ...LOAD, entries: [...LOAD.entries, entry('quest', 'default', '', 'Own')] });
        assert.ok(!w.document.querySelector('button.add[data-scope="quest"][data-kind="default"]'), 'one own default at most');
        assert.equal(w.document.getElementById('quest').value, 'q1');
    });

    test('GE-2: editing and saving', async () => {
        const { w, posted } = setup();
        send(w, LOAD);
        const text = w.document.getElementById('text');
        assert.equal(text.value, 'Built in ${repeatTodoId}');
        assert.equal(w.document.getElementById('save').disabled, true);
        w.document.querySelector('.item[data-key="global:addition:tests"]').click();
        text.selectionStart = text.selectionEnd = 4;
        w.document.querySelector('[data-var="repeatTodoId"]').click();
        assert.equal(text.value, 'Run ${repeatTodoId}the tests.');
        assert.match(w.document.querySelector('.item.selected').textContent, /tests ●/);
        assert.equal(w.document.getElementById('save').disabled, false);
        await sleep(260);
        const preview = posted.filter((m) => m.type === 'preview').pop() as Win;
        assert.equal(preview.key, 'global:addition:tests');
        assert.equal(preview.entries.find((x: Win) => x.name === 'tests').text, 'Run ${repeatTodoId}the tests.', 'with the text as edited');
        send(w, { type: 'preview', key: 'global:addition:tests', text: 'Built in X\n\nRun X', note: 'after the built-in default' });
        assert.equal(w.document.getElementById('preview').textContent, 'Built in X\n\nRun X');
        w.document.getElementById('save').click();
        assert.deepEqual(posted.pop(), { type: 'save', entries: [{ scope: 'global', kind: 'addition', name: 'tests', text: 'Run ${repeatTodoId}the tests.' }] });
    });

    test('GE-3: delete and quest', () => {
        const { w, posted } = setup();
        send(w, LOAD);
        assert.equal(w.document.getElementById('delete').disabled, true, 'the built-in default has no file to delete');
        send(w, { ...LOAD, entries: [entry('global', 'default', '', 'Mine'), ...LOAD.entries.slice(1)] });
        assert.equal(w.document.getElementById('delete').textContent, 'Use built-in');
        w.document.querySelector('.item[data-key="quest:prompt:review"]').click();
        assert.equal(w.document.getElementById('delete').textContent, 'Delete');
        w.document.getElementById('delete').click();
        assert.deepEqual(posted.pop(), { type: 'delete', scope: 'quest', kind: 'prompt', name: 'review' });
        const quest = w.document.getElementById('quest');
        quest.value = 'q2';
        quest.dispatchEvent(new w.Event('change'));
        assert.deepEqual(posted.pop(), { type: 'quest', questId: 'q2' });
    });
});
