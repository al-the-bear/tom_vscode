/**
 * Several choices per aspect and conditional choices (gsel20; guideline_sectioning.md D-21, D-25, D-28):
 * utils/aspectGuidelines.ts, services/aspectGuidelinesStore.ts, services/aspectPromptFacts.ts, the rename
 * carry-over, the read tool, the Aspect Guidelines editor and the picker.
 *
 *   SC-1 the values: a choice, `+choice`, a list (replace), a `+` list (add), `remove`; a mixed list and a `+`
 *        or `remove` name refused; a single value written before still reads; the stores' normalizer keeps lists
 *   SC-2 replace and add across every level: each level's list replaces, its `+` list adds, remove clears,
 *        add after remove starts afresh; the set in the aspect's choice order, each with its level; an
 *        entry of unknown choices skipped whole, a partly unknown one keeps the known ones
 *   SC-3 `when:` per prompt fact (transport, kind, todo, role, roleType, run, process, quest, workspace, night) and
 *        per level: a chosen choice is sent exactly when its condition holds, nothing steps in for it; a choice
 *        not chosen is never sent; several choices each checked; the variables beside the facts
 *   SC-4 `remove_when:` removes the aspect exactly when it holds, whatever level chose; an invalid `when` or
 *        `remove_when` never breaks a send: logged, the choice not sent, nothing removed; the definition
 *        reports the position
 *   SC-5 a send end to end from aspect.yaml (`{name, when}`, `remove_when`), `prompt.night` from the night-mode aspect
 *   SC-6 the editor: Condition and Remove when read and written (`{name, when}`), an invalid one refused with its
 *        position, checked as typed; the checkboxes write and take out their terms, the role types as `a || b`;
 *        `order` written and read back
 *   SC-7 the rename carry-over of lists and `+` entries (in memory and in YAML); the tools' `guidelines` checks
 *        lists; the read tool answers several choices and the conditions; the picker's hover names them
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseDocument } from 'yaml';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    ASPECT_LEVELS, buildAspectSection, combineAspectEntries, formatAspectValue, parseAspectValue, resolveAspects,
    type AspectLevelChoices, type AspectSection,
} from '../../utils/aspectGuidelines';
import { aspectChoicesRefusal, aspectCatalogueOf, normalizeAspectChoices } from '../../utils/aspectChoices';
import { renameInChoices, renameInGuidelinesNodes } from '../../utils/aspectRename';
import { aspectsForSend, conditionEvaluator, readAspectSections } from '../aspectGuidelinesStore';
import { promptFacts } from '../aspectPromptFacts';
import { readSectionsForEdit, saveAspectSection, sectionYamlText } from '../aspectSectionsEdit';
import { getAspectGuidelinesImpl } from '../../tools/aspect-guideline-tools';
import { handleAspectSectionEditorMessage, aspectSectionEditorData } from '../../handlers/aspectSectionEditor-handler';
import { addConditionHolds } from '../aspectPickerState';

const EXT = path.resolve(__dirname, '..', '..', '..');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aspect-several-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const put = (rel: string, text: string): string => {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
};

const aspect = (id: string, names: string[], extra: Partial<AspectSection> = {}, when: Record<string, string> = {}): AspectSection => ({
    id, name: id, label: id, placement: 'system',
    options: names.map((n) => ({ name: n, text: `${id}:${n}`, ...(when[n] !== undefined ? { when: when[n] } : {}) })),
    ...extra,
});
const sent = (sections: AspectSection[], choices: AspectLevelChoices, facts: Record<string, string> = {}, log?: (m: string) => void, lookup?: (n: string) => string | undefined) =>
    resolveAspects(sections, choices, { evaluate: conditionEvaluator(sections, choices, { facts: promptFacts(facts), lookup, log }) }).sections;

describe('several choices per aspect, conditional choices (gsel20)', () => {
    test('SC-1: the values', () => {
        assert.deepEqual(parseAspectValue('a'), { kind: 'replace', choices: ['a'] });
        assert.deepEqual(parseAspectValue('+a'), { kind: 'add', choices: ['a'] });
        assert.deepEqual(parseAspectValue(['a', 'b', 'a']), { kind: 'replace', choices: ['a', 'b'] });
        assert.deepEqual(parseAspectValue(['+a', '+b']), { kind: 'add', choices: ['a', 'b'] });
        assert.deepEqual(parseAspectValue('remove'), { kind: 'remove' });
        assert.deepEqual(parseAspectValue([]), { kind: 'replace', choices: [] });
        for (const bad of [['a', '+b'], '+', ['remove'], ['+remove'], ['a/b'], [1], 3, { a: 1 }]) {
            assert.equal(parseAspectValue(bad), undefined, JSON.stringify(bad));
        }
        assert.equal(formatAspectValue({ kind: 'replace', choices: ['a'] }), 'a', 'one choice stays a string');
        assert.deepEqual(formatAspectValue({ kind: 'replace', choices: ['a', 'b'] }), ['a', 'b']);
        assert.deepEqual(formatAspectValue({ kind: 'add', choices: ['a'] }), ['+a']);
        assert.deepEqual(normalizeAspectChoices({ old: 'a', list: ['a', 'b'], add: ['+c'], bad: ['a', '+b'], rem: 'remove' }), { old: 'a', list: ['a', 'b'], add: ['+c'], rem: 'remove' });
        assert.deepEqual(combineAspectEntries(undefined, { kind: 'add', choices: ['x'] }), { kind: 'add', choices: ['x'] });
        assert.deepEqual(combineAspectEntries({ kind: 'remove' }, { kind: 'add', choices: ['x'] }), { kind: 'replace', choices: ['x'] });
        assert.deepEqual(combineAspectEntries({ kind: 'replace', choices: ['a'] }, { kind: 'add', choices: ['x'] }), { kind: 'replace', choices: ['a', 'x'] });
        assert.deepEqual(combineAspectEntries({ kind: 'add', choices: ['a'] }, { kind: 'replace', choices: ['x'] }), { kind: 'replace', choices: ['x'] });
    });

    test('SC-2: replace and add across every level', () => {
        const s = [aspect('m', ['a', 'b', 'c', 'd', 'e', 'f'], { defaultOption: 'a' })];
        const levels = ASPECT_LEVELS.filter((l) => l !== 'sectionDefault') as Array<keyof AspectLevelChoices>;
        for (const level of levels) {
            const add = resolveAspects(s, { [level]: { m: ['+c', '+b'] } }).sections[0];
            assert.deepEqual([add.options, add.chosen.map((c) => [c.option, c.from])], [['a', 'b', 'c'], [['a', 'sectionDefault'], ['b', level], ['c', level]]], `${level} adds, in the aspect's order`);
            const replace = resolveAspects(s, { [level]: { m: ['d', 'b'] } }).sections[0];
            assert.deepEqual([replace.options, replace.from], [['b', 'd'], level], `${level} replaces`);
            assert.deepEqual(resolveAspects(s, { [level]: { m: 'remove' } }).sections[0].options, [], `${level} removes`);
        }
        const r = resolveAspects(s, {
            workspace: { m: ['+b'] }, questDefault: { m: ['c', 'd'] }, window: { m: '+e' }, run: { m: 'remove' },
            roleType: { m: '+f' }, role: { m: ['+a'] }, item: { m: 'b' }, todo: { m: ['+d', '+c'] },
        }).sections[0];
        assert.deepEqual([r.options, r.from], [['b', 'c', 'd'], 'todo'], 'the item replaced, the todo added; contradictory choices accepted');
        const afterRemove = resolveAspects(s, { window: { m: 'remove' }, role: { m: ['+f', '+e'] } }).sections[0];
        assert.deepEqual([afterRemove.options, afterRemove.removed], [['e', 'f'], false], 'an add after a remove starts afresh');
        const unknown = resolveAspects(s, { window: { m: 'c' }, todo: { m: ['ghost'] } });
        assert.deepEqual([unknown.sections[0].options, unknown.ignored], [['c'], [{ level: 'todo', section: 'm', option: 'ghost' }]], 'an entry of unknown choices is skipped whole');
        const partly = resolveAspects(s, { todo: { m: ['ghost', 'e'] } });
        assert.deepEqual(partly.sections[0].options, ['e'], 'the known ones of a partly unknown entry');
        assert.deepEqual(resolveAspects(s, { window: { m: 'b' } }).sections[0].option, 'b', 'a single value written before still reads');
    });

    test('SC-3: when, per prompt fact and per level', () => {
        const facts: Array<[string, string, string]> = [
            ['transport', 'agentSdk', 'direct'], ['kind', 'todo', 'chat'], ['todo', 't1', ''], ['role', 'coder', 'writer'],
            ['roleType', 'dev', 'author'], ['run', 'r1', 'default'], ['process', 'tom_specs', ''], ['quest', 'q', 'other'],
            ['workspace', 'ws', 'elsewhere'],
        ];
        for (const [fact, yes, no] of facts) {
            const s = [aspect('m', ['plain', 'cond'], { defaultOption: 'plain' }, { cond: `prompt.${fact} == "${yes}"` })];
            assert.deepEqual(sent(s, { window: { m: 'cond' } }, { [`prompt.${fact}`]: yes })[0].options, ['cond'], `${fact} holds`);
            const not = sent(s, { window: { m: 'cond' } }, { [`prompt.${fact}`]: no })[0];
            assert.deepEqual([not.options, not.conditional], [[], true], `${fact} fails: nothing, the default does not step in`);
        }
        const s = [aspect('m', ['a', 'b', 'c'], {}, { a: 'prompt.kind == "todo"', b: 'prompt.kind != "todo"' })];
        for (const level of ASPECT_LEVELS.filter((l) => l !== 'sectionDefault') as Array<keyof AspectLevelChoices>) {
            assert.deepEqual(sent(s, { [level]: { m: ['a', 'b', 'c'] } }, { 'prompt.kind': 'todo' })[0].options, ['a', 'c'], `${level}: each chosen one checked`);
            assert.deepEqual(sent(s, { [level]: { m: 'c' } }, { 'prompt.kind': 'todo' })[0].options, ['c'], `${level}: a not-chosen choice is never sent, though it holds`);
        }
        const lower = sent(s, { questDefault: { m: 'c' }, todo: { m: 'a' } }, { 'prompt.kind': 'chat' })[0];
        assert.deepEqual(lower.options, [], 'the lower level\'s choice does not step in');
        const night = [aspect('night_mode', ['on', 'off'], { defaultOption: 'on' }), aspect('m', ['x'], {}, { x: 'prompt.night == "on"' })];
        assert.deepEqual(sent(night, { window: { m: 'x' } })[1].options, ['x'], 'prompt.night from the night-mode aspect');
        assert.deepEqual(sent(night, { window: { m: 'x', night_mode: 'off' } })[1].options, []);
        // The night choice's own `when` (the window's night-mode chat variable, services/nightMode.ts) decides prompt.night too.
        const byVar = [aspect('night_mode', ['on'], { defaultOption: 'on' }, { on: 'night-mode == "on"' }), aspect('m', ['x'], {}, { x: 'prompt.night == "on"' })];
        const nightVar = (value: string) => (n: string) => (n === 'night-mode' ? value : undefined);
        assert.deepEqual(sent(byVar, { window: { m: 'x' } }, {}, undefined, nightVar('on'))[1].options, ['x'], 'night-mode on: prompt.night is on');
        assert.deepEqual(sent(byVar, { window: { m: 'x' } }, {}, undefined, nightVar('off'))[1].options, [], 'night-mode off: the default is not sent, prompt.night is empty');
        assert.deepEqual(sent(byVar, {}, {}, undefined, nightVar('off'))[0].options, [], 'the night text itself only while night-mode is on');
        assert.deepEqual(sent(byVar, {}, {}, undefined, nightVar('on'))[0].options, ['on']);
        const vars = [aspect('m', ['x'], {}, { x: 'my-var == "1"' })];
        assert.deepEqual(sent(vars, { window: { m: 'x' } }, {}, undefined, (n) => (n === 'my-var' ? '1' : undefined))[0].options, ['x'], 'the chat variables and placeholders');
    });

    test('SC-4: remove_when; invalid expressions never break a send', () => {
        const s = [aspect('m', ['a', 'b'], { defaultOption: 'a', removeWhen: 'prompt.transport == "direct"' })];
        for (const level of ASPECT_LEVELS.filter((l) => l !== 'sectionDefault') as Array<keyof AspectLevelChoices>) {
            const r = sent(s, { [level]: { m: ['a', 'b'] } }, { 'prompt.transport': 'direct' })[0];
            assert.deepEqual([r.options, r.removed, r.removeWhen?.holds], [[], true, true], `${level}: removed while it holds`);
            assert.deepEqual(sent(s, { [level]: { m: ['a', 'b'] } }, { 'prompt.transport': 'agentSdk' })[0].options, ['a', 'b'], `${level}: not while it does not`);
        }
        const logged: string[] = [];
        const bad = [aspect('m', ['a', 'b'], { removeWhen: 'prompt.kind ==' }, { a: '(prompt.kind' })];
        const r = sent(bad, { window: { m: ['a', 'b'] } }, {}, (m) => logged.push(m))[0];
        assert.deepEqual([r.options, r.removed], [['b'], false], 'the invalid when: not sent; the invalid remove_when: removes nothing');
        assert.equal(r.chosen[0].holds, false);
        assert.ok(r.chosen[0].error);
        const texts = aspectsForSend(undefined, 'direct', { systemSegments: [], userContent: '' }, {}, (t) => t);
        assert.deepEqual(texts.systemSegments, [], 'no store: nothing, no throw');
        const built = buildAspectSection('m', { name: 'M', choices: [{ name: 'a', when: 'prompt.kind ==' }, 'b'], remove_when: 'x &&' }, { a: 'A', b: 'B' });
        assert.deepEqual(built.section?.options.map((o) => [o.name, o.when]), [['a', 'prompt.kind =='], ['b', undefined]]);
        assert.equal(built.section?.removeWhen, 'x &&');
        assert.match(built.problems.join('|'), /m: choice "a": when: .*\(at position \d+\); the choice is never sent/);
        assert.match(built.problems.join('|'), /m: remove_when: .*; it removes nothing/);
        assert.match(buildAspectSection('m', { name: 'M' }, { '+x': 'X' }).problems.join('|'), /may not start with "\+"/);
    });

    test('SC-5: a send end to end', () => {
        const dir = path.join(base, 'e2e', 'aspect_guidelines');
        put('e2e/aspect_guidelines/style/aspect.yaml', [
            'name: Style',
            'default: short',
            'choices:',
            '  - short',
            '  - name: todo_only',
            '    when: prompt.kind == "todo"',
            '  - long',
            'remove_when: prompt.transport == "copilot"',
            '',
        ].join('\n'));
        put('e2e/aspect_guidelines/style/short.md', 'Be short.\n');
        put('e2e/aspect_guidelines/style/todo_only.md', 'In todos: report the TODO.\n');
        put('e2e/aspect_guidelines/style/long.md', 'Explain at length.\n');
        assert.deepEqual(readAspectSections(dir).problems, []);
        const send = (transport: string, kind: string, choices: AspectLevelChoices): string =>
            aspectsForSend(dir, transport as never, { systemSegments: [], userContent: 'x' }, choices, (t) => t, [], { facts: promptFacts({ 'prompt.transport': transport, 'prompt.kind': kind }) }).systemSegments.join('');
        assert.equal(send('direct', 'todo', { item: { style: ['+todo_only', '+long'] } }), '## Aspect guidelines\n\n### Style: short, todo_only, long\n\nBe short.\n\nIn todos: report the TODO.\n\nExplain at length.');
        assert.equal(send('direct', 'chat', { item: { style: ['+todo_only'] } }), '## Aspect guidelines\n\n### Style: short\n\nBe short.', 'the todo-only choice is not sent in a chat');
        assert.equal(send('copilot', 'todo', { item: { style: 'long' } }), '', 'remove_when');
    });

    test('SC-6: the editor', async (t) => {
        const dir = path.join(base, 'editor', 'aspect_guidelines');
        fs.mkdirSync(path.join(dir, 'tone'), { recursive: true });
        const yaml = sectionYamlText({ id: 'tone', name: 'Tone', label: '', placement: 'system', defaultOption: '', removeWhen: 'prompt.transport == "direct"',
            options: [{ name: 'dry', text: 'Dry.', when: 'prompt.kind == "todo"' }, { name: 'warm', text: 'Warm.' }] });
        assert.equal(yaml, 'name: Tone\nplacement: system\nchoices:\n  - name: dry\n    when: prompt.kind == "todo"\n  - warm\nremove_when: prompt.transport == "direct"\n');
        saveAspectSection(dir, { id: 'tone', name: 'Tone', label: '', placement: 'system', defaultOption: '', removeWhen: 'prompt.transport == "direct"',
            options: [{ name: 'dry', text: 'Dry.', when: 'prompt.kind == "todo"' }, { name: 'warm', text: 'Warm.' }] });
        const read = readSectionsForEdit(dir)[0];
        assert.deepEqual([read.options.map((o) => [o.name, o.when]), read.removeWhen], [[['dry', 'prompt.kind == "todo"'], ['warm', undefined]], 'prompt.transport == "direct"']);
        assert.throws(() => saveAspectSection(dir, { ...read, options: [{ name: 'dry', text: 'x', when: 'prompt.kind ==' }] }), /The condition of "dry" is no valid expression: .*position/);
        assert.throws(() => saveAspectSection(dir, { ...read, removeWhen: '(' }), /Remove when is no valid expression/);
        // The send order (gsel26): written, read back, kept by a save that carries it.
        saveAspectSection(dir, { ...read, order: 4 });
        assert.match(fs.readFileSync(path.join(dir, 'tone', 'aspect.yaml'), 'utf8'), /^order: 4$/m);
        assert.equal(readSectionsForEdit(dir)[0].order, 4);
        const ui = { ask: async () => undefined, confirm: async () => true, error: () => undefined, info: () => undefined };
        const check = await handleAspectSectionEditorMessage({ type: 'checkCondition', key: 'opt-0', expression: 'a == "x" &&' }, { dir }, ui);
        assert.equal(check?.type, 'conditionCheck');
        assert.match(String(check?.error), /position/);
        assert.equal((await handleAspectSectionEditorMessage({ type: 'checkCondition', key: 'remove', expression: 'prompt.kind == "todo"' }, { dir }, ui))?.error, undefined);

        // The page: the checkboxes write and take out their terms; the role types as one term.
        const body = fs.readFileSync(path.join(EXT, 'media', 'aspectSectionEditor', 'index.html'), 'utf8').split(/<body[^>]*>/)[1].split('<script')[0];
        const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = dom.window as any;
        t.after(() => w.close());
        const posted: Array<Record<string, unknown>> = [];
        w.__INIT__ = {};
        w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined });
        w.eval(fs.readFileSync(path.join(EXT, 'media', 'aspectSectionEditor', 'main.js'), 'utf8'));
        const data = aspectSectionEditorData({ dir, roleTypes: () => ['coder', 'writer'] });
        w.dispatchEvent(new w.MessageEvent('message', { data: JSON.parse(JSON.stringify({ ...data, selected: 'tone' })) }));
        const doc = w.document as Document;
        const cond = (key: string): Win => doc.querySelector(`.cond[data-cond="${key}"]`);
        const box = (key: string, sel: string): Win => cond(key).querySelector(sel);
        const value = (key: string): string => cond(key).querySelector('.cond-input').value;
        assert.equal(value('opt-0'), 'prompt.kind == "todo"');
        assert.equal(box('opt-0', 'input[data-term="todo"]').checked, true, 'the box shows the term');
        const tick = (key: string, sel: string, on: boolean): void => { const b = box(key, sel); b.checked = on; b.dispatchEvent(new w.Event('change', { bubbles: true })); };
        tick('opt-0', 'input[data-term="direct"]', true);
        assert.equal(value('opt-0'), 'prompt.kind == "todo" && prompt.transport == "direct"', 'extended with &&');
        tick('opt-0', 'input[data-term="todo"]', false);
        assert.equal(value('opt-0'), 'prompt.transport == "direct"', 'taken out again');
        tick('opt-1', 'input[data-role-type="coder"]', true);
        assert.equal(value('opt-1'), 'prompt.roleType == "coder"');
        tick('opt-1', 'input[data-role-type="writer"]', true);
        assert.equal(value('opt-1'), '(prompt.roleType == "coder" || prompt.roleType == "writer")', 'several role types with ||');
        tick('opt-1', 'input[data-term="process"]', true);
        assert.equal(value('opt-1'), '(prompt.roleType == "coder" || prompt.roleType == "writer") && prompt.process != ""');
        tick('remove', 'input[data-term="agentSdk"]', true);
        assert.equal(value('remove'), 'prompt.transport == "direct" && prompt.transport == "agentSdk"');
        assert.ok(posted.some((m) => m.type === 'checkCondition' && m.key === 'remove'), 'checked as it changes');
        const input = cond('opt-1').querySelector('.cond-input');
        input.value = 'prompt.kind =='; input.dispatchEvent(new w.Event('input', { bubbles: true }));
        assert.deepEqual(posted.at(-1), { type: 'checkCondition', key: 'opt-1', expression: 'prompt.kind ==' });
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'conditionCheck', key: 'opt-1', error: 'unexpected end (at position 15)' } }));
        assert.equal(cond('opt-1').querySelector('.cond-error').textContent, 'unexpected end (at position 15)');
        posted.length = 0;
        doc.getElementById('btnSave')!.click();
        const saved = posted[0].section as { options: Array<{ when?: string }>; removeWhen?: string };
        assert.deepEqual([saved.options.map((o) => o.when), saved.removeWhen], [['prompt.transport == "direct"', 'prompt.kind =='], 'prompt.transport == "direct" && prompt.transport == "agentSdk"']);
    });

    test('SC-7: rename, the tools, the read tool, the picker', (t) => {
        assert.deepEqual(renameInChoices({ js: ['a', '+b'], x: 'b' }, { kind: 'options', section: 'js', options: { b: 'c' } }), { js: ['a', '+c'], x: 'b' });
        assert.deepEqual(renameInChoices({ js: '+b' }, { kind: 'options', section: 'js', options: { b: 'c' } }), { js: '+c' });
        assert.equal(renameInChoices({ js: ['a'] }, { kind: 'options', section: 'js', options: { b: 'c' } }), undefined);
        const doc = parseDocument('guidelines:\n  js: [vscode, +react]\n  dart: +flutter\n');
        assert.equal(renameInGuidelinesNodes(doc, { kind: 'options', section: 'js', options: { react: 'preact' } }), 1);
        assert.equal(doc.toString(), 'guidelines:\n  js: [ vscode, +preact ]\n  dart: +flutter\n');

        const s = [aspect('js', ['vscode', 'react']), aspect('n', ['on'], { removeWhen: 'prompt.kind == "todo"' }, { on: 'prompt.kind != "todo"' })];
        assert.equal(aspectChoicesRefusal({ js: ['vscode', '+react'] }, s)?.match(/must map to a choice name, a list/) ? 'ok' : 'no', 'ok', 'a mixed list refused');
        assert.equal(aspectChoicesRefusal({ js: ['+react', '+vscode'], n: 'remove' }, s), undefined);
        assert.match(aspectChoicesRefusal({ js: ['ghost'] }, s) ?? '', /"ghost" is no choice of "js"/);

        const answer = JSON.parse(getAspectGuidelinesImpl({
            folder: () => 'x', readSections: () => ({ sections: s, problems: [] }),
            levels: () => ({ levels: { window: { js: 'vscode', n: 'on' }, todo: { js: ['+react'] } }, context: { todoId: 't1' }, notes: [] }),
            conditions: () => ({ facts: promptFacts({ 'prompt.kind': 'todo' }) }),
        } as never, {}));
        const js = answer.selection.find((e: { aspect: string }) => e.aspect === 'js');
        assert.deepEqual([js.choice, js.choices, js.fromByChoice], ['vscode', ['vscode', 'react'], { vscode: 'window', react: 'todo' }]);
        const n = answer.selection.find((e: { aspect: string }) => e.aspect === 'n');
        assert.deepEqual([n.choice, n.conditional, n.conditions, n.removeWhen], ['remove', true, [{ choice: 'on', when: 'prompt.kind != "todo"', holds: false }], { expression: 'prompt.kind == "todo"', holds: true }]);
        assert.deepEqual(answer.aspects[1].when, { on: 'prompt.kind != "todo"' });

        const catalogue = aspectCatalogueOf(s);
        addConditionHolds(catalogue, s, (expression, kind) => conditionEvaluator(s, {}, { facts: promptFacts({ 'prompt.kind': kind }) })(expression));
        assert.deepEqual(catalogue.sections[1].holds, { on: { chat: true, queue: true, todo: false }, '': { chat: false, queue: false, todo: true } });
        const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = dom.window as any;
        t.after(() => w.close());
        w.eval(fs.readFileSync(path.join(EXT, 'media', 'shared', 'aspectPicker.js'), 'utf8'));
        const P = w.TomAspectPicker;
        const view = (level: string) => P.view(JSON.parse(JSON.stringify(catalogue)), { window: { js: ['vscode', 'react'], n: 'on' } }, level);
        assert.equal(P.summary(view('window')), 'js: vscode, react · n: on?');
        const hover = P.hoverText(view('window'), 'G');
        assert.match(hover, /\nWhere from: js: vscode \(here\), react \(here\)/);
        assert.match(hover, /\nConditions: n: on — when prompt\.kind != "todo" \(holds now for a chat prompt\) · n: removed when prompt\.kind == "todo" \(does not hold now for a chat prompt\)/);
        assert.match(P.hoverText(view('todo'), 'G'), /on — when prompt\.kind != "todo" \(does not hold now for a todo prompt\)/, 'for the level shown');
    });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
