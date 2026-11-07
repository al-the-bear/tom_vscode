/**
 * External MCP servers' tools in the tool loop (ccparity_d_claudecode-7,
 * CC-16 (a)), end to end: a workspace whose `.mcp.json` names the fixture
 * stdio server (approved in `.claude/settings.local.json`), a send on the
 * Local LLM transport against a local fake Ollama server.
 *
 *   EM-1 the request offers the server's tools as `mcp__fixture__<tool>`; the model's call to the read-only
 *        `echo` runs on the server without asking and its answer goes back to the model; the call to the writer
 *        `write_note` is asked for under Tool Approval "Always" and then runs
 *   EM-2 the direct transport adds them the same way (before the tool plan, so they are deferred and found by
 *        tool search); an isolated send (a sub-agent) and the other transports do not
 */

/* eslint-disable @typescript-eslint/naming-convention -- Ollama and MCP wire fields */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'external-mcp-transports-')));
const ws = path.join(base, 'ws');
const home = path.join(base, 'home');
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
fs.mkdirSync(home, { recursive: true });
const sdk = path.join(__dirname, '..', '..', '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'server');
const zod = path.join(__dirname, '..', '..', '..', 'node_modules', 'zod');
const serverScript = path.join(base, 'fixture-server.js');
fs.writeFileSync(serverScript, `
const { McpServer } = require(${JSON.stringify(path.join(sdk, 'mcp.js'))});
const { StdioServerTransport } = require(${JSON.stringify(path.join(sdk, 'stdio.js'))});
const { z } = require(${JSON.stringify(zod)});
const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo the text back.', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: 'echo: ' + text }] }));
server.registerTool('write_note', { description: 'Write a note.', inputSchema: { note: z.string() } },
    async ({ note }) => ({ content: [{ type: 'text', text: 'wrote ' + note }] }));
server.connect(new StdioServerTransport());
`);
fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'node', args: [serverScript] } } }));
fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['fixture'] }));

installVscodeStub({ workspaceFolders: [ws] });

// Safe to import after the stub is wired into the resolver.
import { AnthropicHandler, disposeExternalMcp } from '../anthropic-handler.js';
import { LocalLlmManager, setLocalLlmManager } from '../localLlm-handler.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { __setClaudeHomeForTests } from '../../services/claudeDirs.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);
__setClaudeHomeForTests(home);
setLocalLlmManager(new LocalLlmManager({ subscriptions: [] } as never));

/** The fake Ollama: each request's body is kept; the answers follow the script. */
const bodies: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: string }> }> = [];
const script = [
    { tool_calls: [{ function: { name: 'mcp__fixture__echo', arguments: { text: 'hi' } } }] },
    { tool_calls: [{ function: { name: 'mcp__fixture__write_note', arguments: { note: 'n1' } } }] },
    { content: 'all done' },
];
let server: http.Server;
let baseUrl = '';
before(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
            bodies.push(JSON.parse(raw));
            const step = script[Math.min(bodies.length - 1, script.length - 1)];
            res.writeHead(200, { 'content-type': 'application/x-ndjson' });
            res.end(JSON.stringify({ message: { role: 'assistant', content: step.content ?? '', ...(step.tool_calls ? { tool_calls: step.tool_calls } : {}) }, done: true }) + '\n');
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await disposeExternalMcp(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = AnthropicHandler.instance as any;
const asked: string[] = [];
handler.awaitApproval = async (req: { toolName: string }) => { asked.push(req.toolName); return true; };

describe('external MCP tools in the tool loop', () => {
    test('EM-1: Local LLM calls the server\'s tools', async () => {
        const result = await AnthropicHandler.instance.sendMessage({
            userText: 'use the fixture',
            profile: { id: 'p', name: 'p', systemPrompt: 'Base.', toolApprovalMode: 'always' },
            configuration: {
                id: 'local', name: 'local', model: 'qwen', maxTokens: 100, maxRounds: 5, transport: 'localLlm',
                localLlm: { baseUrl, model: 'qwen', temperature: 0 },
            },
            tools: [],
        } as never);
        assert.equal(result.text, 'all done');
        const offered = (bodies[0].tools ?? []).map((t) => t.function.name).sort();
        assert.deepEqual(offered, ['mcp__fixture__echo', 'mcp__fixture__write_note']);
        const toolMessages = (i: number) => bodies[i].messages.filter((m) => m.role === 'tool').map((m) => m.content);
        assert.deepEqual(toolMessages(1), ['echo: hi'], 'the server answered the read-only call');
        assert.deepEqual(toolMessages(2), ['echo: hi', 'wrote n1']);
        assert.deepEqual(asked, ['mcp__fixture__write_note'], 'only the writer asked for approval');
    });

    test('EM-2: which sends get them', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        const send = src.slice(src.indexOf('    async sendMessage(options: AnthropicSendOptions)'));
        assert.ok(send.indexOf('await this.withExternalMcpTools(options)') < send.indexOf('options = withToolPlan(options)'), 'before the tool plan');
        assert.match(src, /if \(\(transport !== 'direct' && transport !== 'localLlm'\) \|\| options\.isolated \|\| !WsPaths\.wsRoot\) \{ return options; \}/);
        assert.match(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'extension.ts'), 'utf8'), /m\.disposeExternalMcp\(\)/, 'stopped at deactivation');
    });
});
