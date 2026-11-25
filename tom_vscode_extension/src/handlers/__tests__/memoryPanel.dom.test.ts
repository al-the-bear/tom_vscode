/**
 * The Memory panel's page (media/memoryPanel) on the quest's memory folder, `_ai/quests/<quest>/memory/`.
 *
 *   MP-1 the list: the curated files first, then — under their own heading — the candidates files, each marked as
 *        candidates with its host (this host's and another host's); the folder is named in the header
 *   MP-2 a click reads the file by its name, a curated one and a candidates one alike; Save posts the edited text
 *   MP-3 there is no session choice: no session button, no `pickSession` message
 *   MP-4 without a quest the list says so; a quest without files shows "(no files)"
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { memoryPanelRows } from '../../services/questMemoryFiles.js';

const ROOT = join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf-8');

interface Posted { type: string; [key: string]: unknown }

function page(t: { after(fn: () => void): void }): { window: JSDOM['window']; posted: Posted[]; send(msg: Record<string, unknown>): void } {
    const html = read('media', 'memoryPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window;
    t.after(() => window.close());
    const posted: Posted[] = [];
    Object.assign(window, {
        acquireVsCodeApi: () => ({ postMessage: (m: Posted) => posted.push({ ...m }), setState: () => undefined, getState: () => undefined }),
        confirm: () => true,
    });
    window.eval(read('media', 'memoryPanel', 'main.js'));
    return {
        window,
        posted,
        send: (msg) => { window.dispatchEvent(new window.MessageEvent('message', { data: msg })); },
    };
}

const FILES = memoryPanelRows([
    { file: 'candidates.bomber.md', bytes: 70 },
    { file: 'facts.md', bytes: 50 },
    { file: 'candidates.mbp.local.md', bytes: 90 },
    { file: 'decisions.md', bytes: 30 },
], 'mbp.local');

describe('memory panel page', () => {
    test('MP-1: curated files first, candidates files marked with their host', (t) => {
        const { window, posted, send } = page(t);
        assert.deepEqual(posted, [{ type: 'ready' }]);
        send({ type: 'snapshot', quest: 'tom_uam', folder: '_ai/quests/tom_uam/memory', questFiles: FILES });
        const doc = window.document;
        assert.equal(doc.getElementById('quest-tab')!.textContent, 'Quest: tom_uam');
        assert.equal(doc.getElementById('memory-folder')!.textContent, '_ai/quests/tom_uam/memory');

        const list = doc.getElementById('file-list')!;
        const shown = Array.from(list.children).map((el) => el.className.includes('file-group')
            ? `# ${el.textContent}`
            : `${(el as HTMLElement).dataset.kind}: ${el.querySelector('span')!.textContent}`);
        assert.deepEqual(shown, [
            'curated: decisions.md',
            'curated: facts.md',
            '# Candidates (automatic extraction)',
            'candidates: candidates.bomber.md',
            'candidates: candidates.mbp.local.md',
        ]);
        const item = (file: string): HTMLElement => list.querySelector(`.file-item[data-file="${file}"]`) as HTMLElement;
        assert.equal(item('facts.md').querySelector('.kind'), null, 'a curated file carries no mark');
        assert.equal(item('facts.md').querySelector('.bytes')!.textContent, '50b');
        assert.equal(item('candidates.mbp.local.md').querySelector('.kind')!.textContent, 'candidates · this host');
        assert.equal(item('candidates.bomber.md').querySelector('.kind')!.textContent, 'candidates · host bomber');
        assert.match(item('candidates.bomber.md').title, /Candidates of host bomber/);
        assert.match(item('candidates.mbp.local.md').title, /memory extraction on this host/);
        assert.ok(item('candidates.bomber.md').classList.contains('candidates'));
        assert.equal(item('facts.md').classList.contains('candidates'), false);
    });

    test('MP-2: reading and saving a file by its name', (t) => {
        const { window, posted, send } = page(t);
        send({ type: 'snapshot', quest: 'q', folder: '_ai/quests/q/memory', questFiles: FILES });
        const doc = window.document;
        const click = (file: string): void => { (doc.querySelector(`.file-item[data-file="${file}"]`) as HTMLElement).click(); };

        click('candidates.mbp.local.md');
        assert.deepEqual(posted.at(-1), { type: 'readFile', scope: 'quest', file: 'candidates.mbp.local.md' });
        send({ type: 'fileContent', scope: 'quest', file: 'candidates.mbp.local.md', content: '- a candidate\n' });
        const content = doc.getElementById('content') as HTMLTextAreaElement;
        assert.equal(content.value, '- a candidate\n');

        click('facts.md');
        assert.deepEqual(posted.at(-1), { type: 'readFile', scope: 'quest', file: 'facts.md' });
        send({ type: 'fileContent', scope: 'quest', file: 'facts.md', content: 'a fact\n' });
        content.value = 'a fact\na promoted candidate\n';
        content.dispatchEvent(new window.Event('input'));
        (doc.getElementById('btn-save') as HTMLButtonElement).click();
        assert.deepEqual(posted.at(-1), { type: 'saveFile', scope: 'quest', file: 'facts.md', content: 'a fact\na promoted candidate\n' });
    });

    test('MP-3: no session choice', (t) => {
        const { window, posted, send } = page(t);
        send({ type: 'snapshot', quest: 'q', folder: '_ai/quests/q/memory', questFiles: FILES });
        assert.equal(window.document.getElementById('btn-session'), null);
        assert.equal(window.document.querySelectorAll('button').length, 4, 'New file, Save, Delete file, Open in editor');
        assert.equal(posted.some((m) => m.type === 'pickSession'), false);
        assert.doesNotMatch(read('media', 'memoryPanel', 'main.js'), /pickSession|per session/);
        assert.doesNotMatch(read('media', 'memoryPanel', 'index.html'), /per session/);
    });

    test('MP-4: no quest, no files', (t) => {
        const { window, send } = page(t);
        send({ type: 'snapshot', quest: '', folder: '', questFiles: [] });
        const list = window.document.getElementById('file-list')!;
        assert.equal(list.textContent, 'No active quest. Set one in the Chat Variables Editor.');
        assert.equal(window.document.getElementById('memory-folder')!.textContent, '');
        send({ type: 'snapshot', quest: 'q', folder: '_ai/quests/q/memory', questFiles: [] });
        assert.equal(list.textContent, '(no files)');
    });
});
