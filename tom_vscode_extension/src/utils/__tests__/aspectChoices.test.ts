/**
 * One level's guideline choices (gsel4): reading a stored map, checking a given one against the sections, setting one
 * section, cutting the levels at one, replacing levels.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { aspectChoicesRefusal, choicesUpTo, normalizeAspectChoices, overrideLevels, sameAspectChoices, withSectionChoice } from '../aspectChoices';
import type { AspectSection } from '../aspectGuidelines';

const SECTIONS: AspectSection[] = [
    { id: 'language', name: 'Language', label: 'Language', placement: 'system', defaultOption: 'en', options: [{ name: 'de', text: 'DE' }, { name: 'en', text: 'EN' }] },
    { id: 'night', name: 'Night', label: 'Night', placement: 'user', options: [{ name: 'on', text: 'ON' }] },
] as AspectSection[];

describe('aspect choices', () => {
    test('a stored map is read leniently', () => {
        assert.deepEqual(normalizeAspectChoices({ language: 'de', night: 3, 'a/b': 'x', mood: ' padded' }), { language: 'de' });
        assert.equal(normalizeAspectChoices({}), undefined);
        assert.equal(normalizeAspectChoices(['de']), undefined);
        assert.equal(normalizeAspectChoices('de'), undefined);
        assert.equal(normalizeAspectChoices(null), undefined);
    });

    test('a given map is checked against the sections', () => {
        assert.equal(aspectChoicesRefusal({ language: 'de', night: 'remove' }, SECTIONS), undefined);
        assert.equal(aspectChoicesRefusal({}, SECTIONS), undefined);
        assert.equal(aspectChoicesRefusal(null, SECTIONS), undefined);
        assert.match(aspectChoicesRefusal({ mood: 'x' }, SECTIONS)!, /"mood" is no aspect section \(sections: language, night\)/);
        assert.match(aspectChoicesRefusal({ night: 'off' }, SECTIONS)!, /"off" is no option of "night" \(options: on, remove\)/);
        assert.match(aspectChoicesRefusal({ night: 1 }, SECTIONS)!, /must map to an option name/);
        assert.match(aspectChoicesRefusal(['x'], SECTIONS)!, /must be an object/);
        assert.match(aspectChoicesRefusal({ mood: 'x' }, [])!, /none — _ai\/aspect_guidelines\/ has none/);
    });

    test('one section is set or dropped', () => {
        assert.deepEqual(withSectionChoice({ language: 'de' }, 'night', 'on'), { language: 'de', night: 'on' });
        assert.deepEqual(withSectionChoice({ language: 'de', night: 'on' }, 'night', undefined), { language: 'de' });
        assert.equal(withSectionChoice({ night: 'on' }, 'night', ''), undefined);
        assert.deepEqual(withSectionChoice(undefined, 'night', 'remove'), { night: 'remove' });
    });

    test('the levels up to one level', () => {
        const levels = { questDefault: { a: '1' }, window: { b: '2' }, run: { c: '3' }, role: { d: '4' }, todo: { e: '5' } };
        assert.deepEqual(choicesUpTo(levels, 'window'), { questDefault: { a: '1' }, window: { b: '2' } });
        assert.deepEqual(choicesUpTo(levels, 'sectionDefault'), {});
        assert.deepEqual(choicesUpTo(levels, 'todo'), levels);
    });

    test('explicit levels replace live ones; an empty map clears one', () => {
        assert.deepEqual(overrideLevels({ run: { a: '1' }, window: { b: '2' } }, { run: {}, item: { c: '3' } }), { window: { b: '2' }, item: { c: '3' } });
        assert.deepEqual(overrideLevels({ run: { a: '1' } }, undefined), { run: { a: '1' } });
    });

    test('equality ignores order, absent equals empty', () => {
        assert.equal(sameAspectChoices({ a: '1', b: '2' }, { b: '2', a: '1' }), true);
        assert.equal(sameAspectChoices(undefined, {}), true);
        assert.equal(sameAspectChoices({ a: '1' }, { a: '2' }), false);
    });
});
