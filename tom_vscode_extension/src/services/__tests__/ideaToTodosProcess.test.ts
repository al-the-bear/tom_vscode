/**
 * The idea_to_todos process (ccparity_j_ideaprocess-2), checked where it
 * lives: `_ai/processes/idea_to_todos/`, its roles under `_ai/roles/`, the
 * DocSpecs schema `.tom/docspecs-schema/idea-blueprint/`. Skipped when the
 * workspace around the extension is not there (a bare checkout of tom_vscode).
 *
 *   IT-1 the definition passes tomAi_validateProcess (YAML, schema, editor rules, roles): four phases Idea,
 *        Blueprint, Deepening, Todos, each with a light gate (a checklist in its description, onFail inside its
 *        phase); the repeatable steps; the reviews are user actions; the roles are the shared three
 *   IT-2 the Proceed prompts: a step before a review ends with the Finish review round prompt, filled in; the
 *        placeholders meant for later stay for later (`${repeatTodoId}`, `${senderQuest}`, `${itemOutcome}`);
 *        the deepening files `ideadeep<iteration>-*` todos and queues their walk
 *   IT-3 the schema idea-blueprint/1.0: a phase-1 document (Intent, Quests) and a full one with parts validate,
 *        one without its quests does not
 *   IT-4 the description: the round folders, filing per quest, the escaped placeholder
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
import { SomModelService } from '../som-model-service.js';
import { SomDocumentStore, nodeSomDocumentIo } from '../som-document-store.js';

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
        assert.match(step('idea', 'questions').prompt!, /tomAi_writeChatVariable \(`idea`\)[\s\S]*\$\{file-_ai\/processes\/_prompts\/question_round\.md\}/, 'phase 1 settles the name, then the shared question round');
        assert.match(step('blueprint', 'iteration').substeps![0].prompt!, /\$\{file-_ai\/processes\/_prompts\/review_round\.md\}/, 'the shared review round');
        assert.match(step('todos', 'file').prompt!, /tomAi_createQuestTodo[\s\S]*tomAi_sendItemToQuest[\s\S]*doneNotificationPrompt/);
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
        assert.match(initial, /\*\*Finish review round\*\* — put the results in front of the user for the review, Phase 2 — Blueprint › Review the Initial Version of process idea_to_todos\./);
        assert.match(initial, /`finishReviewRound: true`/);
        const revise = prompt(at('blueprint', 'iteration', 'revise'));
        assert.match(revise, /Iteration 2 of the blueprint/);
        assert.match(revise, /02_Blueprint\/02_<NN>_Iteration\//);
        assert.match(revise, /How a review is taken in \(shared by idea_to_todos and process_design/, 'the shared review round, included');
        assert.match(revise, /`finishReviewRound: true`/, 'the revision ends with the review too');
        const deepen = prompt(at('deepening', 'deepen'));
        assert.match(deepen, /ideadeep2-<n>_<date code>-<section id>/);
        assert.match(deepen, /`repeatCount: "ideadeep2-\*"`/);
        assert.match(deepen, /Please do the quest todo \$\{repeatTodoId\} — \$\{repeatTodoTitle\}\./, 'left for the queue');
        assert.match(deepen, /The Finish review round instructions for the closing item:\n\n\*\*Finish review round\*\*/);
        const file = prompt(at('todos', 'file'));
        assert.match(file, /sent to \$\{senderQuest\}: \$\{itemOutcome\}\./, 'left for the done notification');
        const gate = prompt(at('idea', 'g1'));
        assert.match(gate, /Gate G1 of the idea[\s\S]*`gates\/G1\.md`[\s\S]*approval and the move \(Gate passed \/ failed\) are the user's/);
    });

    test('IT-3: the schema idea-blueprint/1.0', async () => {
        const { docspecsValidateImpl } = await import('../../tools/docspecs-tools.js');
        const dir = fs.mkdtempSync(path.join(WS, 'ztmp', 'idea-blueprint-test-'));
        try {
            const deps = { wsRoot: WS, store: new SomDocumentStore(SomModelService.instance, nodeSomDocumentIo), service: SomModelService.instance };
            const put = (name: string, text: string) => { fs.writeFileSync(path.join(dir, name), text); return path.relative(WS, path.join(dir, name)); };
            const head = '<!-- docspec: idea-blueprint/1.0 -->\n\n# <!--[word-count]--> Word Count\n\n## <!--[intent]--> Intent\n\nShow a word count.\n\n';
            const quests = '## <!--[quests]--> Quests\n\n- vscode_extension: the file bar.\n\n';
            const parts = '## <!--[scope]--> Scope\n\nThe count only.\n\n## <!--[parts]--> Parts\n\n### <!--[part-count]--> Count\n\nCount the words.\n\n> **❓ IDEA-1 — Code:** count code blocks?\n> - (a) yes\n> - **(b)** no\n>\n> **Answer:**\n';
            const run = async (name: string, text: string) => JSON.parse(await docspecsValidateImpl(deps as never, { file: put(name, text) }));
            const phase1 = await run('phase1.md', head + quests);
            assert.equal(phase1.schema.file, '.tom/docspecs-schema/idea-blueprint/idea-blueprint.1.0.docspecs-schema.yaml');
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
        for (const folder of ['01_Idea/<NN>_Questions Round/', '02_Blueprint/01_Initial Version/', '02_Blueprint/02_<NN>_Iteration/', '03_Deepening/01_Deepening/', '04_Todos/02_Filing/']) {
            assert.ok(md.includes(folder), folder);
        }
        assert.match(md, /`_ai\/quests\/<quest>\/ideas\/<name>\/<name>\.md`/);
        assert.match(md, /`\$\$\{finish-review-round\}`/, 'escaped, so it survives the description\'s resolution');
        assert.ok(!/(?<!\$)\$\{finish-review-round\}/.test(md));
        assert.match(md, /tomAi_sendItemToQuest/);
    });
});
