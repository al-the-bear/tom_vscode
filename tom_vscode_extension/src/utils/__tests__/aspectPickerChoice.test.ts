/**
 * One choice of the guideline picker written to its level (utils/aspectPickerChoice.ts, gsel5)
 * and the picker's catalogue (utils/aspectChoices.ts aspectCatalogueOf).
 *
 *   PC-1 the catalogue: id, name, label, default and option names in order; no texts
 *   PC-2 a choice is checked first: an unknown level, section or option is refused and nothing is written
 *   PC-3 window / all windows: the section's option, undefined for Don't add; all windows answers where it went
 *   PC-4 run: the run's choices with the section set, removed (Don't add) or `remove`; the run passed on
 *   PC-5 item: a gone item and an item that cannot change are refused; otherwise the item's choices updated
 *   PC-6 todo: a missing todo is refused; otherwise its choices updated with its quest
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { aspectCatalogueOf, type AspectChoices } from '../aspectChoices.js';
import type { AspectSection } from '../aspectGuidelines.js';
import { applyAspectChoice, aspectValueRefusal, type AspectChoiceWriters } from '../aspectPickerChoice.js';

const SECTIONS: AspectSection[] = [
    { id: 'answer', name: 'Answer mode', label: 'Answer', placement: 'system', defaultOption: 'brief', options: [{ name: 'brief', text: 'B' }, { name: 'full', text: 'F' }] },
    { id: 'night', name: 'Night mode', label: 'Night', placement: 'user', options: [{ name: 'on', text: 'N' }] },
];

function writers(): AspectChoiceWriters & { log: unknown[]; run: AspectChoices | undefined; item: AspectChoices | undefined | null; todo: AspectChoices | undefined | null; itemOk: boolean } {
    const w = {
        log: [] as unknown[],
        run: { night: 'on' } as AspectChoices | undefined,
        item: undefined as AspectChoices | undefined | null,
        todo: { answer: 'full' } as AspectChoices | undefined | null,
        itemOk: true,
        sections: () => SECTIONS,
        setWindow: (s: string, o: string | undefined) => { w.log.push(['window', s, o]); },
        setAllWindows: (s: string, o: string | undefined) => { w.log.push(['all', s, o]); return ['w2', 'w3']; },
        runChoices: (run: string | undefined) => { w.log.push(['runChoices', run]); return w.run; },
        setRun: (c: AspectChoices | undefined, run: string | undefined) => { w.log.push(['run', c, run]); },
        itemChoices: () => w.item,
        setItem: (id: string, c: AspectChoices | undefined) => { w.log.push(['item', id, c]); return w.itemOk; },
        todoChoices: () => w.todo,
        setTodo: (q: string | undefined, id: string, c: AspectChoices | undefined) => { w.log.push(['todo', q, id, c]); return true; },
    };
    return w;
}

describe('guideline picker: a choice and the catalogue', () => {
    test('PC-1: the catalogue', () => {
        assert.deepEqual(aspectCatalogueOf(SECTIONS), {
            sections: [
                { id: 'answer', name: 'Answer mode', label: 'Answer', defaultOption: 'brief', options: ['brief', 'full'] },
                { id: 'night', name: 'Night mode', label: 'Night', options: ['on'] },
            ],
        });
    });

    test('PC-2: checked first', () => {
        const w = writers();
        assert.match(applyAspectChoice({ level: 'nope' as never, section: 'answer', value: 'full' }, w).error ?? '', /Unknown level/);
        assert.match(applyAspectChoice({ level: 'window', section: 'tone', value: 'x' }, w).error ?? '', /no guideline section "tone"/);
        assert.match(applyAspectChoice({ level: 'window', section: 'night', value: 'off' }, w).error ?? '', /Night mode has no option "off"/);
        assert.deepEqual(w.log, []);
        assert.equal(aspectValueRefusal(SECTIONS, 'night', 'remove'), undefined);
        assert.equal(aspectValueRefusal(SECTIONS, 'night', ''), undefined);
    });

    test('PC-3: window and all windows', () => {
        const w = writers();
        assert.deepEqual(applyAspectChoice({ level: 'window', section: 'answer', value: 'full' }, w), { ok: true });
        assert.deepEqual(applyAspectChoice({ level: 'window', section: 'answer', value: '' }, w), { ok: true });
        assert.deepEqual(applyAspectChoice({ level: 'allWindows', section: 'night', value: 'remove' }, w), { ok: true, sentTo: ['w2', 'w3'] });
        assert.deepEqual(w.log, [['window', 'answer', 'full'], ['window', 'answer', undefined], ['all', 'night', 'remove']]);
    });

    test('PC-4: run', () => {
        const w = writers();
        applyAspectChoice({ level: 'run', section: 'answer', value: 'full', run: 'r1' }, w);
        applyAspectChoice({ level: 'run', section: 'night', value: '' }, w);
        applyAspectChoice({ level: 'run', section: 'night', value: 'remove', run: 'r1' }, w);
        assert.deepEqual(w.log.filter((e) => (e as unknown[])[0] === 'run'), [
            ['run', { night: 'on', answer: 'full' }, 'r1'],
            ['run', undefined, undefined],
            ['run', { night: 'remove' }, 'r1'],
        ]);
    });

    test('PC-5: item', () => {
        const w = writers();
        w.item = null;
        assert.match(applyAspectChoice({ level: 'item', section: 'answer', value: 'full', itemId: 'i1' }, w).error ?? '', /item is gone/);
        assert.match(applyAspectChoice({ level: 'item', section: 'answer', value: 'full' }, w).error ?? '', /item is gone/);
        w.item = undefined;
        assert.deepEqual(applyAspectChoice({ level: 'item', section: 'answer', value: 'full', itemId: 'i1' }, w), { ok: true });
        w.itemOk = false;
        assert.match(applyAspectChoice({ level: 'item', section: 'answer', value: 'full', itemId: 'i1' }, w).error ?? '', /staged or pending/);
        assert.deepEqual(w.log[0], ['item', 'i1', { answer: 'full' }]);
    });

    test('PC-6: todo', () => {
        const w = writers();
        assert.deepEqual(applyAspectChoice({ level: 'todo', section: 'answer', value: '', questId: 'q', todoId: 't1' }, w), { ok: true });
        assert.deepEqual(w.log, [['todo', 'q', 't1', undefined]]);
        w.todo = null;
        assert.match(applyAspectChoice({ level: 'todo', section: 'answer', value: 'brief', todoId: 't9' }, w).error ?? '', /todo t9 was not found/);
    });
});
