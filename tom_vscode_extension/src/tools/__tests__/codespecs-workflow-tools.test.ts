/**
 * The Phase-4 workflow tools (vsctasb9): tomAi_specCodeSpecsStatus over the
 * Meridian sample taken through every stage, and over documents stuck at each
 * one; tomAi_specCodeSpecsGuide over the packaged guides and runbooks.
 *
 *   WS-1  a fresh Meridian copy: the gate passes, nothing else exists; next is the extraction
 *   WS-2  stuck at Stage A: failing checks with their first findings, path and fix; next is the gate
 *   WS-3  extraction: written → done; the document edited afterwards → outdated
 *   WS-4  Stage B: no record → notStarted; a partial record → incomplete naming the missing areas; complete → done
 *   WS-5  the tree: no quest → notChecked; none in the quest → notStarted; created → done; authoring counts
 *         the todos done and names the next one
 *   WS-6  validation: without `shared` notChecked; with the trio it runs
 *   WS-7  the guide tool: the overview, an outline, a section, a runbook with its arguments, refusals
 *   WS-8  registration: both read-only
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codespecs-workflow-'));
installVscodeStub({ workspaceFolders: [ws] });

import { CodeSpecsGateEntry, CodeSpecsGateRecord, CodeSpecsGateVerdict } from 'tom_som_typescript_runtime';
import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import * as questTodo from '../../managers/questTodoManager.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import type { QuestTodoFull, QuestTodoStoreAccess } from '../quest-todo-tools.js';
import { codeSpecsWriteExtractsImpl } from '../codespecs-tools.js';
import { codeSpecsPlanTodosImpl, type PlanTodoDeps } from '../codespecs-plan-tools.js';
import {
    CODESPECS_WORKFLOW_TOOLS,
    codeSpecsGuideImpl,
    codeSpecsStatusImpl,
    type StatusDeps,
} from '../codespecs-workflow-tools.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(EXT_ROOT, 'src', 'tools', '__tests__', 'fixtures', 'phase4');
const AI_BUILD = path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const MERIDIAN_YAML = fs.readFileSync(path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml'), 'utf8');
const FR = 'SBP/introductionAndScope/requirements/functionalRequirements';
const EXTRACTS = path.join('generated-doc', 'codespecs_extracts');

const put = (name: string, text: string): string => {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), text);
    return name;
};

const service = SomModelService.instance;
const store = new SomDocumentStore(service);
const deps: SpecToolDeps = { wsRoot: ws, store, service };

const todoStore: QuestTodoStoreAccess = {
    listFiles: (q) => questTodo.listTodoFiles(q),
    listTodos: (q) => questTodo.readAllTodos(q).map((t) => ({ id: t.id, description: t.description, status: t.status, tags: t.tags })) as never,
    findById: (q, id) => questTodo.findTodoById(q, id) as unknown as QuestTodoFull | undefined,
    create: (q, todo, file) => questTodo.createTodo(q, todo as never, file) as unknown as QuestTodoFull,
    update: () => undefined,
    move: () => undefined,
    delete: () => false,
};
const plan: PlanTodoDeps = {
    todos: { store: todoStore },
    allTodos: (q) => questTodo.readAllTodos(q, questTodo.ALL_TODO_FILES),
    now: () => new Date(2026, 9, 19, 23),
};
let activeQuest = '';
const status: StatusDeps = { plan, activeQuest: () => activeQuest };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const statusOf = async (input: object): Promise<Json> => JSON.parse(await codeSpecsStatusImpl(deps, status, input as never));
const stage = (r: Json, name: string): Json => r.stages.find((s: Json) => s.stage === name);
const states = (r: Json): Record<string, string> => Object.fromEntries(r.stages.map((s: Json) => [s.stage, s.state]));

function meridian(dir: string): string {
    return put(`${dir}/meridian.docspecs.yaml`, MERIDIAN_YAML);
}

/** A gate record over every active area, all sufficient — or only the first `count`. */
function record(dir: string, count?: number): void {
    const areas = service.codeSpecsCatalog.activeAreas.slice(0, count);
    const entries = areas.map((a) => new CodeSpecsGateEntry({ area: a.code, verdict: CodeSpecsGateVerdict.sufficient }));
    put(path.join(dir, EXTRACTS, 'gate.verdicts.yaml'), new CodeSpecsGateRecord(entries).toYaml());
}

