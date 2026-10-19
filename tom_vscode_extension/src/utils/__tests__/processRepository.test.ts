/**
 * The process files on disk (src/utils/processRepository.ts): definitions
 * under `<processes>/<id>/`, the per-quest state file under the quest folder.
 *
 *   PR-1  lists every process folder: a valid one with its definition and description,
 *         an invalid one with its errors, a folder without a .process.yaml not at all
 *   PR-2  creating a process writes a starter definition that validates and an .md; an existing id is refused
 *   PR-3  copying writes the source under a new id (the id inside the YAML too); unknown source or taken id refused
 *   PR-4  saving validates first: an invalid definition writes nothing; a valid one writes YAML and description
 *   PR-5  the state of a quest: missing file is the empty state; written state reads back
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProcessRepository } from '../processRepository.js';
import { EMPTY_PROCESS_STATE, parseProcessYaml, selectProcess } from '../processDefinition.js';

let root: string;
let repo: ProcessRepository;

const VALID = 'id: flow\nname: Flow\nphases:\n  - id: one\n    steps:\n      - id: work\n        role: default\n    gate:\n      id: gate\n';

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-repo-'));
    repo = new ProcessRepository(path.join(root, 'processes'), path.join(root, 'quests'));
});

function writeProcess(id: string, yaml: string | null, md?: string): void {
    const dir = path.join(root, 'processes', id);
    fs.mkdirSync(dir, { recursive: true });
    if (yaml !== null) { fs.writeFileSync(path.join(dir, `${id}.process.yaml`), yaml); }
    if (md !== undefined) { fs.writeFileSync(path.join(dir, `${id}.md`), md); }
}

describe('ProcessRepository', () => {
    test('PR-1: listing', () => {
        writeProcess('flow', VALID, '# Flow\n\nHow we flow.');
        writeProcess('broken', 'id: broken\nphases: []\n');
        writeProcess('empty', null);
        const list = repo.list();
        assert.deepEqual(list.map((p) => p.id), ['broken', 'flow']);
        const flow = list.find((p) => p.id === 'flow')!;
        assert.equal(flow.definition?.name, 'Flow');
        assert.equal(flow.description, '# Flow\n\nHow we flow.');
        assert.deepEqual(list.find((p) => p.id === 'broken')!.errors.map((e) => e.path), ['phases']);
        assert.deepEqual(list.find((p) => p.id === 'broken')!.raw, { id: 'broken', phases: [] }, 'an invalid one still opens in the editor');
        assert.deepEqual([...repo.definitions().keys()], ['flow'], 'only valid definitions can be used');
        assert.deepEqual(new ProcessRepository(path.join(root, 'none'), root).list(), [], 'no folder, no processes');
    });

    test('PR-2: creating', () => {
        const r = repo.create('new_flow', 'New flow');
        assert.deepEqual(r, { ok: true });
        const entry = repo.list().find((p) => p.id === 'new_flow')!;
        assert.deepEqual(entry.errors, []);
        assert.equal(entry.definition?.name, 'New flow');
        assert.match(entry.description, /^# New flow/);
        assert.deepEqual(repo.create('new_flow'), { ok: false, error: 'a process "new_flow" exists already' });
        assert.deepEqual(repo.create('bad id'), { ok: false, error: 'id: letters, digits, "_" and "-" only, starting with a letter or digit' });
    });

    test('PR-3: copying', () => {
        writeProcess('flow', VALID, '# Flow');
        assert.deepEqual(repo.copy('flow', 'flow2'), { ok: true });
        const copy = repo.list().find((p) => p.id === 'flow2')!;
        assert.equal(copy.definition?.id, 'flow2');
        assert.equal(copy.description, '# Flow');
        assert.equal(fs.existsSync(path.join(root, 'processes', 'flow2', 'flow2.process.yaml')), true);
        assert.deepEqual(repo.copy('nope', 'x'), { ok: false, error: 'no process "nope"' });
        assert.deepEqual(repo.copy('flow', 'flow2'), { ok: false, error: 'a process "flow2" exists already' });
    });

    test('PR-4: saving', () => {
        writeProcess('flow', VALID, '# Flow');
        const def = parseProcessYaml(VALID).definition!;
        const bad = repo.save({ ...def, phases: [] }, 'x');
        assert.equal(bad.ok, false);
        assert.equal(fs.readFileSync(path.join(root, 'processes', 'flow', 'flow.md'), 'utf-8'), '# Flow', 'nothing written');
        const renamed = { ...def, name: 'Flow, renamed' };
        assert.deepEqual(repo.save(renamed, '# Flow\n\nNow described.'), { ok: true });
        const entry = repo.list().find((p) => p.id === 'flow')!;
        assert.equal(entry.definition?.name, 'Flow, renamed');
        assert.equal(entry.description, '# Flow\n\nNow described.');
    });

    test('PR-5: quest state', () => {
        writeProcess('flow', VALID);
        assert.deepEqual(repo.readState('q1'), EMPTY_PROCESS_STATE);
        const state = selectProcess(repo.definitions().get('flow')!);
        repo.writeState('q1', state);
        assert.equal(fs.existsSync(path.join(root, 'quests', 'q1', 'process-state.q1.yaml')), true);
        assert.deepEqual(repo.readState('q1'), state);
    });
});
