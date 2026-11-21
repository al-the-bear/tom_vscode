/**
 * The guideline section editor and the one Role Editor (gsel7; design
 * role_and_guideline_selector.vscode_extension.md P-4, L-6, AS-1):
 * services/aspectSectionsEdit.ts, handlers/aspectSectionEditor-handler.ts,
 * media/aspectSectionEditor/, handlers/rolesEditor-handler.ts, media/rolesEditor/.
 *
 *   GE-1 the section store: a new section; a save writes section.yaml (schema line, name, label, placement,
 *        default, option order) and one <option>.md each, read back by the page's and the picker's readers; an
 *        option renamed or deleted loses its old file; a refused section (no name, "remove", a twice-named option,
 *        a default that names no option, a bad name) writes nothing; a folder without a usable section.yaml is
 *        listed with its problems; rename and delete of a section folder
 *   GE-2 the section editor's host: ready answers the sections; add asks the folder name and refuses a bad one;
 *        save, rename, delete (after the confirmation) each write and call `changed`; no _ai folder: an error
 *   GE-3 the section editor page: the list and the form, a draft per section (marked unsaved, kept while another
 *        section is shown), add / rename / move / delete an option, the default following its option's rename,
 *        Save posting the whole section, Revert, a saved answer dropping the draft, the list buttons' messages
 *   GE-4 the Role Editor's host: the guideline sections in every answer, a role's and a role type's choices saved
 *        and loaded (role-config.yaml / role-type.yaml), `{}` clearing them, the role types carrying theirs for the
 *        roles' picker, `changed` after a save
 *   GE-5 the Role Editor page: one page with a Roles and a Role Types tab (the tab asks for its data, `showTab`
 *        switches), each role and role type with the guideline picker — its dot, the role type's choice shown
 *        *from role type* in a role's popup, a choice listed beside the button and saved with Save, Don't add
 *        taking it out, Edit sections… posting `aspectEditSections`
 *   GE-6 the wiring: the command contributed and registered, Extension Tools lists the section editor, the
 *        picker's Edit sections… runs it, the two role commands open the one page on their tab; every media page
 *        with a main.js loads it (the Role Editor's index.html did not)
 */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse as parseYaml } from 'yaml';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    createAspectSection,
    deleteAspectSection,
    readSectionsForEdit,
    renameAspectSection,
    saveAspectSection,
    type AspectSectionEdit,
} from '../../services/aspectSectionsEdit.js';
import { readAspectSections } from '../../services/aspectGuidelinesStore.js';
import { RoleStore } from '../../services/roleStore.js';
import { aspectCatalogueOf } from '../../utils/aspectChoices.js';
import { EXTENSION_TOOLS } from '../../utils/extensionToolsCatalog.js';
import { aspectSectionEditorData, handleAspectSectionEditorMessage, ASPECT_SECTION_EDITOR_COMMAND } from '../aspectSectionEditor-handler.js';
import { handleRolesEditorMessage, rolesEditorData } from '../rolesEditor-handler.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const WS = path.resolve(EXT, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(EXT, ...p), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
type Posted = Array<Record<string, unknown>>;

/** A scratch workspace under the workspace's ztmp/ (never /tmp): `.tom` and `_ai/aspect_guidelines`. */
function sandbox(t: { after(fn: () => void): void }): { ws: string; ai: string; dir: string; topTom: string } {
    const base = path.join(WS, 'ztmp');
    fs.mkdirSync(base, { recursive: true });
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(base, 'gsel7-editors-')));
    t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
    const ai = path.join(ws, '_ai');
    const dir = path.join(ai, 'aspect_guidelines');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(ai, 'roles'), { recursive: true });
    const topTom = path.join(ws, '.tom');
    fs.mkdirSync(topTom, { recursive: true });
    return { ws, ai, dir, topTom };
}