describe('CodeSpecs workflow', () => {
    before(() => { void service.model; });

    test('WS-1: a fresh document', async () => {
        const file = meridian('w1');
        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsStatus:typical', () =>
            codeSpecsStatusImpl(deps, status, { file })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(states(r), {
            gate: 'done', extraction: 'notStarted', verdicts: 'notStarted', todoTree: 'notChecked', authoring: 'notChecked', validation: 'notChecked',
        });
        assert.equal(stage(r, 'extraction').tool, 'tomAi_specCodeSpecsWriteExtracts');
        assert.deepEqual([r.next.stage, r.next.tool], ['extraction', 'tomAi_specCodeSpecsWriteExtracts']);
        assert.match(r.next.action, /codespecs-extraction/);
    });

    test('WS-2: stuck at Stage A', async () => {
        const loaded = store.load(path.join(ws, meridian('w2')));
        loaded.document.setFormField(`${FR}/FRE-REQU-LST-2/FRED`, 'description', '');
        const file = put('w2/meridian.docspecs.yaml', store.render(loaded, { stamp: loaded.stamp }));
        const r = await statusOf({ file });
        const gate = stage(r, 'gate');
        assert.equal(gate.state, 'failing');
        assert.match(gate.summary, /A1/);
        const a1 = gate.details.failing.find((f: Json) => f.check === 'A1');
        assert.equal(a1.first[0].path, `${FR}/FRE-REQU-LST-2/FRED`);
        assert.match(a1.fix, /tomAi_specSetFormField/);
        assert.equal(r.next.stage, 'gate');
    });

    test('WS-3: extraction done, then outdated', async () => {
        const file = meridian('w3');
        const written = JSON.parse(await codeSpecsWriteExtractsImpl(deps, { file }));
        assert.equal(written.ok, true, JSON.stringify(written));
        let r = await statusOf({ file });
        assert.equal(stage(r, 'extraction').state, 'done');
        assert.equal(r.next.stage, 'verdicts');
        const loaded = store.load(path.join(ws, file));
        loaded.document.setFormField('SBP/informationAndDataModel/dataModel/DAENT-ENTI-LST-1/DAENT-IDEN', 'entityName', 'SalesOrder');
        put(file, store.render(loaded, { stamp: loaded.stamp }));
        r = await statusOf({ file });
        const extraction = stage(r, 'extraction');
        assert.equal(extraction.state, 'outdated');
        assert.ok(extraction.details.counts.changed > 0);
        // The rename also leaves references to the old name dangling, so Stage A fails and comes first.
        assert.equal(stage(r, 'gate').state, 'failing');
        assert.equal(r.next.stage, 'gate');
    });

    test('WS-4: Stage B', async () => {
        const file = meridian('w4');
        await codeSpecsWriteExtractsImpl(deps, { file });
        assert.equal(stage(await statusOf({ file }), 'verdicts').state, 'notStarted');
        record('w4', 3);
        const partial = stage(await statusOf({ file }), 'verdicts');
        assert.equal(partial.state, 'incomplete');
        assert.equal(partial.details.missing.length, service.codeSpecsCatalog.activeAreas.length - 3);
        record('w4');
        const r = await statusOf({ file });
        assert.equal(stage(r, 'verdicts').state, 'done');
        assert.deepEqual([r.next.stage, r.next.state], ['todoTree', 'notChecked'], 'no quest yet');
        assert.match(r.next.action, /questId/);
    });

    test('WS-5: the tree and authoring', async () => {
        const file = meridian('w5');
        await codeSpecsWriteExtractsImpl(deps, { file });
        record('w5');
        activeQuest = 'qw5';
        let r = await statusOf({ file });
        assert.equal(r.questId, 'qw5', 'the active quest by default');
        assert.equal(stage(r, 'todoTree').state, 'notStarted');
        assert.equal(stage(r, 'authoring').state, 'blocked');
        assert.equal(r.next.stage, 'todoTree');

        const created = JSON.parse(await codeSpecsPlanTodosImpl(deps, plan, { file, questId: 'qw5', appName: 'meridian' }));
        assert.equal(created.ok, true, JSON.stringify(created));
        r = await statusOf({ file });
        assert.equal(stage(r, 'todoTree').state, 'done');
        const authoring = stage(r, 'authoring');
        assert.equal(authoring.state, 'notStarted');
        assert.match(authoring.details.nextTodo.id, /^csproj1_/);
        assert.deepEqual([authoring.details.stepsDone, authoring.details.steps], [0, 31]);

        for (const t of questTodo.readAllTodos('qw5').filter((x) => /^(csproj1|csgen1|csgen2)_/.test(x.id))) {
            questTodo.updateTodo('qw5', t.id, { status: 'completed' } as never);
        }
        r = await statusOf({ file });
        const later = stage(r, 'authoring');
        assert.equal(later.state, 'incomplete');
        assert.equal(later.details.stepsDone, 2);
        assert.match(later.details.nextTodo.id, /^csgen3_/);
        assert.equal(r.next.stage, 'authoring');
        activeQuest = '';
    });

    test('WS-6: validation', async () => {
        const file = meridian('w6');
        assert.equal(stage(await statusOf({ file }), 'validation').state, 'notChecked');
        fs.cpSync(path.join(FIXTURE, 'codespec'), path.join(ws, 'w6', 'codespec'), { recursive: true });
        // The fixture trio was generated from another document, so against Meridian it does not validate clean.
        const before = stage(await statusOf({ file, shared: 'w6/codespec/shared' }), 'validation');
        assert.ok(['done', 'failing'].includes(before.state), JSON.stringify(before));
        assert.equal(before.details.checkCount, 41);
        assert.ok(before.details.notRun.includes(19), 'without extracts, the extract checks are not run');
        await codeSpecsWriteExtractsImpl(deps, { file });
        const v = stage(await statusOf({ file, shared: 'w6/codespec/shared' }), 'validation');
        assert.equal(v.state, 'failing', JSON.stringify(v));
        assert.ok(v.details.violations > 0 && !v.details.notRun.includes(19), 'with the extracts, Meridian\'s tokens are checked');
    });

    test('WS-7: the guide tool', async () => {
        const all = JSON.parse(await withTiming('tomAi_specCodeSpecsGuide:typical', () => codeSpecsGuideImpl({})));
        assert.deepEqual(all.guides.map((g: Json) => g.id), ['prompt', 'mapping']);
        assert.ok(all.guides[0].sections.some((s: string) => /^6 Stage B/.test(s)), JSON.stringify(all.guides[0].sections));
        assert.equal(all.runbooks.length, 7);
        const outline = JSON.parse(await codeSpecsGuideImpl({ guide: 'mapping' }));
        assert.ok(outline.sections.some((s: Json) => s.number === '4.4.6'));
        const section = JSON.parse(await codeSpecsGuideImpl({ guide: 'prompt', section: '6.2' }));
        assert.equal(section.ok, true);
        assert.match(section.text, /^### 6\.2 /);
        const runbook = JSON.parse(await codeSpecsGuideImpl({ runbook: 'codespecs-authoring-step', file: 'specs/sbp.docspecs.yaml', step: 10 }));
        assert.match(runbook.text, /csgen10/);
        assert.match(runbook.text, /specs\/sbp\.docspecs\.yaml/);
        assert.match(runbook.text, /From the guide \(mapping §4\.4\.6\)/);
        assert.equal(JSON.parse(await codeSpecsGuideImpl({ guide: 'nope' })).code, 'unknownGuide');
        assert.equal(JSON.parse(await codeSpecsGuideImpl({ guide: 'prompt', section: '99' })).code, 'unknownSection');
        assert.equal(JSON.parse(await codeSpecsGuideImpl({ runbook: 'nope' })).code, 'unknownRunbook');
    });

    test('WS-8: registration', () => {
        assert.deepEqual(CODESPECS_WORKFLOW_TOOLS.map((t) => [t.name, t.readOnly, t.requiresApproval ?? false]), [
            ['tomAi_specCodeSpecsStatus', true, false],
            ['tomAi_specCodeSpecsGuide', true, false],
        ]);
    });
});
