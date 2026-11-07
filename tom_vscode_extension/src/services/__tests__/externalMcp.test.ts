/**
 * The MCP client for external MCP servers (ccparity_d_claudecode-7,
 * CC-16 (a)): services/externalMcp.ts against a fixture stdio server built
 * with the same SDK (its tools: `echo`, read-only; `write_note`, a writer;
 * `fail`, answering an error).
 *
 *   MC-1 configuration as Claude Code keeps it: `.mcp.json` (project), `~/.claude.json` mcpServers (user) and
 *        its projects[<workspace>].mcpServers (local); local over project over user; `${VAR}` and
 *        `${VAR:-default}` expanded in command, args, env, url and headers; stdio, http and sse; a project server
 *        runs only when the settings approve it (enableAllProjectMcpServers or enabledMcpjsonServers) and it is
 *        not in disabledMcpjsonServers — the others are listed as not approved
 *   MC-2 the tools: started over stdio, each tool as `mcp__<server>__<tool>` with its description and input
 *        schema; readOnlyHint makes a reader, anything else a writer (approval like ours); a call answers the
 *        text content; an error result throws with its text
 *   MC-3 a server that does not start is left out with a message, the others still serve; a changed
 *        configuration restarts its server; dispose stops them
 *   MC-4 names: characters outside [A-Za-z0-9_-] become `_`, at most 64 characters
 */

