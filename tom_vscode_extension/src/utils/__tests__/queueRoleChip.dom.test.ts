/**
 * The role chip of a queue item in the Prompt Queue editor (gsel11; media/shared/queueEntryRenderFunctions.js
 * queueRoleChip, utils/promptRole.ts queueItemRoleView): the role the item runs as and where it comes from.
 *
 *   RC-1 the item's own role: the name, not dimmed, no origin; a staged or pending item opens the role picker
 *   RC-2 its todo's role: the name, `· from its todo`, dimmed; the hover says its own role is passed over and
 *        names the order
 *   RC-3 its run's default (and its process step's): the name and the origin, dimmed; a finished item shows it
 *        without a click
 *   RC-4 no role: a grey person icon on a staged or pending item (click to set), nothing on a finished one; a
 *        walk with no todo in hand says each todo's own wins
 *   RC-5 an entry without the host's view (another page) shows its own role as before
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { queueItemRoleView } from '../promptRole.js';

const EXT = join(__dirname, '..', '..', '..');
const readMedia = (...parts: string[]): string => readFileSync(join(EXT, 'media', ...parts), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[]): { w: Win; posted: Win[]; doc: Win } {
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
    return { w, posted, doc: w.document };
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-21T10:00:00.000Z' };
const item = (id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...base, id, status, originalText: id, expandedText: id, ...extra });
const chipOf = (doc: Win, id: string): Win => {
    const el = doc.querySelector(`.queue-item[data-id="${id}"]`) ?? [...doc.querySelectorAll('.queue-item')].find((e: Win) => e.innerHTML.includes(`'${id}'`));
    return el?.querySelector('.queue-role-chip') ?? null;
};
const ORDER = /The order: the todo's role > the item's role > the process step's > the run's default > the chat variable role\./;

describe('Prompt Queue editor — the role chip', () => {
    test('RC-1: its own role', (t) => {
        const { w, posted, doc } = setup(t, [item('a', 'pending', { role: 'reviewer', roleView: queueItemRoleView({ itemRole: 'reviewer', runDefaultRole: 'planner' }) })]);
        const chip = chipOf(doc, 'a');
        assert.equal(chip.querySelector('.queue-role-name').textContent, 'reviewer');
        assert.equal(chip.querySelector('.queue-role-from'), null, 'no origin for its own');
        assert.equal(chip.getAttribute('data-role-from'), 'item');
        assert.ok(!/opacity/.test(chip.getAttribute('style')), 'not dimmed');
        assert.match(chip.getAttribute('title'), /^Runs as role reviewer — its own role\./);
        assert.match(chip.getAttribute('title'), ORDER);
        assert.match(chip.getAttribute('title'), / — click to change its own role$/);
        w.editItemRole('a');
        assert.deepEqual(posted.filter((m) => m.type === 'editItemRole'), [{ type: 'editItemRole', id: 'a' }]);
        assert.match(chip.getAttribute('onclick'), /editItemRole\('a'\)/);
    });

    test('RC-2: its todo\'s role', (t) => {
        const { doc } = setup(t, [item('a', 'staged', { role: 'reviewer', roleView: queueItemRoleView({ todoRole: 'idea_author', itemRole: 'reviewer' }) })]);
        const chip = chipOf(doc, 'a');
        assert.equal(chip.querySelector('.queue-role-name').textContent, 'idea_author');
        assert.equal(chip.querySelector('.queue-role-from').textContent, '· from its todo');
        assert.equal(chip.getAttribute('data-role-from'), 'todo');
        assert.match(chip.getAttribute('style'), /opacity:0\.7;/, 'dimmed');
        assert.match(chip.getAttribute('title'), /^Runs as role idea_author — from the todo it runs\. Its own role reviewer is passed over\./);
        assert.match(chip.getAttribute('title'), ORDER);
    });

    test('RC-3: its run\'s default and its process step\'s', (t) => {
        const { doc } = setup(t, [
            item('a', 'pending', { roleView: queueItemRoleView({ runDefaultRole: 'planner' }) }),
            item('b', 'sent', { roleView: queueItemRoleView({ stepRole: 'stepper', runDefaultRole: 'planner' }) }),
        ]);
        const a = chipOf(doc, 'a');
        assert.equal(a.textContent, 'planner· run default');
        assert.match(a.getAttribute('style'), /opacity:0\.7;/);
        assert.match(a.getAttribute('title'), /^Runs as role planner — the default role of its run\./);
        assert.match(a.getAttribute('title'), / — click to set its own role$/);
        const b = chipOf(doc, 'b');
        assert.equal(b.textContent, 'stepper· process step');
        assert.equal(b.getAttribute('onclick'), null, 'a finished item: no click');
        assert.match(b.getAttribute('title'), /from the process step it was queued for\./);
    });

    test('RC-4: no role', (t) => {
        const { doc } = setup(t, [
            item('a', 'pending', { roleView: queueItemRoleView({}) }),
            item('b', 'sent', { roleView: queueItemRoleView({}) }),
            item('c', 'staged', { repeatCount: 't*', roleView: queueItemRoleView({ perTodo: true }) }),
        ]);
        const a = chipOf(doc, 'a');
        assert.equal(a.textContent, '', 'only the icon');
        assert.ok(a.querySelector('.codicon-person'));
        assert.match(a.getAttribute('style'), /opacity:0\.45;/);
        assert.match(a.getAttribute('title'), /^No role of its own: it runs as the chat variable role, if any\./);
        assert.equal(chipOf(doc, 'b'), null, 'a finished item without a role shows none');
        assert.match(chipOf(doc, 'c').getAttribute('title'), /A walk: the todo it runs names its own role, which wins over this\./);
    });

    test('RC-5: an entry without the host\'s view', (t) => {
        const { doc } = setup(t, [item('a', 'sent', { role: 'reviewer' }), item('b', 'sent', {})]);
        assert.equal(chipOf(doc, 'a').querySelector('.queue-role-name').textContent, 'reviewer');
        assert.equal(chipOf(doc, 'b'), null);
    });
});
