/**
 * Aspect guidelines (gsel2): the store, the resolution over the levels, the text and where it goes
 * (utils/aspectGuidelines.ts, services/aspectGuidelinesStore.ts, src/config/aspect-guideline.schema.json).
 *
 *   AG-1 the store: a section folder with aspect.yaml and its <option>.md files; the options in `options` order,
 *        then the others by name; label and placement defaults; what is refused (no name, a bad placement, an
 *        option named `remove`, a listed option without its file, a default that is no option)
 *   AG-2 precedence: section default < quest default < window < run < role type < role < item < todo, per section
 *   AG-3 Remove vs Don't add: an absent entry inherits; `remove` sends nothing, whatever is above (the default too)
 *   AG-4 defaults: a section's default applies when no level chooses; none and no choice: nothing; an entry naming
 *        no option of the section (or no section) is skipped, the level above decides
 *   AG-5 the text: system and user parts under the heading, a `### <section>: <option>` per section, in the
 *        sections' order; placement on the transports
 *   AG-6 recursive placeholders: an option's `${file-…}` whose file names another `${file-…}` (and `${guidelines-…}`)
 *   AG-7 the schema accepts the store's aspect.yaml and refuses what the reader refuses (`options`, the key
 *        before format version 10, among them); `order` is a number
 *   AG-8 the send order: aspects with an `order` first, lowest first, then the others by id; an order that is
 *        no number is a problem
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aspect-guidelines-')));
installVscodeStub({ workspaceFolders: [base] });

import {
    ASPECT_HEADING,
    ASPECT_LEVELS,
    assembleAspects,
    buildAspectSection,
    placeAspects,
    resolveAspects,
    sortAspectSections,
    type AspectLevelChoices,
    type AspectSection,
} from '../aspectGuidelines.js';
import { aspectsForSend, readAspectSections } from '../../services/aspectGuidelinesStore.js';
import { resolveVariables, unescapePlaceholders } from '../variableResolver.js';

after(() => fs.rmSync(base, { recursive: true, force: true }));

function put(rel: string, text: string): string {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
}

const section = (id: string, opts: Partial<AspectSection> = {}): AspectSection => ({
    id, name: id, label: id, placement: 'system', options: [{ name: 'a', text: `${id} a` }, { name: 'b', text: `${id} b` }], ...opts,
});

/** The fields of a resolution these tests check (gsel20 added the choice set and the conditions). */
const core = (r: { section: string; option?: string; removed: boolean; from?: string }): Record<string, unknown> => ({
    section: r.section, ...(r.option !== undefined ? { option: r.option } : {}), removed: r.removed, ...(r.from ? { from: r.from } : {}),
});

