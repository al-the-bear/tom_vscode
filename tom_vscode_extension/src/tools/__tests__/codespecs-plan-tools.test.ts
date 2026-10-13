/**
 * CodeSpecs Stage C, the Phase-4 todo tree (vsctsa21). The todos are written
 * by the real questTodoManager into a temp workspace's quest folder, and the
 * tree is walked by the queue's own prefix iteration (queueStep3Utils).
 *
 *   PT-1  dryRun over phase4_codespecs_run's extracts: csproj1 and csgen1–31 in step order; nothing written
 *   PT-2  create: 32 todos, statuses, dependencies, references; csgen* walks 1..31 and csproj* first
 *   PT-3  creating twice duplicates nothing, archived todos included
 *   PT-4  an unresolved insufficient area gets a decision-needed csopen; a descoped one does not; numbering continues
 *   PT-5  refusals: no record, an incomplete record, no quest; no appName makes csproj1 decision-needed
 *   PT-6  Stage A with the document: Meridian and the corpus record pass, a broken copy is refused
 *   PT-7  registration
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codespecs-plan-'));
installVscodeStub({ workspaceFolders: [ws] });

import { CodeSpecsGateEntry, CodeSpecsGateRecord, CodeSpecsGateVerdict } from 'tom_som_typescript_runtime';
import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import * as questTodo from '../../managers/questTodoManager.js';
import { collectDecisionNeededTodos, pickNextTodoForIteration } from '../../utils/queueStep3Utils.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import type { QuestTodoFull, QuestTodoStoreAccess } from '../quest-todo-tools.js';
import { CODESPECS_PLAN_TOOLS, codeSpecsPlanTodosImpl, slugOf, type PlanTodoDeps } from '../codespecs-plan-tools.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(EXT_ROOT, 'src', 'tools', '__tests__', 'fixtures', 'phase4');
const AI_BUILD = path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const MERIDIAN_YAML = fs.readFileSync(path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml'), 'utf8');
const CORPUS = path.join(AI_BUILD, 'tom_som_conformance', 'generated-doc', 'codespecs_extracts');
const EXTRACTS = path.join('generated-doc', 'codespecs_extracts');

const put = (name: string, text: string): string => {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), text);
    return name;
};

const service = SomModelService.instance;
const store = new SomDocumentStore(service);
const deps: SpecToolDeps = { wsRoot: ws, store, service };

/** The live store's forwarding, over the real manager (chat-enhancement-tools imports vscode and cannot load here). */
const todoStore: QuestTodoStoreAccess = {
    listFiles: (q) => questTodo.listTodoFiles(q),
    listTodos: (q) => questTodo.readAllTodos(q).map((t) => ({ id: t.id, description: t.description, status: t.status, tags: t.tags })) as never,
    findById: (q, id) => questTodo.findTodoById(q, id) as unknown as QuestTodoFull | undefined,
    create: (q, todo, file) => questTodo.createTodo(q, todo as never, file) as unknown as QuestTodoFull,
    update: () => undefined,
    move: () => undefined,
    delete: () => false,
};
const NOW = new Date(2026, 9, 13, 15);
const plan: PlanTodoDeps = {
    todos: { store: todoStore },
    allTodos: (q) => questTodo.readAllTodos(q, questTodo.ALL_TODO_FILES),
    now: () => NOW,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const call = async (input: object): Promise<Json> => JSON.parse(await codeSpecsPlanTodosImpl(deps, plan, input as never));
const todosOf = (quest: string) => questTodo.readAllTodos(quest, questTodo.ALL_TODO_FILES);

/** A spec root with the phase4 fixture's extracts and a record: these areas sufficient, the rest not applicable. */
type VerdictProps = { verdict: CodeSpecsGateVerdict; resolution?: string; note?: string };
function phase4Root(name: string, overrides: Array<[string, VerdictProps]> = []): string {
    const verdicts = new Map(overrides);
    for (const f of fs.readdirSync(path.join(FIXTURE, 'codespecs_extracts'))) {
        put(path.join(name, EXTRACTS, f), fs.readFileSync(path.join(FIXTURE, 'codespecs_extracts', f), 'utf8'));
    }
    const sufficient = new Set(['CE-API', 'CE-SU', 'CE-DB']);
    const entries = service.codeSpecsCatalog.activeAreas.map((a) => new CodeSpecsGateEntry(verdicts.has(a.code)
        ? { area: a.code, ...verdicts.get(a.code)! }
        : { area: a.code, verdict: sufficient.has(a.code) ? CodeSpecsGateVerdict.sufficient : CodeSpecsGateVerdict.notApplicable }));
    put(path.join(name, EXTRACTS, 'gate.verdicts.yaml'), new CodeSpecsGateRecord(entries).toYaml());
    return name;
}

describe('CodeSpecs plan todos', () => {
    before(() => { void service.model; });

    test('PT-1: dryRun proposes csproj1 and the 31 steps in order, writing nothing', async () => {
        phase4Root('p1');
        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsPlanTodos:typical', () =>
            codeSpecsPlanTodosImpl(deps, plan, { specRoot: 'p1', questId: 'q1', appName: 'phase4', dryRun: true })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.tree.csopen, []);
        assert.deepEqual(r.tree.csproj.map((t: Json) => [t.id, t.status]), [['csproj1_ajmp-scaffold-codespecs-trio', 'not-started']]);
        assert.equal(r.tree.csgen.length, 31);
        assert.deepEqual(r.tree.csgen.map((t: Json) => Number(/^csgen(\d+)_ajmp-/.exec(t.id)?.[1])), Array.from({ length: 31 }, (_, i) => i + 1));
        assert.equal(r.tree.csgen[9].title, 'csgen10: CE-DB entities/columns/repositories');
        const inScope = r.tree.csgen.filter((t: Json) => !t.outOfScope).map((t: Json) => /^csgen(\d+)/.exec(t.id)?.[1]);
        assert.deepEqual(inScope, ['5', '10', '18'], 'the steps authoring CE-API, CE-DB and CE-SU');
        assert.deepEqual(Object.entries(r.verdicts).sort(), [['not applicable', 24], ['sufficient', 3]]);
        assert.equal(r.stageA.checked, false);
        assert.equal(fs.existsSync(path.join(ws, '_ai', 'quests', 'q1')), false, 'a dry run writes nothing');
    });

    test('PT-2: create — the tree as the queue walks it', async () => {
        phase4Root('p2');
        const r = await call({ specRoot: 'p2', questId: 'q2', appName: 'phase4' });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.created.length, 32);
        assert.ok(r.created.every((id: string) => /^cs(proj|gen)\d+_ajmp-[a-z0-9-]+$/.test(id)), r.created.join(' '));
        const todos = todosOf('q2');
        const byStem = (stem: string): Json => todos.find((t) => t.id.startsWith(`${stem}_`));
        const proj = byStem('csproj1');
        assert.equal(proj.status, 'not-started');
        assert.match(proj.description, /- phase4_codespec_server: CE-API, CE-SU, CE-DB\n/);
        assert.match(proj.description, /- phase4_codespec_shared: CE-API\n/);
        const g10 = byStem('csgen10');
        assert.deepEqual(g10.dependencies, [proj.id, byStem('csgen9').id]);
        assert.ok(g10.references.some((ref: Json) => ref.path === 'p2/generated-doc/codespecs_extracts/CE-DB.extract.yaml'));
        assert.match(g10.description, /tomAi_specCodeSpecsStepContext\(\{extractsDir: 'p2\/generated-doc\/codespecs_extracts', step: 10\}\)/);
        assert.ok(g10.tags.includes('codespecs-step:10') && g10.tags.includes('codespecs-run:p2/generated-doc/codespecs_extracts'));
        assert.match(byStem('csgen31').description, /tomAi_specCodeSpecsValidate/);
        assert.match(byStem('csgen23').description, /two passes/);
        assert.match(byStem('csgen1').description, /Every area of this step is out of this pass/);

        assert.equal(pickNextTodoForIteration('csproj*', todos)?.id, proj.id);
        assert.equal(pickNextTodoForIteration('csopen*', todos), undefined);
        // The dispatcher marks the picked todo in-progress; the walk is the step order.
        const walked: number[] = [];
        const live = todos.map((t) => ({ id: t.id, status: t.status as string }));
        for (let next = pickNextTodoForIteration('csgen*', live); next; next = pickNextTodoForIteration('csgen*', live)) {
            walked.push(next.index);
            live.find((t) => t.id === next!.id)!.status = 'in-progress';
        }
        assert.deepEqual(walked, Array.from({ length: 31 }, (_, i) => i + 1));
    });

    test('PT-3: creating twice duplicates nothing, archived todos included', async () => {
        const again = await call({ specRoot: 'p2', questId: 'q2', appName: 'phase4' });
        assert.equal(again.ok, true);
        assert.deepEqual(again.created, []);
        assert.equal(again.existing.length, 32);

        const g1 = todosOf('q2').find((t) => t.id.startsWith('csgen1_'))!;
        questTodo.updateTodo('q2', g1.id, { status: 'completed' });
        const file = path.join(ws, '_ai', 'quests', 'q2', 'todos.q2.todo.yaml');
        questTodo.archiveTodos(file, [g1.id]);
        const third = await call({ specRoot: 'p2', questId: 'q2', appName: 'phase4' });
        assert.deepEqual(third.created, []);
        assert.ok(third.existing.includes(g1.id), 'an archived step is still the step');
        assert.equal(todosOf('q2').filter((t) => t.id.startsWith('csgen1_')).length, 1);
    });

    test('PT-4: an unresolved insufficient area opens a decision; a descoped one does not', async () => {
        phase4Root('p4', [
            ['CE-SU', { verdict: CodeSpecsGateVerdict.insufficient, note: 'DAENT-CLAS.aggregateRoot is empty on both entities' }],
            ['CE-EN', { verdict: CodeSpecsGateVerdict.insufficient, resolution: 'descoped' }],
        ]);
        // Another run's csopen in the same quest: the numbering continues after it.
        questTodo.createTodo('q4', { id: 'csopen1_ajmb-earlier', description: 'x', status: 'completed' } as never);
        const r = await call({ specRoot: 'p4', questId: 'q4', appName: 'phase4' });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.tree.csopen.map((t: Json) => [t.id, t.status]), [['csopen2_ajmp-ce-su-insufficient', 'decision-needed']]);
        assert.deepEqual(Object.entries(r.verdicts).sort(), [['descoped', 1], ['insufficient', 1], ['not applicable', 23], ['sufficient', 2]]);
        const open = questTodo.findTodoById('q4', 'csopen2_ajmp-ce-su-insufficient')!;
        assert.match(open.description, /aggregateRoot is empty on both entities/);
        assert.equal(open.decisions?.length, 1);
        assert.match(open.decisions![0].summary, /^CE-SU: complete the missing inputs, or descope/);
        const proj = todosOf('q4').find((t) => t.id.startsWith('csproj1_'))!;
        assert.deepEqual(proj.dependencies, ['csopen2_ajmp-ce-su-insufficient']);
        assert.match(proj.description, /Out of this pass \(no folders\): .*CE-EN \(insufficient, descoped\)/);
        assert.deepEqual(collectDecisionNeededTodos('csopen*', todosOf('q4')).map((t) => t.id), ['csopen2_ajmp-ce-su-insufficient']);
        assert.equal(pickNextTodoForIteration('csopen*', todosOf('q4')), undefined, 'the queue pauses on it');
        assert.match(r.next, /Answer the 1 csopen/);
    });

    test('PT-5: refusals, and a missing app name is a decision', async () => {
        put(path.join('p5', 'spec.md'), '# nothing\n');
        assert.equal((await call({ specRoot: 'p5', questId: 'q5' })).code, 'noGateRecord');
        phase4Root('p5b');
        const recordFile = path.join(ws, 'p5b', EXTRACTS, 'gate.verdicts.yaml');
        const partial = CodeSpecsGateRecord.fromYaml(fs.readFileSync(recordFile, 'utf8'));
        fs.writeFileSync(recordFile, new CodeSpecsGateRecord(partial.verdicts.filter((e) => e.area !== 'CE-DB' && e.area !== 'CE-JB')).toYaml());
        const incomplete = await call({ specRoot: 'p5b', questId: 'q5' });
        assert.equal(incomplete.code, 'incompleteGateRecord');
        assert.deepEqual(incomplete.missing, ['CE-DB', 'CE-JB']);
        assert.equal((await call({ specRoot: 'p1', questId: '' })).code, 'invalidInput');
        assert.equal((await call({ specRoot: 'p1', file: 'x', questId: 'q5' })).code, 'invalidInput');

        const noApp = await call({ specRoot: 'p1', questId: 'q5', dryRun: true });
        assert.equal(noApp.tree.csproj[0].status, 'decision-needed');
        assert.match(noApp.tree.csproj[0].title, /<app>_codespec_shared/);
    });

    test('PT-6: Stage A with the document', async () => {
        put('m/meridian.docspecs.yaml', MERIDIAN_YAML);
        for (const f of fs.readdirSync(CORPUS)) {
            put(path.join('m', EXTRACTS, f), fs.readFileSync(path.join(CORPUS, f), 'utf8'));
        }
        const ok = await call({ file: 'm/meridian.docspecs.yaml', questId: 'q6', appName: 'meridian', dryRun: true });
        assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 400));
        assert.deepEqual(ok.stageA, { checked: true, open: true, failing: [] });
        assert.deepEqual(ok.tree.csopen, [], 'the corpus record descopes its insufficient areas');

        const loaded = store.load(path.join(ws, 'm', 'meridian.docspecs.yaml'));
        loaded.document.setFormField('SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-2/FRED', 'description', '');
        put('m/meridian.docspecs.yaml', store.render(loaded, { stamp: loaded.stamp }));
        const closed = await call({ file: 'm/meridian.docspecs.yaml', questId: 'q6', appName: 'meridian' });
        assert.equal(closed.code, 'gateClosed');
        assert.deepEqual(closed.stageA.failing, ['A1']);
        assert.equal(fs.existsSync(path.join(ws, '_ai', 'quests', 'q6')), false, 'on rejection no todo is created');
    });

    test('PT-7: slugs and registration', () => {
        assert.equal(slugOf('**SCC-A** — CE-ER codes + CE-TX message keys (§4.4.7)'), 'scc-a-ce-er-codes');
        assert.equal(slugOf('Domain enums (`@CsEnum`)'), 'domain-enums-csenum');
        assert.deepEqual(CODESPECS_PLAN_TOOLS.map((t) => [t.name, t.readOnly, t.requiresApproval]), [['tomAi_specCodeSpecsPlanTodos', false, true]]);
    });
});
