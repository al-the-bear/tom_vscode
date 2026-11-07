/**
 * An MCP client for the external MCP servers Claude Code is configured with
 * (CC-16 (a)): their tools join the direct and Local LLM tool loops.
 *
 * **Configuration**, as Claude Code keeps it:
 * - `<workspace>/.mcp.json` — `mcpServers` (project scope);
 * - `~/.claude.json` — `mcpServers` (user scope) and
 *   `projects[<workspace>].mcpServers` (local scope).
 *
 * Local wins over project over user for the same name. A server is
 * `{command, args, env}` (stdio) or `{type: "http" | "sse", url, headers}`;
 * `${VAR}` and `${VAR:-default}` are expanded in all of those. A project
 * server (a `.mcp.json` checked out with a repository can run any command)
 * runs only when Claude Code's settings approve it — `enableAllProjectMcpServers`
 * or its name in `enabledMcpjsonServers` — and it is not in
 * `disabledMcpjsonServers` (`~/.claude/settings.json`, the workspace's
 * `.claude/settings.json` and `.claude/settings.local.json`); the others are
 * reported as not approved.
 *
 * **Tools**: every tool of a connected server as `mcp__<server>__<tool>`
 * (characters outside `[A-Za-z0-9_-]` as `_`, at most 64 characters — the
 * API's limit), with its description and input schema; `readOnlyHint` makes
 * it a reader, anything else a writer, approved like ours. A call answers the
 * result's text (images and resources named); an error result throws.
 *
 * Servers are started (stdio) or connected (HTTP, SSE) on first use and kept;
 * a changed configuration restarts its server; a server that fails to start
 * is left out with a message and tried again after a minute.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import type { SharedToolDefinition } from '../tools/shared-tool-registry';

export type McpScope = 'local' | 'project' | 'user';

export interface McpServerConfig {
    name: string;
    scope: McpScope;
    type: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
}

export interface McpServerConfigs {
    servers: McpServerConfig[];
    /** Project servers the settings have not approved (not started). */
    notApproved: string[];
}

/** `${VAR}` and `${VAR:-default}` from `env`; an unset variable without a default is empty. */
export function expandEnvVars(text: string, env: Record<string, string | undefined>): string {
    return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def: string | undefined) => {
        const value = env[name];
        return value !== undefined && value !== '' ? value : (def ?? '');
    });
}

function readJson(file: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
    } catch {
        return undefined;
    }
}

function stringRecord(value: unknown, env: Record<string, string | undefined>): Record<string, string> | undefined {
    if (!value || typeof value !== 'object') { return undefined; }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string') { out[k] = expandEnvVars(v, env); }
    }
    return out;
}

/** One `mcpServers` entry as a server configuration; undefined when it names neither a command nor a URL. */
function toConfig(name: string, raw: unknown, scope: McpScope, env: Record<string, string | undefined>): McpServerConfig | undefined {
    if (!raw || typeof raw !== 'object') { return undefined; }
    const r = raw as Record<string, unknown>;
    const declared = typeof r.type === 'string' ? r.type : undefined;
    if (typeof r.url === 'string' && declared !== 'stdio') {
        const headers = stringRecord(r.headers, env);
        return {
            name, scope,
            type: declared === 'sse' ? 'sse' : 'http',
            url: expandEnvVars(r.url, env),
            ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        };
    }
    if (typeof r.command !== 'string' || !r.command.trim()) { return undefined; }
    const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string').map((a) => expandEnvVars(a, env)) : undefined;
    const serverEnv = stringRecord(r.env, env);
    return {
        name, scope, type: 'stdio',
        command: expandEnvVars(r.command, env),
        ...(args && args.length > 0 ? { args } : {}),
        ...(serverEnv && Object.keys(serverEnv).length > 0 ? { env: serverEnv } : {}),
    };
}

