/**
 * tomAi_validateProcess / tomAi_writeProcess (ccparity_j_ideaprocess-1): an
 * agent creates a process, on a temporary workspace with `_ai/processes` and
 * `_ai/roles`.
 *
 *   PW-1 valid: a draft that passes YAML, the schema, the editor's rules and the roles answers no findings
 *   PW-2 invalid: broken YAML; a phase without a gate (schema and rules); `onFail` outside its phase; a prompt on a
 *        user-action step; an unknown key; a role that neither exists nor is drafted (`draftRoles` makes it pass);
 *        an unknown session profile; `yaml` and `file` both or neither; a draft read from a file
 *   PW-3 write: both files written (the definition reads back the same), the editor opened; an invalid draft writes
 *        nothing; an existing id is refused unless `replace`; `description` is required
 *   PW-4 registration, approval and the documentation rows
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { withTiming } from './_timing.js';
import { VALIDATE_PROCESS_TOOL, WRITE_PROCESS_TOOL, validateProcessImpl, writeProcessImpl, type ProcessWriteDeps } from '../process-write-tools.js';
import { ProcessRepository } from '../../utils/processRepository.js';
import { parseProcessYaml } from '../../utils/processDefinition.js';

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'process-write-')));
const processesDir = path.join(ws, '_ai', 'processes');
fs.mkdirSync(path.join(ws, '_ai', 'roles', 'author'), { recursive: true });
fs.mkdirSync(processesDir, { recursive: true });
fs.writeFileSync(path.join(ws, '_ai', 'roles', 'reviewer.md'), '# Reviewer\n');
const opened: string[] = [];
const repo = new ProcessRepository(processesDir, path.join(ws, '_ai', 'quests'));
const deps: ProcessWriteDeps = {
    workspaceRoot: ws, processesDir, rolesDir: path.join(ws, '_ai', 'roles'),
    profileIds: () => ['opus-5-5-agent-sdk-mm'],
    write: (def, description) => repo.save(def, description),
    openEditor: (id) => { opened.push(id); },
};

const VALID = `id: idea_flow
name: Idea to todos
summary: From an idea to a todo list.
session: { name: idea, mode: per-prompt, profile: opus-5-5-agent-sdk-mm }
phases:
  - id: shape
    name: Shape the idea
    steps:
      - id: draft
        role: author
        prompt: Write the idea down.
      - id: review
        userAction: true
        description: Review the draft.
    gate:
      id: check
      role: reviewer
      prompt: Check the draft is complete.
      onFail: draft
`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const validate = async (input: object): Promise<Json> => JSON.parse(await validateProcessImpl(deps, input as never));
const sources = (r: Json) => r.findings.map((f: Json) => `${f.source} ${f.path}`);

describe('process creation tools', () => {
    test('PW-1: a valid draft', async () => {
        const r = JSON.parse(await withTiming('tomAi_validateProcess:typical', () => validateProcessImpl(deps, { yaml: VALID })));
        assert.deepEqual(r, { valid: true, id: 'idea_flow', exists: false, findings: [] });
    });

    test('PW-2: findings', async () => {
        assert.deepEqual(sources(await validate({ yaml: 'id: [unclosed' })), ['yaml ']);
        const noGate = await validate({ yaml: VALID.replace(/    gate:\n[\s\S]*$/, '') });
        assert.equal(noGate.valid, false);
        assert.ok(sources(noGate).includes('schema phases[0].gate'), 'the schema says the gate is required');
        assert.ok(sources(noGate).includes('rules phases[0].gate'), 'and so do the editor\'s rules');
        const onFail = await validate({ yaml: VALID.replace('onFail: draft', 'onFail: elsewhere') });
        assert.deepEqual(onFail.findings.filter((f: Json) => f.source === 'rules').map((f: Json) => f.path), ['phases[0].gate.onFail']);
        const userAction = await validate({ yaml: VALID.replace('description: Review the draft.', 'prompt: Review it.') });
        assert.match(userAction.findings.find((f: Json) => f.source === 'rules').message, /a user action runs no prompt/);
        const unknownKey = await validate({ yaml: VALID.replace('name: Idea to todos', 'name: Idea to todos\ncolour: blue') });
        assert.deepEqual(sources(unknownKey).sort(), ['rules colour', 'schema colour']);
        const role = await validate({ yaml: VALID.replace('role: author', 'role: planner') });
        assert.deepEqual(role.findings, [{ source: 'roles', path: 'phases[0].steps[0].role', message: 'no role "planner" under _ai/roles/ — name an existing role or list it in `draftRoles` (and write it)' }]);
        assert.equal((await validate({ yaml: VALID.replace('role: author', 'role: planner'), draftRoles: ['planner'] })).valid, true, 'a drafted role');
        const profile = await validate({ yaml: VALID.replace('profile: opus-5-5-agent-sdk-mm', 'profile: nobody') });
        assert.match(profile.findings.find((f: Json) => f.source === 'rules').message, /no Anthropic profile "nobody"/);
        assert.match((await validate({})).findings[0].message, /exactly one of `yaml`/);
        assert.match((await validate({ yaml: VALID, file: 'x.yaml' })).findings[0].message, /exactly one of `yaml`/);
        fs.writeFileSync(path.join(ws, 'draft.process.yaml'), VALID);
        assert.equal((await validate({ file: 'draft.process.yaml' })).valid, true, 'read from a file');
        assert.match((await validate({ file: '/elsewhere/x.process.yaml' })).findings[0].message, /outside the workspace/);
    });

    test('PW-3: write', async () => {
        const out = JSON.parse(await withTiming('tomAi_writeProcess:typical', () => writeProcessImpl(deps, { yaml: VALID, description: '# Idea to todos\n\nFrom an idea to a todo list.' })));
        assert.deepEqual(out, { ok: true, id: 'idea_flow', replaced: false, files: ['_ai/processes/idea_flow/idea_flow.process.yaml', '_ai/processes/idea_flow/idea_flow.md'], openedInEditor: true });
        assert.deepEqual(opened, ['idea_flow']);
        const written = parseProcessYaml(fs.readFileSync(path.join(processesDir, 'idea_flow', 'idea_flow.process.yaml'), 'utf8'));
        assert.deepEqual(written.errors, []);
        assert.deepEqual(written.definition, parseProcessYaml(VALID).definition, 'the definition reads back the same');
        assert.equal(fs.readFileSync(path.join(processesDir, 'idea_flow', 'idea_flow.md'), 'utf8'), '# Idea to todos\n\nFrom an idea to a todo list.\n');
        assert.equal((await validate({ yaml: VALID })).exists, true);
        // Existing: refused; replace: written.
        const again = JSON.parse(await writeProcessImpl(deps, { yaml: VALID.replace('Shape the idea', 'Shape it'), description: 'x' }));
        assert.match(again.error, /A process "idea_flow" exists already \(_ai\/processes\/idea_flow\); pass `replace: true`/);
        assert.match(fs.readFileSync(path.join(processesDir, 'idea_flow', 'idea_flow.process.yaml'), 'utf8'), /Shape the idea/, 'unchanged');
        const replaced = JSON.parse(await writeProcessImpl(deps, { yaml: VALID.replace('Shape the idea', 'Shape it'), description: 'x', replace: true, open: false }));
        assert.deepEqual([replaced.ok, replaced.replaced, replaced.openedInEditor], [true, true, false]);
        assert.match(fs.readFileSync(path.join(processesDir, 'idea_flow', 'idea_flow.process.yaml'), 'utf8'), /Shape it/);
        // Invalid: nothing written.
        const invalid = JSON.parse(await writeProcessImpl(deps, { yaml: VALID.replace('idea_flow', 'other_flow').replace('role: author', 'role: planner'), description: 'x' }));
        assert.equal(invalid.ok, false);
        assert.equal(invalid.findings[0].source, 'roles');
        assert.ok(!fs.existsSync(path.join(processesDir, 'other_flow')), 'nothing written');
        assert.match(JSON.parse(await writeProcessImpl(deps, { yaml: VALID, description: ' ' })).error, /`description` is required/);
    });

    test('PW-4: registration and docs', () => {
        assert.equal(VALIDATE_PROCESS_TOOL.readOnly, true);
        assert.equal(WRITE_PROCESS_TOOL.readOnly, false);
        assert.equal(WRITE_PROCESS_TOOL.requiresApproval, true);
        const EXT = path.join(__dirname, '..', '..', '..');
        const src = (rel: string) => fs.readFileSync(path.join(EXT, 'src', rel), 'utf8');
        assert.match(src('tools/tool-executors.ts'), /\.\.\.PROCESS_WRITE_TOOLS,/);
        const doc = fs.readFileSync(path.join(EXT, 'doc', 'llm_tools.md'), 'utf8');
        for (const name of ['tomAi_validateProcess', 'tomAi_writeProcess']) {
            assert.match(src('utils/toolCategories.ts'), new RegExp(`'${name}'`));
            assert.match(src('utils/constants.ts'), new RegExp(`'${name}'`));
            assert.match(doc, new RegExp(`^\\| \`${name}\` \\|`, 'm'), `${name}: llm_tools.md row`);
        }
    });
});