/* eslint-disable @typescript-eslint/naming-convention -- MCP and Claude Code configuration fields */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ExternalMcpManager, loadMcpServerConfigs, mcpToolName, type McpServerConfig } from '../externalMcp';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'external-mcp-')));
const home = path.join(base, 'home');
const ws = path.join(base, 'ws');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
const sdk = path.join(__dirname, '..', '..', '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'server');
const zod = path.join(__dirname, '..', '..', '..', 'node_modules', 'zod');
export const FIXTURE_SERVER = path.join(base, 'fixture-server.js');
fs.writeFileSync(FIXTURE_SERVER, `
const { McpServer } = require(${JSON.stringify(path.join(sdk, 'mcp.js'))});
const { StdioServerTransport } = require(${JSON.stringify(path.join(sdk, 'stdio.js'))});
const { z } = require(${JSON.stringify(zod)});
const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo the text back.', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: (process.env.GREETING || '') + 'echo: ' + text }] }));
server.registerTool('write_note', { description: 'Write a note.', inputSchema: { note: z.string() } },
    async ({ note }) => ({ content: [{ type: 'text', text: 'wrote ' + note }] }));
server.registerTool('fail', { description: 'Always fails.', inputSchema: {} },
    async () => ({ isError: true, content: [{ type: 'text', text: 'it broke' }] }));
server.connect(new StdioServerTransport());
`);
const writeJson = (file: string, data: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
};
const stdio = (extra: Record<string, unknown> = {}) => ({ command: 'node', args: [FIXTURE_SERVER], ...extra });

describe('external MCP servers', () => {
    const managers: ExternalMcpManager[] = [];
    after(async () => { for (const m of managers) { await m.dispose(); } });

    test('MC-1: configuration', () => {
        writeJson(path.join(ws, '.mcp.json'), {
            mcpServers: {
                fixture: stdio({ env: { GREETING: '${MC_GREETING:-hello }' } }),
                remote: { type: 'http', url: '${MC_URL:-http://127.0.0.1:9}/mcp', headers: { Authorization: 'Bearer ${MC_TOKEN}' } },
                events: { type: 'sse', url: 'http://127.0.0.1:9/sse' },
                unapproved: stdio(),
                disabled: stdio(),
                shadowed: stdio(),
            },
        });
        writeJson(path.join(ws, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['fixture', 'remote', 'events', 'disabled', 'shadowed'] });
        writeJson(path.join(ws, '.claude', 'settings.json'), { disabledMcpjsonServers: ['disabled'] });
        writeJson(path.join(home, '.claude.json'), {
            mcpServers: { userserver: stdio({ args: ['user.js'] }), shadowed: stdio({ args: ['user.js'] }) },
            projects: { [ws]: { mcpServers: { shadowed: stdio({ args: ['local.js'] }) } } },
        });
        const { servers, notApproved } = loadMcpServerConfigs(ws, home, { MC_TOKEN: 'tok' });
        const byName = new Map(servers.map((s) => [s.name, s]));
        assert.deepEqual([...byName.keys()].sort(), ['events', 'fixture', 'remote', 'shadowed', 'userserver']);
        assert.deepEqual(notApproved, ['unapproved']);
        assert.deepEqual(byName.get('fixture'), { name: 'fixture', scope: 'project', type: 'stdio', command: 'node', args: [FIXTURE_SERVER], env: { GREETING: 'hello ' } });
        assert.deepEqual(byName.get('remote'), { name: 'remote', scope: 'project', type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer tok' } });
        assert.equal(byName.get('events')!.type, 'sse');
        assert.deepEqual([byName.get('shadowed')!.scope, byName.get('shadowed')!.args], ['local', ['local.js']], 'local over project over user');
        assert.equal(byName.get('userserver')!.scope, 'user');
        writeJson(path.join(ws, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true });
        assert.deepEqual(loadMcpServerConfigs(ws, home, {}).notApproved, [], 'all project servers approved');
        assert.ok(!loadMcpServerConfigs(ws, home, {}).servers.some((s) => s.name === 'disabled'), 'disabled stays off');
    });

    test('MC-2: the tools of a stdio server', async () => {
        const config: McpServerConfig = { name: 'fixture', scope: 'project', type: 'stdio', command: 'node', args: [FIXTURE_SERVER], env: { GREETING: 'hi ' } };
        const manager = new ExternalMcpManager(() => ({ servers: [config], notApproved: [] }));
        managers.push(manager);
        const tools = await manager.tools();
        assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp__fixture__echo', 'mcp__fixture__fail', 'mcp__fixture__write_note']);
        const echo = tools.find((t) => t.name === 'mcp__fixture__echo')!;
        assert.equal(echo.description, 'Echo the text back.');
        assert.equal(echo.readOnly, true);
        assert.deepEqual((echo.inputSchema as { properties: Record<string, unknown> }).properties.text, { type: 'string' });
        assert.equal(tools.find((t) => t.name === 'mcp__fixture__write_note')!.readOnly, false, 'no hint: a writer');
        assert.equal(await echo.execute({ text: 'there' }), 'hi echo: there');
        await assert.rejects(tools.find((t) => t.name === 'mcp__fixture__fail')!.execute({}), /it broke/);
        assert.equal(await manager.tools().then((t) => t.length), 3, 'connected once, served again');
    });

    test('MC-3: a broken server, a changed configuration, dispose', async () => {
        let configs: McpServerConfig[] = [
            { name: 'broken', scope: 'user', type: 'stdio', command: path.join(base, 'no-such-binary') },
            { name: 'fixture', scope: 'project', type: 'stdio', command: 'node', args: [FIXTURE_SERVER] },
        ];
        const manager = new ExternalMcpManager(() => ({ servers: configs, notApproved: ['pending'] }), { connectTimeoutMs: 15000 });
        managers.push(manager);
        const tools = await manager.tools();
        assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp__fixture__echo', 'mcp__fixture__fail', 'mcp__fixture__write_note']);
        assert.match(manager.messages.join('\n'), /MCP server "broken" did not start/);
        assert.match(manager.messages.join('\n'), /"pending".*not approved/);
        configs = [{ ...configs[1], env: { GREETING: 'changed ' } }];
        const again = await manager.tools();
        assert.equal(await again.find((t) => t.name === 'mcp__fixture__echo')!.execute({ text: 'x' }), 'changed echo: x', 'restarted with the new configuration');
        await manager.dispose();
        assert.equal(manager.connectedServers().length, 0);
    });

    test('MC-4: names', () => {
        assert.equal(mcpToolName('my server.x', 'a/b'), 'mcp__my_server_x__a_b');
        const long = mcpToolName('s'.repeat(40), 't'.repeat(40));
        assert.equal(long.length, 64);
        assert.ok(long.startsWith('mcp__ssss'));
    });
});
