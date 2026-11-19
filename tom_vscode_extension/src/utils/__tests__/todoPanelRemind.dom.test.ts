/**
 * The todo panel's reminders (vscimpb152ab; media/questTodoPanel/main.js): the 🔔 Remind rule editor and the
 * one-shot Reminders list in the detail form, and the row's 🔔 mark.
 *
 *   PR-1 the Remind section edits the rule like Repeat, without "by hand"; it shows the count and the next moment;
 *        the form sends `remind` (null for "no reminders"), Repeat still sends `repeat`
 *   PR-2 the Reminders section lists the one-shot reminders (the ones that rang marked), adds one at an instant
 *        (with the local offset) or before the due date, removes one; the form sends the list (null when empty)
 *   PR-3 the row's 🔔 mark carries the reminders in its tooltip; a todo without any has none
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const ROOT = join(__dirname, '..', '..', '..');
const media = (...parts: string[]): string => readFileSync(join(ROOT, 'media', ...parts), 'utf-8');

function todoPanel(t: { after(fn: () => void): void }): Win {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    w.vscode = { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + media('shared', 'mdOverlay.js') + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    return w;
}

const TODO = {
    id: 'rm1', title: 'Chase the invoice', status: 'in-progress', description: 'x', due: '2026-11-25',
    repeat: { rule: 'monthly', day: 1 },
    remind: { rule: 'weekly', weekdays: ['mon', 'thu'], time: '09:00' }, next_remind: '2026-11-23T09:00+01:00', remind_count: 2,
    reminders: [{ before: 'PT1H', time: '17:00' }, { at: '2026-11-20T09:00+01:00', acknowledged: '2026-11-20T08:00:00Z' }],
};

/** The form's values as plain objects (the window's objects are of another realm). */
const collect = (w: Win): Record<string, any> => JSON.parse(JSON.stringify(w.qtCollectFormData()));

function render(w: Win, todo: Record<string, unknown>): Win {
    w.eval(`qtDetailTodo = ${JSON.stringify(todo)};`);
    w.qtRenderDetail(todo);
    return w.document.getElementById('qt-detail-pane');
}

describe('todo panel reminders', () => {
    test('PR-1: the Remind rule editor', (t) => {
        const w = todoPanel(t);
        const pane = render(w, TODO);
        const rule = pane.querySelector('#qt-rm-rule');
        assert.ok(rule, 'the Remind section');
        assert.equal(rule.value, 'weekly');
        const options = Array.from(rule.options as ArrayLike<{ value: string }>).map((o) => o.value);
        assert.deepEqual(options, ['', 'after', 'daily', 'weekly', 'monthly', 'yearly'], 'no "by hand"');
        assert.ok(Array.from(pane.querySelector('#qt-rp-rule').options as ArrayLike<{ value: string }>).some((o) => o.value === 'manual'), 'Repeat keeps it');
        assert.match(pane.querySelector('#qt-rm .qt-rp-info').textContent, /Sent 2 reminders\. Next: 2026-11-23 09:00\+01:00/);
        const checked = Array.from(pane.querySelectorAll('#qt-rm [data-rp-wd]:checked') as ArrayLike<{ dataset: { rpWd: string } }>).map((b) => b.dataset.rpWd);
        assert.deepEqual(checked, ['mon', 'thu'], 'its own weekdays, not Repeat\'s');
        let data = collect(w);
        assert.deepEqual(data.remind, { rule: 'weekly', weekdays: ['mon', 'thu'], time: '09:00' });
        assert.deepEqual(data.repeat, { rule: 'monthly', day: 1 });
        rule.value = 'after';
        rule.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.notEqual(pane.querySelector('#qt-rm-unit').style.display, 'none', 'after shows its unit');
        assert.equal(pane.querySelector('#qt-rp-unit').style.display, 'none', 'Repeat is left as it is');
        pane.querySelector('#qt-rm-every').value = '3';
        data = collect(w);
        assert.deepEqual(data.remind, { rule: 'after', every: 3, unit: 'days', time: '09:00' });
        rule.value = '';
        assert.equal(collect(w).remind, null, '"no reminders" removes it');
    });

    test('PR-2: the Reminders list', (t) => {
        const w = todoPanel(t);
        const pane = render(w, TODO);
        const rows = pane.querySelectorAll('#qt-rmd-list .qt-rmd-row');
        assert.equal(rows.length, 2);
        assert.match(rows[0].textContent, /1 hour before the due date at 17:00/);
        assert.equal(rows[0].querySelector('.qt-rmd-rang'), null);
        assert.match(rows[1].textContent, /at 2026-11-20 09:00\+01:00.*✓ rang/);
        // Add one at an instant: written with the local offset.
        pane.querySelector('#qt-rmd-at').value = '2026-12-01T08:30';
        pane.querySelector('#qt-rmd-add').click();
        let list = collect(w).reminders;
        assert.equal(list.length, 3);
        assert.match(list[2].at, /^2026-12-01T08:30[+-]\d{2}:\d{2}$/);
        // Add one before the due date.
        const kind = pane.querySelector('#qt-rmd-kind');
        kind.value = 'before';
        kind.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.notEqual(pane.querySelector('[data-rmd="before"]').style.display, 'none');
        pane.querySelector('#qt-rmd-n').value = '2';
        pane.querySelector('#qt-rmd-unit').value = 'D';
        pane.querySelector('#qt-rmd-add').click();
        list = collect(w).reminders;
        assert.deepEqual(list[3], { before: 'P2D' });
        assert.deepEqual(list[1], TODO.reminders[1], 'the one that rang keeps its acknowledgement');
        // Remove them all: the list is sent as null.
        for (let i = 0; i < 4; i++) { pane.querySelector('[data-rmd-remove="0"]').click(); }
        assert.equal(pane.querySelectorAll('#qt-rmd-list .qt-rmd-row').length, 0);
        assert.equal(collect(w).reminders, null);
    });

    test('PR-3: the row mark', (t) => {
        const w = todoPanel(t);
        const mark = w.qtRemindMark({ id: 'a', reminders: ['every week on Monday at 09:00 — next 2026-11-23 09:00+01:00', '1 hour before the due date'] });
        assert.match(mark, /🔔/);
        assert.match(mark, /title="Reminders: every week on Monday at 09:00 — next 2026-11-23 09:00\+01:00; 1 hour before the due date"/);
        assert.equal(w.qtRemindMark({ id: 'b' }), '');
    });
});
