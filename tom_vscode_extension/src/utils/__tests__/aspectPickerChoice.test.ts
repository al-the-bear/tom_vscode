/**
 * One choice of the guideline picker written to its level (utils/aspectPickerChoice.ts, gsel5)
 * and the picker's catalogue (utils/aspectChoices.ts aspectCatalogueOf).
 *
 *   PC-1 the catalogue: id, name, label, default and option names in order; no texts
 *   PC-2 a choice is checked first: an unknown level, aspect or choice is refused and nothing is written
 *   PC-3 window / all windows: the section's option, undefined for Don't add; all windows answers where it went
 *   PC-4 run: the run's choices with the section set, removed (Don't add) or `remove`; the run passed on
 *   PC-5 item: a gone item and an item that cannot change are refused; otherwise the item's choices updated
 *   PC-6 todo: a missing todo is refused; otherwise its choices updated with its quest
 *   PC-7 chat (gsel6): an unknown panel is refused; otherwise the panel's sticky choices set, removed or `remove`
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
        chat: { anthropic: { answer: 'full' } } as Record<string, AspectChoices | undefined>,
        chatChoices: (p: string) => w.chat[p],
        setChat: (p: string, c: AspectChoices | undefined) => { w.log.push(['chat', p, c]); w.chat[p] = c; },
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
        assert.match(applyAspectChoice({ level: 'window', section: 'tone', value: 'x' }, w).error ?? '', /no guideline aspect "tone"/);
        assert.match(applyAspectChoice({ level: 'window', section: 'night', value: 'off' }, w).error ?? '', /The aspect Night mode has no choice "off"/);
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

    test('PC-7: chat', () => {
        const w = writers();
        assert.match(applyAspectChoice({ level: 'chat', section: 'answer', value: 'brief' }, w).error ?? '', /Unknown chat panel/);
        assert.match(applyAspectChoice({ level: 'chat', section: 'answer', value: 'brief', panel: 'logs' as never }, w).error ?? '', /Unknown chat panel/);
        assert.deepEqual(applyAspectChoice({ level: 'chat', section: 'night', value: 'on', panel: 'anthropic' }, w), { ok: true });
        assert.deepEqual(applyAspectChoice({ level: 'chat', section: 'answer', value: '', panel: 'anthropic' }, w), { ok: true });
        assert.match(applyAspectChoice({ level: 'chat', section: 'answer', value: 'brief', panel: 'copilot' as never }, w).error ?? '', /Unknown chat panel/, 'the removed Copilot panel');
        assert.deepEqual(applyAspectChoice({ level: 'chat', section: 'answer', value: 'remove', panel: 'anthropic' }, w), { ok: true });
        assert.deepEqual(w.log, [
            ['chat', 'anthropic', { answer: 'full', night: 'on' }],
            ['chat', 'anthropic', { night: 'on' }],
            ['chat', 'anthropic', { night: 'on', answer: 'remove' }],
        ]);
    });

    test('PC-8: the quest default and the workspace level (gsel22)', () => {
        const w = writers();
        let quest: AspectChoices | undefined = { night: 'on' };
        let workspace: AspectChoices | undefined | null = {};
        const full: AspectChoiceWriters = {
            ...w,
            questDefaultChoices: () => quest,
            setQuestDefault: (c) => { quest = c; },
            workspaceChoices: () => workspace,
            setWorkspace: (c) => { workspace = c ?? {}; },
        };
        assert.deepEqual(applyAspectChoice({ level: 'questDefault', section: 'answer', value: ['brief', 'full'] }, full), { ok: true });
        assert.deepEqual(quest, { night: 'on', answer: ['brief', 'full'] }, 'one aspect set, the others kept');
        assert.deepEqual(applyAspectChoice({ level: 'questDefault', section: 'night', value: '' }, full), { ok: true });
        assert.deepEqual(quest, { answer: ['brief', 'full'] }, "Don't add");
        assert.deepEqual(applyAspectChoice({ level: 'workspace', section: 'night', value: 'remove' }, full), { ok: true });
        assert.deepEqual(workspace, { night: 'remove' });
        assert.deepEqual(applyAspectChoice({ level: 'workspace', section: 'answer', value: '+full' }, full), { ok: true });
        assert.deepEqual(workspace, { night: 'remove', answer: ['+full'] }, 'an added choice is stored as a list');
        assert.match(applyAspectChoice({ level: 'workspace', section: 'answer', value: 'nope' }, full).error ?? '', /no choice "nope"/, 'checked first');
        workspace = null;
        assert.match(applyAspectChoice({ level: 'workspace', section: 'answer', value: 'full' }, full).error ?? '', /no Tom workspace folder/);
        assert.match(applyAspectChoice({ level: 'questDefault', section: 'answer', value: 'full' }, w).error ?? '', /cannot be set here/, 'writers without the level');
    });
});