describe('aspect guidelines', () => {
    test('AG-1: the store', () => {
        const store = path.join(base, 'store1');
        put('store1/answer_mode/aspect.yaml', 'name: Answer mode\nlabel: Answer\nplacement: user\ndefault: trail only\nchoices: [trail only, answer tool, missing]\n');
        put('store1/answer_mode/answer tool.md', 'Use the answer tool.\n');
        put('store1/answer_mode/trail only.md', 'Answer in the trail only.\n');
        put('store1/answer_mode/extra.md', 'Extra.\n');
        put('store1/answer_mode/remove.md', 'Never an option.\n');
        put('store1/night/aspect.yaml', 'name: Night\n');
        put('store1/night/on.md', 'Night mode.\n');
        put('store1/broken/aspect.yaml', 'name: Broken\nplacement: sideways\n');
        put('store1/nameless/aspect.yaml', 'label: X\n');
        put('store1/no_yaml/on.md', 'x\n');
        put('store1/bad_default/aspect.yaml', 'name: Bad default\ndefault: nope\n');
        put('store1/bad_default/yes.md', 'y\n');
        const { sections, problems } = readAspectSections(store);
        assert.deepEqual(sections.map((s) => s.id), ['answer_mode', 'bad_default', 'night']);
        const am = sections[0];
        assert.equal(am.name, 'Answer mode');
        assert.equal(am.label, 'Answer');
        assert.equal(am.placement, 'user');
        assert.equal(am.defaultOption, 'trail only');
        assert.deepEqual(am.options.map((o) => o.name), ['trail only', 'answer tool', 'extra'], 'listed order first, then the others by name');
        assert.equal(am.options[1].text, 'Use the answer tool.\n');
        const night = sections[2];
        assert.equal(night.label, 'Night', 'label defaults to the name');
        assert.equal(night.placement, 'system', 'placement defaults to system');
        assert.equal(night.defaultOption, undefined);
        assert.equal(sections[1].defaultOption, undefined, 'a default that is no option is dropped');
        for (const expected of [
            /answer_mode: a choice may not be named "remove"/,
            /answer_mode: choice "missing" has no missing\.md/,
            /broken: placement must be system or user/,
            /nameless: aspect\.yaml has no name/,
            /no_yaml: no aspect\.yaml/,
            /bad_default: default "nope" is no choice/,
        ]) {
            assert.ok(problems.some((p) => expected.test(p)), `${expected}: ${problems.join(' | ')}`);
        }
        assert.deepEqual(readAspectSections(path.join(base, 'absent')), { sections: [], problems: [] }, 'no store: nothing');
        assert.deepEqual(buildAspectSection('a/b', { name: 'x' }, {}).section, undefined, 'a folder name that is no name');
    });

    test('AG-2: precedence over the eight levels', () => {
        assert.deepEqual([...ASPECT_LEVELS], ['sectionDefault', 'workspace', 'questDefault', 'window', 'run', 'roleType', 'role', 'item', 'todo']);
        const sections = [section('s', { defaultOption: 'a', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => ({ name: n, text: n })) })];
        const lower: Array<[keyof AspectLevelChoices, string]> = [
            ['questDefault', 'b'], ['window', 'c'], ['run', 'd'], ['roleType', 'e'], ['role', 'f'], ['item', 'g'], ['todo', 'h'],
        ];
        // Adding each lower level in turn: it wins.
        const choices: AspectLevelChoices = {};
        assert.deepEqual(core(resolveAspects(sections, choices).sections[0]), { section: 's', option: 'a', removed: false, from: 'sectionDefault' });
        for (const [level, option] of lower) {
            choices[level] = { s: option };
            assert.deepEqual(core(resolveAspects(sections, choices).sections[0]), { section: 's', option, removed: false, from: level }, level);
        }
        // Per section: one section's choice does not touch another's.
        const two = [section('x'), section('y')];
        const r = resolveAspects(two, { window: { x: 'a', y: 'a' }, todo: { y: 'b' } }).sections;
        assert.deepEqual(r.map((e) => [e.section, e.option, e.from]), [['x', 'a', 'window'], ['y', 'b', 'todo']]);
    });

    test('AG-3: Remove vs Don\'t add', () => {
        const sections = [section('s', { defaultOption: 'a' })];
        // Don't add on the item (no entry): the run's choice is inherited.
        assert.deepEqual(core(resolveAspects(sections, { run: { s: 'b' }, item: {} }).sections[0]), { section: 's', option: 'b', removed: false, from: 'run' });
        // Remove on the item: nothing, though the run and the default chose.
        assert.deepEqual(core(resolveAspects(sections, { run: { s: 'b' }, item: { s: 'remove' } }).sections[0]), { section: 's', removed: true, from: 'item' });
        // Remove on the window suppresses the default; a lower option sends again.
        assert.deepEqual(core(resolveAspects(sections, { window: { s: 'remove' } }).sections[0]), { section: 's', removed: true, from: 'window' });
        assert.deepEqual(core(resolveAspects(sections, { window: { s: 'remove' }, todo: { s: 'b' } }).sections[0]), { section: 's', option: 'b', removed: false, from: 'todo' });
        const assembled = assembleAspects(sections, resolveAspects(sections, { item: { s: 'remove' } }));
        assert.deepEqual(assembled, { system: '', user: '', sections: [] }, 'a removed section sends nothing');
    });

    test('AG-4: defaults and entries that name no option', () => {
        const sections = [section('with', { defaultOption: 'b' }), section('without')];
        const r = resolveAspects(sections, { role: { with: 'zzz', ghost: 'a' } });
        assert.deepEqual(r.sections.map(core), [
            { section: 'with', option: 'b', removed: false, from: 'sectionDefault' },
            { section: 'without', removed: false },
        ]);
        assert.deepEqual(r.ignored, [{ level: 'role', section: 'ghost', option: 'a' }, { level: 'role', section: 'with', option: 'zzz' }]);
        const skipped = core(resolveAspects(sections, { run: { with: 'a' }, todo: { with: 'nope' } }).sections[0]);
        assert.deepEqual(skipped, { section: 'with', option: 'a', removed: false, from: 'run' }, 'the level above the skipped entry decides');
    });

    test('AG-5: the text and its placement', () => {
        const sections = [
            section('first', { name: 'First', defaultOption: 'a', options: [{ name: 'a', text: 'System text one.\n' }] }),
            section('second', { name: 'Second', placement: 'user', defaultOption: 'a', options: [{ name: 'a', text: 'User text.' }] }),
            section('third', { name: 'Third', defaultOption: 'a', options: [{ name: 'a', text: 'System text two.' }] }),
            section('empty', { name: 'Empty', defaultOption: 'a', options: [{ name: 'a', text: '  \n' }] }),
        ];
        const assembled = assembleAspects(sections, resolveAspects(sections));
        assert.equal(assembled.system, `${ASPECT_HEADING}\n\n### First: a\n\nSystem text one.\n\n### Third: a\n\nSystem text two.`);
        assert.equal(assembled.user, `${ASPECT_HEADING}\n\n### Second: a\n\nUser text.`);
        assert.deepEqual(assembled.sections.map((s) => [s.section, s.placement, s.from]), [
            ['first', 'system', 'sectionDefault'], ['second', 'user', 'sectionDefault'], ['third', 'system', 'sectionDefault'],
        ], 'an option whose text is empty is left out');
        const prompt = { systemSegments: ['Base.'], userContent: 'Do it.' };
        for (const transport of ['direct', 'agentSdk', 'vscodeLm', 'localLlm'] as const) {
            assert.deepEqual(placeAspects(transport, prompt, assembled), {
                systemSegments: ['Base.', assembled.system],
                userContent: `${assembled.user}\n\n---\n\nDo it.`,
            }, transport);
        }
        assert.deepEqual(placeAspects('direct', prompt, { system: '', user: '' }), { systemSegments: ['Base.'], userContent: 'Do it.' }, 'nothing to add');
        assert.deepEqual(placeAspects('direct', prompt, { system: 'S', user: '' }), { systemSegments: ['Base.', 'S'], userContent: 'Do it.' }, 'a system part alone leaves the user content as it is');
    });

    test('AG-6: placeholders resolve recursively', () => {
        const inner = put('docs/inner.md', 'Inner text.');
        const outer = put('docs/outer.md', `Outer before. \${file-${inner}} Outer after.`);
        put('_agent_guidelines/aspect_rule.md', '# The guideline\n');
        put('store6/deep/aspect.yaml', 'name: Deep\ndefault: chained\n');
        put('store6/deep/chained.md', `Start. \${file-${outer}}\n\n\${guidelines-aspect_rule}`);
        const resolve = (t: string) => unescapePlaceholders(resolveVariables(t));
        const result = aspectsForSend(path.join(base, 'store6'), 'direct', { systemSegments: [], userContent: 'Go.' }, undefined, resolve);
        assert.equal(result.assembled.sections.length, 1);
        assert.match(result.systemSegments[0], /Start\. Outer before\. Inner text\. Outer after\./, 'a file read through a file');
        assert.match(result.systemSegments[0], /# The guideline/, 'a guideline by name');
        assert.doesNotMatch(result.systemSegments[0], /\$\{/);
        assert.equal(result.userContent, 'Go.');
    });

    test('AG-7: the schema', () => {
        const schemaPath = path.join(__dirname, '..', '..', '..', 'src', 'config', 'aspect-guideline.schema.json');
        const validate = new Ajv2020({ strict: false }).compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
        for (const ok of [
            { name: 'Answer mode' },
            { name: 'Answer mode', label: 'Answer', placement: 'user', default: 'trail only', choices: ['trail only', 'answer tool'] },
            { name: 'Index', order: 2 },
        ]) {
            assert.ok(validate(ok), `${JSON.stringify(ok)}: ${JSON.stringify(validate.errors)}`);
        }
        for (const bad of [
            {},
            { name: '' },
            { name: 'X', placement: 'sideways' },
            { name: 'X', default: 'remove' },
            { name: 'X', choices: ['remove'] },
            { name: 'X', choices: ['a/b'] },
            { name: 'X', choices: [' a'] },
            { name: 'X', choices: ['a', 'a'] },
            { name: 'X', other: 1 },
            { name: 'X', options: ['a'] },
            { name: 'X', order: 'first' },
        ]) {
            assert.equal(validate(bad), false, JSON.stringify(bad));
        }
    });

    test('AG-8: the send order', () => {
        const store = path.join(base, 'store8');
        put('store8/a_last/aspect.yaml', 'name: A\ndefault: x\n');
        put('store8/a_last/x.md', 'TEXT A\n');
        put('store8/z_first/aspect.yaml', 'name: Z\ndefault: x\norder: 1\n');
        put('store8/z_first/x.md', 'TEXT Z\n');
        put('store8/m_second/aspect.yaml', 'name: M\ndefault: x\norder: 2\n');
        put('store8/m_second/x.md', 'TEXT M\n');
        put('store8/bad/aspect.yaml', 'name: Bad\norder: soon\n');
        const read = readAspectSections(store);
        assert.deepEqual(read.sections.map((x) => x.id), ['z_first', 'm_second', 'a_last', 'bad'], 'by order, then those without one by id');
        assert.ok(read.problems.includes('bad: order must be a number'), JSON.stringify(read.problems));
        const text = aspectsForSend(store, 'direct', { systemSegments: [], userContent: 'x' }, {}, (t) => t).systemSegments.join('\n');
        assert.ok(text.indexOf('TEXT Z') < text.indexOf('TEXT M') && text.indexOf('TEXT M') < text.indexOf('TEXT A'), text);
        assert.deepEqual(sortAspectSections([{ id: 'b' }, { id: 'a', order: 3 }, { id: 'c', order: -1 }]).map((x) => x.id), ['c', 'a', 'b']);
    });
});
