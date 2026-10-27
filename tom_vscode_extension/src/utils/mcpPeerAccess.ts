/**
 * Who may use the MCP server without the API key.
 *
 * The server is often bound to `0.0.0.0` so the fleet reaches it over the VPN.
 * That is every interface: on a home or public Wi-Fi the keyless read-only
 * floor (tomAi_readFile, tomAi_findTextInFiles, tomAi_readMemory, …) was open
 * to that network too. So a request without the key is served only from this
 * machine (loopback) or the fleet VPN ({@link MCP_KEYLESS_SUBNETS}), checked
 * per request — it holds however the interfaces change while the server runs.
 * A request with the key is served from anywhere.
 *
 * vscode-free.
 */

/** Where a client without the key may connect from. */
export const MCP_KEYLESS_SUBNETS = ['127.0.0.0/8', '::1', '10.8.0.0/16'] as const;

/** Whether a peer address is loopback or on the fleet VPN; an IPv4-mapped IPv6 address counts as its IPv4. */
export function isTrustedMcpPeer(remoteAddress: string | undefined): boolean {
    if (!remoteAddress) { return false; }
    const address = remoteAddress.toLowerCase().replace(/^::ffff:/, '');
    if (address === '::1') { return true; }
    const octets = address.split('.');
    if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) { return false; }
    const [a, b] = octets.map(Number);
    return a === 127 || (a === 10 && b === 8);
}

export type McpAdmission = { admitted: true } | { admitted: false; reason: string };

/** Serve the request? With the key, yes; without, only from a trusted peer. */
export function mcpRequestAdmission(opts: { authenticated: boolean; remoteAddress: string | undefined; apiKeyEnv?: string }): McpAdmission {
    if (opts.authenticated || isTrustedMcpPeer(opts.remoteAddress)) { return { admitted: true }; }
    const how = opts.apiKeyEnv
        ? `send the key from ${opts.apiKeyEnv} as a bearer token`
        : 'configure mcpServer.apiKeyEnv and send that key as a bearer token';
    return {
        admitted: false,
        reason: `A client without the API key is served only from this machine or the fleet VPN `
            + `(${MCP_KEYLESS_SUBNETS.join(', ')}); this request came from ${opts.remoteAddress || 'an unknown address'}. To connect from there, ${how}.`,
    };
}
