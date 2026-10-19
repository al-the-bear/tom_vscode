/**
 * The spec tools end to end through the standalone MCP server's tool surface
 * (vsctsa22): the tool set the server would serve (resolveEffectiveMcpTools),
 * registered on a real McpServer (buildToolMcpServer) and called by a real MCP
 * Client over an in-memory transport, on a copy of the Meridian sample. The
 * tools run with their live dependencies (liveDeps: the workspace folder and
 * the editor-aware document store), as they do in the extension.
 *
 *   SM-1  authenticated: find, outline, reflect, search, batch-edit, validate, render; the edit lands and validates
 *   SM-2  authenticated: the CodeSpecs path — gate, extract summary, step context
 *   SM-3  unauthenticated: every spec reader is served, no spec writer is
 *   SM-4  unauthenticated too: the CodeSpecs guides are resources (whole and by section), the stage runbooks
 *         prompts with their arguments filled in, and tomAi_specCodeSpecsStatus answers where the sample is
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { installVscodeStub } from './_vscode-stub.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-mcp-'));
const { stub } = installVscodeStub({ workspaceFolders: [ws] });
// The editor-aware store asks which documents are open; none are.
(stub.workspace as { textDocuments: unknown[] }).textDocuments = [];

import { SomModelService } from '../../services/som-model-service.js';
import { buildToolMcpServer, NULL_MCP_TRAIL_SINK, resolveEffectiveMcpTools } from '../../handlers/mcpServer-handler.js';
import type { ResolvedMcpServerSettings } from '../../utils/sendToChatConfig.js';

const AI_BUILD = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build');
const MERIDIAN_YAML = fs.readFileSync(path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml'), 'utf8');
const CORPUS = path.join(AI_BUILD, 'tom_som_conformance', 'generated-doc', 'codespecs_extracts');
const FILE = 'specs/meridian.docspecs.yaml';
const FR = 'SBP/introductionAndScope/requirements/functionalRequirements';

const KEY_ENV = 'TOM_SPEC_MCP_TEST_KEY';
const env = { [KEY_ENV]: 'spec-mcp-secret' };
const settings: ResolvedMcpServerSettings = {
    enabled: true, host: '127.0.0.1', basePort: 19920, apiKeyEnv: KEY_ENV,
    allowWriteWithoutAuth: false, toolsEnabled: true, enabledTools: [],
};
const SPEC = /^tomAi_(spec|docspecs)[A-Z]/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function connect(bearer: string | undefined): Promise<{ client: Client; served: string[] }> {
    const tools = resolveEffectiveMcpTools(settings, bearer, env);
    const { server } = buildToolMcpServer(tools, NULL_MCP_TRAIL_SINK);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'spec-mcp-test', version: '1.0.0' });
    await client.connect(clientTransport);
    const served = (await client.listTools()).tools.map((t) => t.name);
    return { client, served };
}

async function call(client: Client, name: string, args: object): Promise<Json> {
    const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
    const content = r.content as Array<{ type: string; text: string }>;
    assert.ok(!r.isError, `${name} failed: ${content?.[0]?.text}`);
    return JSON.parse(content[0].text);
}

describe('spec tools over MCP', () => {
    let authed: { client: Client; served: string[] };
    let anon: { client: Client; served: string[] };

    before(async () => {
        void SomModelService.instance.model;
        fs.mkdirSync(path.join(ws, 'specs', 'generated-doc', 'codespecs_extracts'), { recursive: true });
        fs.writeFileSync(path.join(ws, FILE), MERIDIAN_YAML);
        for (const f of fs.readdirSync(CORPUS)) {
            fs.copyFileSync(path.join(CORPUS, f), path.join(ws, 'specs', 'generated-doc', 'codespecs_extracts', f));
        }
        authed = await connect(env[KEY_ENV]);
        anon = await connect(undefined);
    });
    after(async () => {
        await authed?.client.close();
        await anon?.client.close();
    });

    test('SM-1: the editing workflow, authenticated', async () => {
        const { client } = authed;
        const listed = await call(client, 'tomAi_specListDocuments', { dir: 'specs' });
        assert.ok(listed.documents.some((d: Json) => d.file === FILE), JSON.stringify(listed).slice(0, 300));

        const outline = await call(client, 'tomAi_specOutline', { file: FILE, path: FR, depth: 1 });
        assert.equal(outline.ok, true);
        assert.equal(outline.document.editability, 'editable');
        const reflect = await call(client, 'tomAi_specReflect', { file: FILE, path: FR });
        assert.ok(JSON.stringify(reflect).includes('FRE-REQU-LST'), 'the list a requirement is added to');
        const search = await call(client, 'tomAi_specSearch', { file: FILE, className: 'FunctionalRequirementEntry' });
        const before = search.total;
        assert.ok(before > 0);
        const baseline = await call(client, 'tomAi_specValidate', { file: FILE });

        const edit = await call(client, 'tomAi_specApplyEdits', {
            file: FILE,
            expectedRevision: outline.document.revision,
            edits: [
                { op: 'addNode', parentPath: FR, childSegment: 'FRE-REQU-LST', itemId: 'FRE-REQU-ARCHIVE', as: 'req' },
                { op: 'setFormField', path: '$req/content', field: 'status', value: 'draft' },
                { op: 'setFormField', path: '$req/FRED', field: 'description', value: 'The system must archive closed orders.' },
                { op: 'setFormField', path: '$req/FREP', field: 'priority', value: 'could' },
                { op: 'setFormField', path: '$req/FREP', field: 'businessValue', value: 'medium' },
                { op: 'setHeadline', path: '$req', headline: 'FR-07 — Archive closed orders' },
            ],
        });
        assert.equal(edit.ok, true, JSON.stringify(edit).slice(0, 400));
        assert.equal(edit.written, true);
        assert.deepEqual(edit.validation.introduced, [], 'the fill introduces no finding');
        assert.match(fs.readFileSync(path.join(ws, FILE), 'utf8'), /archive closed orders/);

        const after = await call(client, 'tomAi_specSearch', { file: FILE, className: 'FunctionalRequirementEntry' });
        assert.equal(after.total, before + 1);
        const validated = await call(client, 'tomAi_specValidate', { file: FILE });
        assert.equal(validated.passed, baseline.passed, JSON.stringify(validated.violations).slice(0, 400));
        assert.equal(validated.violations.length, baseline.violations.length);
        const rendered = await call(client, 'tomAi_specRender', { file: FILE, path: edit.bindings.req });
        assert.match(rendered.markdown, /FR-07 — Archive closed orders/);
    });

    test('SM-2: the CodeSpecs path, authenticated', async () => {
        const { client } = authed;
        const gate = await call(client, 'tomAi_specCodeSpecsGate', { file: FILE });
        assert.equal(gate.ok, true);
        assert.equal(typeof gate.gateOpen, 'boolean');
        const extract = await call(client, 'tomAi_specCodeSpecsExtract', { file: FILE });
        assert.equal(extract.ok, true, JSON.stringify(extract).slice(0, 300));
        const context = await call(client, 'tomAi_specCodeSpecsStepContext', { file: FILE, step: 10 });
        assert.equal(context.ok, true, JSON.stringify(context).slice(0, 300));
        assert.deepEqual(context.extracts.map((e: Json) => e.area), ['CE-DB']);
    });

    test('SM-3: unauthenticated, the readers only', async () => {
        const served = new Set(anon.served);
        for (const name of authed.served.filter((n) => SPEC.test(n))) {
            const isReader = !['Set', 'Add', 'Apply', 'Clear', 'Convert', 'Create', 'Move', 'Remove', 'Write', 'Plan', 'Replace']
                .some((verb) => name.includes(verb));
            assert.equal(served.has(name), isReader, `${name} ${isReader ? 'missing from' : 'leaked into'} the read-only floor`);
        }
        assert.ok(anon.served.includes('tomAi_specGetSection'));
        const refused = await anon.client.callTool({ name: 'tomAi_specApplyEdits', arguments: { file: FILE, edits: [] } })
            .then((r) => r.isError === true, () => true);
        assert.equal(refused, true, 'a writer cannot be called without the key');
        const read = await call(anon.client, 'tomAi_specGetSection', { file: FILE, path: `${FR}/FRE-REQU-LST-1` });
        assert.equal(read.ok, true);
    });
    test('SM-4: the CodeSpecs guides, runbooks and status for an external client', async () => {
        const { client } = anon;
        const resources = (await client.listResources()).resources.map((r) => r.uri);
        assert.deepEqual(resources, ['codespecs-guide://prompt', 'codespecs-guide://mapping']);
        const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
        assert.deepEqual(templates, ['codespecs-guide://{guide}/{section}']);
        const whole = await client.readResource({ uri: 'codespecs-guide://prompt' });
        assert.match((whole.contents[0] as { text: string }).text, /^# CodeSpecs Starting Prompt/);
        const section = await client.readResource({ uri: 'codespecs-guide://prompt/6.2' });
        assert.match((section.contents[0] as { text: string }).text, /^### 6\.2 /);
        const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
        assert.equal(prompts.length, 7);
        assert.ok(prompts.includes('codespecs-stage-b'));
        const got = await client.getPrompt({ name: 'codespecs-stage-b', arguments: { file: FILE } });
        const text = (got.messages[0].content as { text: string }).text;
        assert.ok(text.includes(FILE), 'the argument is filled in');
        assert.match(text, /tomAi_specCodeSpecsSetVerdict/);
        assert.match(text, /From the guide \(prompt §6\)/);
        assert.ok(anon.served.includes('tomAi_specCodeSpecsStatus') && anon.served.includes('tomAi_specCodeSpecsGuide'));
        const status = await call(client, 'tomAi_specCodeSpecsStatus', { file: FILE });
        assert.equal(status.stages[0].stage, 'gate');
        assert.ok(status.next.stage, JSON.stringify(status.next));
    });
});