/** Claude Code's approval of `.mcp.json` servers, merged over its three settings files. */
function projectServerApproval(wsRoot: string, homeDir: string): { all: boolean; enabled: Set<string>; disabled: Set<string> } {
    const result = { all: false, enabled: new Set<string>(), disabled: new Set<string>() };
    for (const file of [path.join(homeDir, '.claude', 'settings.json'), path.join(wsRoot, '.claude', 'settings.json'), path.join(wsRoot, '.claude', 'settings.local.json')]) {
        const s = readJson(file);
        if (!s) { continue; }
        if (s.enableAllProjectMcpServers === true) { result.all = true; }
        for (const n of Array.isArray(s.enabledMcpjsonServers) ? s.enabledMcpjsonServers : []) { if (typeof n === 'string') { result.enabled.add(n); } }
        for (const n of Array.isArray(s.disabledMcpjsonServers) ? s.disabledMcpjsonServers : []) { if (typeof n === 'string') { result.disabled.add(n); } }
    }
    return result;
}

/** The MCP servers configured for the workspace (see the module comment). */
export function loadMcpServerConfigs(wsRoot: string, homeDir: string, env: Record<string, string | undefined> = process.env): McpServerConfigs {
    const byName = new Map<string, McpServerConfig>();
    const notApproved: string[] = [];
    const claudeJson = readJson(path.join(homeDir, '.claude.json'));
    const addAll = (servers: unknown, scope: McpScope, accept: (name: string) => boolean = () => true): void => {
        if (!servers || typeof servers !== 'object') { return; }
        for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
            if (byName.has(name) || !accept(name)) { continue; }
            const config = toConfig(name, raw, scope, env);
            if (config) { byName.set(name, config); }
        }
    };
    // Local first: it wins over project, which wins over user.
    const projects = claudeJson?.projects as Record<string, { mcpServers?: unknown }> | undefined;
    addAll(projects?.[wsRoot]?.mcpServers ?? projects?.[path.resolve(wsRoot)]?.mcpServers, 'local');
    const approval = projectServerApproval(wsRoot, homeDir);
    addAll(readJson(path.join(wsRoot, '.mcp.json'))?.mcpServers, 'project', (name) => {
        if (approval.disabled.has(name)) { return false; }
        if (approval.all || approval.enabled.has(name)) { return true; }
        notApproved.push(name);
        return false;
    });
    addAll(claudeJson?.mcpServers, 'user');
    return { servers: [...byName.values()], notApproved: notApproved.filter((n) => !byName.has(n)) };
}

/** The tool's name in our loops: `mcp__<server>__<tool>`, API-safe, at most 64 characters. */
export function mcpToolName(server: string, tool: string): string {
    return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** A tool result's content as text. */
function resultText(content: unknown): string {
    if (!Array.isArray(content)) { return ''; }
    return content.map((part) => {
        const p = part as { type?: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } };
        if (p.type === 'text') { return p.text ?? ''; }
        if (p.type === 'image' || p.type === 'audio') { return `[${p.type} ${p.mimeType ?? ''}]`.trim(); }
        if (p.type === 'resource') { return p.resource?.text ?? `[resource ${p.resource?.uri ?? ''}]`; }
        if (p.type === 'resource_link') { return `[resource ${(p as { uri?: string }).uri ?? ''}]`; }
        return '';
    }).filter((t) => t).join('\n');
}

interface Connection {
    key: string;
    client: Client;
    tools: SharedToolDefinition[];
}

const RETRY_AFTER_FAILURE_MS = 60_000;
const CALL_TIMEOUT_MS = 10 * 60_000;

export class ExternalMcpManager {
    private readonly connections = new Map<string, Connection>();
    private readonly failedUntil = new Map<string, number>();
    private pending: Promise<SharedToolDefinition[]> | undefined;
    /** What happened that the user should know (a server not started, not approved), newest last. */
    readonly messages: string[] = [];