const section = (over: Partial<AspectSectionEdit> = {}): Omit<AspectSectionEdit, 'problems'> => ({
    id: 'answer', name: 'Answer mode', label: 'Answer', placement: 'user', defaultOption: 'brief',
    options: [{ name: 'full', text: 'Answer in full.\n' }, { name: 'brief', text: 'Answer briefly: ${role}.\n' }],
    ...over,
});

/** A page: the body of its index.html, the shared picker when asked, its main.js, with a recording host. */
function page(t: { after(fn: () => void): void }, panel: string, init: Record<string, unknown>, withPicker = false): { w: Win; posted: Posted; doc: Document } {
    const body = read('media', panel, 'index.html').split(/<body[^>]*>/)[1].split('<script')[0];
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Posted = [];
    let state: unknown;
    w.__INIT__ = init;
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => state, setState: (s: unknown) => { state = s; } });
    if (withPicker) { w.eval(read('media', 'shared', 'aspectPicker.js')); }
    w.eval(read('media', panel, 'main.js'));
    return { w, posted, doc: w.document };
}
const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const input = (w: Win, el: Win, value: string): void => { el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const change = (w: Win, el: Win, value: string): void => { el.value = value; el.dispatchEvent(new w.Event('change', { bubbles: true })); };

describe('the guideline section editor and the Role Editor (gsel7)', () => {
    test('GE-1: the section store', (t) => {
        const { dir, topTom } = sandbox(t);
        createAspectSection(dir, 'answer', 'Answer mode', topTom);
        assert.deepEqual(readSectionsForEdit(dir).map((s) => [s.id, s.name, s.options.length, s.problems]), [['answer', 'Answer mode', 0, []]]);
        assert.throws(() => createAspectSection(dir, 'answer', 'Again', topTom), /exists already/);

        saveAspectSection(dir, section(), topTom);
        const yamlText = fs.readFileSync(path.join(dir, 'answer', 'section.yaml'), 'utf8');
        assert.match(yamlText, /^# yaml-language-server: \$schema=\.\.\/\.\.\/\.\.\/\.tom\/json-schema\/aspect-guidelines\/aspect-guideline-section\.schema\.json\n/);
        assert.deepEqual(parseYaml(yamlText), { name: 'Answer mode', label: 'Answer', placement: 'user', default: 'brief', options: ['full', 'brief'] });
        assert.equal(fs.readFileSync(path.join(dir, 'answer', 'brief.md'), 'utf8'), 'Answer briefly: ${role}.\n');
        const edit = readSectionsForEdit(dir)[0];
        assert.deepEqual({ ...edit, problems: undefined }, { ...section(), problems: undefined }, 'the page reads what it saved');
        const picked = readAspectSections(dir);
        assert.deepEqual(picked.problems, []);
        assert.deepEqual(aspectCatalogueOf(picked.sections).sections, [{ id: 'answer', name: 'Answer mode', label: 'Answer', defaultOption: 'brief', options: ['full', 'brief'] }], 'the pickers read it');

        // An option renamed and one deleted: the old files go; the default follows what the page sent.
        saveAspectSection(dir, section({ defaultOption: 'short', options: [{ name: 'short', text: 'Short.\n' }] }), topTom);
        assert.deepEqual(fs.readdirSync(path.join(dir, 'answer')).sort(), ['section.yaml', 'short.md']);
        // An empty label is left out (the name is shown); placement system written.
        saveAspectSection(dir, section({ label: '', placement: 'system', defaultOption: '', options: [{ name: 'short', text: 'Short.\n' }] }), topTom);
        assert.deepEqual(parseYaml(fs.readFileSync(path.join(dir, 'answer', 'section.yaml'), 'utf8')), { name: 'Answer mode', placement: 'system', options: ['short'] });

        // Refusals write nothing.
        const before = fs.readFileSync(path.join(dir, 'answer', 'section.yaml'), 'utf8');
        const refused: Array<[Partial<AspectSectionEdit>, RegExp]> = [
            [{ name: ' ' }, /needs a name/],
            [{ options: [{ name: 'remove', text: '' }], defaultOption: '' }, /may not be named "remove"/],
            [{ options: [{ name: 'a', text: '' }, { name: 'a', text: '' }], defaultOption: '' }, /there twice/],
            [{ options: [{ name: 'a', text: '' }], defaultOption: 'b' }, /no option of the section/],
            [{ options: [{ name: 'x/y', text: '' }], defaultOption: '' }, /not an option short name/],
            [{ options: [{ name: '', text: '' }], defaultOption: '' }, /not an option short name/],
            [{ placement: 'both' as never }, /placement/],
        ];
        for (const [over, why] of refused) { assert.throws(() => saveAspectSection(dir, section(over), topTom), why); }
        assert.equal(fs.readFileSync(path.join(dir, 'answer', 'section.yaml'), 'utf8'), before);
        assert.deepEqual(fs.readdirSync(path.join(dir, 'answer')).sort(), ['section.yaml', 'short.md']);
        assert.throws(() => saveAspectSection(dir, section({ id: 'gone' }), topTom), /does not exist/);
        assert.throws(() => saveAspectSection(dir, section({ id: '..' }), topTom), /not a section name/);

        // A broken folder is listed with its problems, to be repaired by a save.
        fs.mkdirSync(path.join(dir, 'broken'));
        fs.writeFileSync(path.join(dir, 'broken', 'on.md'), 'On.\n');
        const broken = readSectionsForEdit(dir).find((s) => s.id === 'broken')!;
        assert.deepEqual([broken.name, broken.options.map((o) => o.name), broken.problems], ['', ['on'], ['no section.yaml']]);
        saveAspectSection(dir, { ...broken, name: 'Broken no more' }, topTom);
        assert.deepEqual(readSectionsForEdit(dir).find((s) => s.id === 'broken')!.problems, []);

        renameAspectSection(dir, 'broken', 'night', topTom);
        assert.deepEqual(readSectionsForEdit(dir).map((s) => s.id), ['answer', 'night']);
        assert.throws(() => renameAspectSection(dir, 'night', 'answer', topTom), /exists already/);
        assert.match(fs.readFileSync(path.join(dir, 'night', 'section.yaml'), 'utf8'), /^# yaml-language-server: \$schema=\.\.\/\.\.\/\.\.\/\.tom\//);
        deleteAspectSection(dir, 'night');
        assert.deepEqual(readSectionsForEdit(dir).map((s) => s.id), ['answer']);
        assert.throws(() => deleteAspectSection(dir, '..'), /not a section name/);
        assert.ok(fs.existsSync(dir), 'the store folder stays');
    });

    test('GE-2: the section editor\'s host', async (t) => {
        const { dir, topTom } = sandbox(t);
        let changes = 0;
        const env = { dir, topTom, changed: () => { changes++; } };
        const shown: string[] = [];
        let answer: string | undefined = 'answer';
        let confirmed = false;
        const ui = {
            ask: async () => answer,
            confirm: async (m: string) => { shown.push(`confirm: ${m}`); return confirmed; },
            error: (m: string) => { shown.push(`error: ${m}`); },
            info: (m: string) => { shown.push(m); },
        };
        assert.deepEqual(await handleAspectSectionEditorMessage({ type: 'ready' }, env, ui), { type: 'data', sections: [] });
        const added = await handleAspectSectionEditorMessage({ type: 'addSection' }, env, ui);
        assert.equal(added?.selected, 'answer');
        assert.deepEqual((added?.sections as AspectSectionEdit[]).map((s) => s.id), ['answer']);
        answer = 'bad/name';
        assert.equal(await handleAspectSectionEditorMessage({ type: 'addSection' }, env, ui), undefined);
        assert.match(shown.at(-1)!, /^error: "bad\/name" is not a section name/);

        const saved = await handleAspectSectionEditorMessage({ type: 'save', section: section() }, env, ui);
        assert.equal(saved?.saved, 'answer');
        assert.equal((saved?.sections as AspectSectionEdit[])[0].defaultOption, 'brief');
        assert.equal(shown.at(-1), 'Section answer saved.');
        assert.equal(await handleAspectSectionEditorMessage({ type: 'save', section: section({ defaultOption: 'nope' }) }, env, ui), undefined);
        assert.match(shown.at(-1)!, /^error: The default "nope"/);

        answer = 'mode';
        const renamed = await handleAspectSectionEditorMessage({ type: 'renameSection', id: 'answer' }, env, ui);
        assert.deepEqual([renamed?.selected, renamed?.renamed], ['mode', { from: 'answer', to: 'mode' }]);
        assert.equal(await handleAspectSectionEditorMessage({ type: 'deleteSection', id: 'mode' }, env, ui), undefined, 'not confirmed: nothing');
        assert.match(shown.at(-1)!, /^confirm: Delete the section mode with its 2 options\?/);
        assert.ok(fs.existsSync(path.join(dir, 'mode')));
        confirmed = true;
        const deleted = await handleAspectSectionEditorMessage({ type: 'deleteSection', id: 'mode' }, env, ui);
        assert.deepEqual([deleted?.deleted, deleted?.sections], ['mode', []]);
        assert.equal(changes, 4, 'add, save, rename, delete');

        assert.match(String(aspectSectionEditorData({ dir: undefined }).error), /no _ai folder/);
        assert.equal(await handleAspectSectionEditorMessage({ type: 'addSection' }, { dir: undefined }, ui), undefined);
        assert.match(shown.at(-1)!, /^error: This workspace has no _ai folder/);
    });

    test('GE-3: the section editor page', (t) => {
        const { w, posted, doc } = page(t, 'aspectSectionEditor', {});
        assert.deepEqual(posted, [{ type: 'ready' }]);
        const night = { id: 'night', name: 'Night mode', label: '', placement: 'system', defaultOption: '', options: [{ name: 'on', text: 'Quiet.\n' }], problems: ['option "x" has no x.md'] };
        send(w, { type: 'data', sections: [{ ...section(), problems: [] }, night] });
        const ids = (): string[] => Array.from(doc.querySelectorAll('#sectionList li') as Win).map((li: Win) => li.dataset.id);
        assert.deepEqual(ids(), ['answer', 'night']);
        const $ = (id: string): Win => doc.getElementById(id);
        assert.deepEqual([$('secName').value, $('secLabel').value, $('secPlacement').value, $('secDefault').value], ['Answer mode', 'Answer', 'user', 'brief']);
        const optionNames = (): string[] => Array.from(doc.querySelectorAll('.opt-name') as Win).map((e: Win) => e.value);
        assert.deepEqual(optionNames(), ['full', 'brief']);
        assert.deepEqual(Array.from(($('secDefault').options) as Win).map((o: Win) => o.value), ['', 'full', 'brief']);

        // Edits are a draft: marked unsaved, kept while another section is shown.
        input(w, $('secName'), 'Answer style');
        assert.ok(doc.querySelector('#sectionList li[data-id="answer"] .dirty'), 'unsaved');
        doc.querySelector<HTMLElement>('#sectionList li[data-id="night"]')!.click();
        assert.equal($('secName').value, 'Night mode');
        assert.match(doc.querySelector('.problems')!.textContent!, /has no x\.md/, 'the problems shown');
        doc.querySelector<HTMLElement>('#sectionList li[data-id="answer"]')!.click();
        assert.equal($('secName').value, 'Answer style', 'the draft kept');

        // The default follows its option's rename; options added, moved and deleted.
        input(w, doc.querySelectorAll('.opt-name')[1], 'short');
        assert.equal($('secDefault').value, 'short');
        $('btnAddOption').click();
        assert.deepEqual(optionNames(), ['full', 'short', '']);
        input(w, doc.querySelectorAll('.opt-name')[2], 'long');
        input(w, doc.querySelectorAll('.opt-text')[2], 'At length.');
        doc.querySelectorAll<HTMLElement>('.option')[2].querySelector<HTMLElement>('.opt-up')!.click();
        assert.deepEqual(optionNames(), ['full', 'long', 'short']);
        doc.querySelectorAll<HTMLElement>('.option')[0].querySelector<HTMLElement>('.opt-delete')!.click();
        assert.deepEqual(optionNames(), ['long', 'short']);
        change(w, $('secPlacement'), 'system');
        input(w, $('secLabel'), '');
        posted.length = 0;
        $('btnSave').click();
        assert.deepEqual(posted, [{ type: 'save', section: {
            id: 'answer', name: 'Answer style', label: '', placement: 'system', defaultOption: 'short',
            options: [{ name: 'long', text: 'At length.' }, { name: 'short', text: 'Answer briefly: ${role}.\n' }],
        } }]);

        // The host's answer drops the saved draft; Revert drops one unsaved.
        send(w, { type: 'data', saved: 'answer', selected: 'answer', sections: [{ ...section({ name: 'Answer style' }), problems: [] }, night] });
        assert.equal(doc.querySelector('#sectionList .dirty'), null);
        input(w, $('secName'), 'Changed');
        $('btnRevert').click();
        assert.equal($('secName').value, 'Answer style');

        posted.length = 0;
        $('btnAdd').click(); $('btnRename').click(); $('btnDelete').click(); $('btnFolder').click();
        assert.deepEqual(posted, [{ type: 'addSection' }, { type: 'renameSection', id: 'answer' }, { type: 'deleteSection', id: 'answer' }, { type: 'openFolder', id: 'answer' }]);
        send(w, { type: 'data', sections: [] });
        assert.match($('form').textContent, /No sections yet/);
        assert.equal($('btnDelete').disabled, true);
    });

    test('GE-4: the Role Editor\'s host and the guideline choices', async (t) => {
        const { ai } = sandbox(t);
        const store = new RoleStore(path.join(ai, '..', '.tom'), ai);
        let changes = 0;
        const aspects = { sections: [{ id: 'answer', name: 'Answer mode', label: 'Answer', options: ['brief', 'full'] }] };
        const env = { aspects: () => aspects, changed: () => { changes++; } };
        const ui = { ask: async () => 'reviewer', confirm: async () => true, error: (m: string) => { throw new Error(m); }, info: () => undefined };
        await handleRolesEditorMessage('roleTypes', { type: 'add', kind: 'roleTypes' }, store, ui, env);
        const typeSaved = await handleRolesEditorMessage('roleTypes', { type: 'save', id: 'reviewer', value: { tools: { mode: 'profileDefault' }, guidelines: { answer: 'full' } } }, store, ui, env);
        assert.deepEqual((typeSaved?.items as Array<{ value: { guidelines?: unknown } }>)[0].value.guidelines, { answer: 'full' });
        assert.deepEqual(typeSaved?.aspects, aspects, 'every answer carries the sections');
        assert.match(fs.readFileSync(path.join(ai, 'role-types', 'reviewer', 'role-type.yaml'), 'utf8'), /guidelines:\n {2}answer: full/);

        await handleRolesEditorMessage('roles', { type: 'add' }, store, { ...ui, ask: async () => 'checker' }, env);
        const roleSaved = await handleRolesEditorMessage('roles', { type: 'save', id: 'checker', roleMd: '# Checker\n', roleType: 'reviewer', guidelines: JSON.parse('{"answer":"remove","":"x"}') }, store, ui, env);
        assert.deepEqual(roleSaved?.items, [{ id: 'checker', roleMd: '# Checker\n', roleType: 'reviewer', guidelines: { answer: 'remove' } }], 'saved and loaded; a nameless entry dropped');
        assert.deepEqual(roleSaved?.roleTypes, [{ id: 'reviewer', name: 'reviewer', guidelines: { answer: 'full' } }], 'the type\'s choices for the role\'s picker');
        assert.deepEqual(rolesEditorData('roles', store, env).items, roleSaved?.items, 'loaded again');

        // {} clears; a save without the key clears too (the page always sends what the picker shows).
        await handleRolesEditorMessage('roles', { type: 'save', id: 'checker', roleMd: '# Checker\n', roleType: 'reviewer', guidelines: {} }, store, ui, env);
        assert.equal(store.role('checker')?.guidelines, undefined);
        await handleRolesEditorMessage('roleTypes', { type: 'save', id: 'reviewer', value: { tools: { mode: 'profileDefault' } } }, store, ui, env);
        assert.equal(store.roleTypes()[0].value?.guidelines, undefined);
        assert.equal(changes, 4, 'each save');
        assert.deepEqual(rolesEditorData('roles', undefined, env).aspects, aspects);
    });

    test('GE-5: the Role Editor page: two tabs, the guideline picker', (t) => {
        const aspects = { sections: [
            { id: 'answer', name: 'Answer mode', label: 'Answer', options: ['brief', 'full'] },
            { id: 'night', name: 'Night mode', label: 'Night', defaultOption: 'off', options: ['on', 'off'] },
        ] };
        const { w, posted, doc } = page(t, 'rolesEditor', { kind: 'roles' }, true);
        const $ = (id: string): Win => doc.getElementById(id);
        assert.deepEqual(posted, [{ type: 'ready', kind: 'roles' }]);
        assert.equal($('tabRoles').classList.contains('active'), true);
        send(w, { type: 'data', kind: 'roles', aspects,
            items: [{ id: 'author', roleMd: '# Author\n', roleType: 'writer', guidelines: { night: 'on' } }, { id: 'coder', roleMd: '# Coder\n' }],
            roleTypes: [{ id: 'writer', name: 'Writer', guidelines: { answer: 'full' } }] });
        // The picker: a dot (the role chose), the role's own choices beside it, the type's in the popup.
        assert.equal($('btnGuidelines').classList.contains('own'), true);
        assert.equal($('guideChoices').textContent, 'Night: on');
        assert.match($('btnGuidelines').title, /Answer: full · Night: on/);
        assert.ok(doc.querySelector('#itemList li[data-id="author"] .badge.guide'), 'the list marks a role with choices');
        $('btnGuidelines').click();
        const row = (id: string): Win => doc.querySelector(`#tomAspectPopup .tom-aspect-section[data-section="${id}"]`);
        assert.equal(row('answer').querySelector('.tom-aspect-origin').textContent, 'from role type');
        assert.equal(row('night').querySelector('.tom-aspect-origin').textContent, '\u2713 here');
        row('answer').querySelector('.tom-aspect-option[data-value="brief"]').click();
        assert.equal($('guideChoices').textContent, 'Night: on · Answer: brief');
        $('btnGuidelines').click();
        row('night').querySelector('.tom-aspect-option[data-value=""]').click();
        assert.equal($('guideChoices').textContent, 'Answer: brief', 'Don\'t add takes it out');
        posted.length = 0;
        $('btnSave').click();
        assert.deepEqual(posted, [{ type: 'save', kind: 'roles', id: 'author', roleType: 'writer', roleMd: '# Author\n', guidelines: { answer: 'brief' } }]);
        // Another role type: its choices are the level above.
        change(w, $('roleType'), '');
        $('btnGuidelines').click();
        assert.equal(row('night').querySelector('.tom-aspect-origin').textContent, 'default');
        doc.querySelector<HTMLElement>('#tomAspectPopup .tom-aspect-edit')!.click();
        assert.deepEqual(posted.at(-1), { type: 'aspectEditSections', kind: 'roles' });

        // The Role Types tab asks for its data; its picker edits the type's level.
        posted.length = 0;
        $('tabRoleTypes').click();
        assert.deepEqual(posted, [{ type: 'ready', kind: 'roleTypes' }]);
        assert.equal($('tabRoleTypes').classList.contains('active'), true);
        assert.equal($('btnDelete').style.display, '', 'role types are deleted here');
        send(w, { type: 'data', kind: 'roleTypes', aspects, items: [{ id: 'writer', value: { name: 'Writer', tools: { mode: 'profileDefault' }, guidelines: { answer: 'full' } }, usedBy: ['author'] }], toolGroups: [], alwaysOn: [] });
        assert.equal($('guideChoices').textContent, 'Answer: full');
        $('btnGuidelines').click();
        assert.equal($('tomAspectPopup').getAttribute('data-level'), 'roleType');
        row('answer').querySelector('.tom-aspect-option[data-value="remove"]').click();
        posted.length = 0;
        $('btnSave').click();
        assert.deepEqual(((posted as Posted)[0].value as { guidelines: unknown }).guidelines, { answer: 'remove' });

        // A command opening the page on a tab: showTab switches and asks for the data, the selection named.
        posted.length = 0;
        send(w, { type: 'showTab', kind: 'roles', selected: 'coder' });
        assert.deepEqual(posted, [{ type: 'ready', kind: 'roles', selected: 'coder' }]);
        assert.equal($('tabRoles').classList.contains('active'), true);
        assert.equal(doc.querySelector('#itemList li.active')?.getAttribute('data-id'), 'coder', 'the roles\' data kept, the named role shown');
        // The sections changed: the page asks again for the tab it shows.
        posted.length = 0;
        send(w, { type: 'reload' });
        assert.deepEqual(posted, [{ type: 'refresh', kind: 'roles', selected: 'coder' }]);
    });

    test('GE-6: the wiring', () => {
        const pkg = JSON.parse(read('package.json')) as { contributes: { commands: Array<{ command: string; title: string }> } };
        assert.ok(pkg.contributes.commands.some((c) => c.command === ASPECT_SECTION_EDITOR_COMMAND && c.title === '@T: Open Guideline Sections Editor'));
        const entry = EXTENSION_TOOLS.find((e) => e.command === ASPECT_SECTION_EDITOR_COMMAND);
        assert.equal(entry?.label, 'Guideline Sections Editor', 'Extension Tools lists the section editor');
        assert.match(read('src', 'extension.ts'), /registerAspectSectionEditorCommand\(context\);/);
        const messages = read('src', 'handlers', 'aspectPickerMessages.ts');
        assert.match(messages, /case 'aspectEditSections': \{\s*await vscode\.commands\.executeCommand\(ASPECT_SECTION_EDITOR_COMMAND\);/);
        const roles = read('src', 'handlers', 'rolesEditor-handler.ts');
        assert.match(roles, /registerCommand\('tomAi\.editor\.roles', \(args\?: \{ role\?: string \}\) => openRolesEditor\(context, 'roles', args\?\.role\)\)/);
        assert.match(roles, /registerCommand\('tomAi\.editor\.roleTypes', \(args\?: \{ roleType\?: string \}\) => openRolesEditor\(context, 'roleTypes', args\?\.roleType\)\)/);
        assert.match(roles, /postMessage\(\{ type: 'showTab', kind/, 'an open page switches to the tab');
        assert.match(roles, /let panel: vscode\.WebviewPanel \| undefined;/, 'one page');
        // Every page with its own main.js loads it (the composed accordion and tab panels read theirs themselves).
        const composed = new Set(['accordionPanel', 'tabPanel']);
        for (const panel of fs.readdirSync(path.join(EXT, 'media'))) {
            const html = path.join(EXT, 'media', panel, 'index.html');
            if (composed.has(panel) || !fs.existsSync(html) || !fs.existsSync(path.join(EXT, 'media', panel, 'main.js'))) { continue; }
            assert.match(fs.readFileSync(html, 'utf8'), /<script src="\{\{baseUri\}\}\/main\.js"><\/script>/, `${panel}/index.html loads main.js`);
        }
    });
});
