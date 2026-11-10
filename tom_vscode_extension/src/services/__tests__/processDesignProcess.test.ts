/**
 * The process_design process (ccparity_j_ideaprocess-3), checked where it
 * lives: `_ai/processes/process_design/`, the shared prompts in
 * `_ai/processes/_prompts/`, the shared roles under `_ai/roles/`. Skipped when
 * the workspace around the extension is not there.
 *
 *   PD-1 the definition passes tomAi_validateProcess: three phases Intent, Design, Generation with light gates
 *        (checklists, onFail inside the phase); question rounds and the design iteration repeatable; the reviews
 *        are user actions; the roles are the three idea_to_todos uses
 *   PD-2 shared with idea_to_todos: both processes include the same question-round and review prompts, and the
 *        shared files are not taken for processes
 *   PD-3 the Proceed prompts: the question round includes the shared prompt; the initial design asks for every
 *        part of a definition and drafts new roles; the design's result validates a draft with the drafted roles;
 *        the generation writes the roles first, then validates and writes the process with tomAi_writeProcess
 *   PD-4 the description: the design document, the round folders, new roles, the escaped include
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const EXT = path.join(__dirname, '..', '..', '..');
const WS = path.resolve(EXT, '..', '..', '..');
const PROCESSES = path.join(WS, '_ai', 'processes');
const present = fs.existsSync(path.join(PROCESSES, 'process_design', 'process_design.process.yaml'));
// A workspace without a config (the built-in Assist prompts), `_ai` linked in for the shared prompts.
const BARE = fs.mkdtempSync(path.join(os.tmpdir(), 'process-design-'));
if (present) { fs.symlinkSync(path.join(WS, '_ai'), path.join(BARE, '_ai')); }
installVscodeStub({ workspaceFolders: [BARE] });

import { checkProcessDraft } from '../../tools/process-write-tools.js';
import { availableMoves, EMPTY_PROCESS_STATE, parseProcessYaml, phaseSteps, type ProcessDefinition, type ProcessState } from '../../utils/processDefinition.js';
import { ProcessRepository } from '../../utils/processRepository.js';
import { unescapePlaceholders } from '../../utils/placeholderEscape.js';

const read = (id: string) => fs.readFileSync(path.join(PROCESSES, id, `${id}.process.yaml`), 'utf8');
const yamlText = present ? read('process_design') : '';
const def = present ? parseProcessYaml(yamlText).definition as ProcessDefinition : undefined;
const at = (phase: string, step: string, substep = ''): ProcessState =>
    ({ ...EMPTY_PROCESS_STATE, process: 'process_design', phase, phaseIteration: 1, step, stepIteration: 1, substep, substepIteration: 1 });

describe('the process_design process', { skip: present ? false : 'no _ai/processes/process_design around this checkout' }, () => {
    test('PD-1: the definition', () => {
        const check = checkProcessDraft({ workspaceRoot: WS, processesDir: PROCESSES, rolesDir: path.join(WS, '_ai', 'roles'), write: () => ({ ok: true }) }, { yaml: yamlText });
        assert.deepEqual(check.findings, []);
        assert.equal(def!.name, 'Process Design');
        assert.deepEqual(def!.phases.map((p) => p.id), ['intent', 'design', 'generation']);
        for (const phase of def!.phases) {
            assert.match(phase.gate.description ?? '', /Light gate[\s\S]*Checklist: G\d-/, phase.id);
            assert.ok(phaseSteps(phase).some((e) => e.step.id === phase.gate.onFail), `${phase.id}: onFail inside the phase`);
        }
        const step = (p: string, s: string) => def!.phases.find((x) => x.id === p)!.steps.find((x) => x.id === s)!;
        assert.equal(step('intent', 'questions').repeatable, true);
        assert.equal(step('design', 'iteration').repeatable, true);
        for (const [p, s] of [['design', 'review-initial'], ['generation', 'review']]) { assert.equal(step(p, s).userAction, true, `${p}/${s}`); }
        assert.equal(step('design', 'iteration').substeps![1].userAction, true);
        const roles = new Set(def!.phases.flatMap((p) => phaseSteps(p).flatMap((e) => [e.step.role, ...(e.step.substeps ?? []).map((x) => x.role)])).filter(Boolean));
        assert.deepEqual([...roles].sort(), ['idea_author', 'idea_reviewer', 'todo_planner'], 'the roles of idea_to_todos');
    });

    test('PD-2: shared with idea_to_todos', () => {
        for (const file of ['question_round.md', 'review_round.md']) {
            const include = `\${file-_ai/processes/_prompts/${file}}`;
            assert.ok(read('process_design').includes(include), `process_design includes ${file}`);
            assert.ok(read('idea_to_todos').includes(include), `idea_to_todos includes ${file}`);
            assert.match(fs.readFileSync(path.join(PROCESSES, '_prompts', file), 'utf8'), /shared by idea_to_todos and process_design/);
        }
        const ids = new ProcessRepository(PROCESSES, path.join(WS, '_ai', 'quests')).list().map((e) => e.id);
        assert.ok(ids.includes('process_design') && ids.includes('idea_to_todos'));
        assert.ok(!ids.includes('_prompts'), 'the shared prompts are no process');
    });

    test('PD-3: the Proceed prompts', async () => {
        const { buildProcessActionPrompt } = await import('../processActionService.js');
        const prompt = (state: ProcessState): string => {
            const store = { currentDefinition: () => def!, state, processDescription: () => '' };
            const move = availableMoves(def!, state).find((m) => m.kind === 'proceed')!;
            return unescapePlaceholders(buildProcessActionPrompt(store as never, move, ''));
        };
        const questions = prompt(at('intent', 'questions'));
        assert.match(questions, /tomAi_writeChatVariable \(`design` = the id/, 'the round sets `design` (and, since the revise mode, `design-mode`)');
        assert.match(questions, /How a question round goes \(shared by idea_to_todos and process_design[\s\S]*tomAi_askUser/);
        const initial = prompt(at('design', 'initial'));
        for (const part of ['steps in order', 'repeatable', 'sub-steps', '`userAction`', 'session', 'prompt written out', 'checklist items', '`onFail`', 'post-gate step', '<!--[role-<name>]-->']) {
            assert.ok(initial.includes(part), `the design covers ${part}`);
        }
        assert.match(initial, /ends by showing the result with `\$\{finish-review-round\}`/, 'told to use Finish review round in the designed prompts');
        assert.match(initial, /\*\*Finish review round\*\* — put the results in front of the user/, 'and the step itself ends with it');
        const result = prompt(at('design', 'result'));
        assert.match(result, /tomAi_validateProcess \(`file`, the new roles as `draftRoles`\)/);
        const generate = prompt(at('generation', 'generate'));
        assert.ok(generate.indexOf('_ai/roles/<name>/role.md') < generate.indexOf('tomAi_writeProcess'), 'the roles before the definition');
        assert.match(generate, /tomAi_validateProcess \(`yaml`\)[\s\S]*tomAi_writeProcess[\s\S]*opens the process in the process editor/);
    });

    test('PD-4: the description', () => {
        const md = fs.readFileSync(path.join(PROCESSES, 'process_design', 'process_design.md'), 'utf8');
        assert.match(md, /`_ai\/quests\/<quest>\/designs\/<id>\/<id>\.md`/);
        for (const folder of ['01_Intent/<NN>_Questions Round/', '02_Design/03_Result/', '03_Generation/']) { assert.ok(md.includes(folder), folder); }
        assert.match(md, /drafted in the design, reviewed\s+with it, and written to `_ai\/roles\/<role>\/role\.md` in phase 3/);
        assert.match(md, /`\$\$\{file-_ai\/processes\/_prompts\/review_round\.md\}`/, 'the include escaped in the description');
    });
});
