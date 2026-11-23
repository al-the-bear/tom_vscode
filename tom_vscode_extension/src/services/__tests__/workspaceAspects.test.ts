/**
 * The workspace level of the aspect guidelines (services/workspaceAspects.ts; gsel19, guideline_sectioning.md
 * D-14, D-19, D-27).
 *
 *   WA-1 reading one folder: the `@<path>` lines of workspace_aspects.md (a guideline file, an own text; free text
 *        and fenced code ignored), `remove:` of workspace_aspects.yaml; reported: a path that names no file, a file
 *        that is no choice file, two choices of one aspect (the later wins), an aspect chosen and removed (remove
 *        wins), a broken yaml
 *   WA-2 the order, per level: aspect default < workspace (the root's, a nested workspace folder's overriding per
 *        aspect, a choice and a remove each way) < quest default < window …; the folders of a window
 *   WA-3 writing: the window workspace folder's files from a level's choices (own text as `_ai/aspect_guidelines/…`,
 *        a guideline file relative), free text and other yaml keys kept, the schema line; Clear empties them and
 *        creates nothing; a choice the aspects lack is skipped
 *   WA-4 a send's levels gather the workspace level; the read tool answers it with its files and problems; the
 *        picker shows *from workspace*; the Aspect Guidelines editor lists the problems
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    clearWorkspaceAspects, readWorkspaceAspects, readWorkspaceAspectsFolder, workspaceAspectFolders, workspaceEntriesOf, writeWorkspaceAspects,
} from '../workspaceAspects';
import { readAspectSections } from '../aspectGuidelinesStore';
import { __setAspectChoiceDepsForTests, gatherAspectChoices } from '../aspectChoiceLevels';
import { aspectFileLayers } from '../../utils/aspectChoiceFiles';
import { ASPECT_LEVELS, resolveAspects } from '../../utils/aspectGuidelines';
import { aspectCatalogueOf } from '../../utils/aspectChoices';
import { getAspectGuidelinesImpl } from '../../tools/aspect-guideline-tools';
import { aspectSectionEditorData } from '../../handlers/aspectSectionEditor-handler';

const EXT = path.resolve(__dirname, '..', '..', '..');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-aspects-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const put = (rel: string, text: string): string => {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
};
const read = (rel: string): string => fs.readFileSync(path.join(base, rel), 'utf8');

// A Tom root `root/` with its `_ai`, a nested workspace folder `root/ws` whose `_ai` is a link onto the root's.
const root = path.join(base, 'root');
const ws = path.join(root, 'ws');
put('root/_ai/aspect_guidelines/mode/aspect.yaml', 'name: Mode\ndefault: plain\nchoices: [plain, fancy]\n');
put('root/_ai/aspect_guidelines/mode/plain.md', 'Plain.\n');
put('root/_ai/aspect_guidelines/mode/fancy.md', 'Fancy.\n');
put('root/_ai/aspect_guidelines/night/aspect.yaml', 'name: Night\ndefault: on\nchoices: [on, off]\n');
put('root/_ai/aspect_guidelines/night/on.md', 'Night on.\n');
put('root/_ai/aspect_guidelines/night/off.md', 'Night off.\n');
put('root/_agent_guidelines/aspects/tone/dry.md', 'Dry tone.\n');
put('root/_ai/aspect_guidelines/tone/aspect.yaml', 'name: Tone\nchoices: [dry]\n');
fs.mkdirSync(path.join(ws, '.tom'), { recursive: true });
fs.symlinkSync(path.join(root, '_ai'), path.join(ws, '_ai'));
const isWs = (d: string): boolean => fs.existsSync(path.join(d, '.tom'));
const folders = workspaceAspectFolders(root, ws, isWs);

describe('the workspace aspect level (gsel19)', () => {
    test('WA-1: one folder', () => {
        put('root/workspace_aspects.md', [
            '# Workspace aspects',
            'Free text, also with @_ai/aspect_guidelines/mode/fancy.md inside a sentence.',
            '@_ai/aspect_guidelines/mode/fancy.md',
            '@_agent_guidelines/aspects/tone/dry.md',
            '```',
            '@_ai/aspect_guidelines/night/off.md',
            '```',
            '@_agent_guidelines/aspects/missing/none.md',
            '@_ai/aspect_guidelines/mode/aspect.yaml',
            '',
        ].join('\n'));
        put('root/workspace_aspects.yaml', 'remove: [night]\n');
        const r = readWorkspaceAspectsFolder(root, '.');
        assert.deepEqual(r.choices, { mode: 'fancy', tone: 'dry', night: 'remove' });
        assert.deepEqual(r.sources, { mode: 'workspace_aspects.md:3', tone: 'workspace_aspects.md:4', night: 'workspace_aspects.yaml remove' });
        assert.deepEqual(r.problems, [
            'workspace_aspects.md:8: @_agent_guidelines/aspects/missing/none.md names no file; it chooses nothing',
            'workspace_aspects.md:9: @_ai/aspect_guidelines/mode/aspect.yaml is no choice file (_agent_guidelines/aspects/<aspect>/<choice>.md or _ai/aspect_guidelines/<aspect>/<choice>.md); it chooses nothing',
        ]);

        put('x/workspace_aspects.md', '@_ai/aspect_guidelines/mode/plain.md\n@_ai/aspect_guidelines/mode/fancy.md\n@_ai/aspect_guidelines/night/on.md\n');
        put('x/_ai/aspect_guidelines/mode/plain.md', 'p'); put('x/_ai/aspect_guidelines/mode/fancy.md', 'f'); put('x/_ai/aspect_guidelines/night/on.md', 'o');
        put('x/workspace_aspects.yaml', 'remove: [night]\n');
        const twice = readWorkspaceAspectsFolder(path.join(base, 'x'), 'x');
        assert.deepEqual(twice.choices, { mode: 'fancy', night: 'remove' }, 'the later line wins; remove wins');
        assert.match(twice.problems.join('|'), /x\/workspace_aspects\.md:2: a second choice of mode \(x\/workspace_aspects\.md:1 chose plain\); this line wins/);
        assert.match(twice.problems.join('|'), /x\/workspace_aspects\.yaml: night is removed and chosen \(x\/workspace_aspects\.md:3\); remove wins/);
        put('y/workspace_aspects.yaml', 'remove: [unclosed\n');
        assert.match(readWorkspaceAspectsFolder(path.join(base, 'y'), 'y').problems[0], /^y\/workspace_aspects\.yaml: does not read/);
        assert.deepEqual(readWorkspaceAspectsFolder(path.join(base, 'empty'), 'empty'), { folder: path.join(base, 'empty'), rel: 'empty', choices: {}, sources: {}, problems: [] });
    });

    test('WA-2: the order, per level', () => {
        assert.deepEqual([...ASPECT_LEVELS], ['sectionDefault', 'workspace', 'questDefault', 'window', 'run', 'roleType', 'role', 'item', 'todo']);
        assert.deepEqual(folders.map((f) => f.rel), ['.', 'ws'], 'the root, then the window\'s workspace folder');
        // The root: mode fancy, tone dry, night removed. The workspace folder: night back on, mode removed.
        put('root/ws/workspace_aspects.md', '@_ai/aspect_guidelines/night/on.md\n');
        put('root/ws/workspace_aspects.yaml', 'remove: [mode]\n');
        const level = readWorkspaceAspects(folders);
        assert.deepEqual(level.choices, { mode: 'remove', tone: 'dry', night: 'on' }, 'the nearer folder wins per aspect, each way');
        assert.equal(level.sources.night, 'ws/workspace_aspects.md:1');

        const { sections } = readAspectSections(path.join(root, '_ai', 'aspect_guidelines'), aspectFileLayers(root, ws, isWs));
        const pick = (levels: Parameters<typeof resolveAspects>[1]) => Object.fromEntries(resolveAspects(sections, levels).sections.map((r) => [r.section, [r.removed ? 'remove' : r.option, r.from]]));
        assert.deepEqual(pick({ workspace: level.choices }), {
            mode: ['remove', 'workspace'], night: ['on', 'workspace'], tone: ['dry', 'workspace'],
        }, 'workspace over each aspect\'s default');
        assert.deepEqual(pick({ workspace: readWorkspaceAspects(folders.slice(0, 1)).choices }), {
            mode: ['fancy', 'workspace'], night: ['remove', 'workspace'], tone: ['dry', 'workspace'],
        }, 'the root\'s alone');
        assert.deepEqual(pick({ workspace: level.choices, questDefault: { mode: 'plain', night: 'off' } }), {
            mode: ['plain', 'questDefault'], night: ['off', 'questDefault'], tone: ['dry', 'workspace'],
        }, 'the quest default over the workspace');
        assert.deepEqual(pick({ workspace: level.choices, questDefault: { mode: 'plain' }, window: { mode: 'remove' } }).mode, ['remove', 'window']);
        assert.deepEqual(pick({}).mode, ['plain', 'sectionDefault']);
    });

    test('WA-3: writing and clearing', () => {
        const { sections } = readAspectSections(path.join(root, '_ai', 'aspect_guidelines'), aspectFileLayers(root, ws, isWs));
        const { entries, skipped } = workspaceEntriesOf({ mode: 'fancy', tone: 'dry', night: 'remove', ghost: 'x' }, sections);
        assert.deepEqual(skipped, ['ghost: x']);
        put('root/ws/workspace_aspects.md', '# Mine\n\nKeep this text.\n@_ai/aspect_guidelines/night/on.md\n');
        put('root/ws/workspace_aspects.yaml', 'remove: [mode]\nlater: kept\n');
        const topTom = path.join(root, '.tom');
        const written = writeWorkspaceAspects(ws, entries, topTom);
        assert.deepEqual([written.md, written.yaml], [path.join(ws, 'workspace_aspects.md'), path.join(ws, 'workspace_aspects.yaml')]);
        assert.equal(read('root/ws/workspace_aspects.md'), '# Mine\n\nKeep this text.\n\n@_ai/aspect_guidelines/mode/fancy.md\n@../_agent_guidelines/aspects/tone/dry.md\n',
            'own text through the folder\'s _ai, a guideline file relative; the free text kept');
        assert.equal(read('root/ws/workspace_aspects.yaml'), '# yaml-language-server: $schema=../.tom/json-schema/aspect-guidelines/workspace-aspects.schema.json\nremove:\n  - night\nlater: kept\n');
        assert.deepEqual(readWorkspaceAspectsFolder(ws, 'ws').choices, { mode: 'fancy', tone: 'dry', night: 'remove' }, 'reads back');

        clearWorkspaceAspects(ws);
        assert.equal(read('root/ws/workspace_aspects.md'), '# Mine\n\nKeep this text.\n');
        assert.doesNotMatch(read('root/ws/workspace_aspects.yaml'), /remove/);
        assert.deepEqual(readWorkspaceAspectsFolder(ws, 'ws').choices, {});
        fs.writeFileSync(path.join(ws, 'workspace_aspects.yaml'), 'remove: [mode]\n');
        clearWorkspaceAspects(ws);
        assert.equal(fs.existsSync(path.join(ws, 'workspace_aspects.yaml')), false, 'nothing left: no yaml');
        const fresh = path.join(base, 'fresh');
        fs.mkdirSync(fresh);
        clearWorkspaceAspects(fresh);
        assert.deepEqual(fs.readdirSync(fresh), [], 'Clear creates nothing');
        writeWorkspaceAspects(fresh, {}, undefined);
        assert.match(fs.readFileSync(path.join(fresh, 'workspace_aspects.md'), 'utf8'), /^# Workspace aspects\n/, 'a new file gets a head');
    });

    test('WA-4: a send, the read tool, the picker, the editor', (t) => {
        __setAspectChoiceDepsForTests({ workspaceChoices: () => ({ mode: 'fancy' }), aiRoot: () => undefined, runChoices: () => undefined });
        t.after(() => __setAspectChoiceDepsForTests(undefined));
        assert.deepEqual(gatherAspectChoices({ queued: { runGuidelines: undefined } as never, role: '' }).workspace, { mode: 'fancy' });

        const { sections } = readAspectSections(path.join(root, '_ai', 'aspect_guidelines'), []);
        const answer = JSON.parse(getAspectGuidelinesImpl({
            folder: () => 'x',
            readSections: () => ({ sections, problems: [] }),
            levels: () => ({ levels: { workspace: { mode: 'fancy' } }, context: {}, notes: [] }),
            workspace: () => ({ files: [{ folder: '.', md: '/r/workspace_aspects.md' }], sources: { mode: 'workspace_aspects.md:3' }, problems: ['workspace_aspects.md:8: @x names no file; it chooses nothing'] }),
        } as never, {}));
        assert.deepEqual(answer.selection.find((s: { aspect: string }) => s.aspect === 'mode'), { aspect: 'mode', choice: 'fancy', from: 'workspace', file: '_ai/aspect_guidelines/mode/fancy.md' });
        assert.deepEqual(answer.workspace.problems, ['workspace_aspects.md:8: @x names no file; it chooses nothing']);
        assert.equal(answer.workspace.sources.mode, 'workspace_aspects.md:3');
        assert.match(JSON.parse(getAspectGuidelinesImpl({ folder: () => 'x', readSections: () => ({ sections, problems: [] }), levels: () => ({ levels: {}, context: {}, notes: [] }) } as never, { level: 'workspace' })).level, /^workspace$/);

        const dom = new JSDOM('<!DOCTYPE html><body><button id="a"></button></body>', { runScripts: 'outside-only' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = dom.window as any;
        t.after(() => w.close());
        w.eval(fs.readFileSync(path.join(EXT, 'media', 'shared', 'aspectPicker.js'), 'utf8'));
        const v = w.TomAspectPicker.view(JSON.parse(JSON.stringify(aspectCatalogueOf(sections))), { workspace: { mode: 'fancy' } }, 'window');
        assert.equal(v.sections.find((s: { id: string }) => s.id === 'mode')?.from, 'workspace');
        const popup = w.TomAspectPicker.open(w.document.getElementById('a'), v, { title: 'T', onChoose: () => undefined });
        assert.ok(Array.from(popup.querySelectorAll('.tom-aspect-origin') as ArrayLike<{ textContent: string }>).some((e) => e.textContent === 'from workspace'), 'the picker names the source');

        const data = aspectSectionEditorData({ dir: path.join(root, '_ai', 'aspect_guidelines'), workspaceProblems: () => ['ws/workspace_aspects.md:1: @x names no file; it chooses nothing'] });
        assert.deepEqual(data.workspaceProblems, ['ws/workspace_aspects.md:1: @x names no file; it chooses nothing'], 'the editor gets the problems');
        const page = fs.readFileSync(path.join(EXT, 'media', 'aspectSectionEditor', 'main.js'), 'utf8');
        assert.match(page, /workspace-problems/);
        const status = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'statusPage-handler.ts'), 'utf8');
        assert.match(status, /\.\.\.workspaceAspectErrors\(\)/, 'the Status Page lists them under Configuration Errors');
    });
});
