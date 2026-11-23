/**
 * Aspect choices as guideline files (gsel17; guideline_sectioning.md D-8, D-18): utils/aspectChoiceFiles.ts,
 * services/aspectGuidelinesStore.ts, services/aspectSectionsEdit.ts, the Aspect Guidelines editor page, the
 * selection read tool, the picker's hover, the workspace template.
 *
 *   CF-1 the layers: the root's, the workspace folders on the way down, the window's own (nearest); a folder on
 *        the way that is no workspace folder is none; a standalone window has the root's only
 *   CF-2 a send: a choice from a root file, one the window's workspace file overrides and an own text are each
 *        sent with their text; own text wins over a file (the file named as shadowed); a choice listed in
 *        aspect.yaml with only a file is no problem; an aspect folder of a layer without aspect.yaml is one
 *   CF-3 the editor's store: each choice's mode, own text and files; a save edits a file in place, writes the
 *        workspace's own copy (the root's file kept), drops the own text of a choice switched to a file, keeps
 *        the file of one switched to own text, deletes the file of a file choice removed; an orphan aspect is
 *        listed and a save creates its definition; a rename moves the layers' folders
 *   CF-4 the page: the switch Own text / Guideline file, the file it edits named with its layer, Create the
 *        workspace's own copy, the copy offer on switching to Own text, and the save message
 *   CF-5 the read tool's selection names the file; the picker's catalogue carries the files and its hover names
 *        them; the template build packs `_agent_guidelines/aspects/` and `_ai/aspect_guidelines/`
 */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse as parseYaml } from 'yaml';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { aspectFileLayers, type AspectFileLayer } from '../../utils/aspectChoiceFiles.js';
import { aspectsForSend, readAspectSections } from '../../services/aspectGuidelinesStore.js';
import { readSectionsForEdit, renameAspectSection, saveAspectSection, type AspectSectionEdit } from '../../services/aspectSectionsEdit.js';
import { aspectCatalogueOf } from '../../utils/aspectChoices.js';
import { getAspectGuidelinesImpl } from '../../tools/aspect-guideline-tools.js';
import { aspectSectionEditorData } from '../aspectSectionEditor-handler.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const WS = path.resolve(EXT, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(EXT, ...p), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function put(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

/**
 * A scratch Tom root under the workspace's ztmp/ (never /tmp): `root/` with `_ai/aspect_guidelines/mode/`
 * (choices rootfile, both, own; own.md its own text), the root's guideline files rootfile.md and both.md, and
 * a nested workspace folder `outer/inner` (both workspace folders) whose window layer overrides both.md.
 */
function sandbox(t: { after(fn: () => void): void }) {
    const base = path.join(WS, 'ztmp');
    fs.mkdirSync(base, { recursive: true });
    const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'gsel17-choice-files-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, '_ai', 'aspect_guidelines');
    put(path.join(dir, 'mode', 'aspect.yaml'), 'name: Mode\nplacement: system\ndefault: rootfile\nchoices: [rootfile, both, own]\n');
    put(path.join(dir, 'mode', 'own.md'), 'Own text.\n');
    const rootAspects = path.join(root, '_agent_guidelines', 'aspects');
    put(path.join(rootAspects, 'mode', 'rootfile.md'), 'From the root.\n');
    put(path.join(rootAspects, 'mode', 'both.md'), 'Root copy.\n');
    put(path.join(rootAspects, 'mode', 'own.md'), 'Shadowed by the own text.\n');
    const outer = path.join(root, 'outer');
    const inner = path.join(outer, 'inner');
    for (const w of [outer, inner]) { fs.mkdirSync(path.join(w, '.tom'), { recursive: true }); fs.mkdirSync(path.join(w, '_ai'), { recursive: true }); }
    const innerAspects = path.join(inner, '_agent_guidelines', 'aspects');
    put(path.join(innerAspects, 'mode', 'both.md'), 'Workspace copy.\n');
    const isWs = (d: string): boolean => fs.existsSync(path.join(d, '.tom'));
    const layers = aspectFileLayers(root, inner, isWs);
    return { root, dir, rootAspects, outer, inner, innerAspects, layers, isWs };
}

