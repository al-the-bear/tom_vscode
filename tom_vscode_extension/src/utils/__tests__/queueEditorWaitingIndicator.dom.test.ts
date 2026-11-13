/**
 * The waiting indicator on queue items (vscimpb81; media/shared/queueEntryRenderFunctions.js waitingForUserBadge).
 *
 *   QI-1 a sending item waiting for the user shows a clickable badge naming what it waits for (a reply, an approval,
 *        a plan decision, an answer in the MD Browser); its click posts `openPendingQuestion` with the item, which the
 *        host turns into tomAi.showUserInteraction (the user-input panel on the item's run tab, or its MD Browser)
 *   QI-2 a running chat item shows the same badge; an ended one does not
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[]): { w: Win; posted: Win[] } {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({}) });
    w.__INIT__ = {
        state: { items, autoSend: false, processRuns: ['default'], currentRun: 'default' },
        queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
        addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
    };
    w.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { w, posted };
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-13T10:00:00.000Z' };

describe('Prompt Queue editor — waiting for the user', () => {
    test('QI-1: the badge on a sending item', (t) => {
        const { w, posted } = setup(t, [
            { ...base, id: 'a', status: 'sending', originalText: 'a', expandedText: 'a', waitingForUser: ['approval'] },
            { ...base, id: 'b', status: 'sending', originalText: 'b', expandedText: 'b', waitingForUser: ['plan'] },
            { ...base, id: 'c', status: 'sending', originalText: 'c', expandedText: 'c', waitingForUser: ['mdBrowser'] },
            { ...base, id: 'd', status: 'sending', originalText: 'd', expandedText: 'd' },
        ]);
        const badges = [...w.document.querySelectorAll('#queueList .waiting-user-badge.clickable')];
        assert.deepEqual(badges.map((b: Win) => b.textContent), ['[⏳ waiting for your approval]', '[⏳ waiting for your decision on a plan]', '[⏳ waiting for your answer in the MD Browser]']);
        assert.match(badges[0].title, /user-input panel \(on this item's run tab\)/);
        assert.match(badges[2].title, /bring its MD Browser to the front/);
        assert.match(badges[0].getAttribute('onclick'), /openPendingQuestion\('a'\)/);
        w.openPendingQuestion('a');
        assert.deepEqual(posted.filter((m) => m.type === 'openPendingQuestion'), [{ type: 'openPendingQuestion', id: 'a' }]);
        const host = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(host, /case 'openPendingQuestion':[\s\S]{0,200}executeCommand\('tomAi\.showUserInteraction', \{ itemId: String\(msg\.id \?\? ''\) \}\)/);
    });

    test('QI-2: chat items', (t) => {
        const { w } = setup(t, [
            { ...base, id: 'c1', status: 'chat', originalText: 'chat', expandedText: 'chat', session: 'chat', waitingForUser: ['question'] },
            { ...base, id: 'c2', status: 'chat-sent', originalText: 'old', expandedText: 'old', session: 'chat', waitingForUser: ['question'] },
        ]);
        const chatItems = [...w.document.querySelectorAll('#queueList .chat-item')];
        assert.equal(chatItems.length, 2);
        assert.equal(chatItems[0].querySelector('.waiting-user-badge.clickable')?.textContent, '[⏳ waiting for your reply]');
        assert.equal(chatItems[1].querySelector('.waiting-user-badge'), null, 'an ended chat send waits for nothing');
    });
});