    constructor(
        private readonly loadConfigs: () => McpServerConfigs,
        private readonly opts: { connectTimeoutMs?: number; log?: (line: string) => void } = {},
    ) {}

    private note(message: string): void {
        this.messages.push(message);
        if (this.messages.length > 50) { this.messages.shift(); }
        this.opts.log?.(message);
    }

    /** The tools of every configured server, connecting what is not connected yet. */
    tools(): Promise<SharedToolDefinition[]> {
        this.pending ??= this.sync().finally(() => { this.pending = undefined; });
        return this.pending;
    }

    /** The servers connected now. */
    connectedServers(): string[] {
        return [...this.connections.keys()];
    }

    private async sync(): Promise<SharedToolDefinition[]> {
        const { servers, notApproved } = this.loadConfigs();
        for (const name of notApproved) {
            const message = `MCP server "${name}" (.mcp.json) is not approved: approve it in Claude Code, or add it to enabledMcpjsonServers in .claude/settings.local.json`;
            if (!this.messages.includes(message)) { this.note(message); }
        }
        const wanted = new Map(servers.map((s) => [s.name, s]));
        for (const [name, conn] of this.connections) {
            const config = wanted.get(name);
            if (!config || JSON.stringify(config) !== conn.key) { await this.close(name); }
        }
        const now = Date.now();
        await Promise.all(servers
            .filter((s) => !this.connections.has(s.name) && (this.failedUntil.get(JSON.stringify(s)) ?? 0) <= now)
            .map((s) => this.connect(s)));
        return [...this.connections.values()].flatMap((c) => c.tools);
    }

    private async connect(config: McpServerConfig): Promise<void> {
        const key = JSON.stringify(config);
        const client = new Client({ name: 'tom-ai-extension', version: '1.0.0' });
        try {
            const transport = config.type === 'stdio'
                ? new StdioClientTransport({
                    command: config.command!,
                    args: config.args ?? [],
                    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
                    stderr: 'ignore',
                })
                : config.type === 'sse'
                    ? new SSEClientTransport(new URL(config.url!), { requestInit: { headers: config.headers ?? {} } })
                    : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: config.headers ?? {} } });
            const timeoutMs = this.opts.connectTimeoutMs ?? 30_000;
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
                client.connect(transport),
                new Promise((_r, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs); }),
            ]).finally(() => clearTimeout(timer));
            const listed = await client.listTools();
            const tools = listed.tools.map((tool): SharedToolDefinition => ({
                name: mcpToolName(config.name, tool.name),
                displayName: `${config.name}: ${tool.title ?? tool.name}`,
                description: tool.description ?? `${tool.name} (MCP server ${config.name})`,
                tags: ['mcp', `mcp-${config.name}`],
                readOnly: tool.annotations?.readOnlyHint === true,
                inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as SharedToolDefinition['inputSchema'],
                execute: async (input: Record<string, unknown>) => {
                    const result = await client.callTool({ name: tool.name, arguments: input }, undefined, { timeout: CALL_TIMEOUT_MS });
                    const text = resultText(result.content);
                    if (result.isError) { throw new Error(text || `MCP tool ${tool.name} failed`); }
                    return text;
                },
            }));
            this.connections.set(config.name, { key, client, tools });
            this.failedUntil.delete(key);
        } catch (err) {
            this.failedUntil.set(key, Date.now() + RETRY_AFTER_FAILURE_MS);
            this.note(`MCP server "${config.name}" did not start: ${(err as Error).message}`);
            await client.close().catch(() => undefined);
        }
    }

    private async close(name: string): Promise<void> {
        const conn = this.connections.get(name);
        this.connections.delete(name);
        await conn?.client.close().catch(() => undefined);
    }

    /** Stop every server (stdio processes end, HTTP sessions close). */
    async dispose(): Promise<void> {
        for (const name of [...this.connections.keys()]) { await this.close(name); }
    }
}