const sendWith = (dir: string, layers: AspectFileLayer[], choice: string): string =>
    aspectsForSend(dir, 'direct', { systemSegments: [], userContent: 'Go.' }, choice ? { todo: { mode: choice } } : undefined, (x) => x, layers).systemSegments.join('\n');

describe('aspect choices as guideline files (gsel17)', () => {
    test('CF-1: the layers', (t) => {
        const { root, outer, inner, layers, isWs } = sandbox(t);
        assert.deepEqual(layers.map((l) => [l.level, l.folder, l.own]), [['root', '.', false], ['workspace', 'outer', false], ['workspace', 'outer/inner', true]]);
        assert.equal(layers[2].base, path.join(inner, '_agent_guidelines', 'aspects'));
        fs.rmSync(path.join(outer, '.tom'), { recursive: true });
        assert.deepEqual(aspectFileLayers(root, inner, isWs).map((l) => l.folder), ['.', 'outer/inner'], 'a folder on the way that is no workspace folder is no layer');
        assert.deepEqual(aspectFileLayers(root, root, isWs).map((l) => [l.level, l.own]), [['root', true]], 'standalone: the root\'s only');
    });

    test('CF-2: a send gets the right text', (t) => {
        const { dir, layers } = sandbox(t);
        assert.match(sendWith(dir, layers, ''), /### Mode: rootfile\n+From the root\./, 'the default, from a root file');
        assert.match(sendWith(dir, layers, 'both'), /Workspace copy\./, 'the window workspace\'s file wins over the root\'s');
        assert.doesNotMatch(sendWith(dir, layers, 'both'), /Root copy/);
        assert.match(sendWith(dir, layers, 'own'), /Own text\./, 'own text');
        assert.doesNotMatch(sendWith(dir, layers, 'own'), /Shadowed/, 'own text wins over a file');
        const { sections, problems } = readAspectSections(dir, layers);
        assert.deepEqual(problems, [], 'choices with only a file are no problem');
        const sources = Object.fromEntries(sections[0].options.map((o) => [o.name, [o.source?.kind, o.source?.display, o.source?.level, o.source?.shadows]]));
        assert.deepEqual(sources, {
            rootfile: ['file', '_agent_guidelines/aspects/mode/rootfile.md', 'root', undefined],
            both: ['file', 'outer/inner/_agent_guidelines/aspects/mode/both.md', 'workspace', ['_agent_guidelines/aspects/mode/both.md']],
            own: ['own', '_ai/aspect_guidelines/mode/own.md', undefined, ['_agent_guidelines/aspects/mode/own.md']],
        });
        assert.match(readAspectSections(dir, []).problems.join('|'), /choice "rootfile" has no rootfile\.md \(own text or guideline file\)/, 'without the layers the file choices are missing');
        put(path.join(layers[0].base, 'lonely', 'x.md'), 'x');
        assert.match(readAspectSections(dir, layers).problems.join('|'), /^lonely: guideline files in _agent_guidelines\/aspects\/lonely\/, but no _ai\/aspect_guidelines\/lonely\/aspect\.yaml defines the aspect/);
    });

    test('CF-3: the editor\'s store', (t) => {
        const { dir, rootAspects, innerAspects, layers } = sandbox(t);
        const edit = readSectionsForEdit(dir, layers).find((s) => s.id === 'mode')!;
        const by = (name: string) => edit.options.find((o) => o.name === name)!;
        assert.deepEqual([by('rootfile').mode, by('rootfile').fileBase, by('rootfile').text], ['file', rootAspects, 'From the root.\n']);
        assert.deepEqual(by('both').files!.map((f) => f.base), [innerAspects, rootAspects], 'nearest first');
        assert.deepEqual([by('own').mode, by('own').ownText, by('own').files!.length], ['own', 'Own text.\n', 1]);
        const save = (options: AspectSectionEdit['options']) => saveAspectSection(dir, { id: 'mode', name: 'Mode', label: '', placement: 'system', defaultOption: options.some((o) => o.name === 'rootfile') ? 'rootfile' : '', options }, undefined, layers);

        save([
            { name: 'rootfile', text: 'Edited at the root.\n', mode: 'file', fileBase: rootAspects },
            { name: 'both', text: 'Workspace copy, edited.\n', mode: 'file', fileBase: innerAspects },
            { name: 'own', text: 'Now a file of the workspace.\n', mode: 'file', fileBase: innerAspects },
        ]);
        assert.equal(fs.readFileSync(path.join(rootAspects, 'mode', 'rootfile.md'), 'utf8'), 'Edited at the root.\n', 'edited in place');
        assert.equal(fs.readFileSync(path.join(rootAspects, 'mode', 'both.md'), 'utf8'), 'Root copy.\n', 'the root\'s copy kept');
        assert.equal(fs.readFileSync(path.join(innerAspects, 'mode', 'own.md'), 'utf8'), 'Now a file of the workspace.\n');
        assert.equal(fs.existsSync(path.join(dir, 'mode', 'own.md')), false, 'switched to a file: the own text goes');
        assert.deepEqual(parseYaml(fs.readFileSync(path.join(dir, 'mode', 'aspect.yaml'), 'utf8')).choices, ['rootfile', 'both', 'own']);

        // The workspace's own copy: written beside the root's, which stays.
        save([
            { name: 'rootfile', text: 'My workspace\'s copy.\n', mode: 'file', fileBase: innerAspects },
            { name: 'both', text: 'Back to own text.\n' },
            { name: 'own', text: 'Now a file of the workspace.\n', mode: 'file', fileBase: innerAspects },
        ]);
        assert.equal(fs.readFileSync(path.join(innerAspects, 'mode', 'rootfile.md'), 'utf8'), 'My workspace\'s copy.\n');
        assert.equal(fs.readFileSync(path.join(rootAspects, 'mode', 'rootfile.md'), 'utf8'), 'Edited at the root.\n');
        assert.equal(fs.readFileSync(path.join(dir, 'mode', 'both.md'), 'utf8'), 'Back to own text.\n');
        assert.ok(fs.existsSync(path.join(innerAspects, 'mode', 'both.md')), 'switched to own text: the file stays');
        assert.match(sendWith(dir, layers, 'rootfile'), /My workspace's copy\./);

        // A file choice removed in the draft: the file it had goes.
        save([{ name: 'both', text: 'Back to own text.\n' }, { name: 'own', text: 'x', mode: 'file', fileBase: innerAspects }]);
        assert.equal(fs.existsSync(path.join(innerAspects, 'mode', 'rootfile.md')), false, 'the window\'s copy, which it edited, deleted');
        assert.ok(fs.existsSync(path.join(rootAspects, 'mode', 'rootfile.md')), 'the root\'s copy then shows through');
        assert.throws(() => save([{ name: 'own', text: 'x', mode: 'file', fileBase: '/elsewhere' }]), /no guideline folder of this window/);

        // An orphan aspect: listed, and a save creates its definition.
        put(path.join(rootAspects, 'lonely', 'on.md'), 'Lonely.\n');
        const orphan = readSectionsForEdit(dir, layers).find((s) => s.id === 'lonely')!;
        assert.deepEqual([orphan.options.map((o) => [o.name, o.mode]), orphan.problems], [[['on', 'file']], ['no aspect.yaml in _ai/aspect_guidelines/lonely/: only guideline files; Save creates it']]);
        saveAspectSection(dir, { ...orphan, name: 'Lonely', options: orphan.options.map((o) => ({ name: o.name, text: o.text, mode: o.mode, fileBase: o.fileBase })) }, undefined, layers);
        assert.ok(fs.existsSync(path.join(dir, 'lonely', 'aspect.yaml')));
        assert.deepEqual(readAspectSections(dir, layers).problems, []);

        renameAspectSection(dir, 'lonely', 'solo', undefined, layers);
        assert.ok(fs.existsSync(path.join(rootAspects, 'solo', 'on.md')), 'the layers\' folders move with a rename');
        assert.equal(fs.existsSync(path.join(rootAspects, 'lonely')), false);
    });

    test('CF-4: the editor page', (t) => {
        const { dir, rootAspects, innerAspects, layers } = sandbox(t);
        const body = read('media', 'aspectSectionEditor', 'index.html').split(/<body[^>]*>/)[1].split('<script')[0];
        const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        const posted: Array<Record<string, unknown>> = [];
        w.__INIT__ = {};
        w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined });
        w.eval(read('media', 'aspectSectionEditor', 'main.js'));
        const data = aspectSectionEditorData({ dir, layers });
        w.dispatchEvent(new w.MessageEvent('message', { data: JSON.parse(JSON.stringify({ ...data, selected: 'mode' })) }));
        const doc = w.document as Document;
        const block = (i: number): Win => doc.querySelectorAll('.option')[i];
        const modes = (): string[] => Array.from(doc.querySelectorAll('.opt-mode') as Win).map((e: Win) => e.value);
        assert.deepEqual(modes(), ['file', 'file', 'own']);
        assert.match(block(0).querySelector('.file-line').textContent, /^Edits _agent_guidelines\/aspects\/mode\/rootfile\.md \(the root's\)/);
        assert.equal(block(0).querySelector('.opt-text').value, 'From the root.\n', 'the text area shows the file');
        assert.match(block(1).querySelector('.file-line').textContent, /Edits outer\/inner\/_agent_guidelines\/aspects\/mode\/both\.md \(workspace outer\/inner\)/);
        assert.equal(block(1).querySelector('.opt-own-copy'), null, 'already the workspace\'s own file');

        // Create the workspace's own copy: the text kept, the file to write is the window's.
        block(0).querySelector('.opt-own-copy').click();
        assert.match(block(0).querySelector('.file-line').textContent, /^New file outer\/inner\/_agent_guidelines\/aspects\/mode\/rootfile\.md/);
        const text = block(0).querySelector('.opt-text');
        text.value = 'Mine.\n'; text.dispatchEvent(new w.Event('input', { bubbles: true }));

        // Switching to Own text offers the file's text.
        const mode = block(1).querySelector('.opt-mode');
        mode.value = 'own'; mode.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.equal(block(1).querySelector('.opt-text').value, '', 'no own text yet');
        block(1).querySelector('.opt-copy').click();
        assert.equal(block(1).querySelector('.opt-text').value, 'Workspace copy.\n', 'copied into the field');
        assert.equal(block(1).querySelector('.opt-copy'), null, 'the offer gone once the texts agree');

        // Own → Guideline file: a new file starts with the own text.
        const own = block(2).querySelector('.opt-mode');
        own.value = 'file'; own.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.equal(block(2).querySelector('.opt-text').value, 'Shadowed by the own text.\n', 'the existing file\'s text shown');

        posted.length = 0;
        doc.getElementById('btnSave')!.click();
        assert.deepEqual((posted[0].section as { options: unknown }).options, [
            { name: 'rootfile', text: 'Mine.\n', mode: 'file', fileBase: innerAspects },
            { name: 'both', text: 'Workspace copy.\n' },
            { name: 'own', text: 'Shadowed by the own text.\n', mode: 'file', fileBase: rootAspects },
        ]);
    });

    test('CF-5: the read tool, the picker, the template', (t) => {
        const { dir, layers } = sandbox(t);
        const store = readAspectSections(dir, layers);
        const answer = JSON.parse(getAspectGuidelinesImpl({
            folder: () => dir,
            readSections: () => store,
            levels: () => ({ levels: { todo: { mode: 'both' } }, context: {}, notes: [] }),
        } as never, {}));
        assert.deepEqual(answer.selection, [{ aspect: 'mode', choice: 'both', from: 'todo', file: 'outer/inner/_agent_guidelines/aspects/mode/both.md', guidelineFile: true }]);
        const catalogue = aspectCatalogueOf(store.sections);
        assert.deepEqual(catalogue.sections[0].files, {
            rootfile: '_agent_guidelines/aspects/mode/rootfile.md', both: 'outer/inner/_agent_guidelines/aspects/mode/both.md', own: '_ai/aspect_guidelines/mode/own.md',
        });
        const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        w.eval(read('media', 'shared', 'aspectPicker.js'));
        const P = w.TomAspectPicker;
        const hover = P.hoverText(P.view(JSON.parse(JSON.stringify(catalogue)), {}, 'window'), 'Guidelines');
        assert.match(hover, /\nFrom: Mode: _agent_guidelines\/aspects\/mode\/rootfile\.md$/, 'the hover names the file of the effective choice');

        const build = fs.readFileSync(path.join(EXT, 'scripts', 'build-workspace-template.cjs'), 'utf8');
        assert.match(build, /\{ path: `\$\{rootGuidelines\}\/aspects`, kind: 'dir', optional: true \}/);
        assert.match(build, /\{ path: '_ai\/aspect_guidelines', kind: 'dir', optional: true \}/);
    });
});
