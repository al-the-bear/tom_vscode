/**
 * The idea_to_todos process (ccparity_j_ideaprocess-2), checked where it
 * lives: `_ai/processes/idea_to_todos/`, its roles under `_ai/roles/`, the
 * DocSpecs schema `.tom/docspecs-schema/idea-blueprint/`. Skipped when the
 * workspace around the extension is not there (a bare checkout of tom_vscode).
 *
 *   IT-1 the definition passes tomAi_validateProcess (YAML, schema, editor rules, roles): four phases Idea,
 *        Blueprint, Deepening, Todos, each with a light gate (a checklist in its description, onFail inside its
 *        phase); the repeatable steps; the reviews are user actions; the roles are the shared three; the filing
 *        creates every todo directly in its quest with tomAi_createQuestTodo, never through another quest's queue
 *   IT-2 the Proceed prompts: a step before a review ends with the Finish review round prompt, filled in; the
 *        placeholders meant for later stay for later (`${repeatTodoId}`, `${repeatTodoTitle}`); the deepening
 *        files `ideadeep<phase iteration>x<step iteration>-*` todos and queues their walk; the proposal groups the
 *        todos in phases (`<NN><g>_<stem><n>`) in a todos document with an overview, phase tables and Details; the
 *        filing creates them directly (tomAi_createQuestTodo, tomAi_generateIdPrefix), checks each quest's file
 *        before and after, and asks no other window to file them
 *   IT-3 the schema idea-blueprint/1.0: a phase-1 document (Intent, Quests) and a full one with parts validate,
 *        one without its quests does not
 *   IT-4 the description: the round folders (iterations in phases 3 and 4 too), the todos document (phases, groups,
 *        the id form, overview, Details), the direct filing in every affected quest, the escaped placeholder
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const EXT = path.join(__dirname, '..', '..', '..');
const WS = path.resolve(EXT, '..', '..', '..');
const PROCESS = path.join(WS, '_ai', 'processes', 'idea_to_todos');
const present = fs.existsSync(path.join(PROCESS, 'idea_to_todos.process.yaml'));
// A workspace without a config: the prompts are built from the built-in Assist prompts,
// not from whatever the user's config holds.
// `_ai` is linked in, so the shared prompts (`$${file-_ai/processes/_prompts/…}`) resolve.
const BARE = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-to-todos-'));
if (present) { fs.symlinkSync(path.join(WS, '_ai'), path.join(BARE, '_ai')); }
installVscodeStub({ workspaceFolders: [BARE] });

import { checkProcessDraft } from '../../tools/process-write-tools.js';
import { availableMoves, EMPTY_PROCESS_STATE, parseProcessYaml, phaseSteps, type ProcessDefinition, type ProcessState } from '../../utils/processDefinition.js';
import { unescapePlaceholders } from '../../utils/placeholderEscape.js';
import { QUEUED_WORK_TEXT } from '../../utils/processActionPrompt.js';
import { SomModelService } from '../som-model-service.js';
import { SomDocumentStore, nodeSomDocumentIo } from '../som-document-store.js';
import { rootTomPath } from '../../utils/__tests__/_layoutRoot.js';

const yamlText = present ? fs.readFileSync(path.join(PROCESS, 'idea_to_todos.process.yaml'), 'utf8') : '';
const def = present ? parseProcessYaml(yamlText).definition as ProcessDefinition : undefined;
const at = (phase: string, step: string, substep = ''): ProcessState =>
    ({ ...EMPTY_PROCESS_STATE, process: 'idea_to_todos', phase, phaseIteration: 1, step, stepIteration: 2, substep, substepIteration: 1 });

describe('the idea_to_todos process', { skip: present ? false : 'no _ai/processes/idea_to_todos around this checkout' }, () => {
    test('IT-1: the definition', () => {
        const check = checkProcessDraft({ workspaceRoot: WS, processesDir: path.join(WS, '_ai', 'processes'), rolesDir: path.join(WS, '_ai', 'roles'), write: () => ({ ok: true }) }, { yaml: yamlText });
        assert.deepEqual(check.findings, [], 'valid: YAML, schema, editor rules, roles');
        assert.equal(def!.name, 'Idea → Todos');
        assert.deepEqual(def!.phases.map((p) => p.id), ['idea', 'blueprint', 'deepening', 'todos']);
        for (const phase of def!.phases) {
            assert.match(phase.gate.description ?? '', /Light gate[\s\S]*Checklist: G\d-/, `${phase.id}: a checklist`);
            assert.equal(phase.gate.role, 'idea_reviewer');
            assert.ok(phaseSteps(phase).some((e) => e.step.id === phase.gate.onFail), `${phase.id}: onFail inside the phase`);
        }
        const step = (p: string, s: string) => def!.phases.find((x) => x.id === p)!.steps.find((x) => x.id === s)!;
        assert.equal(step('idea', 'questions').repeatable, true, 'repeatable question rounds');
        assert.equal(step('blueprint', 'iteration').repeatable, true, 'repeatable iteration');
        assert.deepEqual(step('blueprint', 'iteration').substeps!.map((s) => [s.id, s.userAction === true]), [['revise', false], ['review', true]]);
        for (const [p, s] of [['blueprint', 'review-initial'], ['deepening', 'review'], ['todos', 'review']]) {
            assert.equal(step(p, s).userAction, true, `${p}/${s} is yours`);
        }
        const roles = new Set(def!.phases.flatMap((p) => phaseSteps(p).flatMap((e) => [e.step.role, ...(e.step.substeps ?? []).map((x) => x.role)])).filter(Boolean));
        assert.deepEqual([...roles].sort(), ['idea_author', 'idea_reviewer', 'todo_planner']);
        for (const role of roles) { assert.ok(fs.existsSync(path.join(WS, '_ai', 'roles', role!, 'role.md')), `${role}/role.md`); }
        for (const phase of def!.phases) { assert.equal(phase.repeatable, true, `${phase.id} is repeatable`); }
        assert.match(step('idea', 'start').prompt!, /tomAi_askUser[\s\S]*tomAi_writeChatVariable: `idea`[\s\S]*`idea-input-mode`[\s\S]*Resume an idea[\s\S]*tomAi_setProcessState/, '00 Start: new or resumed, settled with the user');
        assert.match(step('idea', 'questions').prompt!, /\$\{file-_ai\/processes\/_prompts\/idea_context\.md\}[\s\S]*\$\{file-_ai\/processes\/_prompts\/question_round\.md\}/, 'the idea context, then the shared question round');
        for (const p of ['deepening', 'todos']) {
            assert.equal(step(p, 'iteration').repeatable, true, `${p}: repeatable iteration`);
            assert.equal(step(p, 'iteration').substeps![1].userAction, true, `${p}: its review is yours`);
        }
        assert.match(step('blueprint', 'iteration').substeps![0].prompt!, /\$\{file-_ai\/processes\/_prompts\/review_round\.md\}/, 'the shared review round');
        const filing = step('todos', 'file').prompt!;
        assert.match(filing, /create each todo \*\*directly in that quest\*\* with tomAi_createQuestTodo \(`questId` the quest\)/, 'the todo tool, in every quest');
        assert.match(filing, /`<NN><g>_<stem><n>_<date code>-<description>` \(the date code from tomAi_generateIdPrefix\)/);
        assert.match(filing, /Never queue an item asking another quest's window to file them\./);
        assert.ok(!/tomAi_sendItemToQuest|doneNotificationPrompt/.test(filing), 'no filing through another quest\'s queue');
        assert.match(step('todos', 'propose').prompt!, /`<NN><g>_<stem><n>`[\s\S]*`01a_rdv\*`/, 'phase groups, walked by prefix');
    });

    test('IT-2: the Proceed prompts', async () => {
        const { buildProcessActionPrompt } = await import('../processActionService.js');
        const prompt = (state: ProcessState): string => {
            const store = { currentDefinition: () => def!, state, processDescription: () => '' };
            const move = availableMoves(def!, state).find((m) => m.kind === 'proceed')!;
            return unescapePlaceholders(buildProcessActionPrompt(store as never, move, ''));
        };
        const questions = prompt({ ...at('idea', 'questions'), stepIteration: 1 });
        assert.match(questions, /Question round 1 of the idea/);
        assert.match(questions, /How a question round goes \(shared by idea_to_todos and process_design[\s\S]*tomAi_askUser[\s\S]*`choices` \(kind `answer`\)/, 'the shared question round, included');
        const initial = prompt(at('blueprint', 'initial'));
        assert.ok(!initial.includes('${finish-review-round}'), 'filled in');
        assert.match(initial, /\*\*Finish review round\*\* — put the results in front of the user for the review, Phase 2 — Blueprint #1 › Review the Initial Version of process idea_to_todos\./);
        assert.match(initial, /`finishReviewRound: true`/);
        const revise = prompt(at('blueprint', 'iteration', 'revise'));
        assert.match(revise, /Iteration 2 of the blueprint/);
        assert.match(revise, /02_Blueprint\/02_<NN>_Iteration\//);
        assert.match(revise, /How a review is taken in \(shared by idea_to_todos and process_design/, 'the shared review round, included');
        assert.match(revise, /`finishReviewRound: true`/, 'the revision ends with the review too');
        const deepen = prompt(at('deepening', 'deepen'));
        assert.match(deepen, /ideadeep1x2-<n>_<date code>-<section id>/);
        assert.match(deepen, /`repeatCount: "ideadeep1x2-\*"`/);
        assert.match(deepen, /Please do the quest todo \$\{repeatTodoId\} — \$\{repeatTodoTitle\}\./, 'left for the queue');
        assert.match(deepen, /The Finish review round instructions for the closing item:\n\n\*\*Finish review round\*\*/);
        const propose = prompt(at('todos', 'propose'));
        assert.match(propose, /group the todos in \*\*phases\*\* by their dependencies/);
        assert.match(propose, /Each todo's id is `<NN><g>_<stem><n>`/);
        assert.match(propose, /an overview table \(phase, its groups with their quests, number of todos\)/);
        assert.match(propose, /one `## Phase <NN> — <title>` section per phase, and in it one `### <NN><g> — <quest>` subsection per group/);
        assert.match(propose, /`## Details`: one `### <id> — <title>` per todo/);
        assert.match(propose, /nothing is created yet/);
        assert.match(propose, /`finishReviewRound: true`/, 'the proposal ends with the review');
        const file = prompt(at('todos', 'file'));
        assert.match(file, /Every affected quest, this one \(\S*\) and every other alike: create each todo \*\*directly in that quest\*\* with tomAi_createQuestTodo/, 'every quest: the window\'s (empty in this bare workspace) and the others');
        assert.match(file, /Check each quest's todo file before creating \(an id or a todo of the idea already there is not created twice\) and after \(every todo is there\)/);
        assert.match(file, /Dependencies inside the quest go in `dependencies` \(by id\); a dependency on another quest's todo goes in `blocked_by` as `<quest>\/<id>`, with status `blocked` while that todo is open/);
        assert.match(file, /Never put a dependency in `notes`/, 'a cross-quest dependency is released by itself, not kept as text (ideatests2)');
        // The Proceed template's *Work you queue* section names tomAi_sendItemToQuest generically (gsel8); the step itself does not.
        assert.ok(file.includes(QUEUED_WORK_TEXT), 'the Proceed template says what queued work may name');
        assert.ok(!/tomAi_sendItemToQuest|\$\{itemOutcome\}|\$\{senderQuest\}/.test(file.replace(QUEUED_WORK_TEXT, '')), 'nothing goes through another quest\'s queue');
        const gate = prompt(at('idea', 'g1'));
        assert.match(gate, /Gate G1 of the idea[\s\S]*`gates\/G1\.md`[\s\S]*approval and the move \(Gate passed \/ failed\) are the user's/);
        // Every gate ends with its result and the decision's buttons (vscimpb85).
        for (const [phase, g] of [['idea', 'g1'], ['blueprint', 'g2'], ['deepening', 'g3'], ['todos', 'g4']]) {
            const text = prompt(at(phase, g));
            assert.ok(!text.includes('${gate-decision}'), `${g}: filled in`);
            assert.match(text, /\*\*Gate decision\*\* — put the gate's result in front of the user with the decision's buttons, Phase \d — [^\n]* of process idea_to_todos\./, g);
            assert.match(text, /`gateDecision: true`/, g);
        }
    });

    test('IT-3: the schema idea-blueprint/1.0', async () => {
        const { docspecsValidateImpl } = await import('../../tools/docspecs-tools.js');
        const dir = fs.mkdtempSync(path.join(WS, 'ztmp', 'idea-blueprint-test-'));
        try {
            // The schemas are the root's (`.tom/docspecs-schema/`): the configuration layer the layout gives the tool.
            const deps = { wsRoot: WS, configLayers: [rootTomPath()], store: new SomDocumentStore(SomModelService.instance, nodeSomDocumentIo), service: SomModelService.instance };
            const put = (name: string, text: string) => { fs.writeFileSync(path.join(dir, name), text); return path.relative(WS, path.join(dir, name)); };
            const head = '<!-- docspec: idea-blueprint/1.0 -->\n\n# <!--[word-count]--> Word Count\n\n## <!--[intent]--> Intent\n\nShow a word count.\n\n';
            const quests = '## <!--[quests]--> Quests\n\n- vscode_extension: the file bar.\n\n';
            const parts = '## <!--[scope]--> Scope\n\nThe count only.\n\n## <!--[parts]--> Parts\n\n### <!--[part-count]--> Count\n\nCount the words.\n\n> **❓ IDEA-1 — Code:** count code blocks?\n> - (a) yes\n> - **(b)** no\n>\n> **Answer:**\n';
            const run = async (name: string, text: string) => JSON.parse(await docspecsValidateImpl(deps as never, { file: put(name, text) }));
            const phase1 = await run('phase1.md', head + quests);
            assert.equal(path.resolve(WS, phase1.schema.file), rootTomPath('docspecs-schema', 'idea-blueprint', 'idea-blueprint.1.0.docspecs-schema.yaml'), JSON.stringify(phase1.schema));
            assert.deepEqual([phase1.passed, phase1.findings], [true, []], 'a phase-1 document');
            assert.deepEqual((await run('full.md', head + quests + parts)).findings, [], 'with scope and parts');
            const noQuests = await run('bad.md', head);
            assert.equal(noQuests.passed, false);
            assert.match(noQuests.findings[0].message, /required document section "quests"/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('IT-4: the description', () => {
        const md = fs.readFileSync(path.join(PROCESS, 'idea_to_todos.md'), 'utf8');
        for (const folder of ['01_Idea/<NN>_Questions Round/', '02_Blueprint/01_Initial Version/', '02_Blueprint/02_<NN>_Iteration/', '03_Deepening/01_Deepening/', '03_Deepening/02_<NN>_Iteration/', '04_Todos/02_<NN>_Iteration/', '04_Todos/03_Filing/']) {
            assert.ok(md.includes(folder), folder);
        }
        assert.match(md, /`_ai\/quests\/<quest>\/ideas\/<idea>\/<idea>\.docspecs\.md`/, 'the working document\'s default name (doc_specs 01d_rdv1: a DocSpecs document is `*.docspecs.md`)');
        assert.match(md, /`\$\$\{finish-review-round\}`/, 'escaped, so it survives the description\'s resolution');
        assert.ok(!/(?<!\$)\$\{finish-review-round\}/.test(md));
        assert.match(md, /`<NN><g>_<stem><n>` — the phase `<NN>`, the group letter `<g>`/, 'the id form');
        assert.match(md, /The document opens with the ids explained and an overview table, then one\s+`## Phase <NN>` section per phase with a table per group/, 'the document layout');
        assert.match(md, /`## Details` follows/);
        assert.match(md, /\*\*directly in every affected quest\*\* — this one and every other\s+alike — with `tomAi_createQuestTodo` \(`questId` the quest\)/, 'direct filing with the todo tool');
        assert.match(md, /a dependency on another\s+quest's todo in `blocked_by` as `<quest>\/<id>`/, 'a cross-quest dependency as a blocker (ideatests2)');
        assert.ok(!/dependencies on another quest\s+in `notes`/.test(md), 'no dependency kept in notes');
        assert.match(md, /No queue item asks another quest's window to file them/);
        assert.ok(!/tomAi_sendItemToQuest/.test(md), 'no filing through another quest\'s queue');
    });
});
