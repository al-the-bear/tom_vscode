/**
 * `@<path>` line imports in injected files (utils/lineImports.ts; gsel18, guideline_sectioning.md D-20, D-29).
 *
 *   LI-1 a line that is only `@<path>` is replaced in place by the file (relative, `~/…`, absolute; whitespace
 *        around it allowed); the lines around it stay
 *   LI-2 nested imports to five levels; a sixth-level import line stays as written
 *   LI-3 a cycle and a repeated file: each file imported once (the second import line dropped), also across
 *        the injections of one resolution
 *   LI-4 left as written: `@` inside a sentence, inside a code span and a fenced block, `@T: …`, `@CHAT`, a path
 *        that names no file, a folder
 *   LI-5 the injections: `${file-…}`, `${guidelines-…}`, `${guidelines-index}`, `${role-…}`, `${quest-…}`, an aspect
 *        choice file (own text and guideline file); tomAi_readGlobalGuideline's index files
 *   LI-6 an aspect's import lines are expanded for the choices the send sends only, in their order: a choice not
 *        sent takes no file away from one that is (each file still once per send)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { expandLineImports, MAX_IMPORT_DEPTH } from '../lineImports';
import { resolveVariables } from '../variableResolver';
import { aspectsForSend } from '../../services/aspectGuidelinesStore';
import { aspectFileLayers } from '../aspectChoiceFiles';
import { readGlobalGuidelineImpl } from '../../tools/guideline-tools';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'line-imports-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const put = (rel: string, text: string): string => {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
};
const home = path.join(base, 'home');

describe('@<path> line imports', () => {
    test('LI-1: a line import is replaced in place', () => {
        put('a/part.md', 'PART line 1\nPART line 2\n');
        put('home/rules.md', 'HOME RULES\n');
        const abs = put('elsewhere/abs.md', 'ABSOLUTE\n');
        const file = put('a/main.md', '');
        const text = `Before.\n@part.md\n  @~/rules.md  \n@${abs}\nAfter.\n`;
        assert.equal(expandLineImports(text, file, { homeDir: home }), 'Before.\nPART line 1\nPART line 2\nHOME RULES\nABSOLUTE\nAfter.\n');
        assert.equal(expandLineImports('@./part.md', file, { homeDir: home }), 'PART line 1\nPART line 2', 'a ./ path');
        assert.equal(MAX_IMPORT_DEPTH, 5);
    });

    test('LI-2: nested to five levels', () => {
        for (let i = 1; i <= 6; i++) { put(`n/l${i}.md`, `L${i}\n@l${i + 1}.md\n`); }
        put('n/l7.md', 'L7\n');
        const out = expandLineImports('TOP\n@l1.md\n', path.join(base, 'n', 'top.md'));
        assert.equal(out, 'TOP\nL1\nL2\nL3\nL4\nL5\n@l6.md\n', 'five levels imported; the sixth level\'s line stays');
    });

    test('LI-3: a cycle and a repeated file are imported once', () => {
        put('c/a.md', 'A\n@b.md\n');
        put('c/b.md', 'B\n@a.md\n@shared.md\n');
        put('c/shared.md', 'SHARED\n');
        assert.equal(expandLineImports('@a.md\n@shared.md\n@shared.md\nEND\n', path.join(base, 'c', 'top.md')), 'A\nB\nSHARED\nEND\n',
            'the cycle back to a.md and the repeats of shared.md dropped');
        put('c/top.md', 'TOP\n');
        assert.equal(expandLineImports('Self:\n@top.md\n', path.join(base, 'c', 'top.md')), 'Self:\n',
            'the importing file itself counts as imported');
        const seen = new Set<string>();
        assert.equal(expandLineImports('@shared.md', path.join(base, 'c', 'x.md'), { seen }), 'SHARED');
        assert.equal(expandLineImports('@shared.md\nY', path.join(base, 'c', 'y.md'), { seen }), 'Y', 'once per resolution across files');
    });

    test('LI-4: what stays as written', () => {
        put('s/part.md', 'PART\n');
        const file = path.join(base, 's', 'main.md');
        const text = [
            'See @part.md for more.',
            '`@part.md`',
            '```',
            '@part.md',
            '```',
            '~~~md',
            '@part.md',
            '~~~',
            '@T: Open Aspect Guidelines Editor',
            '@CHAT',
            '@missing.md',
            '@.',
            '',
        ].join('\n');
        assert.equal(expandLineImports(text, file), text);
        assert.equal(expandLineImports('no at sign', file), 'no at sign');
    });

    test('LI-5: the injections and readGlobalGuideline', async () => {
        const ws = path.join(base, 'ws');
        put('ws/docs/top.md', 'FILE TOP\n@inc/one.md\n');
        put('ws/docs/inc/one.md', 'FILE ONE\n@../../shared.md\n');
        put('ws/shared.md', 'SHARED ONCE\n');
        put('ws/_ai/roles/writer.md', 'ROLE\n@../../shared.md\n');
        put('ws/_ai/quests/q/notes.q.md', 'QUEST NOTES\n@extra.md\n');
        put('ws/_ai/quests/q/extra.md', 'QUEST EXTRA\n');
        const text = resolveVariables('${file-docs/top.md}\n---\n${role-writer}\n---\n${quest-notes}', {
            values: { workspaceFolder: ws, quest: 'q', questsPath: path.join(ws, '_ai', 'quests'), rolesPath: path.join(ws, '_ai', 'roles') },
        });
        assert.equal(text, 'FILE TOP\nFILE ONE\nSHARED ONCE\n\n---\nROLE\n\n---\nQUEST NOTES\nQUEST EXTRA\n', 'shared.md once in the whole resolution');

        // An aspect choice: own text and guideline file, each relative to its own file.
        put('ws/_ai/aspect_guidelines/mode/aspect.yaml', 'name: Mode\nchoices: [own, file]\n');
        put('ws/_ai/aspect_guidelines/mode/own.md', 'OWN\n@own-extra.md\n');
        put('ws/_ai/aspect_guidelines/mode/own-extra.md', 'OWN EXTRA\n');
        put('ws/_agent_guidelines/aspects/mode/file.md', 'FROM FILE\n@../../imported.md\n');
        put('ws/_agent_guidelines/imported.md', 'GUIDELINE IMPORTED\n');
        const layers = aspectFileLayers(ws, ws, () => false);
        const send = (choice: string): string => aspectsForSend(path.join(ws, '_ai', 'aspect_guidelines'), 'direct', { systemSegments: [], userContent: 'x' },
            { todo: { mode: choice } }, (t) => t, layers).systemSegments.join('\n');
        assert.match(send('own'), /OWN\nOWN EXTRA/);
        assert.match(send('file'), /FROM FILE\nGUIDELINE IMPORTED/);

        // tomAi_readGlobalGuideline: the index files' imports expanded, other files as they are.
        put('g/_agent_guidelines/index.md', '# Index\n\n@part_one.md\n');
        put('g/_agent_guidelines/part_one.md', 'PART ONE TABLE\n');
        put('g/_agent_guidelines/plain.md', 'Plain\n@part_one.md\n');
        const root = path.join(base, 'g');
        assert.match(await readGlobalGuidelineImpl(root, {}), /# Index\n\nPART ONE TABLE/);
        assert.match(await readGlobalGuidelineImpl(root, { fileName: 'index.md' }), /PART ONE TABLE/);
        assert.match(await readGlobalGuidelineImpl(root, { fileName: 'plain.md' }), /^Plain\n@part_one\.md/m, 'only index files');
    });

    test('LI-6: only the choices sent import, in the order they are sent', () => {
        const ws = path.join(base, 'ws6');
        // `big` comes first in the aspect and imports `small`'s base file; sending only `small` still gets it.
        put('ws6/_ai/aspect_guidelines/stack/aspect.yaml', 'name: Stack\ndefault: small\n');
        put('ws6/_agent_guidelines/aspects/stack/big.md', '@base.md\nBIG\n');
        put('ws6/_agent_guidelines/aspects/stack/small.md', '@base.md\nSMALL\n');
        put('ws6/_agent_guidelines/aspects/stack/base.md', 'BASE\n');
        const layers = aspectFileLayers(ws, ws, () => false);
        const send = (choices: Record<string, Record<string, string | string[]>>): string => aspectsForSend(path.join(ws, '_ai', 'aspect_guidelines'), 'direct',
            { systemSegments: [], userContent: 'x' }, choices, (t) => t, layers).systemSegments.join('\n');
        assert.match(send({}), /BASE\nSMALL/, 'the default choice imports its base although an unsent choice names it too');
        assert.match(send({ todo: { stack: 'big' } }), /BASE\nBIG/);
        const both = send({ todo: { stack: ['big', 'small'] } });
        assert.equal(both.split('BASE').length, 2, 'two sent choices: the base once');
    });
});
