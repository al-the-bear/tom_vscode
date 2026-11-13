/**
 * The documents a review step puts in front of the user (vscimpb64): `documents:` on a step or sub-step
 * (src/utils/processDocuments.ts), the PROCESS view's links, the process editor's block, tomAi_getProcessState.
 *
 *   PD-1 the definition: `documents:` on a step, a sub-step, a gate and a post-gate step validates; an entry
 *        without a path, an unknown key, a label that is no text and a list that is no list are refused; Save
 *        writes {path, label} with an empty label left out; the schema has it on all three step shapes
 *   PD-2 which documents: the sub-step's own, else its step's; none at another step, without a process or once
 *        the process is finished
 *   PD-3 the paths: ${<chat variable>} (with or without custom.), ${input.<name>}, ${output.<name>},
 *        ${dirname:<variable>} (a file in the workspace root gives a relative path, not `/…`); a placeholder
 *        without a value leaves the link unresolved; a .md file opens in the MD Browser, a process definition under
 *        _ai/processes in the process editor (its id), any other file in its editor; the label defaults to the file
 *        name; a path outside the workspace stays absolute; whether the file exists is checked
 *   PD-4 the PROCESS view: at a user action the Your turn box lists one link per document with its label and path; a
 *        click posts openDocument with its index; an unresolved or missing document is shown and disabled, saying
 *        why; at a position that is not the user's the links stand on their own; none without documents; the host
 *        sends the resolved links and opens by index (MD Browser reused, process editor, default editor) and warns
 *        for an unresolved or missing one
 *   PD-5 the process editor: a Documents block on every step and sub-step; add a document, fill path and label;
 *        Save holds them; remove the last one and the key goes
 *   PD-6 tomAi_getProcessState names the position's documents (label, path, exists, opensIn, unresolved)
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { stringifyProcessDefinition, validateProcessDefinition, type ProcessDefinition, type ProcessState } from '../processDefinition.js';
import { documentLinks, documentLookup, documentOpener, positionDocuments, resolveDocumentPath } from '../processDocuments.js';
import { getProcessStateImpl, type ProcessToolDeps } from '../../tools/quest-process-tools.js';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (panel: string, file: string): string => readFileSync(join(ROOT, 'media', panel, file), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(panel: string): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset(panel, 'index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const w = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true }).window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => undefined });
    w.eval(asset(panel, 'main.js'));
    return { w, posted };
}
const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const text = (el: Win): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const IDEA: ProcessDefinition = {
    id: 'idea', name: 'Idea',
    phases: [{
        id: 'blueprint', name: 'Blueprint',
        steps: [
            { id: 'initial', name: '01 Initial Version', prompt: 'Write it.' },
            { id: 'review-initial', name: 'Review the Initial Version', userAction: true, documents: [{ path: '${idea-document}', label: 'Working document' }] },
            {
                id: 'iteration', name: '02 Iteration', repeatable: true,
                documents: [{ path: '${idea-document}' }],
                substeps: [
                    { id: 'revise', name: 'Revise', prompt: 'Revise.' },
                    { id: 'review', name: 'Review', userAction: true, documents: [{ path: '${dirname:idea-document}/${idea}.todos.md', label: 'Todos document' }, { path: '${idea-document}', label: 'Working document' }] },
                ],
            },
        ],
        gate: { id: 'g2', documents: [{ path: '${idea-document}' }] },
        postGate: { id: 'after', documents: [{ path: 'notes.md' }] },
    }],
} as ProcessDefinition;
const at = (step: string, substep = ''): ProcessState => ({ process: 'idea', phase: 'blueprint', phaseIteration: 1, step, stepIteration: 1, substep, substepIteration: 1, completed: false });

const VALUES = { quest: 'q1', 'custom.idea': 'collab', 'custom.idea-document': '_ai/quests/q1/ideas/collab/collab.md' };
const WS = '/ws';
const EXISTING = new Set(['/ws/_ai/quests/q1/ideas/collab/collab.md']);
const exists = (abs: string): boolean => EXISTING.has(abs);

describe('the documents of a review step', () => {
    test('PD-1: the definition', () => {
        assert.deepEqual(validateProcessDefinition(IDEA).errors, [], 'on a step, a sub-step, a gate and a post-gate step');
        const bad = JSON.parse(JSON.stringify(IDEA));
        bad.phases[0].steps[1].documents = [{ label: 'no path' }, { path: 'a.md', label: 3 }, { path: 'b.md', where: 'x' }, 'c.md'];
        bad.phases[0].steps[0].documents = 'a.md';
        const errors = validateProcessDefinition(bad).errors.map((e) => `${e.path}: ${e.message}`);
        assert.deepEqual(errors.filter((e) => e.includes('documents')).sort(), [
            'phases[0].steps[0].documents: a list of {path, label}',
            'phases[0].steps[1].documents[0].path: a path (placeholders allowed)',
            'phases[0].steps[1].documents[1].label: text expected',
            'phases[0].steps[1].documents[2].where: unknown key',
            'phases[0].steps[1].documents[3]: an object {path, label}',
        ].sort());
        const saved = JSON.parse(JSON.stringify(IDEA));
        saved.phases[0].steps[1].documents = [{ path: '${idea-document}', label: '' }];
        const yaml = stringifyProcessDefinition(saved);
        assert.match(yaml, /userAction: true\n\s+documents:\n\s+- path: \$\{idea-document\}\n\s+- id: iteration/, 'an empty label is left out');
        assert.match(stringifyProcessDefinition(IDEA), /- path: \$\{dirname:idea-document\}\/\$\{idea\}\.todos\.md\n\s+label: Todos document/);
        const schema = readFileSync(join(ROOT, 'src', 'config', 'process.schema.json'), 'utf-8');
        assert.equal((schema.match(/"documents": \{\n\s+"\$ref": "#\/\$defs\/documents"/g) ?? []).length, 3, 'substep, step and post-gate step');
        assert.match(schema, /"documents": \{\n\s+"type": "array",[\s\S]*?"required": \["path"\]/);
    });

    test('PD-2: which documents', () => {
        assert.deepEqual(positionDocuments(IDEA, at('review-initial')), [{ path: '${idea-document}', label: 'Working document' }]);
        assert.equal(positionDocuments(IDEA, at('iteration', 'review')).length, 2, 'the sub-step\'s own');
        assert.deepEqual(positionDocuments(IDEA, at('iteration', 'revise')), [{ path: '${idea-document}' }], 'else its step\'s');
        assert.deepEqual(positionDocuments(IDEA, at('initial')), []);
        assert.deepEqual(positionDocuments(null, at('review-initial')), []);
        assert.deepEqual(positionDocuments(IDEA, { ...at('review-initial'), process: '' }), []);
        assert.deepEqual(positionDocuments(IDEA, { ...at('review-initial'), completed: true }), []);
    });

    test('PD-3: the paths', () => {
        const state: ProcessState = { ...at('review-initial'), inputs: { folder: 'specs/change-7' }, outputs: { report: 'specs/change-7/report.txt' } };
        const lookup = documentLookup(VALUES, state);
        assert.deepEqual(resolveDocumentPath('${idea-document}', lookup), { path: '_ai/quests/q1/ideas/collab/collab.md', unresolved: [] });
        assert.deepEqual(resolveDocumentPath('${custom.idea}/x.md', lookup).path, 'collab/x.md');
        assert.equal(resolveDocumentPath('${dirname:idea-document}/${idea}.todos.md', lookup).path, '_ai/quests/q1/ideas/collab/collab.todos.md');
        assert.equal(resolveDocumentPath('${input.folder}/change.md', lookup).path, 'specs/change-7/change.md');
        assert.equal(resolveDocumentPath('${output.report}', lookup).path, 'specs/change-7/report.txt');
        assert.equal(resolveDocumentPath('${dirname:top}/b.md', documentLookup({ top: 'a.md' })).path, 'b.md', 'a file in the root: relative');
        assert.equal(resolveDocumentPath('${abs}', documentLookup({ abs: '/elsewhere/a.md' })).path, '/elsewhere/a.md', 'an absolute value stays');
        assert.deepEqual(resolveDocumentPath('_ai/quests/${quest}/designs/${design}/${design}.md', lookup), {
            path: '_ai/quests/q1/designs/${design}/${design}.md', unresolved: ['${design}', '${design}'],
        });
        assert.deepEqual(documentOpener('a/b.md'), { opener: 'mdBrowser' });
        assert.deepEqual(documentOpener('_ai/processes/flow/flow.process.yaml'), { opener: 'processEditor', processId: 'flow' });
        assert.deepEqual(documentOpener('x/_ai/processes/flow/other.process.yaml'), { opener: 'editor' }, 'not the process\'s own definition');
        assert.deepEqual(documentOpener('report.txt'), { opener: 'editor' });
        const links = documentLinks([
            { path: '${idea-document}' },
            { path: '${dirname:idea-document}/${idea}.todos.md', label: 'Todos document' },
            { path: '${design}.md', label: 'Design' },
            { path: '/elsewhere/a.yaml' },
        ], lookup, WS, exists);
        assert.deepEqual(links.map((l) => [l.label, l.path, l.opener, l.exists, l.unresolved]), [
            ['collab.md', '_ai/quests/q1/ideas/collab/collab.md', 'mdBrowser', true, []],
            ['Todos document', '_ai/quests/q1/ideas/collab/collab.todos.md', 'mdBrowser', false, []],
            ['Design', '', 'mdBrowser', false, ['${design}']],
            ['a.yaml', '/elsewhere/a.yaml', 'editor', false, []],
        ]);
        assert.equal(links[0].absPath, '/ws/_ai/quests/q1/ideas/collab/collab.md');
    });

    test('PD-4: the PROCESS view', () => {
        const { w, posted } = setup('processPanel');
        try {
            const documents = documentLinks(positionDocuments(IDEA, at('iteration', 'review')), documentLookup(VALUES), WS, exists);
            const viewState = (state: ProcessState, docs: unknown[]): Record<string, unknown> => ({
                type: 'state', quest: 'q1', processes: [{ id: 'idea', name: 'Idea', valid: true }], state, definition: IDEA, description: '',
                stepRole: '', chatRole: '', stepRun: null, moves: [{ kind: 'proceed', level: null, label: 'Proceed', to: '' }], levels: [], startable: 0, documents: docs,
            });
            send(w, viewState(at('iteration', 'review'), documents));
            const box = w.document.querySelector('.user-action');
            assert.ok(box, 'the Your turn box');
            const links = [...box.querySelectorAll('.documents .doc-link')];
            assert.deepEqual(links.map(text), ['Todos document _ai/quests/q1/ideas/collab/collab.todos.md', 'Working document _ai/quests/q1/ideas/collab/collab.md']);
            assert.equal(links[0].disabled, true, 'the todos document does not exist yet');
            assert.match(links[0].title, /^Does not exist yet: /);
            assert.equal(links[1].disabled, false);
            assert.match(links[1].title, /^Open in the MD Browser: /);
            links[1].click();
            assert.deepEqual(posted.at(-1), { type: 'openDocument', index: 1 });
            // Unresolved: shown, disabled, saying which placeholder.
            send(w, viewState(at('review-initial'), [{ label: 'Design', path: '', absPath: '', opener: 'mdBrowser', exists: false, unresolved: ['${design}'] }]));
            const off = w.document.querySelector('.user-action .doc-link');
            assert.equal(off.disabled, true);
            assert.equal(off.title, 'Not set yet: ${design}');
            // Not the user's position: the links stand on their own.
            send(w, viewState(at('iteration', 'revise'), documents.slice(1)));
            assert.equal(w.document.querySelector('.user-action'), null);
            assert.equal(w.document.querySelectorAll('.documents .doc-link').length, 1);
            send(w, viewState(at('initial'), []));
            assert.equal(w.document.querySelector('.documents'), null, 'none without documents');
        } finally { w.close(); }
        const host = readFileSync(join(ROOT, 'src', 'handlers', 'processPanel-handler.ts'), 'utf-8');
        assert.match(host, /documents: this\.documents\(\),/);
        assert.match(host, /documentLinks\(positionDocuments\(def, state\), documentLookup\(values, state\), root, \(abs\) => fs\.existsSync\(abs\)\)/);
        assert.match(host, /case 'openDocument':\s*await this\.openDocument\(Number\(msg\.index\)\);/);
        assert.match(host, /link\.opener === 'processEditor' && link\.processId\) \{ openProcessEditor\(this\.context, link\.processId\)/);
        assert.match(host, /openInMdBrowserImpl\(mdBrowserController, \{ filePath: link\.absPath \}\)/, 'the MD Browser, a panel on it reused');
        assert.match(host, /executeCommand\('vscode\.open', vscode\.Uri\.file\(link\.absPath\)\)/);
        assert.match(host, /has no path yet/);
        assert.match(host, /does not exist yet/);
    });

    test('PD-5: the process editor', () => {
        const { w, posted } = setup('processEditor');
        try {
            send(w, { type: 'list', processes: [{ id: 'idea', name: 'Idea', valid: true, inputs: [], phases: [] }], roles: [], currentProcess: '' });
            const def = JSON.parse(JSON.stringify(IDEA));
            delete def.phases[0].steps[1].documents;
            send(w, { type: 'load', id: 'idea', definition: def, description: '', errors: [], files: { definition: 'idea.process.yaml', description: 'idea.md' } });
            const doc = w.document;
            for (const p of ['phases.0.steps.0', 'phases.0.steps.2.substeps.1', 'phases.0.gate']) {
                assert.ok(doc.querySelector(`[data-op="add-document"][data-path="${p}"]`), p);
            }
            doc.querySelector('[data-op="add-document"][data-path="phases.0.steps.1"]').click();
            const set = (sel: string, value: string): void => {
                const el = doc.querySelector(sel);
                assert.ok(el, sel);
                el.value = value;
                el.dispatchEvent(new w.Event('input', { bubbles: true }));
                el.dispatchEvent(new w.Event('change', { bubbles: true }));
            };
            set('[data-path="phases.0.steps.1.documents.0.path"]', '${idea-document}');
            set('[data-path="phases.0.steps.1.documents.0.label"]', 'Working document');
            doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
            const saved = (posted.filter((m) => m.type === 'save').pop() as Win).definition;
            assert.deepEqual(saved.phases[0].steps[1].documents, [{ path: '${idea-document}', label: 'Working document' }]);
            doc.querySelector('[data-op="remove"][data-path="phases.0.steps.1.documents.0"]').click();
            doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
            const again = (posted.filter((m) => m.type === 'save').pop() as Win).definition;
            assert.equal('documents' in again.phases[0].steps[1], false, 'the last one removed: the key goes');
        } finally { w.close(); }
    });

    test('PD-6: tomAi_getProcessState names them', async () => {
        const state = at('review-initial');
        const deps: ProcessToolDeps = {
            list: () => [], activeQuest: () => 'q1', state: () => state, currentRole: () => '', contextBlock: () => '',
            apply: () => ({ ok: true, state }), dropProcessMoveMarkers: () => 0,
            documents: (s: ProcessState) => documentLinks(positionDocuments(IDEA, s), documentLookup(VALUES, s), WS, exists),
        } as unknown as ProcessToolDeps;
        const r = JSON.parse(await getProcessStateImpl(deps));
        assert.deepEqual(r.documents, [{ label: 'Working document', path: '_ai/quests/q1/ideas/collab/collab.md', exists: true, opensIn: 'mdBrowser' }]);
        const none = JSON.parse(await getProcessStateImpl({ ...deps, state: () => at('initial') } as ProcessToolDeps));
        assert.equal('documents' in none, false);
        const unresolved = JSON.parse(await getProcessStateImpl({ ...deps, documents: () => documentLinks([{ path: '${design}.md' }], documentLookup({}), WS, exists) } as ProcessToolDeps));
        assert.deepEqual(unresolved.documents[0].unresolved, ['${design}']);
    });
});
