/**
 * Plan mode on the transports whose tool loop the extension runs itself —
 * direct, Local LLM and VS Code LM (CC-3): every tool call of their loops goes
 * through AnthropicHandler.runTool, where a write tool is refused before it
 * runs (and before any approval).
 *
 *   PT-1 per transport (direct, localLlm, vscodeLm): with plan mode on, a write tool answers the plan-mode
 *        refusal as an error result and does not run; a read tool runs; tomAi_askUser's kind runs
 *   PT-2 with plan mode off the writer runs again (Tool Approval "Never": no approval in the way)
 *   PT-3 the three loops call runTool for every tool call (the single gate)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mode-tool-loop-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { AnthropicHandler } from '../anthropic-handler.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { enterPlanModeImpl, leavePlanModeByUser, PLAN_MODE_REFUSAL, resetPlanModeForTests } from '../../tools/planning-tools.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

const ran: string[] = [];
const tool = (name: string, readOnly: boolean): SharedToolDefinition => ({
    name, description: name, readOnly, inputSchema: { type: 'object', properties: {} },
    execute: async () => { ran.push(name); return `${name} done`; },
}) as unknown as SharedToolDefinition;
const TOOLS = [tool('tomAi_editFile', false), tool('tomAi_readFile', true), tool('tomAi_askUser', false)];

type ToolResult = { content: string; is_error?: boolean };

async function runTool(transport: string, name: string): Promise<ToolResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = AnthropicHandler.instance as any;
    return handler.runTool(
        { type: 'tool_use', id: `tu-${name}`, name, input: {} },
        TOOLS,
        { id: 'cfg', name: 'cfg', model: 'm', maxTokens: 100, maxRounds: 3, transport },
        { profile: { id: 'p', toolApprovalMode: 'never' } },
        1, 'test_quest', 'win', 'req-1', null,
    );
}

beforeEach(() => { resetPlanModeForTests(); ran.length = 0; });

describe('plan mode in the extension\'s own tool loop', () => {
    for (const transport of ['direct', 'localLlm', 'vscodeLm']) {
        test(`PT-1: ${transport} — writers refused, readers run`, async () => {
            await enterPlanModeImpl({});
            const refused = await runTool(transport, 'tomAi_editFile');
            assert.equal(refused.is_error, true);
            assert.equal(refused.content, PLAN_MODE_REFUSAL);
            assert.deepEqual(ran, [], 'the writer did not run');
            const read = await runTool(transport, 'tomAi_readFile');
            assert.notEqual(read.is_error, true);
            await runTool(transport, 'tomAi_askUser');
            assert.deepEqual(ran, ['tomAi_readFile', 'tomAi_askUser']);
        });
    }

    test('PT-2: plan mode off — the writer runs again', async () => {
        await enterPlanModeImpl({});
        await runTool('direct', 'tomAi_editFile');
        leavePlanModeByUser();
        const r = await runTool('direct', 'tomAi_editFile');
        assert.notEqual(r.is_error, true);
        assert.deepEqual(ran, ['tomAi_editFile']);
    });

    test('PT-3: every loop goes through runTool', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        assert.ok((src.match(/await this\.runTool\(/g) ?? []).length >= 3, 'the direct, VS Code LM and Local LLM loops');
        const runToolBody = src.slice(src.indexOf('private async runTool('));
        assert.ok(runToolBody.indexOf('planModeRefusalFor(') < runToolBody.indexOf('awaitApproval('), 'refused before any approval');
    });
});
