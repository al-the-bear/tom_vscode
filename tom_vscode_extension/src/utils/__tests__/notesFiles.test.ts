/**
 * Where the notes views read and write (src/utils/notesFiles.ts).
 *
 *   NF-1 the default quest notes file: `notes/quest-notes.md`; a quest whose notes are at the old place
 *        (`quest-notes.<quest>.md`, no `notes/quest-notes.md`) keeps the old file as its default, under the
 *        default's name; once the new file exists it wins; a quest with neither gets the new place
 *   NF-2 the list of notes files: the default first (listed before it exists, the old place under the default's
 *        name), then the other `.md` files of the notes folder by name without case; folders and other files
 *        are not listed; a kept choice picks its file, a choice whose file is gone the default
 *   NF-3 the name of a new notes file: empty, a path separator, `..` and an existing name (without case) are
 *        refused; `.md` is appended when missing; the heading is the name
 *   NF-4 the workspace notes file: `_ai/workspaces/<workspace>.notes.md`, beside the workspace's quest list
 *   NF-5 the one-time import: from the picked file, from `<workspace folder>/notes.md`, nothing to import (the
 *        heading), and no import when the workspace notes file exists; the source is left as it is
 *   NF-6 the quest folder's notes entries for a list of its documents: `notes/<file>`, sorted
 */

/* eslint-disable @typescript-eslint/naming-convention -- the sandbox trees are keyed by file path */

import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    DEFAULT_QUEST_NOTES_PATTERN,
    WORKSPACE_NOTES_HEADER,
    defaultQuestNotesPath,
    ensureWorkspaceNotesFile,
    listQuestNotesFiles,
    newNotesFileName,
    pickQuestNotesFile,
    questFolderNotesEntries,
    questNotesHeader,
    resolveDefaultQuestNotes,
    workspaceNotesFile,
    workspaceNotesImportSource,
} from '../notesFiles.js';
import { aiWorkspaceFile, aiWorkspaceName } from '../aiWorkspace.js';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-files-')));
after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

let counter = 0;
function quest(files: Record<string, string> = {}): string {
    const folder = path.join(SANDBOX, `q${++counter}`, '_ai', 'quests', 'q');
    fs.mkdirSync(folder, { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true });
        fs.writeFileSync(path.join(folder, rel), text);
    }
    return folder;
}
const resolve = (folder: string): ReturnType<typeof resolveDefaultQuestNotes> => resolveDefaultQuestNotes(defaultQuestNotesPath(folder), folder, 'q');

