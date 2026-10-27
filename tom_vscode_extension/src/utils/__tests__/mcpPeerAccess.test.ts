/**
 * The MCP server serves a client without the API key only from this machine or the fleet VPN.
 *
 * Measured 2026-10-27: bound to `0.0.0.0` with no `apiKeyEnv`, the server served 91 read-only tools
 * (tomAi_readFile, tomAi_findTextInFiles, tomAi_readMemory, …) to any client on any network the host was on —
 * a home or public Wi-Fi included. Decision (b): the bind stays; a request without the key is served only
 * from loopback or 10.8.0.0/16, anything else is answered 401.
 *
 *   PA-1 trusted peers: 127.0.0.0/8, ::1, 10.8.0.0/16, each also as an IPv4-mapped IPv6 address; not others
 *        (10.9.x, 192.168.x, a public address, 10.80.x, an unknown address)
 *   PA-2 admission: a request with the key is served from anywhere; one without from a trusted peer only,
 *        whatever allowWriteWithoutAuth says; the refusal names the address and what to do
 *   PA-3 over HTTP: a refused request gets 401 with a JSON-RPC error and no tool set is built for it; an
 *        admitted one is served
 *   PA-4 the server's own starter wires the admission from the settings and the environment
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { isTrustedMcpPeer, mcpRequestAdmission } from '../mcpPeerAccess.js';
import { startMcpHttpServer } from '../../handlers/mcpServer-handler.js';

describe('MCP keyless access', () => {
    test('PA-1: trusted peers', () => {
        for (const a of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '10.8.0.7', '10.8.255.1', '::ffff:10.8.0.9']) {
            assert.equal(isTrustedMcpPeer(a), true, a);
        }
        for (const a of ['10.9.0.1', '10.80.0.1', '192.168.1.20', '::ffff:192.168.1.20', '81.169.1.2', 'fe80::1', '', undefined]) {
            assert.equal(isTrustedMcpPeer(a), false, String(a));
        }
    });

    test('PA-2: admission', () => {
        assert.deepEqual(mcpRequestAdmission({ authenticated: true, remoteAddress: '192.168.1.20' }), { admitted: true });
        assert.deepEqual(mcpRequestAdmission({ authenticated: false, remoteAddress: '10.8.0.9' }), { admitted: true });
        const refused = mcpRequestAdmission({ authenticated: false, remoteAddress: '192.168.1.20', apiKeyEnv: 'TOM_MCP_KEY' });
        assert.equal(refused.admitted, false);
        assert.match(refused.admitted ? '' : refused.reason, /10\.8\.0\.0\/16.*192\.168\.1\.20.*TOM_MCP_KEY/s);
        const noKey = mcpRequestAdmission({ authenticated: false, remoteAddress: '192.168.1.20' });
        assert.match(noKey.admitted ? '' : noKey.reason, /mcpServer\.apiKeyEnv/, 'without a configured key, says to configure one');
    });

    test('PA-3: over HTTP', async () => {
        let built = 0;
        const deps = {
            resolveTools: () => { built++; return []; },
            sink: { writeRequest: () => undefined, writeAnswer: () => undefined },
            admit: (_bearer: string | undefined, remote: string | undefined) => remote === 'never'
                ? { admitted: true as const }
                : { admitted: false as const, reason: 'not from here' },
        };
        const server = await startMcpHttpServer({ host: '127.0.0.1', basePort: 19960 }, deps);
        try {
            const res = await post(server.port);
            assert.equal(res.status, 401);
            assert.match(res.body, /"jsonrpc":"2\.0".*not from here/);
            assert.equal(built, 0, 'no tool set for a refused request');
        } finally { await server.close(); }

        const open = await startMcpHttpServer({ host: '127.0.0.1', basePort: 19960 }, { ...deps, admit: () => ({ admitted: true as const }) });
        try {
            const res = await post(open.port);
            assert.equal(res.status, 200, 'served, not refused');
            assert.equal(built, 1, 'the tool set was built for it');
        } finally { await open.close(); }
    });

    test('PA-4: the starter wires it', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'mcpServer-handler.ts'), 'utf-8');
        assert.match(src, /admit: \(bearer, remoteAddress\) => admitMcpRequest\(settings, bearer, remoteAddress, log\)/);
    });
});

/** HTTP header names are not camelCase. */
// eslint-disable-next-line @typescript-eslint/naming-convention
const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function post(port: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        // agent: false — a fresh connection each time; a kept-alive one would reach the closed first server.
        const req = http.request({ agent: false, host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: HEADERS }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    });
}