describe('notes files', () => {
    test('NF-1: the default quest notes file and the old place', () => {
        assert.equal(DEFAULT_QUEST_NOTES_PATTERN, '_ai/quests/${quest}/notes/quest-notes.md');
        assert.equal(questNotesHeader('q'), '# Quest Notes — q\n\n');

        const fresh = quest();
        assert.deepEqual(resolve(fresh), { name: 'quest-notes.md', folder: path.join(fresh, 'notes'), filePath: path.join(fresh, 'notes', 'quest-notes.md'), oldPlace: false });

        const old = quest({ 'quest-notes.q.md': 'old notes\n' });
        assert.deepEqual(resolve(old), { name: 'quest-notes.md', folder: path.join(old, 'notes'), filePath: path.join(old, 'quest-notes.q.md'), oldPlace: true });
        assert.equal(fs.existsSync(path.join(old, 'notes')), false, 'nothing is copied or moved');

        // Other notes files beside a missing default do not end the interim rule.
        const oldWithMore = quest({ 'quest-notes.q.md': 'old\n', 'notes/ideas.md': 'ideas\n' });
        assert.equal(resolve(oldWithMore).filePath, path.join(oldWithMore, 'quest-notes.q.md'));

        const both = quest({ 'quest-notes.q.md': 'old\n', 'notes/quest-notes.md': 'new\n' });
        assert.deepEqual([resolve(both).filePath, resolve(both).oldPlace], [path.join(both, 'notes', 'quest-notes.md'), false], 'the new file wins');

        // Another quest's old file is not this quest's.
        const other = quest({ 'quest-notes.other.md': 'x\n' });
        assert.equal(resolve(other).oldPlace, false);

        // The check is injectable, and asked for the configured file first.
        const asked: string[] = [];
        resolveDefaultQuestNotes('/c/notes/quest-notes.md', '/c', 'q', (p) => { asked.push(p); return false; });
        assert.deepEqual(asked, ['/c/notes/quest-notes.md', path.join('/c', 'quest-notes.q.md')]);
    });

    test('NF-2: the list and the kept choice', () => {
        const fresh = quest();
        assert.deepEqual(listQuestNotesFiles(resolve(fresh)), [{ name: 'quest-notes.md', filePath: path.join(fresh, 'notes', 'quest-notes.md'), isDefault: true }], 'the default before it exists');

        const q = quest({
            'notes/quest-notes.md': 'd', 'notes/zeta.md': 'z', 'notes/Alpha.md': 'a', 'notes/beta.MD': 'b',
            'notes/readme.txt': 't', 'notes/sub/inner.md': 'i', 'overview.q.md': 'o',
        });
        const files = listQuestNotesFiles(resolve(q));
        assert.deepEqual(files.map((f) => [f.name, f.isDefault]), [['quest-notes.md', true], ['Alpha.md', false], ['beta.MD', false], ['zeta.md', false]]);
        assert.equal(files[1].filePath, path.join(q, 'notes', 'Alpha.md'));

        const old = quest({ 'quest-notes.q.md': 'old\n', 'notes/ideas.md': 'ideas\n' });
        assert.deepEqual(listQuestNotesFiles(resolve(old)).map((f) => [f.name, path.relative(old, f.filePath), f.isDefault]),
            [['quest-notes.md', 'quest-notes.q.md', true], ['ideas.md', path.join('notes', 'ideas.md'), false]], 'the old file first, under the default\'s name');

        assert.equal(pickQuestNotesFile(files, 'zeta.md').name, 'zeta.md');
        assert.equal(pickQuestNotesFile(files, undefined).name, 'quest-notes.md');
        assert.equal(pickQuestNotesFile(files, 'gone.md').name, 'quest-notes.md', 'a choice whose file is gone: the default');
    });

    test('NF-3: the name of a new notes file', () => {
        const existing = ['quest-notes.md', 'Ideas.md'];
        assert.deepEqual(newNotesFileName('meeting', existing), { ok: true, fileName: 'meeting.md', heading: '# meeting\n\n' });
        assert.deepEqual(newNotesFileName('  2026 plan.md ', existing), { ok: true, fileName: '2026 plan.md', heading: '# 2026 plan\n\n' });
        assert.deepEqual(newNotesFileName('Upper.MD', existing), { ok: true, fileName: 'Upper.MD', heading: '# Upper\n\n' });
        const refused = (input: string): string => {
            const r = newNotesFileName(input, existing);
            assert.equal(r.ok, false, `${JSON.stringify(input)} is refused`);
            return r.ok ? '' : r.problem;
        };
        assert.match(refused(''), /Enter a name/);
        assert.match(refused('   '), /Enter a name/);
        assert.match(refused('.md'), /Enter a name/);
        assert.match(refused('a/b'), /path separator/);
        assert.match(refused('a\\b'), /path separator/);
        assert.match(refused('/abs'), /path separator/);
        assert.match(refused('..'), /"\.\."/);
        assert.match(refused('a..b'), /"\.\."/);
        assert.match(refused('ideas'), /Ideas\.md exists already/);
        assert.match(refused('IDEAS.MD'), /Ideas\.md exists already/);
        assert.match(refused('Quest-Notes'), /quest-notes\.md exists already/, 'the default\'s name is taken, wherever its file is');
    });

    test('NF-4: the workspace notes file', () => {
        const aiRoot = path.join(SANDBOX, 'root', '_ai');
        const workspace = aiWorkspaceName(path.join(SANDBOX, 'root', 'tom_agent_container'));
        assert.equal(workspaceNotesFile(aiRoot, workspace), path.join(aiRoot, 'workspaces', 'tom_agent_container.notes.md'));
        assert.equal(path.dirname(workspaceNotesFile(aiRoot, workspace)), path.dirname(aiWorkspaceFile(aiRoot, workspace)), 'beside the quest list');
        assert.equal(WORKSPACE_NOTES_HEADER, '# Workspace notes\n\n');
    });

    test('NF-5: the one-time import', () => {
        const setup = (): { ws: string; target: string; picked: string } => {
            const ws = path.join(SANDBOX, `w${++counter}`);
            fs.mkdirSync(path.join(ws, '_ai'), { recursive: true });
            fs.mkdirSync(path.join(ws, 'elsewhere'), { recursive: true });
            return { ws, target: workspaceNotesFile(path.join(ws, '_ai'), 'w'), picked: path.join(ws, 'elsewhere', 'my-notes.txt') };
        };

        // From the picked file (it wins over notes.md).
        const a = setup();
        fs.writeFileSync(a.picked, 'picked notes\n');
        fs.writeFileSync(path.join(a.ws, 'notes.md'), 'root notes\n');
        assert.equal(workspaceNotesImportSource(a.target, a.picked, a.ws), a.picked);
        assert.deepEqual(ensureWorkspaceNotesFile(a.target, a.picked, a.ws), { created: true, importedFrom: a.picked });
        assert.equal(fs.readFileSync(a.target, 'utf8'), 'picked notes\n');
        assert.equal(fs.readFileSync(a.picked, 'utf8'), 'picked notes\n', 'the old file is left as it is');

        // From <workspace folder>/notes.md: no picked file, a picked file that is gone, an empty picked file.
        for (const picked of ['none', 'gone', 'empty'] as const) {
            const b = setup();
            fs.writeFileSync(path.join(b.ws, 'notes.md'), 'root notes\n');
            if (picked === 'empty') { fs.writeFileSync(b.picked, '  \n'); }
            const from = picked === 'none' ? undefined : b.picked;
            assert.deepEqual(ensureWorkspaceNotesFile(b.target, from, b.ws), { created: true, importedFrom: path.join(b.ws, 'notes.md') }, picked);
            assert.equal(fs.readFileSync(b.target, 'utf8'), 'root notes\n');
            assert.equal(fs.readFileSync(path.join(b.ws, 'notes.md'), 'utf8'), 'root notes\n');
        }

        // Nothing to import: no file, or only empty ones. The folder and the file are created with the heading.
        const c = setup();
        fs.writeFileSync(path.join(c.ws, 'notes.md'), '');
        assert.equal(workspaceNotesImportSource(c.target, undefined, c.ws), undefined);
        assert.equal(fs.existsSync(path.dirname(c.target)), false);
        assert.deepEqual(ensureWorkspaceNotesFile(c.target, undefined, c.ws), { created: true });
        assert.equal(fs.readFileSync(c.target, 'utf8'), '# Workspace notes\n\n');

        // The workspace notes file exists: no import, nothing written.
        const d = setup();
        fs.writeFileSync(d.picked, 'picked notes\n');
        fs.writeFileSync(path.join(d.ws, 'notes.md'), 'root notes\n');
        fs.mkdirSync(path.dirname(d.target), { recursive: true });
        fs.writeFileSync(d.target, 'mine\n');
        assert.equal(workspaceNotesImportSource(d.target, d.picked, d.ws), undefined);
        assert.deepEqual(ensureWorkspaceNotesFile(d.target, d.picked, d.ws), { created: false });
        assert.equal(fs.readFileSync(d.target, 'utf8'), 'mine\n');
        // Also an empty one: the import is once.
        fs.writeFileSync(d.target, '');
        assert.deepEqual(ensureWorkspaceNotesFile(d.target, d.picked, d.ws), { created: false });
        assert.equal(fs.readFileSync(d.target, 'utf8'), '');
    });

    test('NF-6: the notes entries of a quest folder', () => {
        assert.deepEqual(questFolderNotesEntries(quest()), []);
        const q = quest({ 'notes/quest-notes.md': 'd', 'notes/Alpha.md': 'a', 'notes/x.txt': 't', 'notes/sub/inner.md': 'i', 'overview.q.md': 'o' });
        assert.deepEqual(questFolderNotesEntries(q), ['notes/Alpha.md', 'notes/quest-notes.md']);
    });
});
